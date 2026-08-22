import { expect, test } from 'bun:test';
import { safeParse, safeStringify } from '../../../../protocol/serialization';

test('operation counters attribute one call to process, frame, and runtime scopes', () => {
  const moduleUrl = new URL('../../../../support/performance/op-counters.ts', import.meta.url).href;
  const serializationUrl = new URL('../../../../protocol/serialization/index.ts', import.meta.url).href;
  const script = `
    const counters = await import(${safeStringify(moduleUrl)});
    const serialization = await import(${safeStringify(serializationUrl)});
    counters.runWithOpScopes(['frame', 'runtime:r1'], () =>
      counters.runWithOpScopes(['frame', 'phase:apply'], () =>
        counters.countOp('test.boundary', 7, 11)));
    process.stdout.write(serialization.safeStringify({
      all: counters.snapshotOpCounters(),
      frame: counters.snapshotOpCounters('frame'),
      runtime: counters.snapshotOpCounters('runtime:r1'),
      phase: counters.snapshotOpCounters('phase:apply'),
    }));
  `;
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--eval', script],
    env: { ...process.env, XLN_RUNTIME_OP_COUNTERS: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = safeParse(child.stdout.toString()) as Record<
    string,
    Record<string, { calls: number; bytes: number; durationUs: number }>
  >;
  const expected = { calls: 1, bytes: 7, durationUs: 11 };
  expect(result['all']?.['test.boundary']).toEqual(expected);
  expect(result['frame']?.['test.boundary']).toEqual(expected);
  expect(result['runtime']?.['test.boundary']).toEqual(expected);
  expect(result['phase']?.['test.boundary']).toEqual(expected);
});
