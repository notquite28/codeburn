# OMP

OMP CLI. Same parser as Pi, different data directory.

- **Source:** `src/providers/pi.ts` (the `omp` export)
- **Loading:** eager (`src/providers/index.ts:9`)
- **Test:** `tests/providers/omp.test.ts` (253 lines)

## Where it reads from

`~/.omp/agent/sessions/` (`pi.ts:89-91`).

## Storage format

JSONL, identical schema to Pi.

## Caching

None.

## Deduplication

Identical to Pi: `<provider>:<path>:<responseId>` with timestamp / line-index fallbacks (`pi.ts:210`).

## Quirks

- OMP and Pi share the **same** `createParser` function. The provider object differs only in name, displayName, and the discovery directory.
- If OMP and Pi diverge in a future release, do **not** copy-paste the parser. Add a discriminator to `createParser` and branch.
- Real OMP files lead with a `{type:"title"}` entry and place the `{type:"session"}` header one or more lines down (32 of 34 files on a real machine). Discovery scans a bounded line prefix for the `session` entry rather than requiring it on line 0 (`readSessionEntry`, `pi.ts:101`). Pi shares this path, so the same guard covers both.

## When fixing a bug here

1. Check if the bug also reproduces against Pi. If yes, fix both with one change; the parser is shared.
2. If the bug is OMP-specific, the right fix is usually to pass an option into `createParser` rather than to fork the file.
3. Read [`pi.md`](pi.md) for the parser-level details.
