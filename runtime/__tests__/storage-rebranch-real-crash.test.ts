import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';

import { KEY_REBRANCH_NODE } from '../storage/keys';
import {
  STORAGE_MAX_PHYSICAL_VALUE_BYTES,
  withRebranchedValues,
} from '../storage/rebranched-db';

const fixture = join(import.meta.dir, 'fixtures/storage-rebranch-crash-child.ts');
const roots: string[] = [];
const logicalKey = Buffer.from([0x22, 0x01]);

const patternedValue = (bytes: number, salt: number): Buffer => {
  const value = Buffer.allocUnsafe(bytes);
  for (let index = 0; index < bytes; index += 1) value[index] = (index + salt) % 251;
  return value;
};

const runKilledStage = async (dbPath: string, stage: string): Promise<void> => {
  const child = Bun.spawn({
    cmd: [process.execPath, fixture, dbPath, stage],
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(exitCode, `${stage}\n${stdout}\n${stderr}`).toBe(137);
  expect(child.signalCode, `${stage}\n${stdout}\n${stderr}`).toBe('SIGKILL');
};

const inspect = async (
  dbPath: string,
  expected: Buffer | null,
): Promise<{ physicalKeys: string[]; rowCount: number }> => {
  const raw = new Level<Buffer, Buffer>(dbPath, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
  });
  await raw.open();
  try {
    const db = withRebranchedValues(raw);
    if (expected) expect(await db.get(logicalKey)).toEqual(expected);
    else await expect(db.get(logicalKey)).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' });

    const physicalKeys: string[] = [];
    let rowCount = 0;
    for await (const [key, value] of raw.iterator()) {
      rowCount += 1;
      expect(value.byteLength).toBeLessThan(STORAGE_MAX_PHYSICAL_VALUE_BYTES);
      if (key[0] === KEY_REBRANCH_NODE) physicalKeys.push(key.toString('hex'));
      else expect(key).toEqual(logicalKey);
    }
    return { physicalKeys: physicalKeys.sort(), rowCount };
  } finally {
    await raw.close();
  }
};

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

test('real SIGKILL preserves exact split, shrink, collapse, regrow, and delete states', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-rebranch-crash-'));
  roots.push(root);
  const dbPath = join(root, 'level');

  await runKilledStage(dbPath, 'split');
  const split = await inspect(dbPath, patternedValue(40_000, 11));
  expect(split.physicalKeys.length).toBeGreaterThan(1);
  expect(split.rowCount).toBe(split.physicalKeys.length + 1);

  await runKilledStage(dbPath, 'shrink');
  const shrink = await inspect(dbPath, patternedValue(20_000, 29));
  expect(shrink.physicalKeys.length).toBeGreaterThan(1);
  expect(shrink.physicalKeys.length).toBeLessThan(split.physicalKeys.length);
  expect(shrink.rowCount).toBe(shrink.physicalKeys.length + 1);
  expect(split.physicalKeys.filter((key) => !shrink.physicalKeys.includes(key)).length).toBeGreaterThan(0);

  await runKilledStage(dbPath, 'collapse');
  const collapsed = await inspect(dbPath, patternedValue(9_999, 47));
  expect(collapsed).toEqual({ physicalKeys: [], rowCount: 1 });

  await runKilledStage(dbPath, 'regrow');
  const regrown = await inspect(dbPath, patternedValue(32_000, 71));
  expect(regrown.physicalKeys.length).toBeGreaterThan(1);
  expect(regrown.rowCount).toBe(regrown.physicalKeys.length + 1);

  await runKilledStage(dbPath, 'delete');
  expect(await inspect(dbPath, null)).toEqual({ physicalKeys: [], rowCount: 0 });
}, 20_000);
