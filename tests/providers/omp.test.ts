import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { createOmpProvider } from '../../src/providers/omp.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'omp-stats-test-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

// Build a stats.db with the columns omp.ts queries. Mirrors OMP's real schema
// (UNIQUE(session_file, entry_id) so the dedup key is stable).
function createStatsDb(): string {
  const dbPath = join(tmpRoot, 'stats.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath) as TestDb
  db.exec(`
    CREATE TABLE messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'omp',
      api TEXT NOT NULL DEFAULT 'omp',
      timestamp INTEGER NOT NULL,
      duration INTEGER, ttft INTEGER,
      stop_reason TEXT NOT NULL DEFAULT 'stop',
      error_message TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      premium_requests REAL NOT NULL DEFAULT 0,
      cost_input REAL NOT NULL DEFAULT 0,
      cost_output REAL NOT NULL DEFAULT 0,
      cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'main',
      UNIQUE(session_file, entry_id)
    );
    CREATE TABLE tool_calls(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'omp',
      provider TEXT NOT NULL DEFAULT 'omp',
      timestamp INTEGER NOT NULL DEFAULT 0,
      agent_type TEXT NOT NULL DEFAULT 'main',
      calls_in_turn INTEGER NOT NULL DEFAULT 1,
      args_chars INTEGER NOT NULL DEFAULT 0,
      result_chars INTEGER,
      is_error INTEGER
    );
  `)
  db.close()
  return dbPath
}

function withDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath) as TestDb
  try {
    fn(db)
  } finally {
    db.close()
  }
}

function insertMessage(db: TestDb, o: {
  session_file?: string
  entry_id: string
  folder?: string
  model?: string
  timestamp?: number
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cost_total?: number
  cost_input?: number
  cost_output?: number
  cost_cache_read?: number
  cost_cache_write?: number
}): void {
  const ins = db.prepare(`INSERT INTO messages
    (session_file, entry_id, folder, model, timestamp,
     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     total_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  ins.run(
    o.session_file ?? '/tmp/sess/main.jsonl',
    o.entry_id,
    o.folder ?? '-Code-Projects-Sample',
    o.model ?? 'gpt-5.6-sol',
    o.timestamp ?? 1785005105018,
    o.input_tokens ?? 1000,
    o.output_tokens ?? 200,
    o.cache_read_tokens ?? 0,
    o.cache_write_tokens ?? 0,
    (o.input_tokens ?? 1000) + (o.output_tokens ?? 200),
    o.cost_input ?? 0,
    o.cost_output ?? 0,
    o.cost_cache_read ?? 0,
    o.cost_cache_write ?? 0,
    o.cost_total ?? 0,
  )
}

function insertToolCall(db: TestDb, o: { entry_id: string; tool_name: string; session_file?: string }): void {
  const ins = db.prepare(`INSERT INTO tool_calls
    (session_file, entry_id, tool_call_id, folder, tool_name)
    VALUES (?,?,?,?,?)`)
  ins.run(o.session_file ?? '/tmp/sess/main.jsonl', o.entry_id, `tc-${o.tool_name}`, '-Code-Projects-Sample', o.tool_name)
}

describe.skipIf(!isSqliteAvailable())('omp provider (stats.db) - identity', () => {
  it('has correct name and displayName', () => {
    const provider = createOmpProvider(join(tmpRoot, 'stats.db'))
    expect(provider.name).toBe('omp')
    expect(provider.displayName).toBe('OMP')
  })
})

describe.skipIf(!isSqliteAvailable())('omp provider (stats.db) - discovery', () => {
  it('discovers the stats.db source when it has rows', async () => {
    const dbPath = createStatsDb()
    withDb(dbPath, db => insertMessage(db, { entry_id: 'm1' }))

    const provider = createOmpProvider(dbPath)
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(1)
    expect(sources[0]!.provider).toBe('omp')
    expect(sources[0]!.path).toBe(dbPath)
  })

  it('returns empty when the db has no message rows', async () => {
    const dbPath = createStatsDb()
    const provider = createOmpProvider(dbPath)
    expect(await provider.discoverSessions()).toEqual([])
  })

  it('returns empty for a non-existent db path', async () => {
    const provider = createOmpProvider(join(tmpRoot, 'missing.db'))
    expect(await provider.discoverSessions()).toEqual([])
  })

  it('probeRoots reports the db path', async () => {
    const dbPath = createStatsDb()
    const provider = createOmpProvider(dbPath)
    const roots = await provider.probeRoots!()
    expect(roots).toEqual([{ path: dbPath, label: 'stats.db' }])
  })
})

describe.skipIf(!isSqliteAvailable())('omp provider (stats.db) - parsing', () => {
  it('extracts tokens and preserves OMP cost_total verbatim (no LiteLLM recompute)', async () => {
    const dbPath = createStatsDb()
    // cost_total 0.42 is deliberately NOT what LiteLLM would price
    // gpt-5.6-sol (1000 in / 200 out) at - proving the provider's cost wins.
    withDb(dbPath, db => insertMessage(db, {
      entry_id: 'm1', model: 'gpt-5.6-sol',
      input_tokens: 1000, output_tokens: 200,
      cache_read_tokens: 5000, cache_write_tokens: 50,
      cost_total: 0.42,
    }))

    const provider = createOmpProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for await (const c of provider.createSessionParser(source!, new Set()).parse()) calls.push(c)

    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.provider).toBe('omp')
    expect(c.model).toBe('gpt-5.6-sol')
    expect(c.inputTokens).toBe(1000)
    expect(c.outputTokens).toBe(200)
    expect(c.cacheReadInputTokens).toBe(5000)
    expect(c.cachedInputTokens).toBe(5000)
    expect(c.cacheCreationInputTokens).toBe(50)
    expect(c.costUSD).toBe(0.42) // OMP's own cost, not recalculated
  })
  it('values $0 (subscription) calls at the model rate derived from priced calls', async () => {
    const dbPath = createStatsDb()
    withDb(dbPath, db => {
      // Two priced calls reveal gpt-5.6-sol's real rate: $5/M in, $30/M out.
      // (1M in * $5 = $5 cost_input; 100K out * $30 = $3 cost_output.)
      insertMessage(db, { entry_id: 'p1', model: 'gpt-5.6-sol', input_tokens: 1_000_000, output_tokens: 100_000, cost_input: 5, cost_output: 3, cost_total: 8 })
      insertMessage(db, { entry_id: 'p2', model: 'gpt-5.6-sol', input_tokens: 1_000_000, output_tokens: 100_000, cost_input: 5, cost_output: 3, cost_total: 8 })
      // A $0 (subscription-routed) call: 2M in + 200K out should be valued at
      // the derived rate -> 2M*$5/M + 200K*$30/M = $10 + $6 = $16.
      insertMessage(db, { entry_id: 'z1', model: 'gpt-5.6-sol', input_tokens: 2_000_000, output_tokens: 200_000, cost_total: 0 })
    })

    const provider = createOmpProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for await (const c of provider.createSessionParser(source!, new Set()).parse()) calls.push(c)

    const find = (id: string) => calls.find(c => c.deduplicationKey.endsWith(':' + id))!
    expect(find('p1').costUSD).toBe(8)            // priced -> cost_total verbatim
    expect(find('z1').costUSD).toBeCloseTo(16, 6) // $0 -> derived rate applied
  })

  it('derives project from the folder column', async () => {
    const dbPath = createStatsDb()
    withDb(dbPath, db => insertMessage(db, {
      entry_id: 'm1', folder: '-Code-Projects-ForzaBlender',
    }))

    const provider = createOmpProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for await (const cc of provider.createSessionParser(source!, new Set()).parse()) calls.push(cc)

    expect(calls[0]!.project).toBe('ForzaBlender')
    expect(calls[0]!.projectPath).toBe('/Code/Projects/ForzaBlender')
  })

  it('joins tool_calls to attach tool names (mapped to display names)', async () => {
    const dbPath = createStatsDb()
    withDb(dbPath, db => {
      insertMessage(db, { entry_id: 'm1' })
      insertToolCall(db, { entry_id: 'm1', tool_name: 'read' })
      insertToolCall(db, { entry_id: 'm1', tool_name: 'bash' })
      insertToolCall(db, { entry_id: 'm1', tool_name: 'grep' })
    })

    const provider = createOmpProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for await (const c of provider.createSessionParser(source!, new Set()).parse()) calls.push(c)

    expect(calls[0]!.tools).toEqual(['Read', 'Bash', 'Grep'])
  })

  it('skips rows whose token fields are all zero', async () => {
    const dbPath = createStatsDb()
    withDb(dbPath, db => {
      insertMessage(db, { entry_id: 'm1', input_tokens: 100, output_tokens: 10, cost_total: 0.01 })
      insertMessage(db, { entry_id: 'm2', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_total: 0 })
      insertMessage(db, { entry_id: 'm3', input_tokens: 0, output_tokens: 5 }) // cache-less but has output
    })

    const provider = createOmpProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for await (const c of provider.createSessionParser(source!, new Set()).parse()) calls.push(c)

    expect(calls.map(c => c.deduplicationKey)).toEqual([
      expect.stringContaining(':m1'),
      expect.stringContaining(':m3'),
    ])
  })

  it('deduplicates by (session_file, entry_id) which the schema guarantees unique', async () => {
    const dbPath = createStatsDb()
    withDb(dbPath, db => {
      insertMessage(db, { entry_id: 'm1', input_tokens: 100, output_tokens: 10 })
    })

    const provider = createOmpProvider(dbPath)
    const [source] = await provider.discoverSessions()
    // Even with a shared seenKeys set, the UNIQUE constraint means each row
    // appears once in the table, so the parser yields it once.
    const calls: ParsedProviderCall[] = []
    for await (const c of provider.createSessionParser(source!, new Set()).parse()) calls.push(c)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.deduplicationKey).toBe(`omp:/tmp/sess/main.jsonl:m1`)
  })

  it('converts epoch-ms timestamp to ISO', async () => {
    const dbPath = createStatsDb()
    withDb(dbPath, db => insertMessage(db, { entry_id: 'm1', timestamp: 1785005105018 }))

    const provider = createOmpProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for await (const c of provider.createSessionParser(source!, new Set()).parse()) calls.push(c)
    expect(calls[0]!.timestamp).toBe(new Date(1785005105018).toISOString())
  })
})
