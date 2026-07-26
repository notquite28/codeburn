import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // The nix flake devShell mirrors inputs under .direnv/flake-inputs/,
      // which vitest would otherwise discover and double-run.
      '**/.direnv/**',
    ],
    // Runs once per worker before any test. Scrubs the developer's shell so
    // session-discovery env vars (CLAUDE_CONFIG_DIRS, HOME, XDG_*, every
    // provider-specific *_HOME) don't bleed real local data into fixtures.
    setupFiles: ['./tests/setup/env-isolation.ts'],
  },
})
