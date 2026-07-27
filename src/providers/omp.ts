import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'

import { getSqliteLoadError, isSqliteAvailable, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { ParsedProviderCall, Provider, SessionParser, SessionSource } from './types.js'

// OMP (Oh My Pi) records every API call — main turns AND subagent dispatches,
// including streaming continuations — in stats.db, with per-call token counts
// AND its own pre-computed cost_total at the real rates it pays. The session
// JSONL transcripts are an incomplete subset: only a fraction of files sit at
// the depth the legacy parser scanned, subagent transcripts nest deeper, and a
// single assistant message can fold several API calls. stats.db is the
// authoritative source, so we read it directly and trust its cost_total
// instead of recomputing via LiteLLM rates (which mis-price models like
// gpt-5.6-sol by ~3.3x — see the parser.ts provider-cost allowlist).

const OMP_HOME = join(homedir(), '.omp')
const DEFAULT_GLOBAL_DB = join(OMP_HOME, 'stats.db')

// OMP keeps one global stats.db and, for named profiles, a per-profile DB under
// ~/.omp/profiles/<name>/stats.db. Read every DB that exists so multi-profile
// usage is fully captured (mirrors listOmpSessionDirs' multi-root intent, but
// for the authoritative SQLite source instead of JSONL).
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
// a stable project label that matches the legacy JSONL parser's basename(cwd):
// '-Code-Projects-ForzaBlender' -> 'ForzaBlender'.
function folderToProject(folder: string): string {
  const unsanitized = folder.replace(/-/g, '/')
  const base = basename(unsanitized)
  return base.length > 0 ? base : folder
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query(
      'SELECT model, folder, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total FROM messages LIMIT 1',
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
  cost_total: number
}

type ToolRow = {
  session_file: string
  entry_id: string
  tool_name: string
}

// Native OMP tool slugs -> codeburn's canonical display names. MCP tools
// (mcp__server_method) and anything unmapped pass through unchanged.
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

        // Preload tool_calls once, grouped by (session_file, entry_id), so each
        // message can carry its tools for the activity/tools breakdown. tool_calls
        // stores no command args, so bashCommands stays empty (names only).
        const toolsByMessage = new Map<string, string[]>()
        let toolRows: ToolRow[] = []
        try {
          toolRows = db.query<ToolRow>(
            'SELECT session_file, entry_id, tool_name FROM tool_calls',
          )
        } catch {
          // Older OMP builds may lack tool_calls; tools just come back empty.
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

        // One source covers a whole DB; each call carries its own project
        // (parser.ts groups by call.project, falling back to source.project).
        const rows = db.query<MessageRow>(
          `SELECT session_file, entry_id, folder, model, timestamp,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                  cost_total
           FROM messages
           ORDER BY timestamp ASC`,
        )

        for (const row of rows) {
          const inputTokens = row.input_tokens ?? 0
          const outputTokens = row.output_tokens ?? 0
          const cacheRead = row.cache_read_tokens ?? 0
          const cacheWrite = row.cache_write_tokens ?? 0
          // Skip genuinely empty rows (error/aborted calls with no tokens).
          if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) {
            continue
          }

          // stats.db enforces UNIQUE(session_file, entry_id), so this is stable
          // and globally unique — no reliance on the shared seenKeys set.
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
            // OMP's own cost at the rates it actually pays; preserved verbatim
            // via the parser.ts provider-cost allowlist (no LiteLLM recompute).
            costUSD: row.cost_total ?? 0,
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

// One SessionSource per existing DB (global + each named profile), so each is
// parsed and cached independently and invalidated by its own mtime.
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
  // An explicit dbPath (tests) means "only this DB"; otherwise scan the global
  // DB plus every named profile's stats.db.
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
