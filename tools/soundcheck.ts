#!/usr/bin/env bun

type Gate = { name: string; command: string[] };

const MAX_CONCURRENT_GATES = 4;

const json = process.argv.includes('--json');
const unknownArgs = process.argv.slice(2).filter(argument => argument !== '--json');
if (unknownArgs.length > 0) {
  console.error(`Usage: bun tools/soundcheck.ts [--json]\nUnknown arguments: ${unknownArgs.join(' ')}`);
  process.exit(1);
}

// Soundcheck is intentionally a fast aggregator of zero-debt static gates.
// TypeScript compilation, tests, formatting and broader source checks have
// dedicated owners; running them again here made release feedback slower and
// produced conflicting verdicts from non-canonical regex scans.
const gates: Gate[] = [
  { name: 'eslint-ratchet', command: ['bun', 'core/scripts/checks/architecture/check-eslint-ratchet.ts'] },
  { name: 'unsafe-types', command: ['bun', 'core/scripts/checks/architecture/check-unsafe-types.ts'] },
  { name: 'frontend-unsafe-types', command: ['bun', 'frontend/scripts/check-unsafe-types.ts'] },
  { name: 'determinism', command: ['bun', 'core/scripts/checks/architecture/check-determinism.ts', '--static-only'] },
  { name: 'no-weak-collections', command: ['bun', 'core/scripts/checks/policy/check-no-weak-collections.ts'] },
  { name: 'runtime-dependencies', command: ['bun', 'core/scripts/checks/architecture/check-runtime-dependencies.ts'] },
  { name: 'fints-negative-types', command: ['bun', 'run', 'check:fints-negative-types'] },
  { name: 'fints-compiler-policy', command: ['bun', 'run', 'check:fints-compiler-policy'] },
  { name: 'fints-decoder-authority', command: ['bun', 'run', 'check:fints-decoder-authority'] },
  { name: 'nested-hash-coverage', command: ['bun', 'run', 'check:nested-hash-coverage'] },
];

type Result = Readonly<{
  name: string;
  ok: boolean;
  durationMs: number;
  output: string;
}>;

const active = new Set<ReturnType<typeof Bun.spawn>>();
const results: Result[] = [];
let nextIndex = 0;
let stopped = false;

const stopChildren = (): void => {
  stopped = true;
  for (const child of active) child.kill('SIGTERM');
};

process.on('SIGINT', stopChildren);
process.on('SIGTERM', stopChildren);

const runLane = async (): Promise<void> => {
  while (!stopped && nextIndex < gates.length) {
    const gate = gates[nextIndex++];
    if (!gate) break;
    const startedAt = performance.now();
    const child = Bun.spawn(gate.command, {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    active.add(child);
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    active.delete(child);
    results.push({
      name: gate.name,
      ok: status === 0,
      durationMs: Math.round(performance.now() - startedAt),
      output: `${stdout}${stderr}`.trim(),
    });
    if (status !== 0) stopChildren();
  }
};

// Every member is read-only and independent. Four lanes keep the host below
// the saturation point where Bun Worker tests can miss their own deadlines.
await Promise.all(Array.from(
  { length: Math.min(MAX_CONCURRENT_GATES, gates.length) },
  runLane,
));

const orderedResults = gates.flatMap(gate => {
  const result = results.find(candidate => candidate.name === gate.name);
  return result ? [result] : [];
});
const ok = orderedResults.length === gates.length && orderedResults.every(result => result.ok);
if (json) {
  console.log(JSON.stringify({ schema: 'xln-soundcheck-v2', ok, results: orderedResults }, null, 2));
} else {
  for (const result of orderedResults) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name} ${result.durationMs}ms`);
    if (!result.ok && result.output) console.error(result.output);
  }
  console.log(`SOUNDCHECK_${ok ? 'OK' : 'FAILED'} gates=${orderedResults.length}`);
}

process.exit(ok ? 0 : 1);
