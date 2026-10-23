/** Runs independent package gates concurrently and reports each result immediately. */

const gateNames = process.argv.slice(2);
if (gateNames.length === 0 || gateNames.some(name => !/^[a-z0-9:-]+$/.test(name))) {
  throw new Error('PARALLEL_CHECK_GATE_NAMES_INVALID');
}

// The measured broad source inventory exceeds the aggregate verification
// budget in three lanes. Four bounded lanes keep its long tail independent
// of the full lint; smaller nested groups retain two lanes.
const MAX_CONCURRENT_GATES = gateNames.length > 10 ? 4 : 2;
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

const runLane = async (): Promise<void> => {
  while (!stopped && nextIndex < gateNames.length) {
    const name = gateNames[nextIndex++];
    if (!name) break;
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
  }
};

await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_GATES, gateNames.length) }, runLane));

const failed = results.find(result => result.exitCode !== 0);
if (failed) process.exit(failed.exitCode || 1);
if (results.length !== gateNames.length) process.exit(1);
console.log(`PARALLEL_CHECKS_OK gates=${results.length}`);
