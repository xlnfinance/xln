import { expect, test } from 'bun:test';

import { validateProposedEntityFrame } from '../../../entity/consensus/frame/validation';
import { assertEntityFrameTotalByteBudget } from '../../../entity/consensus/frame';
import { LIMITS } from '../../../config/constants';

const entityId = `0x${'01'.repeat(32)}`;
const signerId = `0x${'02'.repeat(20)}`;
const emptyContext = {
  version: 1 as const,
  proposerReplicaId: `${entityId}:${signerId}`,
  entityId,
  proposerSignerId: signerId,
  parentFrameHash: 'genesis',
  height: 1,
  gossipProfiles: [],
  peerAssertions: [],
  htlc: { version: 1 as const, entries: [], originated: [] },
};

test('proposed Entity frames reject malformed transactions before replay', () => {
  const malformedFrame = {
    height: 1,
    parentFrameHash: 'genesis',
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    timestamp: 1,
    entityContext: emptyContext,
    txs: [{ type: 'chat', data: { from: 'validator-without-message' } }],
    events: [],
    hash: `0x${'33'.repeat(32)}`,
    leader: { proposerSignerId: signerId, view: 0 },
  };

  expect(() => validateProposedEntityFrame(malformedFrame, 'EntityFrame'))
    .toThrow('EntityFrame.txs_0_DATA_FIELDS');
});

test('Entity frame total byte budget rejects aggregate payloads', () => {
  const half = 'x'.repeat(Math.floor(LIMITS.MAX_FRAME_SIZE_BYTES / 2) + 1_000);
  expect(() => assertEntityFrameTotalByteBudget({
    prevFrameHash: 'genesis',
    height: 1,
    timestamp: 1,
    txs: [{ type: 'chat', data: { from: signerId, message: half } }],
    events: [{ type: 'status', message: half }],
    entityId,
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    entityContext: emptyContext,
  })).toThrow('ENTITY_FRAME_TOTAL_BYTE_LIMIT_EXCEEDED');
});

test('proposed Entity frames require the exact signed-hash manifest', () => {
  const frameWithoutManifest = {
    height: 1,
    parentFrameHash: 'genesis',
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    timestamp: 1,
    entityContext: emptyContext,
    txs: [],
    events: [],
    hash: `0x${'33'.repeat(32)}`,
    leader: { proposerSignerId: signerId, view: 0 },
  };

  expect(() => validateProposedEntityFrame(frameWithoutManifest, 'EntityFrame'))
    .toThrow('EntityFrame.hashesToSign');
  expect(() => validateProposedEntityFrame({
    ...frameWithoutManifest,
    hashesToSign: [],
  }, 'EntityFrame')).toThrow('EntityFrame.hashesToSign cannot be empty');
});
