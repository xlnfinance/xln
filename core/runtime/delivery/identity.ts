import type { RuntimeReplica, RoutedEntityInput } from '../types';
import { hasEntityCommitCertificate } from '../../entity/auth/signatures';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import { txFingerprint } from '../../protocol/state/tx-multiset';
import { safeStringify } from '../../protocol/serialization';
import { hashEntityLeaderVoteBody } from '../../entity/consensus/leader';
import { getEffectiveEntityInputTxs } from '../../entity/consensus/output/envelope';
import { accountInputProposal } from '../../account/consensus/flush';

export const carriesEntityCommitNotification = (output: RoutedEntityInput): boolean =>
  hasEntityCommitCertificate(output.proposedFrame);

export const copyRoutedOutputForMerge = <T extends RoutedEntityInput>(output: T): T => {
  // Delivery normalization mutates only the routed envelope's own fields. The
  // consensus payloads below it are immutable evidence and must not be walked
  // or copied merely to acquire an isolated merge target. In particular, an
  // Entity frame can contain a very large Account/order-book projection.
  return {
    ...output,
    ...(output.entityTxs ? { entityTxs: [...output.entityTxs] } : {}),
    ...(output.hashPrecommits
      ? {
          hashPrecommits: new Map(
            [...output.hashPrecommits].map(([signerId, signatures]) => [signerId, [...signatures]]),
          ),
        }
      : {}),
    ...(output.jPrefixAttestations ? { jPrefixAttestations: new Map(output.jPrefixAttestations) } : {}),
  } as T;
};

export const normalizeRouteText = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * One routed output per consensus payload kind: Entity frame, precommit bundle,
 * leader vote, each J-prefix attestation, and the txs together. Delivery is
 * best effort; splitting only keeps route keys and merges per payload kind.
 */
export const splitRoutedOutputByDeliveryLane = <T extends RoutedEntityInput>(output: T): T[] => {
  const {
    entityTxs = [],
    proposedFrame,
    hashPrecommits,
    hashPrecommitFrame,
    jPrefixAttestations,
    leaderTimeoutVote,
    ...route
  } = output;
  const split: RoutedEntityInput[] = [];
  const routeInput = route as RoutedEntityInput;

  if (proposedFrame) split.push({ ...routeInput, proposedFrame });
  if (hashPrecommits && hashPrecommits.size > 0) {
    if (!hashPrecommitFrame) throw new Error('ROUTE_PRECOMMIT_FRAME_REFERENCE_MISSING');
    split.push({ ...routeInput, hashPrecommitFrame, hashPrecommits });
  } else if (hashPrecommitFrame) {
    throw new Error('ROUTE_PRECOMMIT_FRAME_REFERENCE_WITHOUT_SIGNATURES');
  }
  if (leaderTimeoutVote) split.push({ ...routeInput, leaderTimeoutVote });
  if (jPrefixAttestations) {
    for (const [signerId, attestation] of jPrefixAttestations) {
      // Attestations are signed immutable evidence. Split the Map shell only.
      split.push({ ...routeInput, jPrefixAttestations: new Map([[signerId, attestation]]) });
    }
  }
  if (entityTxs.length > 0 || split.length === 0) split.push({ ...routeInput, entityTxs });
  return split as T[];
};

export const accountProposalOutputIdentity = (output: RoutedEntityInput): string | null => {
  const txs = getEffectiveEntityInputTxs(output);
  if (txs.length === 0) return null;
  const proposals = txs.flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const proposal = accountInputProposal(tx.data);
    return proposal ? [{ accountInput: tx.data, proposal }] : [];
  });
  if (proposals.length !== txs.length) return null;
  return safeStringify({
    runtimeId: normalizeRuntimeId(output.runtimeId),
    entityId: output.entityId.toLowerCase(),
    signerId: normalizeRouteText(output.signerId),
    from: normalizeRuntimeId(output.from),
    proposals: proposals.map(({ accountInput, proposal }) => ({
      fromEntityId: accountInput.fromEntityId.toLowerCase(),
      toEntityId: accountInput.toEntityId.toLowerCase(),
      height: proposal.frame.height,
      stateHash: proposal.frame.stateHash.toLowerCase(),
    })),
  });
};

export const accountProposalEvidenceRank = (output: RoutedEntityInput): number =>
  getEffectiveEntityInputTxs(output).reduce((rank, tx) => {
    if (tx.type !== 'accountInput') return rank;
    const proposal = accountInputProposal(tx.data);
    if (!proposal) return rank;
    return rank + Number(Boolean(proposal.frameHanko)) + Number(Boolean(proposal.disputeSeal));
  }, 0);

const senderAccountForProposal = (
  env: RuntimeReplica,
  fromEntityId: string,
  toEntityId: string,
) => {
  const owner = fromEntityId.toLowerCase();
  const counterparty = toEntityId.toLowerCase();
  for (const replica of env.state.eReplicas.values()) {
    if (replica.entityId.toLowerCase() !== owner) continue;
    const account = replica.state.accounts.get(counterparty);
    if (account) return account;
  }
  return null;
};

/**
 * Bilateral Account consensus allows exactly one pending frame per account, so a
 * proposal is live in the outbox for exactly as long as it *is* that frame.
 * Asking whether the sender still holds the frame covers both terminals
 * (commit and rollback) with one question and cannot leave a duplicate behind.
 */
export const accountProposalSettledBySender = (env: RuntimeReplica, output: RoutedEntityInput): boolean => {
  const proposals = getEffectiveEntityInputTxs(output).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const proposal = accountInputProposal(tx.data);
    return proposal ? [{ accountInput: tx.data, proposal }] : [];
  });
  if (proposals.length === 0) return false;
  return proposals.every(({ accountInput, proposal }) => {
    const account = senderAccountForProposal(env, accountInput.fromEntityId, accountInput.toEntityId);
    // An account the sender no longer hosts cannot advance this proposal either.
    if (!account) return true;
    const pending = account.pendingFrame;
    return !(
      pending?.height === proposal.frame.height &&
      pending.stateHash.toLowerCase() === proposal.frame.stateHash.toLowerCase()
    );
  });
};

/** Dedup/merge key for one split routed output: route + exact payload kind. */
export const buildRouteOutputKey = (output: RoutedEntityInput): string => {
  const accountProposalIdentity = accountProposalOutputIdentity(output);
  if (accountProposalIdentity) return accountProposalIdentity;
  return safeStringify({
    runtimeId: output.runtimeId ?? '',
    sourceRuntimeFrame: output.sourceRuntimeFrame ?? null,
    entityId: output.entityId.toLowerCase(),
    signerId: normalizeRouteText(output.signerId),
    from: output.from ?? '',
    frame: output.proposedFrame ? { height: output.proposedFrame.height, hash: output.proposedFrame.hash } : null,
    precommit: output.hashPrecommitFrame
      ? { ...output.hashPrecommitFrame, signers: [...(output.hashPrecommits?.keys() ?? [])].sort() }
      : null,
    vote: output.leaderTimeoutVote
      ? { voterId: output.leaderTimeoutVote.voterId.toLowerCase(), hash: hashEntityLeaderVoteBody(output.leaderTimeoutVote) }
      : null,
    attestations: [...(output.jPrefixAttestations?.keys() ?? [])].sort(),
    txs: (output.entityTxs || []).map(tx => txFingerprint(tx)),
  });
};
