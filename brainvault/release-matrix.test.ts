import { expect, test } from 'bun:test';

const workers = Number(process.env.BRAINVAULT_MATRIX_WORKERS ?? '1');
const multiplier = Number(process.env.BRAINVAULT_MATRIX_MULTIPLIER ?? '1');
const engine = process.env.BRAINVAULT_MATRIX_ENGINE;
const matrix = await Bun.file(`${import.meta.dir}/matrix-v1.json`).json() as {
  format: string;
  roots: Record<string, string>;
};

test(`release matrix: workers=${workers}, multiplier=${multiplier}`, () => {
  expect([1, 2, 8, 32]).toContain(workers);
  expect([1, 2, 10]).toContain(multiplier);
  const run = Bun.spawnSync({
    cmd: [
      'bun', 'cli.ts', '--bench', '--shards', String(workers),
      '--workers', String(workers), '--multiplier', String(multiplier),
      ...(engine === undefined ? [] : ['--engine', engine]),
    ],
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const output = run.stdout.toString();
  expect(run.exitCode).toBe(0);
  expect(output).not.toContain('FAILED');
  expect(matrix.format).toBe('brainvault-release-matrix-v1/1');
  expect(output).toMatch(engine === undefined
    ? /Running (?:[2-9]|[1-9][0-9]+) engines sequentially/
    : /Running 1 engines sequentially/);
  expect(output).toContain(`${engine === undefined ? 'Root parity' : 'Frozen root check'}: PASS (${matrix.roots[`w${workers}-m${multiplier}`]})`);
}, 28_000);
