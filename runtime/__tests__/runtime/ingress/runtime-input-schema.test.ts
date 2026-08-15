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

test('RuntimeInput decoder validates every durable receipt before minting the batch', () => {
  const identity = {
    kind: 'entity-frame',
    entityId: `0x${'11'.repeat(32)}`,
    signerId: `0x${'22'.repeat(20)}`,
    laneKey: 'entity-frame:1',
    height: 1,
    frameHash: `0x${'33'.repeat(32)}`,
    logicalKey: 'entity-frame:1',
    evidenceVersion: 1,
    evidenceKind: 'entity-certificate',
    evidenceDigest: `0x${'44'.repeat(32)}`,
    bodyDigest: `0x${'55'.repeat(32)}`,
  };
  const receipt = {
    body: {
      version: 1,
      coverage: 'terminal',
      receiverRuntimeId: `0x${'66'.repeat(20)}`,
      identity,
      appliedRuntimeHeight: 1,
    },
    signature: `0x${'77'.repeat(65)}`,
  };

  expect(decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [],
    reliableReceipts: [receipt],
  }, 'RUNTIME_INPUT').reliableReceipts).toEqual([receipt]);
  expect(() => decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [],
    reliableReceipts: [{ ...receipt, ignored: true }],
  }, 'RUNTIME_INPUT')).toThrow('RUNTIME_INPUT_RELIABLE_RECEIPT_0_FIELDS');
  expect(() => decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [],
    reliableReceipts: [{
      ...receipt,
      body: { ...receipt.body, identity: { ...identity, height: '1' } },
    }],
  }, 'RUNTIME_INPUT')).toThrow('RELIABLE_RECEIPT_HEIGHT_INVALID');
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
