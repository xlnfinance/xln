import { expect, test } from 'bun:test';

import { decodeRuntimeEntityInputsEnvelope } from '../networking/entity-input-envelope';

const runtimeId = `0x${'11'.repeat(20)}`;

test('P2P entity-input envelope rejects unknown outer fields', () => {
  expect(() => decodeRuntimeEntityInputsEnvelope({
    sourceRuntimeId: runtimeId,
    sourceRuntimeHeight: 1,
    sourceRuntimeTimestamp: 2,
    entityInputs: [],
    crossJurisdictionIntent: {},
    unexpected: true,
  })).toThrow(
    'P2P_ENTITY_INPUTS_ENVELOPE_FIELDS_INVALID:missing=none:extra=unexpected',
  );
});

test('P2P atomic cohort rejects unknown fields before Runtime admission', () => {
  expect(() => decodeRuntimeEntityInputsEnvelope({
    sourceRuntimeId: runtimeId,
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
