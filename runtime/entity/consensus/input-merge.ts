import type { EntityTx, JurisdictionEventData, RoutedEntityInput } from '../../types';
import { signatureMapSize } from '../../protocol/signatures';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { HEAVY_LOGS } from '../../utils';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';

const entityInputMergeLog = createStructuredLogger('entity.input.merge');

const mergeJEventTxs = (txs: EntityTx[]): EntityTx[] => {
  const merged: EntityTx[] = [];
  const seenSignedObservations = new Set<string>();
  const seenSignedCheckpoints = new Set<string>();

  for (const tx of txs) {
    if (tx.type === 'j_history_checkpoint') {
      const checkpointKey = safeStringify({
        from: String(tx.data.from || '').toLowerCase(),
        jurisdictionRef: String(tx.data.jurisdictionRef || '').toLowerCase(),
        baseHeight: tx.data.baseHeight,
        scannedThroughHeight: tx.data.scannedThroughHeight,
        tipBlockHash: String(tx.data.tipBlockHash || '').toLowerCase(),
        eventHistoryRoot: String(tx.data.eventHistoryRoot || '').toLowerCase(),
        signature: String(tx.data.signature || '').toLowerCase(),
      });
      if (seenSignedCheckpoints.has(checkpointKey)) continue;
      seenSignedCheckpoints.add(checkpointKey);
      merged.push(tx);
      continue;
    }
    if (tx.type !== 'j_event' || !tx.data) {
      merged.push(tx);
      continue;
    }

    const data = tx.data as JurisdictionEventData;
    const signedObservationKey = safeStringify({
      from: String(data.from || '').toLowerCase(),
      jurisdictionRef: String(data.jurisdictionRef || '').toLowerCase(),
      blockNumber: data.blockNumber,
      blockHash: String(data.blockHash || '').toLowerCase(),
      transactionHash: String(data.transactionHash || '').toLowerCase(),
      eventsHash: String(data.eventsHash || '').toLowerCase(),
      disputeFinalizationEvidenceHash: String(data.disputeFinalizationEvidenceHash || '').toLowerCase(),
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
  entityTxs: input.entityTxs ?? [],
});

const sortMergedEntityInputs = (inputs: RoutedEntityInput[]): RoutedEntityInput[] =>
  [...inputs].sort((left, right) =>
    compareStableText(canonicalEntityInputSortKey(left), canonicalEntityInputSortKey(right)));

export const mergeEntityInputs = (inputs: RoutedEntityInput[]): RoutedEntityInput[] => {
  const merged = new Map<string, RoutedEntityInput>();
  const conflicts: RoutedEntityInput[] = [];
  let duplicateCount = 0;
  const isCommitNotificationFrame = (input: RoutedEntityInput): boolean =>
    signatureMapSize(input.proposedFrame?.collectedSigs) > 0;

  for (const input of inputs) {
    const key = `${input.entityId}:${input.signerId || ''}`;
    const entityShort = input.entityId.slice(0, 10);

    if (merged.has(key)) {
      const existing = merged.get(key)!;
      duplicateCount++;

      const existingFrameHash = existing.proposedFrame?.hash;
      const incomingFrameHash = input.proposedFrame?.hash;
      if (existingFrameHash && incomingFrameHash && existingFrameHash !== incomingFrameHash) {
        const existingHasPrecommits = !!existing.hashPrecommits && existing.hashPrecommits.size > 0;
        const incomingHasPrecommits = !!input.hashPrecommits && input.hashPrecommits.size > 0;
        entityInputMergeLog.warn('frame.conflict', {
          entity: shortId(input.entityId),
          signer: shortId(input.signerId || ''),
          existing: shortHash(existingFrameHash),
          incoming: shortHash(incomingFrameHash),
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
          existingPrecommits.set(signerId, sigs);
        });
        existing.hashPrecommits = existingPrecommits;
        if (HEAVY_LOGS) entityInputMergeLog.debug('precommits.result', { total: existingPrecommits.size });
      }

      if (input.proposedFrame) {
        const existingIsCommit = isCommitNotificationFrame(existing);
        const incomingIsCommit = isCommitNotificationFrame(input);
        if (!existing.proposedFrame || incomingIsCommit || !existingIsCommit) {
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
