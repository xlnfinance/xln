import type { EntityTx, JurisdictionEvent, JurisdictionEventData, RoutedEntityInput } from './types';
import { signatureMapSize } from './consensus-signatures';
import { safeStringify } from './serialization-utils';
import { HEAVY_LOGS } from './utils';

const mergeJEventTxs = (txs: EntityTx[]): EntityTx[] => {
  const merged: EntityTx[] = [];

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
    const existingEvents = existingData.events || (existingData.event ? [existingData.event] : []);
    const incomingEvents = data.events || (data.event ? [data.event] : []);

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
      console.log(
        `🔍 MERGE-J-EVENTS: block ${blockNumber} ${blockHash?.slice(0, 10)}... now ${mergedEvents.length} events`,
      );
    }
  }

  return merged;
};

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
        console.warn(
          `⚠️  MERGE-CONFLICT: ${key} has different proposedFrame hashes (${existingFrameHash.slice(0, 10)} vs ${incomingFrameHash.slice(0, 10)}) - keeping both inputs`,
        );
        if (incomingHasPrecommits && !existingHasPrecommits) {
          merged.set(key, { ...input });
          conflicts.push(existing);
        } else {
          conflicts.push(input);
        }
        continue;
      }

      if (HEAVY_LOGS) console.log(`🔍 DUPLICATE-FOUND: Merging duplicate input ${duplicateCount} for ${entityShort}:${input.signerId || ''}`);

      if (input.entityTxs) {
        existing.entityTxs = [...(existing.entityTxs || []), ...input.entityTxs];
        if (existing.entityTxs) {
          existing.entityTxs = mergeJEventTxs(existing.entityTxs);
        }
        if (HEAVY_LOGS) console.log(`🔍 MERGE-TXS: Added ${input.entityTxs.length} transactions`);
      }

      if (input.hashPrecommits) {
        const existingPrecommits = existing.hashPrecommits || new Map<string, string[]>();
        if (HEAVY_LOGS) {
          console.log(
            `🔍 MERGE-PRECOMMITS: Merging ${input.hashPrecommits.size} hashPrecommits into existing ${existingPrecommits.size} for ${entityShort}:${input.signerId || ''}`,
          );
        }
        input.hashPrecommits.forEach((sigs, signerId) => {
          if (HEAVY_LOGS) console.log(`🔍 MERGE-DETAIL: Adding hashPrecommit from ${signerId} (${sigs.length} sigs)`);
          existingPrecommits.set(signerId, sigs);
        });
        existing.hashPrecommits = existingPrecommits;
        if (HEAVY_LOGS) console.log(`🔍 MERGE-RESULT: Total ${existingPrecommits.size} hashPrecommits after merge`);
      }

      if (input.proposedFrame) {
        const existingIsCommit = isCommitNotificationFrame(existing);
        const incomingIsCommit = isCommitNotificationFrame(input);
        if (!existing.proposedFrame || incomingIsCommit || !existingIsCommit) {
          existing.proposedFrame = input.proposedFrame;
        }
      }

      if (HEAVY_LOGS) {
        console.log(
          `    🔄 Merging inputs for ${key}: txs=${input.entityTxs?.length || 0}, hashPrecommits=${input.hashPrecommits?.size || 0}, frame=${!!input.proposedFrame}`,
        );
      }
    } else {
      merged.set(key, { ...input });
    }
  }

  if (HEAVY_LOGS && duplicateCount > 0) {
    console.log(`    deduped ${duplicateCount} duplicate inputs (${inputs.length} -> ${merged.size})`);
  }

  const mergedInputs = Array.from(merged.values());
  return [...mergedInputs, ...conflicts].map(input => {
    if (input.entityTxs && input.entityTxs.length > 1) {
      return { ...input, entityTxs: mergeJEventTxs(input.entityTxs) };
    }
    return input;
  });
};
