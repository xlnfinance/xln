/** Runs independent package gates concurrently with compact, ordered output. */

const gateNames = process.argv.slice(2);
if (gateNames.length === 0 || gateNames.some(name => !/^[a-z0-9:-]+$/.test(name))) {
  throw new Error('PARALLEL_CHECK_GATE_NAMES_INVALID');
}

// This runner is nested (`check` -> `check:src` -> heavyweight Rust/TS
// parity). Two lanes keep the aggregate fan-out bounded; four outer lanes
// multiplied into enough compilers/workers to make otherwise sub-second Bun
// worker tests miss their own five-second fail-stop deadline.
const MAX_CONCURRENT_GATES = 2;
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
  output: string;
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
      stdout: 'pipe',
      stderr: 'pipe',
    });
    active.add(child);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    active.delete(child);
    results.push({
      name,
      exitCode,
      durationMs: Math.round(performance.now() - startedAt),
      output: stdout + stderr,
    });
    if (exitCode !== 0) stopChildren();
  }
};

await Promise.all(Array.from(
  { length: Math.min(MAX_CONCURRENT_GATES, gateNames.length) },
  runLane,
));

for (const name of gateNames) {
  const result = results.find(candidate => candidate.name === name);
  if (!result) continue;
  console.log(`${result.exitCode === 0 ? 'PASS' : 'FAIL'} ${name} ${result.durationMs}ms`);
  if (result.exitCode !== 0 && result.output.trim()) console.error(result.output.trim());
}

const failed = results.find(result => result.exitCode !== 0);
if (failed) process.exit(failed.exitCode || 1);
if (results.length !== gateNames.length) process.exit(1);
console.log(`PARALLEL_CHECKS_OK gates=${results.length}`);
