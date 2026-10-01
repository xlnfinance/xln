/** Runs independent package gates concurrently and reports each result immediately. */

const gateNames = process.argv.slice(2);
if (gateNames.length === 0 || gateNames.some(name => !/^[a-z0-9:-]+$/.test(name))) {
  throw new Error('PARALLEL_CHECK_GATE_NAMES_INVALID');
}

// The broad source inventory needs a third lane so its one-time 18s compiler
// gates do not serialize past the repository's 30s hard budget. Smaller nested
// groups stay at two lanes, keeping compiler/test fan-out bounded.
const MAX_CONCURRENT_GATES = gateNames.length > 10 ? 3 : 2;
// A test with a fixed time limit inside frozen core cannot be given more time.
// canonical-payment-surface reads every tracked file within 15s and took 16s
// beside the Rust compile in Runtime Checks (run 36901597856). Quiet gates run
// first and alone, before the lanes start.
const QUIET_GATES: ReadonlySet<string> = new Set(['check:canonical-payment-surface']);
const active = new Set<ReturnType<typeof Bun.spawn>>();
let stopped = false;

const stopChildren = (): void => {
  stopped = true;
  for (const child of active) child.kill('SIGTERM');
};

process.on('SIGINT', stopChildren);
process.on('SIGTERM', stopChildren);

type Result = Readonly<{
  name: string;
  exitCode: number;
  durationMs: number;
}>;

const results: Result[] = [];
let nextIndex = 0;

const runGate = async (name: string): Promise<void> => {
  const startedAt = performance.now();
  const child = Bun.spawn(['bun', 'run', name], {
    cwd: process.cwd(),
    // Nested gates must expose the first failure even while another lane
    // is still running. Inherited streams also cannot hold result delivery
    // hostage to an unrelated descendant keeping a captured pipe open.
    stdout: 'inherit',
    stderr: 'inherit',
  });
  active.add(child);
  const exitCode = await child.exited;
  active.delete(child);
  const result: Result = {
    name,
    exitCode,
    durationMs: Math.round(performance.now() - startedAt),
  };
  results.push(result);
  console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'} ${name} ${result.durationMs}ms`);
  if (exitCode !== 0) stopChildren();
};

const quietNames = gateNames.filter(name => QUIET_GATES.has(name));
const laneNames = gateNames.filter(name => !QUIET_GATES.has(name));

const runLane = async (): Promise<void> => {
  while (!stopped && nextIndex < laneNames.length) {
    const name = laneNames[nextIndex++];
    if (!name) break;
    await runGate(name);
  }
};

for (const name of quietNames) {
  if (!stopped) await runGate(name);
}

await Promise.all(Array.from(
  { length: Math.min(MAX_CONCURRENT_GATES, laneNames.length) },
  runLane,
));

const failed = results.find(result => result.exitCode !== 0);
if (failed) process.exit(failed.exitCode || 1);
if (results.length !== gateNames.length) process.exit(1);
console.log(`PARALLEL_CHECKS_OK gates=${results.length}`);
