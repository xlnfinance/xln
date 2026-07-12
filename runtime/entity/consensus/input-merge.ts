import type { EntityTx, JurisdictionEvent, JurisdictionEventData, RoutedEntityInput } from '../../types';
import { signatureMapSize } from '../../protocol/signatures';
import { compareStableText, safeStringify } from '../../serialization-utils';
import { HEAVY_LOGS } from '../../utils';
import { createStructuredLogger, shortHash, shortId } from '../../logger';

const entityInputMergeLog = createStructuredLogger('entity.input.merge');

const mergeJEventTxs = (txs: EntityTx[]): EntityTx[] => {
  const merged: EntityTx[] = [];

  const normalizeJEventList = (data: JurisdictionEventData, source: string): JurisdictionEvent[] => {
    if (data.events !== undefined) {
      if (!Array.isArray(data.events)) {
        throw new Error(`RUNTIME_J_EVENT_EVENTS_NOT_ARRAY:${source}`);
      }
      return data.events;
    }
    return data.event ? [data.event] : [];
  };

  for (const tx of txs) {
    if (tx.type !== 'j_event' || !tx.data) {
      merged.push(tx);
      continue;
    }

    const data = tx.data as JurisdictionEventData;
    const blockNumber = data.blockNumber;
    const blockHash = data.blockHash;

    const existing = merged.find(
      candidate =>
        candidate.type === 'j_event' &&
        candidate.data &&
        candidate.data.blockNumber === blockNumber &&
        candidate.data.blockHash === blockHash,
    );

    if (!existing || !existing.data) {
      merged.push(tx);
      continue;
    }

    const existingData = existing.data as JurisdictionEventData;
    const existingEvents = normalizeJEventList(existingData, 'existing');
    const incomingEvents = normalizeJEventList(data, 'incoming');

    const seen = new Set<string>();
    const mergedEvents: JurisdictionEvent[] = [];
    for (const event of [...existingEvents, ...incomingEvents]) {
      const key = `${event?.type ?? 'unknown'}:${safeStringify(event?.data ?? event)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mergedEvents.push(event);
    }

    const firstMergedEvent = mergedEvents[0];
    if (!firstMergedEvent) continue;
    existingData.events = mergedEvents;
    existingData.event = firstMergedEvent;

    if (typeof data.observedAt === 'number') {
      if (typeof existingData.observedAt !== 'number' || data.observedAt < existingData.observedAt) {
        existingData.observedAt = data.observedAt;
      }
    }

    if (HEAVY_LOGS) {
      entityInputMergeLog.debug('j_events.merged', {
        blockNumber,
        blockHash: typeof blockHash === 'string' ? shortHash(blockHash) : blockHash,
        events: mergedEvents.length,
      });
    }
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
