import { describe, expect, test } from 'bun:test';

import { accountInputAck } from '../account/consensus/flush';
import { initJBatch } from '../jurisdiction/batch';
import {
  collectReachableDisputeEvidenceHashes,
  pruneUnreachableDisputeEvidence,
} from '../protocol/dispute/evidence-retention';
import { hashProofBodyStruct } from '../protocol/dispute/proof-builder';
import { hydrateAccountDocFromStorage, projectAccountDoc } from '../storage/projections';
import type { AccountMachine } from '../types';
import type { ProofBodyStruct } from '../protocol/dispute/proof-body';
import { entity, makeAccount } from './helpers/cross-j';

const proofBody = (byte: string): ProofBodyStruct => ({
  watchSeed: `0x${byte.repeat(32)}`,
  offdeltas: [],
  tokenIds: [],
  transformers: [],
});

const hashAt = (index: number): string =>
  `0x${BigInt(index).toString(16).padStart(64, '0')}`;

const evidenceSnapshot = (hash: string, nonce: number, body: ProofBodyStruct) => ({
  proofbodyHash: hash,
  nonce,
  side: 'left' as const,
  proofBodyStruct: body,
  plan: {
    paymentHashlocks: [],
    leftSwapOfferIds: [],
    rightSwapOfferIds: [],
    leftPullIds: [],
    rightPullIds: [],
  },
  appliedSwapFillFingerprints: [],
});

const installEvidence = (
  account: AccountMachine,
  hashes: readonly string[],
  body: ProofBodyStruct,
): void => {
  account.disputeProofBodiesByHash = Object.fromEntries(
    hashes.map((hash) => [hash, structuredClone(body)]),
  );
  account.disputeProofNoncesByHash = Object.fromEntries(
    hashes.map((hash, index) => [hash, index + 1]),
  );
  account.disputeArgumentSnapshotsByHash = Object.fromEntries(
    hashes.map((hash, index) => [hash, evidenceSnapshot(hash, index + 1, body)]),
  );
};

const installExactEvidence = (
  account: AccountMachine,
  body: ProofBodyStruct,
  nonce: number,
): string => {
  const hash = hashProofBodyStruct(body);
  account.disputeProofBodiesByHash![hash] = structuredClone(body);
  account.disputeProofNoncesByHash![hash] = nonce;
  account.disputeArgumentSnapshotsByHash![hash] = evidenceSnapshot(hash, nonce, body);
  return hash;
};

describe('reachable-only dispute evidence retention', () => {
  test('10k historical proofs compact to exact live Account and J-submit references and survive restore', () => {
    const self = entity('11');
    const counterparty = entity('22');
    const account = makeAccount(self, counterparty);
    const baseBody = proofBody('31');
    const allHashes = Array.from({ length: 10_000 }, (_, index) => hashAt(index + 1));

    installEvidence(account, allHashes, baseBody);
    const currentHash = installExactEvidence(account, proofBody('32'), 10_001);
    const counterpartyHash = installExactEvidence(account, proofBody('33'), 10_002);
    const activeHash = installExactEvidence(account, proofBody('34'), 10_003);
    const pendingHash = installExactEvidence(account, proofBody('35'), 10_004);
    const cachedAckHash = installExactEvidence(account, proofBody('36'), 10_005);
    const pendingSettlementHash = installExactEvidence(account, proofBody('38'), 10_006);
    const draftStartBody = proofBody('41');
    const draftStartHash = installExactEvidence(account, draftStartBody, 10_007);
    const draftFinalInitialHash = installExactEvidence(account, proofBody('37'), 10_008);
    const draftFinalBody = proofBody('42');
    const draftFinalHash = installExactEvidence(account, draftFinalBody, 10_009);
    const sentStartBody = proofBody('43');
    const sentStartHash = installExactEvidence(account, sentStartBody, 10_010);
    const reachable = [
      currentHash,
      counterpartyHash,
      activeHash,
      pendingHash,
      cachedAckHash,
      pendingSettlementHash,
      draftStartHash,
      draftFinalInitialHash,
      draftFinalHash,
      sentStartHash,
    ];
    account.currentDisputeProofBodyHash = currentHash;
    account.counterpartyDisputeProofBodyHash = counterpartyHash;
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: activeHash,
      initialNonce: 3,
      disputeTimeout: 100,
      jNonce: 3,
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
    };
    const pendingFrame = {
      ...account.currentFrame,
      height: 1,
      timestamp: 1,
      prevFrameHash: hashAt(10_011),
      stateHash: hashAt(10_012),
    };
    account.pendingFrame = pendingFrame;
    account.pendingAccountInput = {
      kind: 'frame',
      fromEntityId: self,
      toEntityId: counterparty,
      proposal: {
        frame: pendingFrame,
        disputeSeal: {
          hanko: '0x11',
          hash: hashAt(10_001),
          proofBodyHash: pendingHash,
          proofNonce: 4,
        },
      },
    };
    account.pendingAccountInputSignerId = 'pending-evidence-signer';
    account.lastOutboundFrameAck = {
      height: 7,
      counterpartyEntityId: counterparty,
      response: {
        kind: 'ack',
        fromEntityId: self,
        toEntityId: counterparty,
        ack: {
          height: 7,
          frameHash: hashAt(10_002),
          disputeSeal: {
            hanko: '0x22',
            hash: hashAt(10_003),
            proofBodyHash: cachedAckHash,
            proofNonce: 5,
          },
        },
      },
    };
    account.settlementWorkspace = {
      ops: [],
      lastModifiedByLeft: true,
      status: 'awaiting_counterparty',
      version: 1,
      createdAt: 1,
      lastUpdatedAt: 1,
      executorIsLeft: true,
      postSettlementDisputeProof: {
        disputeHash: hashAt(10_005),
        proofBodyHash: pendingSettlementHash,
        nonce: 10_006,
      },
    };

    const jBatchState = initJBatch();
    jBatchState.batch.disputeStarts.push({
      counterentity: counterparty,
      nonce: 6,
      proofbodyHash: draftStartHash,
      initialProofbody: draftStartBody,
      watchSeed: draftStartBody.watchSeed,
      sig: '0x33',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
    });
    jBatchState.batch.disputeFinalizations.push({
      counterentity: counterparty,
      initialNonce: 7,
      finalNonce: 8,
      initialProofbodyHash: draftFinalInitialHash,
      finalProofbody: draftFinalBody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: '0x44',
      startedByLeft: true,
      cooperative: false,
    });
    jBatchState.batch.disputeStarts.push({
      counterentity: entity('99'),
      nonce: 88,
      proofbodyHash: hashAt(10_088),
      initialProofbody: proofBody('88'),
      watchSeed: proofBody('88').watchSeed,
      sig: '0x88',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
    });
    const sentBatch = initJBatch().batch;
    sentBatch.disputeStarts.push({
      counterentity: counterparty,
      nonce: 9,
      proofbodyHash: sentStartHash,
      initialProofbody: sentStartBody,
      watchSeed: sentStartBody.watchSeed,
      sig: '0x55',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
    });
    jBatchState.sentBatch = {
      batch: sentBatch,
      batchHash: hashAt(10_004),
      encodedBatch: '0x',
      entityNonce: 1,
      firstSubmittedAt: 1,
      lastSubmittedAt: 0,
      submitAttempts: 0,
    };

    expect([...collectReachableDisputeEvidenceHashes(account, jBatchState)].sort())
      .toEqual([...reachable].map((hash) => hash.toLowerCase()).sort());
    const result = pruneUnreachableDisputeEvidence(account, jBatchState);
    expect(result.before).toBe(10_010);
    expect(result.after).toBe(reachable.length);
    expect(Object.keys(account.disputeProofBodiesByHash ?? {}).sort()).toEqual([...reachable].sort());
    expect(Object.keys(account.disputeProofNoncesByHash ?? {}).sort()).toEqual([...reachable].sort());
    expect(Object.keys(account.disputeArgumentSnapshotsByHash ?? {}).sort()).toEqual([...reachable].sort());

    const restored = hydrateAccountDocFromStorage(projectAccountDoc(account));
    expect(accountInputAck(restored.lastOutboundFrameAck!.response)?.disputeSeal?.proofBodyHash)
      .toBe(cachedAckHash);
    expect(pruneUnreachableDisputeEvidence(restored, jBatchState)).toEqual({
      before: reachable.length,
      after: reachable.length,
    });
    expect(Object.keys(restored.disputeProofBodiesByHash ?? {})).toHaveLength(reachable.length);
  });

  test('no live reference retires all three evidence records', () => {
    const account = makeAccount(entity('11'), entity('22'));
    installEvidence(account, [hashAt(1), hashAt(2)], proofBody('51'));

    expect(pruneUnreachableDisputeEvidence(account)).toEqual({ before: 2, after: 0 });
    expect(account.disputeProofBodiesByHash).toBeUndefined();
    expect(account.disputeProofNoncesByHash).toBeUndefined();
    expect(account.disputeArgumentSnapshotsByHash).toBeUndefined();
  });

  test('case-ambiguous reachable evidence fails atomically instead of silently repairing', () => {
    const account = makeAccount(entity('11'), entity('22'));
    const canonical = `0x${'ab'.repeat(32)}`;
    const ambiguous = `0x${'AB'.repeat(32)}`;
    account.currentDisputeProofBodyHash = canonical;
    account.disputeProofBodiesByHash = {
      [canonical]: proofBody('61'),
      [ambiguous]: proofBody('62'),
    };
    account.disputeProofNoncesByHash = { [hashAt(99)]: 99 };
    const beforeBodies = structuredClone(account.disputeProofBodiesByHash);
    const beforeNonces = structuredClone(account.disputeProofNoncesByHash);

    expect(() => pruneUnreachableDisputeEvidence(account))
      .toThrow(`DISPUTE_EVIDENCE_HASH_AMBIGUOUS:${canonical}`);
    expect(account.disputeProofBodiesByHash).toEqual(beforeBodies);
    expect(account.disputeProofNoncesByHash).toEqual(beforeNonces);
  });

  test('oversized J-submit reference set fails closed instead of making retention unbounded', () => {
    const self = entity('11');
    const counterparty = entity('22');
    const account = makeAccount(self, counterparty);
    const body = proofBody('71');
    const hash = hashProofBodyStruct(body);
    const jBatchState = initJBatch();
    jBatchState.batch.disputeStarts = Array.from({ length: 9 }, () => ({
      counterentity: counterparty,
      nonce: 1,
      proofbodyHash: hash,
      initialProofbody: body,
      watchSeed: body.watchSeed,
      sig: '0x71',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
    }));

    expect(() => collectReachableDisputeEvidenceHashes(account, jBatchState))
      .toThrow('J_BATCH_LIMIT_EXCEEDED: jBatch.draft.evidenceRetention: disputeStarts 9/8');
  });
});
