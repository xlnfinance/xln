import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { safeStringify } from '../../../../protocol/serialization';

test('economic gate publishes a complete unchanged PID at first visibility', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-hlt-publication-'));
  const writer = resolve(import.meta.dir, '../../../../scripts/operations/hlt/workload/worker-payments.ts');
  const gates = 32;
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      [
        `import { waitForHltEconomicStartGate } from ${safeStringify(writer)};`,
        `for (let index = 0; index < ${gates}; index++) {`,
        `process.env.XLN_HLT_ECONOMIC_GATE_DIR = ${safeStringify(directory)} + '/' + index;`,
        'await waitForHltEconomicStartGate();',
        '}',
      ].join('\n'),
    ],
    { stdout: 'ignore', stderr: 'inherit' },
  );
  const expected = `${child.pid}\n`;
  const deadline = Date.now() + 4500;
  const observe = (path: string): void => {
    let firstVisible;
    while (!(firstVisible = statSync(path, { throwIfNoEntry: false }))) {
      if (Date.now() >= deadline) throw new Error(`HLT_GATE_PUBLICATION_TIMEOUT:${path}`);
    }
    // A separate process can observe open-before-write even with writeFileSync.
    // Check the first visible inode; never retry an empty marker until it passes.
    expect(firstVisible.size).toBe(Buffer.byteLength(expected));
    expect(readFileSync(path, 'utf8')).toBe(expected);
  };
  try {
    for (let index = 0; index < gates; index++) {
      const gate = join(directory, String(index));
      observe(join(gate, 'ready'));
      const start = join(gate, 'start');
      const temporary = `${start}.tmp-${process.pid}`;
      writeFileSync(temporary, 'start\n', { mode: 0o600 });
      renameSync(temporary, start);
      observe(join(gate, 'started'));
    }
    expect(await child.exited).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
