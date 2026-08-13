import { expect, test } from 'bun:test';

import { fingerprintRuntimeIngressInput } from '../../../../runtime/input-pipeline/ingress-receipts';
import type { RuntimeInput } from '../../../../runtime/types';
import type { JPrefixAttestation } from '../../../../types/jurisdiction-events';
import type { EntityLeaderTimeoutVote } from '../../../../entity/types';

const entityId = `0x${'11'.repeat(32)}`;
const signerId = `0x${'22'.repeat(20)}`;

const attestation: JPrefixAttestation = {
  version: 1,
  entityId,
  targetEntityHeight: 2,
  parentFrameHash: `0x${'33'.repeat(32)}`,
  validatorId: signerId,
  jurisdictionRef: 'stack:31337:test',
  baseHeight: 0,
  scannedThroughHeight: 0,
  tipBlockHash: `0x${'44'.repeat(32)}`,
  eventHistoryRoot: `0x${'55'.repeat(32)}`,
  rangeHash: `0x${'66'.repeat(32)}`,
  headers: [],
  blocks: [],
  signature: '0xattestation',
};

const timeoutVote = (signature: string): EntityLeaderTimeoutVote => ({
  entityId,
  targetHeight: 2,
  previousFrameHash: `0x${'33'.repeat(32)}`,
  fromView: 0,
  toView: 1,
  previousLeaderId: signerId,
  nextLeaderId: `0x${'77'.repeat(20)}`,
  voterId: signerId,
  signature,
});

const input = (voteSignature: string): RuntimeInput => ({
  runtimeTxs: [],
  entityInputs: [{
    entityId,
    signerId,
    jPrefixAttestations: new Map([[signerId, attestation]]),
    leaderTimeoutVote: timeoutVote(voteSignature),
  }],
});

test('ingress receipts independently bind J-prefix and leader-timeout lanes', () => {
  const first = fingerprintRuntimeIngressInput(input('0xvote-a'));
  const changedVote = fingerprintRuntimeIngressInput(input('0xvote-b'));

  expect(first).toHaveLength(2);
  expect(changedVote).toHaveLength(2);
  expect(first.filter(fingerprint => changedVote.includes(fingerprint))).toHaveLength(1);
});
