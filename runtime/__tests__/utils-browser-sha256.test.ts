import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

import { createHash } from '../utils';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('createHash uses the exact SHA-256 bytes for incremental input', () => {
  expect(createHash('sha256').update('a').update('bc').digest('hex')).toBe(ABC_SHA256);
  expect(createHash('sha256').update('abc').digest()).toHaveLength(32);
  expect(() => createHash('sha1')).toThrow('HASH_ALGORITHM_UNSUPPORTED:sha1');
});

test('browser-selected createHash produces a full cryptographic SHA-256 digest', () => {
  const utilsUrl = new URL('../utils.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['-e', `
    globalThis.window = globalThis;
    const { createHash } = await import(${JSON.stringify(utilsUrl)});
    console.log(createHash('sha256').update('abc').digest('hex'));
  `], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim().split(/\s+/).at(-1)).toBe(ABC_SHA256);
});
