// check:test-timeouts, ours: a test that is heavy names its own timeout. Bun gives every test 5 s unless it is told
// otherwise, and a test that runs a gate, a subprocess or og's world takes longer than that on a loaded machine. Run
// with a --timeout flag the suite hides this until someone forgets the flag; a gate that goes red on machine load is a
// gate people learn to ignore. So the suite runs with no flag, and a heavy test carries its timeout as the third
// argument: test("...", async () => {...}, 120_000).
//
// Heavy is read from the test's own code, never from its time: it starts a bun, forge, ast-grep, quint or uvx process
// (every test that runs the gate on a tree does), opens og's world or lane (openWorld, createLane, bootChain, walk), calls
// an explorer (a function named explore...), in the object form of a spawn or as a command line too, or lists or copies a
// whole tree of files (existingFiles, cpSync, copyFileSync, a recursive readdirSync: a scratch copy of pure/ is about 3,800
// files and needs seconds on a loaded machine though it starts no process). A test, or a
// beforeAll, beforeEach, afterAll or afterEach hook (hooks have the same 5 s default), that does this directly or through
// a helper of its own file is heavy. What this cannot see: a heavy call that comes through a helper of another file or
// one passed by name, a command held in a variable, test.each and other test forms, and a slow test that makes none of
// these calls (so the tests that took over 1 s when measured carry a timeout as well, see rules/README.md).
//   bun rules/check.ts --timeouts-only
import { TYPESCRIPT_LANGUAGE, closeOf, depthsBefore } from "../../names/source.ts";
import { existingFiles } from "../folder-width.ts";

export type Offender = Readonly<{ line: number; title: string; why: string }>;

const SUBPROCESS = /\b(?:Bun\.spawn(?:Sync)?|spawnSync|execFileSync|execSync|execFile|exec)\s*\(\s*(?:\{[^}]*?\bcmd:\s*)?\[?\s*(?:process\.execPath|"(?:bun|forge|ast-grep|quint|uvx)\b)/;
const COMMAND_WORD = /^["'](?:bun|forge|ast-grep|quint|uvx)(?:["']$|\s)/;
const WORLD = /(?<![.\w$])(?:openWorld|createLane|bootChain|walk|explore\w*)\s*\(/;
const TREE = /(?<![.\w$])existingFiles\s*\(|\b(?:cpSync|copyFileSync)\s*\(|\breaddirSync\s*\([^)]*\brecursive\s*:\s*true/;
const CALL = /(?<![.\w$])(?:(?:test|it)(?:\.only)?|(beforeAll|beforeEach|afterAll|afterEach))\s*\(/g;
const STATEMENT_NAME = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([\w$]+)/;

const spaced = (text: string): string => text.replace(/[^\n]/g, " ");

// The same text, same length, with comments blanked and strings and regex literals blanked too (only their quotes stay),
// so a call, a bracket or a comma that sits in a string is not read as code. `keepCommands` leaves the strings that are
// exactly a command word ("bun", "forge", ...), which is how a spawn names what it starts. Offsets are the source's.
const blanked = (source: string, keepCommands: boolean): string =>
  source.replace(TYPESCRIPT_LANGUAGE, (token) => {
    if (/^\/[/*]/.test(token)) return spaced(token);
    if (!/^["'`]/.test(token)) return spaced(token);
    return keepCommands && COMMAND_WORD.test(token) ? token : `${token[0]}${spaced(token.slice(1, -1))}${token.slice(-1)}`;
  });

type Statement = Readonly<{ name: string | undefined; from: number; to: number }>;

// The file's top-level statements: a statement starts at a column-0 line where no bracket is open.
const statements = (text: string, depths: Int32Array): readonly Statement[] => {
  const starts = [...text.matchAll(/^\S/gm)].map((found) => found.index).filter((at) => depths[at] === 0);
  return starts.map((from, index) => {
    const to = starts[index + 1] ?? text.length;
    return { name: STATEMENT_NAME.exec(text.slice(from, to))?.[1], from, to };
  });
};

const isHeavyCode = (code: string): string | undefined =>
  SUBPROCESS.test(code) ? "starts a bun, forge, ast-grep, quint or uvx process"
  : WORLD.test(code) ? "opens og's world or lane, or runs an explorer"
  : TREE.test(code) ? "lists or copies a whole tree of files"
  : undefined;

const callsAny = (code: string, names: readonly string[]): string | undefined =>
  names.find((name) => new RegExp(`(?<![.\\w$])${name.replace(/\$/g, "\\$")}\\s*\\(`).test(code));

// Helpers of this file that are heavy, to two levels (a helper that calls a helper that starts a process).
const heavyHelpers = (text: string, found: readonly Statement[]): ReadonlyMap<string, string> => {
  const named = found.flatMap((statement) => (statement.name === undefined ? [] : [{ name: statement.name, code: text.slice(statement.from, statement.to) }]));
  const direct = named.flatMap((helper) => {
    const why = isHeavyCode(helper.code);
    return why === undefined ? [] : [[helper.name, why] as const];
  });
  const viaDirect = named.flatMap((helper) => {
    const through = callsAny(helper.code.replace(STATEMENT_NAME, ""), direct.map(([name]) => name));
    return through === undefined || direct.some(([name]) => name === helper.name) ? [] : [[helper.name, `calls ${through}`] as const];
  });
  return new Map([...direct, ...viaDirect]);
};

const lineOf = (source: string, at: number): number => source.slice(0, at).split("\n").length;

export type TestCall = Readonly<{ line: number; title: string; why: string | undefined; timeout: boolean; end: number }>;

// Every test( and it( call of a file, and every beforeAll, beforeEach, afterAll and afterEach hook (a hook has the same
// 5 s default): its first line, its title as written (a hook's is its name), why it is heavy (if it is), whether it
// names a timeout, and where its callback ends. A test's timeout is its third argument (a number, a constant, or
// { timeout }) after the title and the callback; a hook's is its second after the callback.
export const testCalls = (source: string): readonly TestCall[] => {
  const text = blanked(source, true);
  const skeleton = blanked(source, false);
  const depths = depthsBefore(skeleton);
  const helpers = heavyHelpers(text, statements(text, depths));
  return [...skeleton.matchAll(CALL)].map((found) => {
    const hook = found[1];
    const open = found.index + found[0].length - 1;
    const close = closeOf(depths, open);
    const commas = [...skeleton.slice(open + 1, close).matchAll(/,/g)].map((comma) => open + 1 + comma.index).filter((at) => depths[at] === depths[open]! + 1);
    const bounds = [open, ...commas, close];
    const parts = bounds.slice(0, -1).map((from, index) => ({ from: from + 1, to: bounds[index + 1]! })).filter((part) => text.slice(part.from, part.to).trim() !== "");
    const body = text.slice(open + 1, close);
    const through = callsAny(body, [...helpers.keys()]);
    const callback = hook === undefined ? 1 : 0;
    return {
      line: lineOf(source, found.index),
      title: hook ?? source.slice(parts[0]?.from ?? open, parts[0]?.to ?? open).trim(),
      why: isHeavyCode(body) ?? (through === undefined ? undefined : `calls ${through}, which ${helpers.get(through)}`),
      timeout: parts.length > callback + 1,
      end: parts[callback]?.to ?? close,
    };
  });
};

// The tests of a file that are heavy and give no timeout.
export const heavyWithoutTimeout = (source: string): readonly Offender[] =>
  testCalls(source).flatMap((call) => (call.why === undefined || call.timeout ? [] : [{ line: call.line, title: call.title.slice(0, 70), why: call.why }]));

export type TimeoutsReport = Readonly<{ failed: boolean; lines: readonly string[] }>;

const TEST_FILE = /\.test\.(?:ts|tsx|mts)$/;

// Every test file git lists under pure/ (tracked plus untracked, never ignored). No file at all is a failure: a git
// that did not answer must not read as a pass.
export const timeoutsReport = (pureRoot: string, read: (path: string) => string): TimeoutsReport => {
  const files = existingFiles(pureRoot).filter((file) => TEST_FILE.test(file));
  const problems = files.flatMap((file) => heavyWithoutTimeout(read(`${pureRoot}/${file}`)).map((offender) => `TEST_TIMEOUT_MISSING pure/${file}:${offender.line} ${offender.title} ${offender.why}: give it a timeout (the third argument of a test, the second of a hook)`));
  if (files.length === 0) return { failed: true, lines: [`FAIL test-timeouts: git lists no test file under ${pureRoot}`] };
  return problems.length === 0
    ? { failed: false, lines: [`ok   test timeouts: every heavy test names its own (${files.length} test files)`] }
    : { failed: true, lines: [...problems, `FAIL test-timeouts: ${problems.length} heavy test(s) without a timeout`] };
};
