import { expect, test } from 'bun:test';

import { decodeRuntimeInput } from '../../../runtime/input-schema';

test('RuntimeInput decoder owns the exact envelope and RuntimeTx boundary', () => {
  expect(() => decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [],
    ignored: true,
  }, 'RUNTIME_INPUT')).toThrow('RUNTIME_INPUT_FIELDS_INVALID');

  expect(() => decodeRuntimeInput({
    runtimeTxs: [{ type: 'unknown', data: {} }],
    entityInputs: [],
  }, 'RUNTIME_INPUT')).toThrow('RUNTIME_INPUT_RUNTIME_TX_0_DATA_TYPE_UNKNOWN');

  expect(() => decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [],
    jInputs: [{ jurisdictionName: 'testnet', jTxs: [], ignored: true }],
  }, 'RUNTIME_INPUT')).toThrow('RUNTIME_INPUT_J_INPUT_FIELDS_INVALID:index=0');
});

test('RuntimeInput decoder mints exact Entity, Signer, Runtime, and unix-ms values', () => {
  const entityId = `0x${'22'.repeat(32)}`;
  const numberedEntityId = `0x${'7'.padStart(64, '0')}`;
  const runtimeId = `0x${'33'.repeat(20)}`;
  const decoded = decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [{
      entityId,
      signerId: 'signer-1',
      runtimeId,
      from: runtimeId,
      entityTxs: [],
    }],
    timestamp: 8_000,
    queuedAt: 7_000,
  }, 'RUNTIME_INPUT');

  expect(decoded.entityInputs[0]?.entityId).toBe(entityId);
  expect(decoded.entityInputs[0]?.signerId).toBe('signer-1');
  expect(decoded.entityInputs[0]?.runtimeId).toBe(runtimeId);
  expect(decoded.entityInputs[0]?.from).toBe(runtimeId);
  expect(decoded.timestamp).toBe(8_000);
  expect(decoded.queuedAt).toBe(7_000);

  expect(decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [{ entityId: numberedEntityId, signerId: 'signer-1', entityTxs: [] }],
  }, 'RUNTIME_INPUT').entityInputs[0]?.entityId).toBe(numberedEntityId);

  expect(() => decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [{ entityId, signerId: '', entityTxs: [] }],
  }, 'RUNTIME_INPUT')).toThrow('Invalid SignerId');
  expect(() => decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [{
      entityId,
      signerId: 'signer-1',
      runtimeId: runtimeId.toUpperCase(),
      entityTxs: [],
    }],
  }, 'RUNTIME_INPUT')).toThrow('Invalid RuntimeId');
  expect(() => decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [{ entityId: '0007', signerId: 'signer-1', entityTxs: [] }],
  }, 'RUNTIME_INPUT')).toThrow('Invalid EntityId');
});
