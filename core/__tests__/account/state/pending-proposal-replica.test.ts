import { describe, expect, test } from 'bun:test';

import {
  installPendingProposalReplica,
  stashPendingProposalReplica,
  takePendingProposalReplica,
} from '../../../account/state/pending-proposal-replica';
import { hashProofBodyStruct } from '../../../protocol/dispute/proof-builder';
import type { ProofBodyStruct } from '../../../protocol/dispute/proof-body';
import { entity, makeAccount } from '../../helpers/cross-j';

const proofBody = (byte: string): ProofBodyStruct => ({
  watchSeed: `0x${byte.repeat(32)}`,
  leftResponseSeconds: 10,
  rightResponseSeconds: 10,
  offdeltas: [],
  tokenIds: [],
  transformers: [],
});

describe('pending proposal replica ACK install', () => {
  test('keeps the live signed ProofBody when the stashed candidate is pre-Hanko', () => {
    const live = makeAccount(entity('11'), entity('22'));
    const candidate = makeAccount(entity('11'), entity('22'));
    const previousBody = proofBody('aa');
    const signedBody = proofBody('bb');
    const previousHash = hashProofBodyStruct(previousBody);
    const signedHash = hashProofBodyStruct(signedBody);

    candidate.currentHeight = 2;
    candidate.disputeProofBodiesByHash = { [previousHash]: previousBody };
    candidate.disputeProofNoncesByHash = { [previousHash]: 1 };
    candidate.currentDisputeProofBodyHash = previousHash;

    live.currentHeight = 1;
    live.pendingFrame = {
      ...live.currentFrame,
      height: 2,
      stateHash: `0x${'22'.repeat(32)}`,
    };
    live.currentDisputeProofHanko = '0xhanko';
    live.currentDisputeHash = `0x${'33'.repeat(32)}`;
    live.currentDisputeProofBodyHash = signedHash;
    live.currentDisputeProofNonce = 2;
    live.currentDisputeProofProposerIsLeft = true;
    live.disputeProofBodiesByHash = {
      [previousHash]: previousBody,
      [signedHash]: signedBody,
    };
    live.disputeProofNoncesByHash = {
      [previousHash]: 1,
      [signedHash]: 2,
    };
    live.proofHeader.nextProofNonce = 3;

    stashPendingProposalReplica(live, candidate);
    const prepared = takePendingProposalReplica(live);
    if (!prepared) throw new Error('TEST_PENDING_PROPOSAL_MISSING');
    installPendingProposalReplica(live, prepared);

    expect(live.currentHeight).toBe(2);
    expect(live.currentDisputeProofHanko).toBe('0xhanko');
    expect(live.currentDisputeProofBodyHash).toBe(signedHash);
    expect(live.disputeProofBodiesByHash?.[signedHash]).toEqual(signedBody);
    expect(live.proofHeader.nextProofNonce).toBe(3);
    expect(live.pendingFrame?.height).toBe(2);
  });
});
