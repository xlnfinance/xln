/**
 * Offline/storage integrity decoder for one exact rscore restore row.
 *
 * This deliberately does not return AccountReplica: Rust checkpoints retain
 * only the roots of TS-owned carried trees, not their bodies. Fabricating
 * empty maps would create a second state with the same claimed roots. The
 * returned seed is complete for Rust-owned state and explicit about the four
 * root-only sections.
 */
import { canonicalAccountTxForFrameHash } from '../account/consensus/frame/hash';
import { computeCanonicalMerkleRoot, EMPTY_ACCOUNT_STATE_ROOT } from '../account/commitment/state-root';
import { createDisputeProofHashWithNonce } from '../protocol/dispute/proof-builder';
import { computeEntityAccountLeafDigest } from '../entity/consensus/state-root';
import { computeIntegrityDigest } from '../support/bytes/integrity-checksum';
import { assertSameRscoreCanonicalValue } from './canonical-wire';
import type {
  RscoreConsensusSeed,
  RscoreDisputeDraft,
  RscoreOutboundAck,
  RscorePendingFrame,
} from './checkpoint-restore-consensus';
import { decodeRscoreConsensusSeed } from './checkpoint-restore-consensus';
import { checkpointHex, checkpointRestoreFail } from './checkpoint-restore-read';
import type { RscoreAccountStateSeed } from './checkpoint-restore-state';
import { decodeRscoreAccountStateSeed } from './checkpoint-restore-state';
import { rscoreCheckpointTuple } from './checkpoint-wire';

export const RSCORE_ROOT_ONLY_CARRIED_SECTIONS = Object.freeze([
  'pulls',
  'subcontracts',
  'requestedRebalance',
  'requestedRebalanceFeeState',
] as const);

export type RscoreDecodedAccountRestore = Readonly<{
  accountId: string;
  storedEntityAccountLeaf: string;
  accountStateRoot: string;
  mempoolRoot: string;
  entityAccountLeaf: string;
  stateSeed: RscoreAccountStateSeed;
  consensus: RscoreConsensusSeed;
  /** Bodies are not present in the exact checkpoint; only these roots are. */
  rootOnlyCarriedSections: typeof RSCORE_ROOT_ONLY_CARRIED_SECTIONS;
}>;

const DERIVED_CONSENSUS_FIELDS: ReadonlySet<string> = new Set([
  'counterpartyDisputeHash',
  'counterpartyDisputeProofBodyHash',
  'counterpartyDisputeProofNonce',
  'counterpartyDisputeProofProposerIsLeft',
  'counterpartyDisputeProofHanko',
  'pendingAccountInput',
  'lastOutboundFrameAck',
  'proofHeader',
  'currentDisputeHash',
  'currentDisputeProofBodyHash',
  'currentDisputeProofNonce',
  'currentDisputeProofProposerIsLeft',
  'counterpartyFrameHanko',
  'currentHeight',
  'rollbackCount',
  'currentFrameHash',
  'pendingFrameHash',
  'lastRollbackFrameHash',
]);

const computeRestoredAccountStateRoot = (seed: RscoreAccountStateSeed): string =>
  computeCanonicalMerkleRoot(
    'account.state',
    [
      [
        'identity',
        {
          chainId: seed.domain.chainId,
          depositoryAddress: seed.domain.depositoryAddress,
          leftEntity: seed.leftEntity,
          rightEntity: seed.rightEntity,
          watchSeed: seed.watchSeed,
        },
      ],
      [
        'financial',
        {
          deltasRoot: seed.deltas.rootHash(),
          jNonce: seed.jNonce,
          disputeConfig: seed.disputeConfig,
        },
      ],
      [
        'commitments',
        {
          locksRoot: seed.locks.rootHash(),
          pullsRoot: seed.carried.pullsRoot,
          swapOffersRoot: seed.swapOffers.rootHash(),
          subcontractsRoot: seed.carried.subcontractsRoot,
          lendingIntentsRoot: seed.lendingIntents.rootHash(),
        },
      ],
      [
        'jurisdiction',
        {
          lastFinalizedJHeight: seed.lastFinalizedJHeight,
          leftPendingJClaims: seed.carried.leftPendingJClaims,
          rightPendingJClaims: seed.carried.rightPendingJClaims,
        },
      ],
      [
        'rebalance',
        {
          requestedRebalanceRoot: seed.carried.requestedRebalanceRoot,
          requestedRebalanceFeeStateRoot: seed.carried.requestedRebalanceFeeStateRoot,
          rebalanceFeePoliciesRoot: seed.rebalanceFeePolicies.rootHash(),
        },
      ],
    ],
    'integrity',
  );

const disputeBinding = (draft: RscoreDisputeDraft): Record<string, unknown> => ({
  hash: draft.hash,
  proofBodyHash: draft.proofBodyHash,
  proofNonce: draft.nonce,
  proposerIsLeft: draft.proposerIsLeft,
});

const ackFields = (ack: RscoreOutboundAck): Record<string, unknown> => ({
  height: ack.height,
  frameHash: ack.frameHash,
  ...(ack.dispute ? { disputeHanko: disputeBinding(ack.dispute) } : {}),
});

const pendingBinding = (pending: RscorePendingFrame, seed: RscoreAccountStateSeed): Record<string, unknown> => ({
  kind: pending.bundledAck ? 'frame_ack' : 'frame',
  fromEntityId: seed.ownerEntityId,
  toEntityId: seed.accountId,
  proposal: {
    height: pending.frame.height,
    frameHash: pending.frame.stateHash,
    ...(pending.proposalDispute ? { disputeHanko: disputeBinding(pending.proposalDispute) } : {}),
  },
  ...(pending.bundledAck ? { ack: ackFields(pending.bundledAck) } : {}),
});

const outboundAckBinding = (ack: RscoreOutboundAck, seed: RscoreAccountStateSeed): Record<string, unknown> => ({
  height: ack.height,
  counterpartyEntityId: seed.accountId,
  response: {
    kind: 'ack',
    fromEntityId: seed.ownerEntityId,
    toEntityId: seed.accountId,
    ack: ackFields(ack),
  },
});

const expectedDisputeHash = (
  draft: Pick<RscoreDisputeDraft, 'proofBodyHash' | 'nonce' | 'proposerIsLeft'>,
  seed: RscoreAccountStateSeed,
): string =>
  createDisputeProofHashWithNonce(
    { leftEntity: seed.leftEntity, rightEntity: seed.rightEntity, watchSeed: seed.watchSeed },
    draft.proofBodyHash,
    seed.domain,
    draft.nonce,
    draft.proposerIsLeft,
  ).toLowerCase();

const validateDisputeHashes = (consensus: RscoreConsensusSeed, seed: RscoreAccountStateSeed): void => {
  const drafts = [
    consensus.dispute,
    consensus.lastOutboundAck?.dispute,
    consensus.pending?.proposalDispute,
    consensus.pending?.bundledAck?.dispute,
  ].filter((draft): draft is RscoreDisputeDraft => draft !== undefined);
  for (const draft of drafts) {
    if (draft.hash !== expectedDisputeHash(draft, seed)) checkpointRestoreFail('DISPUTE_HASH_MISMATCH');
  }
};

const hankoDigest = (hanko: string): string => computeIntegrityDigest(new TextEncoder().encode(hanko));

const computeRestoredEntityLeaf = (
  seed: RscoreAccountStateSeed,
  consensus: RscoreConsensusSeed,
  accountStateRoot: string,
  mempoolRoot: string,
): string => {
  const projection = Object.fromEntries(
    Object.entries(seed.envelope.fields).filter(([field]) => !DERIVED_CONSENSUS_FIELDS.has(field)),
  );
  projection['currentHeight'] = consensus.currentFrame?.height ?? 0;
  projection['rollbackCount'] = consensus.rollbackCount;
  if (consensus.currentFrame) projection['currentFrameHash'] = consensus.currentFrame.stateHash;
  if (consensus.pending) projection['pendingFrameHash'] = consensus.pending.frame.stateHash;
  if (consensus.lastRollbackFrameHash) projection['lastRollbackFrameHash'] = consensus.lastRollbackFrameHash;
  if (consensus.pending) projection['pendingAccountInput'] = pendingBinding(consensus.pending, seed);
  if (consensus.dispute) {
    projection['currentDisputeHash'] = consensus.dispute.hash;
    projection['currentDisputeProofBodyHash'] = consensus.dispute.proofBodyHash;
    projection['currentDisputeProofNonce'] = consensus.dispute.nonce;
    projection['currentDisputeProofProposerIsLeft'] = consensus.dispute.proposerIsLeft;
  }
  projection['proofHeader'] = {
    fromEntity: seed.ownerEntityId,
    toEntity: seed.accountId,
    nextProofNonce: consensus.nextProofNonce,
  };
  if (consensus.lastOutboundAck) {
    projection['lastOutboundFrameAck'] = outboundAckBinding(consensus.lastOutboundAck, seed);
  }
  if (consensus.counterpartyDispute) {
    const dispute = consensus.counterpartyDispute;
    projection['counterpartyDisputeHash'] = expectedDisputeHash(dispute, seed);
    projection['counterpartyDisputeProofBodyHash'] = dispute.proofBodyHash;
    projection['counterpartyDisputeProofNonce'] = dispute.nonce;
    projection['counterpartyDisputeProofProposerIsLeft'] = dispute.proposerIsLeft;
    projection['counterpartyDisputeProofHanko'] = hankoDigest(dispute.hanko);
  }
  if (consensus.counterpartyFrameHanko) {
    projection['counterpartyFrameHanko'] = hankoDigest(consensus.counterpartyFrameHanko);
  }
  projection['accountStateRoot'] = accountStateRoot;
  projection['mempoolRoot'] = mempoolRoot;
  return computeEntityAccountLeafDigest(Object.entries(projection));
};

export const decodeRscoreAccountRestoreRow = (value: unknown): RscoreDecodedAccountRestore => {
  const row = rscoreCheckpointTuple(value, 9, 'RESTORE_ACCOUNT');
  const accountId = checkpointHex(row[0], 32, 'ACCOUNT_ID');
  const storedEntityAccountLeaf = checkpointHex(row[1], 32, 'ACCOUNT_LEAF');
  const stateSeed = decodeRscoreAccountStateSeed(accountId, row[2], row.slice(3, 8));
  const consensus = decodeRscoreConsensusSeed(row[8]);
  if (stateSeed.domain.chainId === 0) checkpointRestoreFail('CHAIN_ID_ZERO');
  if (stateSeed.envelope.canonicalMempool.length !== consensus.mempool.length) {
    checkpointRestoreFail('ENVELOPE_MEMPOOL_LENGTH');
  }
  const canonicalMempool = consensus.mempool.map(canonicalAccountTxForFrameHash);
  for (const [index, expected] of canonicalMempool.entries()) {
    assertSameRscoreCanonicalValue(
      stateSeed.envelope.canonicalMempool[index],
      expected,
      `RESTORE_ENVELOPE_MEMPOOL_${index}`,
    );
  }
  validateDisputeHashes(consensus, stateSeed);
  const accountStateRoot = computeRestoredAccountStateRoot(stateSeed);
  if (
    consensus.currentFrame?.accountStateRoot !== undefined &&
    consensus.currentFrame.accountStateRoot !== accountStateRoot
  ) {
    checkpointRestoreFail('CURRENT_ACCOUNT_STATE_ROOT_MISMATCH');
  }
  const mempoolRoot =
    canonicalMempool.length === 0
      ? EMPTY_ACCOUNT_STATE_ROOT
      : computeCanonicalMerkleRoot(
          'entity.account-mempool',
          canonicalMempool.map((tx, index) => [String(index), tx] as const),
          'integrity',
        );
  const entityAccountLeaf = computeRestoredEntityLeaf(stateSeed, consensus, accountStateRoot, mempoolRoot);
  if (entityAccountLeaf !== storedEntityAccountLeaf) checkpointRestoreFail('ACCOUNT_LEAF_MISMATCH');
  return {
    accountId,
    storedEntityAccountLeaf,
    accountStateRoot,
    mempoolRoot,
    entityAccountLeaf,
    stateSeed,
    consensus,
    rootOnlyCarriedSections: RSCORE_ROOT_ONLY_CARRIED_SECTIONS,
  };
};
