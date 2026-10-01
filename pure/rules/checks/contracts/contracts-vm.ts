// The BrowserVM and deploy-gate tests of contracts/ run inside the one gate, the same way CI runs them. A contract test in
// contracts/test/vm/<area>/ or contracts/test/gate/ is a gate test (rules/scan.ts isGateTest); placement (rules/checks/
// contract-tests.ts) only proves it sits in such a folder, so a red one passed `bun rules/check.ts` and `bun test` and went
// red on GitHub alone. This part runs them: one file per process (several BrowserVM stacks in one process exhaust memory),
// after a rebuild that must leave the committed typechain-types as they were. The files run in WORKERS lanes at once (a file is
// its own process, so the lanes share nothing); the report names the same failures whatever the number of lanes.
//   bun rules/check.ts --contracts-only
import { readFileSync } from "node:fs";
import { existingFiles } from "../folder-width.ts";
import { isGateTest } from "../../scan.ts";

const TEST_ROOT = "contracts/test/";
const TYPECHAIN = "contracts/typechain-types/";
const BUILD = ["bash", "contracts/scripts/build.sh"] as const;

export type Run = Readonly<{ exitCode: number | null; output: string }>;
export type Runner = (repo: string, command: readonly string[]) => Promise<Run>;

// One test process per lane step. A BrowserVM stack is about a gigabyte, so this is a small number; GATE_CONTRACT_LANES overrides it.
const DEFAULT_LANES = 3;
export const lanesFrom = (text: string | undefined): number => {
  const asked = Number(text);
  return Number.isInteger(asked) && asked >= 1 ? asked : DEFAULT_LANES;
};

// The files CI's loop takes: contracts/test/vm/*/*.test.ts and contracts/test/gate/*.test.ts, sorted as a shell glob sorts.
export const vmTestFiles = (repo: string): readonly string[] =>
  existingFiles(repo)
    .filter((file) => file.startsWith(TEST_ROOT) && file.endsWith(".test.ts") && isGateTest(file.slice(TEST_ROOT.length)))
    .sort();

const tail = (output: string): readonly string[] => output.trimEnd().split("\n").slice(-12).map((line) => `  | ${line}`);

// The typechain-types of the checkout as one digest: what each file is called and holds.
export const typechainDigest = (repo: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): string => {
  const hash = new Bun.CryptoHasher("sha256");
  existingFiles(repo)
    .filter((file) => file.startsWith(TYPECHAIN))
    .sort()
    .forEach((file) => hash.update(`${file}\0${read(`${repo}/${file}`)}\0`));
  return hash.digest("hex");
};

const run: Runner = async (repo, command) => {
  const child = Bun.spawn([...command], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: out + err };
};

// File k goes to lane k mod n; a lane runs its files one after the other, so at most n files run at a time.
export const inLanes = <T>(items: readonly T[], lanes: number): readonly (readonly T[])[] =>
  Array.from({ length: Math.min(lanes, items.length) }, (_, lane) => items.filter((_item, index) => index % lanes === lane));

export type ContractsReport = Readonly<{ failed: boolean; lines: readonly string[] }>;

// Rebuild, then judge the typechain-types against what the checkout held before; then each test file in its own process.
export const contractsReport = async (
  repo: string,
  runner: Runner = run,
  digest: (repo: string) => string = typechainDigest,
  lanes: number = lanesFrom(process.env["GATE_CONTRACT_LANES"]),
): Promise<ContractsReport> => {
  const files = vmTestFiles(repo);
  if (files.length === 0) return { failed: true, lines: ["CONTRACTS_NO_TESTS git lists no test file under contracts/test/vm/<area>/ or contracts/test/gate/", "CONTRACTS_INVARIANT_FAILED"] };
  const before = digest(repo);
  const built = await runner(repo, BUILD);
  const build =
    built.exitCode !== 0 ? [`CONTRACTS_BUILD_FAILED ${BUILD.join(" ")} exited ${built.exitCode}`, ...tail(built.output)]
    : digest(repo) !== before ? [`TYPECHAIN_STALE ${TYPECHAIN} differs after ${BUILD.join(" ")}: commit the rebuilt files`]
    : [];
  const runFile = async (file: string): Promise<readonly string[]> => {
    const done = await runner(repo, [process.execPath, "test", file]);
    return done.exitCode === 0 ? [] : [`CONTRACTS_TEST_FAILED ${file} exited ${done.exitCode}`, ...tail(done.output)];
  };
  const runLane = (lane: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> =>
    lane.reduce<Promise<ReadonlyMap<string, readonly string[]>>>(
      async (before, file) => new Map([...(await before), [file, await runFile(file)]]),
      Promise.resolve(new Map()),
    );
  const results = new Map((await Promise.all(inLanes(files, lanes).map(runLane))).flatMap((lane) => [...lane]));
  // Failures are reported in the order of the file list, not in the order the lanes finished.
  const failures = files.flatMap((file) => results.get(file) ?? []);
  const problems = [...build, ...failures];
  return {
    failed: problems.length > 0,
    lines: problems.length === 0 ? [`ok   contracts: typechain current, ${files.length} BrowserVM and gate test files, one per process`] : [...problems, "CONTRACTS_INVARIANT_FAILED"],
  };
};

if (import.meta.main) {
  const report = await contractsReport(`${import.meta.dir}/../../../..`);
  report.lines.forEach((line) => console.log(line));
  process.exit(report.failed ? 1 : 0);
}
