import type { RuntimeReplica, RoutedEntityInput } from '../types';
import { hasEntityCommitCertificate } from '../../entity/auth/signatures';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import { txFingerprint } from '../../protocol/state/tx-multiset';
import { safeStringify } from '../../protocol/serialization';
import { hashEntityLeaderVoteBody } from '../../entity/consensus/leader';
import { getEffectiveEntityInputTxs } from '../../entity/consensus/output/envelope';
import { accountInputAck, accountInputProposal } from '../../account/consensus/flush';

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
  // Scalars only; a flat joined key is the same identity as the former JSON.
  return `ap|${normalizeRuntimeId(output.runtimeId)}|${output.entityId.toLowerCase()}|${normalizeRouteText(output.signerId)}` +
    `|${normalizeRuntimeId(output.from)}|` +
    proposals.map(({ accountInput, proposal }) =>
      `${accountInput.fromEntityId.toLowerCase()}:${accountInput.toEntityId.toLowerCase()}:${proposal.frame.height}:${proposal.frame.stateHash.toLowerCase()}`,
    ).join(',');
};

export const accountProposalEvidenceRank = (output: RoutedEntityInput): number =>
  getEffectiveEntityInputTxs(output).reduce((rank, tx) => {
    if (tx.type !== 'accountInput') return rank;
    const proposal = accountInputProposal(tx.data);
    if (!proposal) return rank;
    return rank + Number(Boolean(proposal.frameHanko)) + Number(Boolean(proposal.disputeHanko));
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
 *
 * A `ack_frame` also carries the ACK for the previous height. That ACK is still
 * owed after the successor proposal leaves `pendingFrame`. Pruning the whole
 * envelope then strands the peer as proposer: receiver idle, proposer pending.
 */
export const accountProposalSettledBySender = (env: RuntimeReplica, output: RoutedEntityInput): boolean => {
  const proposals = getEffectiveEntityInputTxs(output).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const proposal = accountInputProposal(tx.data);
    return proposal ? [{ accountInput: tx.data, proposal, ack: accountInputAck(tx.data) }] : [];
  });
  if (proposals.length === 0) return false;
  if (proposals.some(part => part.ack)) return false;
  return proposals.every(({ accountInput, proposal }) => {
    const account = senderAccountForProposal(env, accountInput.fromEntityId, accountInput.toEntityId);
    if (!account) {
      throw new Error(
        `ACCOUNT_PROPOSAL_OUTBOX_SOURCE_ACCOUNT_MISSING:${safeStringify({
          runtimeId: env.runtimeId,
          fromEntityId: accountInput.fromEntityId,
          toEntityId: accountInput.toEntityId,
          proposalHeight: proposal.frame.height,
          proposalStateHash: proposal.frame.stateHash,
          output,
        })}`,
      );
    }
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
  const frame = output.sourceRuntimeFrame;
  const precommit = output.hashPrecommitFrame;
  return `ro|${output.runtimeId ?? ''}|${frame ? `${frame.height}:${frame.timestamp}` : ''}` +
    `|${output.entityId.toLowerCase()}|${normalizeRouteText(output.signerId)}|${output.from ?? ''}` +
    `|${output.proposedFrame ? `${output.proposedFrame.height}:${output.proposedFrame.hash}` : ''}` +
    `|${precommit ? `${precommit.height}:${precommit.frameHash}:${[...(output.hashPrecommits?.keys() ?? [])].sort().join(',')}` : ''}` +
    `|${output.leaderTimeoutVote ? `${output.leaderTimeoutVote.voterId.toLowerCase()}:${hashEntityLeaderVoteBody(output.leaderTimeoutVote)}` : ''}` +
    `|${[...(output.jPrefixAttestations?.keys() ?? [])].sort().join(',')}` +
    `|${(output.entityTxs || []).map(tx => txFingerprint(tx)).join('\u0001')}`;
};
