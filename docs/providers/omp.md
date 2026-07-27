# OMP

OMP (Oh My Pi). Reads OMP's own usage database, not the session transcripts.

- **Source:** `src/providers/omp.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/omp.test.ts`

## Where it reads from

- `~/.omp/stats.db` (the global DB)
- `~/.omp/profiles/<profile>/stats.db` (one per named profile, if present)

OMP writes one row per API call into `stats.db` — main turns **and** subagent
dispatches, including streaming continuations — with per-call token counts and
its own pre-computed `cost_total` at the rates it actually pays. This is the
authoritative source; the JSONL transcripts under `~/.omp/agent/sessions/` are
an incomplete subset (subagent transcripts nest several levels deep, and a
single assistant message can fold several API calls), so we read the DB
directly and ignore the transcripts for cost/usage.

## Storage format

SQLite. Tables used:

- `messages` — one row per call: `model`, `folder`, `timestamp` (epoch ms),
  `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
  `cost_total`, plus the per-field `cost_input`/`cost_output`/`cost_cache_read`/`cost_cache_write`. `UNIQUE(session_file, entry_id)`.
- `tool_calls` — tool invocations, joined to `messages` on
  `(session_file, entry_id)` for the tools/activity breakdown.

## Pricing

OMP's `cost_total` is preserved verbatim where OMP priced a call. For the many
calls OMP logs as $0 — typically subscription/included routing (e.g.
`openai-codex`) — the provider values them at the **model's own rate derived
from its priced rows** (e.g. `gpt-5.6-sol` → $5/$30/$0.50 per M), so the
reported total is gross pay-as-you-go API cost rather than the $0 marginal cost
OMP recorded. Models OMP never priced fall back to codeburn's LiteLLM/fallback
rates. This makes a subscription's value visible: compare the reported total
against the flat subscription fee. The computed cost is kept through the
pipeline by the `omp` entry in `src/parser.ts`'s provider-cost allowlist.

## Caching

Standard session cache, keyed by DB path; invalidated by `stats.db` mtime.

## Deduplication

`omp:<session_file>:<entry_id>` — stable and globally unique because the
schema enforces `UNIQUE(session_file, entry_id)`.

## Quirks

- **No bash commands or user message.** `tool_calls` stores tool names but not
  command args, so `bashCommands` is empty. `userMessage` is empty, so turn
  category classification falls back to tool-based signals (still works, just
  without user-keyword hints).
- **Project from `folder`.** OMP sanitizes cwd with `-` for `/`; the provider
  reverses that to derive the project label (`-Code-Projects-X` -> `X`).
- **All-zero rows skipped.** Rows where every token field is 0 (error/aborted
  calls) are dropped so they don't inflate the call count.
- Pi remains a separate JSONL provider (`src/providers/pi.ts`); OMP no longer
  shares its parser.

## When fixing a bug here

1. Compare codeburn's per-model totals against `stats.db` directly:
   `SELECT model, count(*), sum(cost_total), sum(input_tokens) FROM messages GROUP BY model`.
   If they match, the bug is downstream of the provider; if not, it's here.
2. A schema change in a future OMP build shows up as `discoverSessions`
   returning empty (validateSchema fails) — `codeburn doctor --provider omp`
   reports the probed DB path.
