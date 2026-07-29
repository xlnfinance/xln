import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHash } from '../infra/platform-crypto';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('createHash uses the exact SHA-256 bytes for incremental input', () => {
  expect(createHash('sha256').update('a').update('bc').digest('hex')).toBe(ABC_SHA256);
  expect(createHash('sha256').update('abc').digest()).toHaveLength(32);
  expect(() => createHash('sha1')).toThrow('HASH_ALGORITHM_UNSUPPORTED:sha1');
});

test('browser bundle produces a full cryptographic SHA-256 digest', async () => {
  const build = await Bun.build({
    entrypoints: [new URL('../infra/platform-crypto.ts', import.meta.url).pathname],
    target: 'browser',
    format: 'esm',
    minify: true,
    write: false,
  });
  expect(build.success, build.logs.map(log => log.message).join('\n')).toBe(true);
  const output = build.outputs[0];
  expect(output).toBeDefined();

  const directory = mkdtempSync(join(tmpdir(), 'xln-browser-sha256-'));
  const bundlePath = join(directory, 'utils.mjs');
  try {
    writeFileSync(bundlePath, await output!.arrayBuffer());
    const child = spawnSync(process.execPath, ['-e', `
      globalThis.window = globalThis;
      const { createHash } = await import(${JSON.stringify(new URL(`file://${bundlePath}`).href)});
      console.log(createHash('sha256').update('abc').digest('hex'));
    `], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim().split(/\s+/).at(-1)).toBe(ABC_SHA256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
