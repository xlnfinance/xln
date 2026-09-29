// Shared test helper — NOT a *.test.ts file (vitest.config.ts whitelists only
// `*.test.{ts,tsx}`, so this never runs as its own suite). Exact SGR/truecolor escape
// codes are brittle to assert on directly (any tuning of the OKLCH→RGB projection in
// tints.ts would break byte-exact snapshots for no behavioral reason) — tests compare
// the STRIPPED text instead, and separately assert that color codes are present when a
// color mode is active (tints.test.ts).
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape codes ARE control chars
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}
