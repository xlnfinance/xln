import type { EntityTx, JPrefixAttestation, JurisdictionEventData, RoutedEntityInput } from '../../types';
import { signatureMapSize } from '../../protocol/signatures';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { HEAVY_LOGS } from '../../utils';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import { hashEntityLeaderVoteBody } from './leader';
import { hashJPrefixAttestation } from '../../jurisdiction/j-prefix-consensus';
import { getEffectiveEntityInputTxs } from './output-envelope';

const entityInputMergeLog = createStructuredLogger('entity.input.merge');

const jPrefixAttestationHash = (attestation: JPrefixAttestation): string => {
  const { signature: _signature, ...unsigned } = attestation;
  return hashJPrefixAttestation(unsigned);
};

const mergeJEventTxs = (txs: EntityTx[]): EntityTx[] => {
  const merged: EntityTx[] = [];
  const seenSignedObservations = new Set<string>();

  for (const tx of txs) {
    if (tx.type !== 'j_event' || !tx.data) {
      merged.push(tx);
      continue;
    }

    const data = tx.data as JurisdictionEventData;
    const signedObservationKey = safeStringify({
      from: String(data.from || '').toLowerCase(),
      jurisdictionRef: String(data.jurisdictionRef || '').toLowerCase(),
      baseHeight: data.baseHeight,
      scannedThroughHeight: data.scannedThroughHeight,
      tipBlockHash: String(data.tipBlockHash || '').toLowerCase(),
      eventHistoryRoot: String(data.eventHistoryRoot || '').toLowerCase(),
      rangeHash: String(data.rangeHash || '').toLowerCase(),
      signature: String(data.signature || '').toLowerCase(),
    });
    if (seenSignedObservations.has(signedObservationKey)) continue;
    seenSignedObservations.add(signedObservationKey);
    merged.push(tx);
  }

  return merged;
};

export const prioritizeScheduledWakeTransactions = (txs: EntityTx[]): EntityTx[] => {
  const wakes = txs.filter(tx => tx.type === 'scheduledWake');
  if (wakes.length === 0) return txs;
  const canonicalWake = safeStringify(wakes[0]);
  if (wakes.some(wake => safeStringify(wake) !== canonicalWake)) {
    throw new Error('SCHEDULED_WAKE_CONFLICTING_INPUTS');
  }
  // The wake was computed from frame-start state. Run it before user/network
  // txs so a tx that replaces the same hook cannot invalidate or consume it.
  return [wakes[0]!, ...txs.filter(tx => tx.type !== 'scheduledWake')];
};

const canonicalEntityInputSortKey = (input: RoutedEntityInput): string => safeStringify({
  entityId: String(input.entityId || '').toLowerCase(),
  signerId: String(input.signerId || '').toLowerCase(),
  from: String(input.from || '').toLowerCase(),
  runtimeId: String(input.runtimeId || '').toLowerCase(),
  proposedFrame: input.proposedFrame
    ? {
        height: input.proposedFrame.height,
        hash: input.proposedFrame.hash,
      }
    : null,
  hashPrecommitCount: signatureMapSize(input.hashPrecommits),
  hashPrecommitFrame: input.hashPrecommitFrame ?? null,
  leaderTimeoutVote: input.leaderTimeoutVote
    ? {
        targetHeight: input.leaderTimeoutVote.targetHeight,
        voterId: input.leaderTimeoutVote.voterId.toLowerCase(),
        voteHash: hashEntityLeaderVoteBody(input.leaderTimeoutVote),
      }
    : null,
  jPrefixAttestations: input.jPrefixAttestations
    ? Array.from(input.jPrefixAttestations.entries()).map(([signerId, attestation]) => ({
        signerId: signerId.toLowerCase(),
        targetEntityHeight: attestation.targetEntityHeight,
        hash: jPrefixAttestationHash(attestation),
      }))
    : null,
  entityTxs: input.entityTxs ?? [],
});

type ConsensusInputOrder = Readonly<{
  targetHeight: number;
  priority: number;
}>;

export type EntityCommitPriorityPredicate = (input: RoutedEntityInput) => boolean;

const isProtocolEntityInput = (input: RoutedEntityInput): boolean =>
  Boolean(
    input.proposedFrame ||
    input.leaderTimeoutVote ||
    input.hashPrecommits?.size ||
    input.jPrefixAttestations?.size,
  ) || getEffectiveEntityInputTxs(input).some(tx =>
    tx.type === 'accountInput' || tx.type === 'j_event');

/**
 * Keep account/Entity/J consensus responsive when a runtime also receives a
 * bulk stream of ordinary certified outputs. The partition is stable and
 * reorders whole authenticated inputs, so it cannot alter a command or the
 * transaction order certified by its source Entity.
 */
export const prioritizeProtocolEntityInputs = <T extends RoutedEntityInput>(
  inputs: readonly T[],
): T[] => {
  const protocol: T[] = [];
  const ordinary: T[] = [];
  for (const input of inputs) {
    (isProtocolEntityInput(input) ? protocol : ordinary).push(input);
  }
  return protocol.length > 0 && ordinary.length > 0
    ? [...protocol, ...ordinary]
    : [...inputs];
};

const consensusInputOrder = (
  input: RoutedEntityInput,
  hasVerifiedCommit: EntityCommitPriorityPredicate,
): ConsensusInputOrder | null => {
  if (input.proposedFrame && hasVerifiedCommit(input)) {
    return { targetHeight: input.proposedFrame.height, priority: 0 };
  }
  if (input.leaderTimeoutVote) {
    return { targetHeight: input.leaderTimeoutVote.targetHeight, priority: 1 };
  }
  if (input.proposedFrame) {
    return { targetHeight: input.proposedFrame.height, priority: 2 };
  }
  return null;
};

/**
 * Reorder only the slots belonging to one Entity/signer/height consensus race.
 * A due signed view change wins over every unverified network frame envelope.
 * `hankos` are proposer-supplied bytes until consensus replays the frame and
 * verifies the actual board quorum, so they must never influence pre-cap
 * scheduling. A later valid commit remains authoritative. Unrelated lanes
 * retain their exact order.
 */
export const prioritizeEntityConsensusInputs = <T extends RoutedEntityInput>(
  inputs: readonly T[],
  hasVerifiedCommit: EntityCommitPriorityPredicate = () => false,
): T[] => {
  const result = [...inputs];
  const positionsByRound = new Map<string, number[]>();
  result.forEach((input, index) => {
    const order = consensusInputOrder(input, hasVerifiedCommit);
    if (!order) return;
    const key = `${input.entityId.trim().toLowerCase()}:` +
      `${input.signerId.trim().toLowerCase()}:${order.targetHeight}`;
    const positions = positionsByRound.get(key) ?? [];
    positions.push(index);
    positionsByRound.set(key, positions);
  });
  for (const positions of positionsByRound.values()) {
    if (positions.length < 2) continue;
    const ordered = positions
      .map((position, stableIndex) => ({
        input: result[position]!,
        stableIndex,
        priority: consensusInputOrder(result[position]!, hasVerifiedCommit)!.priority,
      }))
      .sort((left, right) => left.priority - right.priority || left.stableIndex - right.stableIndex)
      .map(entry => entry.input);
    positions.forEach((position, index) => {
      result[position] = ordered[index]!;
    });
  }
  return result;
};

const entityInputMergeKey = (input: RoutedEntityInput): string => {
  const base = `${input.entityId.toLowerCase()}:${String(input.signerId || '').toLowerCase()}`;
  if (input.jPrefixAttestations) {
    if (input.jPrefixAttestations.size !== 1) throw new Error('ENTITY_INPUT_J_PREFIX_MUST_BE_SPLIT');
    const entry = input.jPrefixAttestations.entries().next().value;
    if (!entry) throw new Error('ENTITY_INPUT_J_PREFIX_MISSING');
    const [rawSignerId, attestation] = entry;
    return `${base}:j-prefix:${rawSignerId.toLowerCase()}:` +
      `${attestation.targetEntityHeight}:${jPrefixAttestationHash(attestation)}`;
  }
  const vote = input.leaderTimeoutVote;
  if (!vote && input.hashPrecommits && input.hashPrecommits.size > 0) {
    const reference = input.hashPrecommitFrame;
    if (!reference) throw new Error('ENTITY_INPUT_PRECOMMIT_FRAME_REFERENCE_MISSING');
    return `${base}:precommit:${reference.height}:${reference.frameHash.toLowerCase()}`;
  }
  if (!vote) {
    // `from` is the authenticated runtime provenance used by ingress policy.
    // Combining transaction envelopes from different runtimes erases that
    // provenance and can make one sender appear to have authored another
    // sender's cross-j output. Local inputs still share the same empty-origin
    // lane and retain the normal same-frame merge behavior.
    return input.entityTxs?.length
      ? `${base}:tx-origin:${String(input.from || '').trim().toLowerCase()}`
      : base;
  }
  // Each timeout vote is its own signed consensus message. Collapsing several
  // voters into the target replica's route key drops quorum evidence before
  // Entity consensus can validate it.
  return `${base}:leader:${vote.targetHeight}:${vote.voterId.toLowerCase()}:${hashEntityLeaderVoteBody(vote)}`;
};

const mergePrecommitBundles = (
  existing: Map<string, string[]> | undefined,
  incoming: Map<string, string[]>,
): Map<string, string[]> => {
  const normalize = (bundles: Map<string, string[]>, source: string): Map<string, string[]> => {
    const normalized = new Map<string, string[]>();
    for (const [rawSignerId, signatures] of bundles) {
      const signerId = rawSignerId.trim().toLowerCase();
      if (normalized.has(signerId)) {
        throw new Error(`ENTITY_INPUT_PRECOMMIT_DUPLICATE_SIGNER:${source}:${rawSignerId}`);
      }
      normalized.set(signerId, [...signatures]);
    }
    return normalized;
  };
  const merged = existing ? normalize(existing, 'existing') : new Map<string, string[]>();
  const normalizedIncoming = normalize(incoming, 'incoming');
  for (const [signerId, signatures] of normalizedIncoming) {
    const previous = merged.get(signerId);
    if (previous) {
      const exactDuplicate = previous.length === signatures.length &&
        previous.every((signature, index) => signature === signatures[index]);
      if (!exactDuplicate) throw new Error(`ENTITY_INPUT_PRECOMMIT_EQUIVOCATION:${signerId}`);
      continue;
    }
    merged.set(signerId, [...signatures]);
  }
  return merged;
};

const sortMergedEntityInputs = (
  inputs: RoutedEntityInput[],
  hasVerifiedCommit: EntityCommitPriorityPredicate,
): RoutedEntityInput[] =>
  prioritizeEntityConsensusInputs([...inputs].sort((left, right) => {
    const entityOrder = compareStableText(left.entityId.toLowerCase(), right.entityId.toLowerCase());
    if (entityOrder !== 0) return entityOrder;
    const signerOrder = compareStableText(
      String(left.signerId || '').toLowerCase(),
      String(right.signerId || '').toLowerCase(),
    );
    if (signerOrder !== 0) return signerOrder;
    if (left.proposedFrame && right.proposedFrame && left.proposedFrame.height !== right.proposedFrame.height) {
      return left.proposedFrame.height - right.proposedFrame.height;
    }
    if (
      left.hashPrecommitFrame &&
      right.hashPrecommitFrame &&
      left.hashPrecommitFrame.height !== right.hashPrecommitFrame.height
    ) return left.hashPrecommitFrame.height - right.hashPrecommitFrame.height;
    return compareStableText(canonicalEntityInputSortKey(left), canonicalEntityInputSortKey(right));
  }), hasVerifiedCommit);

export const mergeEntityInputs = (
  inputs: RoutedEntityInput[],
  hasVerifiedCommit: EntityCommitPriorityPredicate = () => false,
): RoutedEntityInput[] => {
  const merged = new Map<string, RoutedEntityInput>();
  const conflicts: RoutedEntityInput[] = [];
  let duplicateCount = 0;
  for (const input of inputs) {
    const key = entityInputMergeKey(input);
    const entityShort = input.entityId.slice(0, 10);

    if (merged.has(key)) {
      const existing = merged.get(key)!;
      duplicateCount++;

      if (input.leaderTimeoutVote || existing.leaderTimeoutVote) {
        if (safeStringify(input.leaderTimeoutVote) !== safeStringify(existing.leaderTimeoutVote)) {
          throw new Error(`ENTITY_LEADER_VOTE_EQUIVOCATION:${input.leaderTimeoutVote?.voterId ?? 'missing'}`);
        }
      }

      if (input.jPrefixAttestations || existing.jPrefixAttestations) {
        if (
          safeStringify(input.jPrefixAttestations) !==
          safeStringify(existing.jPrefixAttestations)
        ) {
          throw new Error('ENTITY_INPUT_J_PREFIX_EQUIVOCATION');
        }
      }

      const existingFrameHash = existing.proposedFrame?.hash;
      const incomingFrameHash = input.proposedFrame?.hash;
      const existingFrameHeight = existing.proposedFrame?.height;
      const incomingFrameHeight = input.proposedFrame?.height;
      if (
        existingFrameHash &&
        incomingFrameHash &&
        (existingFrameHash !== incomingFrameHash || existingFrameHeight !== incomingFrameHeight)
      ) {
        const existingHasPrecommits = !!existing.hashPrecommits && existing.hashPrecommits.size > 0;
        const incomingHasPrecommits = !!input.hashPrecommits && input.hashPrecommits.size > 0;
        entityInputMergeLog.warn('frame.conflict', {
          entity: shortId(input.entityId),
          signer: shortId(input.signerId || ''),
          existing: shortHash(existingFrameHash),
          incoming: shortHash(incomingFrameHash),
          existingHeight: existingFrameHeight,
          incomingHeight: incomingFrameHeight,
          existingHasPrecommits,
          incomingHasPrecommits,
        });
        if (incomingHasPrecommits && !existingHasPrecommits) {
          merged.set(key, { ...input });
          conflicts.push(existing);
        } else {
          conflicts.push(input);
        }
        continue;
      }

      if (HEAVY_LOGS) {
        entityInputMergeLog.debug('duplicate.found', {
          duplicateCount,
          entity: entityShort,
          signer: shortId(input.signerId || ''),
        });
      }

      if (input.entityTxs) {
        existing.entityTxs = [...(existing.entityTxs || []), ...input.entityTxs];
        if (existing.entityTxs) {
          existing.entityTxs = mergeJEventTxs(existing.entityTxs);
        }
        if (HEAVY_LOGS) entityInputMergeLog.debug('txs.added', { count: input.entityTxs.length });
      }

      if (input.hashPrecommits) {
        const existingPrecommits = existing.hashPrecommits || new Map<string, string[]>();
        if (HEAVY_LOGS) {
          entityInputMergeLog.debug('precommits.merge', {
            incoming: input.hashPrecommits.size,
            existing: existingPrecommits.size,
            entity: entityShort,
            signer: shortId(input.signerId || ''),
          });
        }
        input.hashPrecommits.forEach((sigs, signerId) => {
          if (HEAVY_LOGS) {
            entityInputMergeLog.debug('precommit.added', {
              signer: shortId(signerId),
              signatures: sigs.length,
            });
          }
        });
        existing.hashPrecommits = mergePrecommitBundles(existing.hashPrecommits, input.hashPrecommits);
        if (HEAVY_LOGS) {
          entityInputMergeLog.debug('precommits.result', { total: existing.hashPrecommits.size });
        }
      }

      if (input.proposedFrame) {
        const existingIsCommit = hasVerifiedCommit(existing);
        const incomingIsCommit = hasVerifiedCommit(input);
        if (!existing.proposedFrame || (incomingIsCommit && !existingIsCommit)) {
          existing.proposedFrame = input.proposedFrame;
        }
      }

      if (HEAVY_LOGS) {
        entityInputMergeLog.debug('input.merged', {
          entity: shortId(input.entityId),
          signer: shortId(input.signerId || ''),
          txs: input.entityTxs?.length || 0,
          hashPrecommits: input.hashPrecommits?.size || 0,
          frame: Boolean(input.proposedFrame),
        });
      }
    } else {
      merged.set(key, { ...input });
    }
  }

  if (HEAVY_LOGS && duplicateCount > 0) {
    entityInputMergeLog.debug('duplicates.deduped', {
      duplicates: duplicateCount,
      inputs: inputs.length,
      merged: merged.size,
    });
  }

  const mergedInputs = Array.from(merged.values());
  return sortMergedEntityInputs([...mergedInputs, ...conflicts].map(input => {
    if (!input.entityTxs || input.entityTxs.length === 0) return input;
    return { ...input, entityTxs: prioritizeScheduledWakeTransactions(mergeJEventTxs(input.entityTxs)) };
  }), hasVerifiedCommit);
};
