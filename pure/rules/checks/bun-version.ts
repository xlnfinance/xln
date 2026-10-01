// check:bun-version, ours: the gate refuses to run on a Bun older than the one pure/package.json asks for (engines.bun,
// ">=x.y.z"). Bun 1.3.11 segfaults when a Worker is terminated (og's Account workers, one pool per world), at a random
// point of a long run: about 600 s into SEEDX=0 of the full suite with no failing test. 1.3.14 and the 1.4 line do not.
// The check turns that into a red gate at the start. See review/seed0-crash/NOTES.md.   bun rules/check.ts --bun-only
import type { Result } from "../register.ts";

export type Version = readonly [major: number, minor: number, patch: number];

export type BunPin = Readonly<{ _tag: "BunPinBad"; detail: string }>;

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

const versionOf = (text: string): Version | undefined => {
  const parts = VERSION.exec(text);
  return parts === null ? undefined : [Number(parts[1]), Number(parts[2]), Number(parts[3])];
};

// Whole-number order, major then minor then patch: 1.10.0 is newer than 1.4.2.
export const atLeast = (have: Version, need: Version): boolean =>
  have[0] !== need[0] ? have[0] > need[0] : have[1] !== need[1] ? have[1] > need[1] : have[2] >= need[2];

const bad = (detail: string): Result<never, BunPin> => ({ ok: false, error: { _tag: "BunPinBad", detail } });

// package.json is read with a pattern, not parsed: no try/catch boundary, and the one key it needs is a flat string.
const ENGINES_BUN = /"engines"\s*:\s*\{[^}]*"bun"\s*:\s*"([^"]*)"/;

// The minimum Bun that package.json asks for: engines.bun as ">=x.y.z". Anything else is a gate failure, so the pin cannot rot.
export const requiredBun = (packageJson: string): Result<string, BunPin> => {
  const asked = ENGINES_BUN.exec(packageJson)?.[1];
  const need = asked?.startsWith(">=") === true ? asked.slice(2) : "";
  return versionOf(need) === undefined ? bad(`package.json engines.bun must read ">=x.y.z", got ${JSON.stringify(asked)}`) : { ok: true, value: need };
};

// The one command that gets a passing Bun into ~/.bun/bin, where a default container finds it first on PATH.
export const installLine = (version: string): string => `curl -fsSL https://bun.sh/install | bash -s "bun-v${version}"`;

export type BunReport = Readonly<{ failed: boolean; line: string }>;

export const bunReport = (have: string, packageJson: string): BunReport => {
  const need = requiredBun(packageJson);
  if (!need.ok) return { failed: true, line: `FAIL ${need.error.detail}` };
  const haveVersion = versionOf(have);
  const ok = haveVersion !== undefined && atLeast(haveVersion, versionOf(need.value)!);
  return ok
    ? { failed: false, line: `ok   bun ${have} satisfies >=${need.value}` }
    : { failed: true, line: `FAIL bun ${have} is older than the required >=${need.value} (older Bun segfaults on Worker termination mid-run). Install it:  ${installLine(need.value)}   then \`which bun\` must print ~/.bun/bin/bun` };
};
