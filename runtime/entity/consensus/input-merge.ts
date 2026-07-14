import type { EntityTx, JurisdictionEventData, RoutedEntityInput } from '../../types';
import { hasEntityCommitCertificate, signatureMapSize } from '../../protocol/signatures';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { HEAVY_LOGS } from '../../utils';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import { hashEntityLeaderVoteBody } from './leader';

const entityInputMergeLog = createStructuredLogger('entity.input.merge');

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

const prioritizeScheduledWake = (txs: EntityTx[]): EntityTx[] => {
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
  leaderTimeoutVote: input.leaderTimeoutVote
    ? {
        targetHeight: input.leaderTimeoutVote.targetHeight,
        voterId: input.leaderTimeoutVote.voterId.toLowerCase(),
        voteHash: hashEntityLeaderVoteBody(input.leaderTimeoutVote),
      }
    : null,
  entityTxs: input.entityTxs ?? [],
});

const entityInputMergeKey = (input: RoutedEntityInput): string => {
  const base = `${input.entityId.toLowerCase()}:${String(input.signerId || '').toLowerCase()}`;
  const vote = input.leaderTimeoutVote;
  if (!vote) return base;
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

const sortMergedEntityInputs = (inputs: RoutedEntityInput[]): RoutedEntityInput[] =>
  [...inputs].sort((left, right) => {
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
    return compareStableText(canonicalEntityInputSortKey(left), canonicalEntityInputSortKey(right));
  });

export const mergeEntityInputs = (inputs: RoutedEntityInput[]): RoutedEntityInput[] => {
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
        const existingIsCommit = hasEntityCommitCertificate(existing.proposedFrame);
        const incomingIsCommit = hasEntityCommitCertificate(input.proposedFrame);
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
    return { ...input, entityTxs: prioritizeScheduledWake(mergeJEventTxs(input.entityTxs)) };
  }));
};
