import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDefaultDelta } from '../../../account/state/delta';
import { validateAccountDeltas } from '../../../account/validation/delta-validation';

test('validation utilities do not hide account-delta failures behind console output', () => {
  const source = readFileSync(
    join(process.cwd(), 'core/account/validation/delta-validation.ts'),
    'utf8',
  );

  expect(source).not.toContain('console.');
  expect(source).toContain('ACCOUNT_DELTAS_MISSING');
  expect(source).toContain('ACCOUNT_DELTAS_INVALID_TOKEN_ID');
});

test('validateAccountDeltas accepts canonical Map and object delta inputs', () => {
  const mapDeltas = validateAccountDeltas(new Map([[1, createDefaultDelta(1)]]), 'map-test');
  expect(mapDeltas.get(1)?.tokenId).toBe(1);

  const objectDeltas = validateAccountDeltas({ 2: createDefaultDelta(2) }, 'object-test');
  expect(objectDeltas.get(2)?.tokenId).toBe(2);
});

test('validateAccountDeltas fails loud for missing, malformed, or partial input', () => {
  expect(() => validateAccountDeltas(undefined, 'missing-test')).toThrow('ACCOUNT_DELTAS_MISSING');
  expect(() => validateAccountDeltas(new Map([['1', createDefaultDelta(1)]]), 'map-key-test')).toThrow(
    'ACCOUNT_DELTAS_INVALID_TOKEN_ID',
  );
  expect(() => validateAccountDeltas({ '01': createDefaultDelta(1) }, 'object-key-test')).toThrow(
    'ACCOUNT_DELTAS_INVALID_TOKEN_ID',
  );
  expect(() => validateAccountDeltas({ 1: { tokenId: 1 } }, 'bad-delta-test')).toThrow(
    'Delta validation failed from bad-delta-test.Object[1]',
  );
});

test('validateAccountDeltas rejects omitted hold fields instead of restoring capacity', () => {
  const missingLeftHold: Record<string, unknown> = { ...createDefaultDelta(1) };
  delete missingLeftHold['leftHold'];
  expect(() => validateAccountDeltas({ 1: missingLeftHold }, 'missing-left-hold')).toThrow(
    'leftHold cannot be null/undefined',
  );

  const missingRightHold: Record<string, unknown> = { ...createDefaultDelta(1) };
  delete missingRightHold['rightHold'];
  expect(() => validateAccountDeltas({ 1: missingRightHold }, 'missing-right-hold')).toThrow(
    'rightHold cannot be null/undefined',
  );
});
