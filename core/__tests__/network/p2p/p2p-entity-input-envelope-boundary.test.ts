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
      {
        entityId,
        signerId: 'signer-1',
        runtimeId,
        entityTxs: [{ type: 'chat', data: { from: 'signer-1', message: 'hi' } }],
      },
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

test('P2P decoder runs the exact AccountInput decoder before Runtime admission', () => {
  // Without this, a peer ACK lacking `height` reached applyAccountInput and
  // threw ACCOUNT_INPUT_HEIGHT_NORMALIZATION_INVARIANT, a Runtime halt. At the
  // envelope it fails only this message and the peer session.
  const fromEntityId = `0x${'33'.repeat(32)}`;
  const toEntityId = `0x${'44'.repeat(32)}`;
  const envelopeWithAck = (ack: Record<string, unknown>) => ({
    sourceRuntimeId: runtimeId,
    sourceSignature,
    sourceRuntimeHeight: 7,
    sourceRuntimeTimestamp: 8_000,
    entityInputs: [{
      entityId: toEntityId,
      signerId: 'signer-1',
      runtimeId,
      entityTxs: [{
        type: 'accountInput',
        data: {
          kind: 'ack',
          fromEntityId,
          toEntityId,
          domain: { chainId: 31337, depositoryAddress: `0x${'55'.repeat(20)}` },
          disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
          ack,
        },
      }],
    }],
  });
  const frameHash = `0x${'66'.repeat(32)}`;
  expect(decodeRuntimeEntityInputsEnvelope(envelopeWithAck({ height: 1, frameHash }))
    .entityInputs[0]?.entityTxs).toHaveLength(1);
  expect(() => decodeRuntimeEntityInputsEnvelope(envelopeWithAck({ frameHash })))
    .toThrow('P2P_ENTITY_INPUTS_ENVELOPE_INPUT_0_TX_0_DATA_ACK_FIELDS:missing=height');
  expect(() => decodeRuntimeEntityInputsEnvelope(envelopeWithAck({ height: 1, frameHash: 7 })))
    .toThrow('P2P_ENTITY_INPUTS_ENVELOPE_INPUT_0_TX_0_DATA_ACK_FRAME_HASH');
});
