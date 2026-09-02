import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStringify } from '../../../protocol/serialization';
import { executeCrossJOpeningLifecycleVector } from '../../../../rscore/fixtures/cross-j-opening/lifecycle';

test('cross-J opening is one canonical three-Runtime-frame cascade', async () => {
  const actual = await executeCrossJOpeningLifecycleVector();
  const expected = readFileSync(
    join(import.meta.dir, '../../../../rscore/fixtures/cross-j-opening/lifecycle-v1.json'),
    'utf8',
  );
  expect(`${safeStringify(actual, 2)}\n`).toBe(expected);
  expect(actual.frames.map(frame => frame.entityFrames.length)).toEqual([5, 2, 2]);
  expect(actual.frames.map(frame => frame.outbox.count)).toEqual([2, 2, 0]);
  expect(actual.frames[0]?.appliedEntityInputs).toHaveLength(1);
  expect(actual.frames[2]?.accounts.every(account =>
    account.currentHeight === 1 && account.pendingHeight === null,
  )).toBe(true);
});
