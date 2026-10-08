import { expect, test } from 'bun:test';
import vector from '../../fixtures/jurisdiction/tron-financial-replacement.json';
import { validateTronReplacement } from '../../../jurisdiction/adapter/operations/tron-replacement';
import { decodeSignedTronTransaction } from '../../../jurisdiction/adapter/operations/tron-transaction';
import { validateRuntimeTx } from '../../../runtime/decode/runtime-tx';
import { assertJSubmitRuntimeTxAuthorized } from '../../../runtime/j-submit/j-submit-state';
import type { RuntimeTx } from '../../../runtime/types';

const data = vector.accepted.data;
test('real expired financial call preserves payer and exact economic intent through native replacement', () => {
  expect(() => validateTronReplacement(vector.oldRaw, data.rawTransaction, data.previousTransactionHash, data.evidence)).not.toThrow();
  expect(() => validateTronReplacement(data.rawTransaction, data.rawTransaction, data.previousTransactionHash, data.evidence)).not.toThrow();
  const old = decodeSignedTronTransaction(vector.oldRaw);
  const next = decodeSignedTronTransaction(data.rawTransaction);
  expect([next.from, next.to, next.value, next.data]).toEqual([old.from, old.to, old.value, old.data]);
  expect(next.hash).not.toBe(old.hash);
});

test('financial replacement rejects mismatched old identity and invalid expiry evidence', () => {
  for (const evidence of [
    { ...data.evidence, oldTransactionHash: `0x${'00'.repeat(32)}` },
    { ...data.evidence, timestamp: 1 },
    { ...data.evidence, blockHash: `0x${'00'.repeat(32)}` },
    { ...data.evidence, blockNumber: data.evidence.blockNumber + 1 },
  ]) expect(() => validateTronReplacement(vector.oldRaw, data.rawTransaction, data.previousTransactionHash, evidence)).toThrow();
  expect(() => validateTronReplacement(vector.oldRaw, data.rawTransaction, `0x${'00'.repeat(32)}`, data.evidence)).toThrow();
});

test('financial replacement remains an internal strictly decoded Runtime input', () => {
  const tx = structuredClone(vector.accepted) as RuntimeTx;
  expect(() => validateRuntimeTx(tx)).not.toThrow();
  expect(() => assertJSubmitRuntimeTxAuthorized(tx, false)).toThrow();
  expect(() => validateRuntimeTx({ ...tx, data: { ...data, sidecar: true } })).toThrow();
});
