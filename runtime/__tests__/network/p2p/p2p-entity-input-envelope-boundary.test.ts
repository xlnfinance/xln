import { expect, test } from 'bun:test';

import {
  decodeRuntimeEntityInputsEnvelope,
  MAX_P2P_ENTITY_INPUTS,
} from '../../../network/p2p/auth/entity-input-envelope';

const runtimeId = `0x${'11'.repeat(20)}`;
const sourceSignature = `0x${'11'.repeat(65)}`;

test('P2P entity-input envelope rejects unknown outer fields', () => {
  expect(() => decodeRuntimeEntityInputsEnvelope({
    sourceRuntimeId: runtimeId,
    sourceSignature,
    sourceRuntimeHeight: 1,
    sourceRuntimeTimestamp: 2,
    entityInputs: [],
    unexpected: true,
  })).toThrow(
    'P2P_ENTITY_INPUTS_ENVELOPE_FIELDS_INVALID:missing=none:extra=unexpected',
  );
});

test('P2P atomic cohort rejects unknown fields before Runtime admission', () => {
  expect(() => decodeRuntimeEntityInputsEnvelope({
    sourceRuntimeId: runtimeId,
    sourceSignature,
    sourceRuntimeHeight: 1,
    sourceRuntimeTimestamp: 2,
    entityInputs: [
      { entityId: 'a', signerId: 's', runtimeId, entityTxs: [{ type: 'chat' }] },
      { entityId: 'b', signerId: 's', runtimeId, entityTxs: [{ type: 'chat' }] },
    ],
    atomicCrossJurisdictionPair: {
      phase: 'proposal',
      pairKey: 'pair',
      unexpected: true,
    },
  })).toThrow(
    'P2P_ENTITY_INPUTS_ENVELOPE_ATOMIC_PAIR_FIELDS_INVALID:missing=none:extra=unexpected',
  );
});

test('P2P envelope rejects oversized entity batches before decoding entries', () => {
  expect(() => decodeRuntimeEntityInputsEnvelope({
    sourceRuntimeId: runtimeId,
    sourceSignature,
    sourceRuntimeHeight: 1,
    sourceRuntimeTimestamp: 2,
    entityInputs: Array.from({ length: MAX_P2P_ENTITY_INPUTS + 1 }, () => null),
  })).toThrow(
    `P2P_ENTITY_INPUTS_ENVELOPE_INPUTS_TOO_MANY:${MAX_P2P_ENTITY_INPUTS + 1}:${MAX_P2P_ENTITY_INPUTS}`,
  );
});

test('P2P decoder mints identity and coordinate brands only after exact validation', () => {
  const entityId = `0x${'22'.repeat(32)}`;
  const decoded = decodeRuntimeEntityInputsEnvelope({
    sourceRuntimeId: runtimeId,
    sourceSignature,
    sourceRuntimeHeight: 7,
    sourceRuntimeTimestamp: 8_000,
    entityInputs: [
      { entityId, signerId: 'signer-1', runtimeId, entityTxs: [{ type: 'chat' }] },
    ],
  });
  expect(decoded.sourceRuntimeId).toBe(runtimeId);
  expect(decoded.sourceRuntimeHeight).toBe(7);
  expect(decoded.sourceRuntimeTimestamp).toBe(8_000);
  expect(decoded.entityInputs[0]?.entityId).toBe(entityId);

  expect(() => decodeRuntimeEntityInputsEnvelope({
    sourceRuntimeId: runtimeId,
    sourceSignature,
    sourceRuntimeHeight: 7,
    sourceRuntimeTimestamp: 8_000,
    entityInputs: [
      { entityId: 'not-an-entity-id', signerId: 'signer-1', runtimeId, entityTxs: [{ type: 'chat' }] },
    ],
  })).toThrow('Invalid EntityId');
});
