import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'

import { getSqliteLoadError, isSqliteAvailable, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { calculateCost } from '../models.js'
import type { ParsedProviderCall, Provider, SessionParser, SessionSource } from './types.js'

// OMP (Oh My Pi) records every API call — main turns AND subagent dispatches,
// including streaming continuations — in stats.db, with per-call token counts
// and its own cost_total. This is the authoritative source for usage; the JSONL
// transcripts are an incomplete subset (subagent files nest several levels deep
// beyond what legacy discovery scanned, and one assistant message can fold
// several API calls), so we read the DB directly.
//
// COST MODEL: OMP logs $0 for calls routed through a subscription/included
// tier (e.g. openai-codex), which erases the notional value of that usage. To
// show pay-as-you-go API value instead, we trust OMP's cost_total where it
// priced a call, and for $0 calls we apply the model's own per-token rate
// derived from the rows OMP DID price (LiteLLM fallback for models OMP never
// priced). This makes a subscription's value visible: gross API cost vs the
// flat subscription fee. See the parser.ts provider-cost allowlist, which keeps
// this computed cost from being recomputed via LiteLLM.

const OMP_HOME = join(homedir(), '.omp')
const DEFAULT_GLOBAL_DB = join(OMP_HOME, 'stats.db')

// OMP keeps one global stats.db and, for named profiles, a per-profile DB under
// ~/.omp/profiles/<name>/stats.db. Read every DB that exists so multi-profile
// usage is fully captured.
function listStatsDbs(): string[] {
  const dbs: string[] = []
  if (existsSync(DEFAULT_GLOBAL_DB)) dbs.push(DEFAULT_GLOBAL_DB)
  const profilesDir = join(OMP_HOME, 'profiles')
  try {
    for (const name of readdirSync(profilesDir)) {
      const candidate = join(profilesDir, name, 'stats.db')
      if (existsSync(candidate)) dbs.push(candidate)
    }
  } catch {
    // No profiles dir (or unreadable) — global DB alone covers this install.
  }
  return dbs
}

// OMP sanitizes cwd into a folder name using '-' for '/'. Reverse enough to get
// a stable project label: '-Code-Projects-ForzaBlender' -> 'ForzaBlender'.
function folderToProject(folder: string): string {
  const unsanitized = folder.replace(/-/g, '/')
  const base = basename(unsanitized)
  return base.length > 0 ? base : folder
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query(
      'SELECT model, folder, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total, cost_input, cost_output, cost_cache_read FROM messages LIMIT 1',
    )
    return true
  } catch {
    return false
  }
}

type MessageRow = {
  session_file: string
  entry_id: string
  folder: string
  model: string
  timestamp: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_input: number
  cost_output: number
  cost_cache_read: number
  cost_cache_write: number
  cost_total: number
}

type ToolRow = {
  session_file: string
  entry_id: string
  tool_name: string
}

// Per-model API rates ($/token), derived from rows OMP priced, used to value
// the $0 (subscription-routed) calls at the same rate.
type ModelRates = { input: number; output: number; cacheRead: number; cacheWrite: number }

function deriveModelRates(rows: MessageRow[]): Map<string, ModelRates> {
  const agg = new Map<string, {
    ci: number; co: number; ccr: number; ccw: number
    inp: number; out: number; cr: number; cw: number
  }>()
  for (const row of rows) {
    if ((row.cost_total ?? 0) <= 0) continue
    let a = agg.get(row.model)
    if (!a) {
      a = { ci: 0, co: 0, ccr: 0, ccw: 0, inp: 0, out: 0, cr: 0, cw: 0 }
      agg.set(row.model, a)
    }
    a.ci += row.cost_input ?? 0
    a.co += row.cost_output ?? 0
    a.ccr += row.cost_cache_read ?? 0
    a.ccw += row.cost_cache_write ?? 0
    a.inp += row.input_tokens ?? 0
    a.out += row.output_tokens ?? 0
    a.cr += row.cache_read_tokens ?? 0
    a.cw += row.cache_write_tokens ?? 0
  }

  const rates = new Map<string, ModelRates>()
  for (const [model, a] of agg) {
    rates.set(model, {
      input: a.inp > 0 ? a.ci / a.inp : 0,
      output: a.out > 0 ? a.co / a.out : 0,
      cacheRead: a.cr > 0 ? a.ccr / a.cr : 0,
      cacheWrite: a.cw > 0 ? a.ccw / a.cw : 0,
    })
  }
  return rates
}

// API-equivalent cost. OMP's cost_total where it priced the call; otherwise the
// model's derived rate applied to this call's tokens; otherwise LiteLLM fallback
// (for models OMP never priced at all).
function apiEquivalentCost(row: MessageRow, rates: Map<string, ModelRates>): number {
  if ((row.cost_total ?? 0) > 0) return row.cost_total

  const r = rates.get(row.model)
  if (r) {
    return (
      (row.input_tokens ?? 0) * r.input +
      (row.output_tokens ?? 0) * r.output +
      (row.cache_read_tokens ?? 0) * r.cacheRead +
      (row.cache_write_tokens ?? 0) * r.cacheWrite
    )
  }

  return calculateCost(
    row.model,
    row.input_tokens ?? 0,
    row.output_tokens ?? 0,
    row.cache_write_tokens ?? 0,
    row.cache_read_tokens ?? 0,
    0,
  )
}

// Native OMP tool slugs -> codeburn canonical display names. MCP tools pass through.
const TOOL_DISPLAY: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  dispatch_agent: 'Agent',
  eval: 'Eval',
  todo: 'TodoWrite',
  patch: 'Patch',
  search: 'WebSearch',
  fetch: 'WebFetch',
}

function createParser(source: SessionSource, _seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      let db: SqliteDatabase
      try {
        db = openDatabase(source.path)
      } catch {
        return
      }

      try {
        if (!validateSchema(db)) return

        // Preload tool_calls grouped by (session_file, entry_id) for the tools
        // breakdown. tool_calls stores no command args, so bashCommands is empty.
        const toolsByMessage = new Map<string, string[]>()
        let toolRows: ToolRow[] = []
        try {
          toolRows = db.query<ToolRow>(
            'SELECT session_file, entry_id, tool_name FROM tool_calls',
          )
        } catch {
          // Older OMP builds may lack tool_calls; tools come back empty.
        }
        for (const t of toolRows) {
          const key = t.session_file + '\0' + t.entry_id
          const display = TOOL_DISPLAY[t.tool_name] ?? t.tool_name
          const list = toolsByMessage.get(key)
          if (list) {
            if (!list.includes(display)) list.push(display)
          } else {
            toolsByMessage.set(key, [display])
          }
        }

        const rows = db.query<MessageRow>(
          `SELECT session_file, entry_id, folder, model, timestamp,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                  cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
           FROM messages
           ORDER BY timestamp ASC`,
        )

        // Derive each model's real API rate from the rows OMP priced, so the
        // $0 (subscription) calls can be valued at that same rate.
        const rates = deriveModelRates(rows)

        for (const row of rows) {
          const inputTokens = row.input_tokens ?? 0
          const outputTokens = row.output_tokens ?? 0
          const cacheRead = row.cache_read_tokens ?? 0
          const cacheWrite = row.cache_write_tokens ?? 0
          // Skip genuinely empty rows (error/aborted calls with no tokens).
          if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) {
            continue
          }

          const deduplicationKey = `omp:${row.session_file}:${row.entry_id}`
          const tools = toolsByMessage.get(row.session_file + '\0' + row.entry_id) ?? []

          yield {
            provider: 'omp',
            model: row.model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: cacheWrite,
            cacheReadInputTokens: cacheRead,
            cachedInputTokens: cacheRead,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD: apiEquivalentCost(row, rates),
            tools,
            bashCommands: [],
            timestamp: new Date(row.timestamp).toISOString(),
            speed: 'standard',
            deduplicationKey,
            userMessage: '',
            sessionId: basename(row.session_file, '.jsonl'),
            project: folderToProject(row.folder),
            projectPath: row.folder.replace(/-/g, '/'),
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

async function discoverFromDb(dbPath: string): Promise<SessionSource[]> {
  if (!existsSync(dbPath) || !isSqliteAvailable()) return []

  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }

  try {
    if (!validateSchema(db)) return []
    const row = db.query<{ n: number }>('SELECT count(*) AS n FROM messages LIMIT 1')[0]
    if (!row || row.n === 0) return []
    return [{ path: dbPath, project: 'OMP', provider: 'omp' }]
  } catch {
    return []
  } finally {
    db.close()
  }
}

export function createOmpProvider(dbPath?: string): Provider {
  const dbPaths = dbPath ? [dbPath] : listStatsDbs()

  return {
    name: 'omp',
    displayName: 'OMP',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return TOOL_DISPLAY[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []
      for (const p of dbPaths) {
        sources.push(...await discoverFromDb(p))
      }
      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },

    async probeRoots() {
      return dbPaths.map(p => ({ path: p, label: basename(p) }))
    },
  }
}

export const omp = createOmpProvider()
