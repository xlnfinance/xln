import { describe, expect, test } from 'bun:test';

import {
  hasCertifiedEntityFrameProofShape,
  isDraftEntityFrame,
  isLockedEntityFrame,
  requireCertifiedEntityFrameAfterQuorum,
} from '../../../../entity/consensus/frame/phase-views';
import type { EntityFrame } from '../../../../entity/types';

const frame = (): EntityFrame => ({
  height: 1,
  parentFrameHash: `0x${'01'.repeat(32)}`,
  stateRoot: `0x${'02'.repeat(32)}`,
  authorityRoot: `0x${'03'.repeat(32)}`,
  timestamp: 1,
  entityContext: {
    version: 1,
    proposerReplicaId: 'entity:signer',
    entityId: 'entity',
    proposerSignerId: 'signer',
    parentFrameHash: `0x${'01'.repeat(32)}`,
    height: 1,
    gossipProfiles: [],
    htlc: { version: 1, entries: [], originated: [] },
    peerAssertions: [],
  },
  txs: [],
  events: [],
  hash: `0x${'04'.repeat(32)}`,
  leader: { proposerSignerId: 'signer', view: 0 },
  hashesToSign: [{ hash: `0x${'04'.repeat(32)}`, type: 'entityFrame', context: 'frame' }],
});

describe('FinTS EntityFrame phase views', () => {
  test('narrows the same object without cloning or changing bytes', () => {
    const candidate = frame();
    expect(isDraftEntityFrame(candidate)).toBe(true);

    candidate.collectedSigs = new Map([['signer', ['signature']]]);
    expect(isLockedEntityFrame(candidate)).toBe(true);
    expect(isDraftEntityFrame(candidate)).toBe(false);

    candidate.hankos = ['hanko'];
    expect(hasCertifiedEntityFrameProofShape(candidate)).toBe(true);
    expect(requireCertifiedEntityFrameAfterQuorum(candidate)).toBe(candidate);
  });

  test('rejects partial signature and Hanko manifests', () => {
    const candidate = frame();
    candidate.collectedSigs = new Map([['signer', []]]);
    expect(isLockedEntityFrame(candidate)).toBe(false);
    candidate.collectedSigs = new Map([['signer', ['signature']]]);
    candidate.hankos = [];
    expect(hasCertifiedEntityFrameProofShape(candidate)).toBe(false);
    expect(() => requireCertifiedEntityFrameAfterQuorum(candidate)).toThrow(
      `ENTITY_FRAME_CERTIFIED_PROOF_SHAPE_INVALID:${candidate.hash}`,
    );
  });
});
