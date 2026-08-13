#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';

type Gate = { name: string; command: string[] };

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
  { name: 'eslint-ratchet', command: ['bun', 'runtime/scripts/checks/architecture/check-eslint-ratchet.ts'] },
  { name: 'unsafe-types', command: ['bun', 'runtime/scripts/checks/architecture/check-unsafe-types.ts'] },
  { name: 'determinism', command: ['bun', 'runtime/scripts/checks/architecture/check-determinism.ts', '--static-only'] },
  { name: 'no-weak-collections', command: ['bun', 'runtime/scripts/checks/policy/check-no-weak-collections.ts'] },
  { name: 'runtime-dependencies', command: ['bun', 'runtime/scripts/checks/architecture/check-runtime-dependencies.ts'] },
  { name: 'fints-negative-types', command: ['bun', 'run', 'check:fints-negative-types'] },
  { name: 'nested-hash-coverage', command: ['bun', 'run', 'check:nested-hash-coverage'] },
];

const results = gates.map(gate => {
  const startedAt = performance.now();
  const child = spawnSync(gate.command[0]!, gate.command.slice(1), {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return {
    name: gate.name,
    ok: child.status === 0,
    durationMs: Math.round(performance.now() - startedAt),
    output: `${child.stdout ?? ''}${child.stderr ?? ''}`.trim(),
  };
});

const ok = results.every(result => result.ok);
if (json) {
  console.log(JSON.stringify({ schema: 'xln-soundcheck-v2', ok, results }, null, 2));
} else {
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name} ${result.durationMs}ms`);
    if (!result.ok && result.output) console.error(result.output);
  }
  console.log(`SOUNDCHECK_${ok ? 'OK' : 'FAILED'} gates=${results.length}`);
}

process.exit(ok ? 0 : 1);
