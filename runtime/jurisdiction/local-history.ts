import type {
  EntityState,
  JurisdictionEventBlock,
  JurisdictionEventData,
  ValidatorJBlockHeader,
  ValidatorJEventBlock,
  ValidatorJHistory,
} from '../types';
import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
} from './event-observation';
import {
  compareCanonicalJurisdictionEvents,
  normalizeJurisdictionEvents,
} from './event-normalization';
import {
  canonicalJEventRangeHash,
  EMPTY_J_HISTORY_ROOT,
  foldJHistoryRoot,
} from './history-consensus';

const normalizedText = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const normalizeEventBlock = (
  jurisdictionRef: string,
  block: ValidatorJEventBlock,
): ValidatorJEventBlock => {
  const jHeight = Number(block.jHeight);
  if (!Number.isSafeInteger(jHeight) || jHeight <= 0) throw new Error('J_HISTORY_LOCAL_BLOCK_HEIGHT_INVALID');
  const blockJurisdiction = normalizedText(block.jurisdictionRef);
  if (blockJurisdiction !== jurisdictionRef) throw new Error('J_HISTORY_LOCAL_JURISDICTION_MISMATCH');
  const jBlockHash = normalizedText(block.jBlockHash);
  if (!jBlockHash) throw new Error('J_HISTORY_LOCAL_BLOCK_HASH_MISSING');
  const events = normalizeJurisdictionEvents(block.events).sort(compareCanonicalJurisdictionEvents);
  const eventsHash = canonicalJurisdictionEventsHash(events);
  if (normalizedText(block.eventsHash) !== eventsHash) throw new Error('J_HISTORY_LOCAL_EVENTS_HASH_MISMATCH');
  const evidence = block.disputeFinalizationEvidence;
  const evidenceHash = evidence?.length ? canonicalDisputeFinalizationEvidenceHash(evidence) : '';
  if (normalizedText(block.disputeFinalizationEvidenceHash) !== evidenceHash) {
    throw new Error('J_HISTORY_LOCAL_EVIDENCE_HASH_MISMATCH');
  }
  return {
    jurisdictionRef,
    jHeight,
    jBlockHash,
    eventsHash,
    events,
    ...(evidence?.length ? { disputeFinalizationEvidence: structuredClone(evidence) } : {}),
    ...(evidenceHash ? { disputeFinalizationEvidenceHash: evidenceHash } : {}),
  };
};

const blockIdentity = (block: Pick<ValidatorJEventBlock, 'jBlockHash' | 'eventsHash'>): string =>
  `${normalizedText(block.jBlockHash)}:${normalizedText(block.eventsHash)}`;

export const recordValidatorJHistory = (
  current: ValidatorJHistory | undefined,
  input: {
    jurisdictionRef: string;
    scannedThroughHeight: number;
    tipBlockHash: string;
    headers?: ValidatorJBlockHeader[];
    blocks: ValidatorJEventBlock[];
  },
): ValidatorJHistory => {
  const jurisdictionRef = normalizedText(input.jurisdictionRef);
  if (!jurisdictionRef) throw new Error('J_HISTORY_LOCAL_JURISDICTION_MISSING');
  const scannedThroughHeight = Number(input.scannedThroughHeight);
  if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight <= 0) {
    throw new Error('J_HISTORY_LOCAL_SCANNED_HEIGHT_INVALID');
  }
  const tipBlockHash = normalizedText(input.tipBlockHash);
  if (!tipBlockHash) throw new Error('J_HISTORY_LOCAL_TIP_HASH_MISSING');
  if (current && normalizedText(current.jurisdictionRef) !== jurisdictionRef) {
    throw new Error('J_HISTORY_LOCAL_JURISDICTION_REBIND');
  }

  const eventBlocks = new Map(current?.eventBlocks ?? []);
  const blockHashes = new Map(current?.blockHashes ?? []);
  for (const header of input.headers ?? []) {
    const jHeight = Number(header.jHeight);
    const jBlockHash = normalizedText(header.jBlockHash);
    if (!Number.isSafeInteger(jHeight) || jHeight <= 0 || jHeight > scannedThroughHeight) {
      throw new Error('J_HISTORY_LOCAL_HEADER_HEIGHT_INVALID');
    }
    if (!jBlockHash) throw new Error('J_HISTORY_LOCAL_HEADER_HASH_MISSING');
    const existingHash = blockHashes.get(jHeight);
    if (existingHash && normalizedText(existingHash) !== jBlockHash) {
      throw new Error(`J_HISTORY_LOCAL_REORG_AT_BLOCK:${jHeight}`);
    }
    blockHashes.set(jHeight, jBlockHash);
  }
  for (const rawBlock of input.blocks) {
    const block = normalizeEventBlock(jurisdictionRef, rawBlock);
    if (block.jHeight > scannedThroughHeight) throw new Error('J_HISTORY_LOCAL_BLOCK_ABOVE_SCAN_TIP');
    const existing = eventBlocks.get(block.jHeight);
    if (existing && blockIdentity(existing) !== blockIdentity(block)) {
      throw new Error(`J_HISTORY_LOCAL_REORG_AT_EVENT_BLOCK:${block.jHeight}`);
    }
    const existingHash = blockHashes.get(block.jHeight);
    if (existingHash && normalizedText(existingHash) !== block.jBlockHash) {
      throw new Error(`J_HISTORY_LOCAL_REORG_AT_BLOCK:${block.jHeight}`);
    }
    eventBlocks.set(block.jHeight, block);
    blockHashes.set(block.jHeight, block.jBlockHash);
  }

  const existingTipHash = blockHashes.get(scannedThroughHeight);
  if (existingTipHash && normalizedText(existingTipHash) !== tipBlockHash) {
    throw new Error(`J_HISTORY_LOCAL_REORG_AT_TIP:${scannedThroughHeight}`);
  }
  blockHashes.set(scannedThroughHeight, tipBlockHash);
  const previousScanned = current?.scannedThroughHeight ?? 0;
  return {
    jurisdictionRef,
    scannedThroughHeight: Math.max(previousScanned, scannedThroughHeight),
    tipBlockHash: scannedThroughHeight >= previousScanned ? tipBlockHash : current!.tipBlockHash,
    eventBlocks,
    blockHashes,
  };
};

export const finalizedJHistoryRoot = (state: EntityState): string =>
  state.jHistoryFinality?.eventHistoryRoot || foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, state.jBlockChain);

const toWireBlock = (block: ValidatorJEventBlock): JurisdictionEventBlock => ({
  blockNumber: block.jHeight,
  blockHash: block.jBlockHash,
  eventsHash: block.eventsHash,
  events: structuredClone(block.events),
  ...(block.disputeFinalizationEvidence?.length
    ? { disputeFinalizationEvidence: structuredClone(block.disputeFinalizationEvidence) }
    : {}),
  ...(block.disputeFinalizationEvidenceHash
    ? { disputeFinalizationEvidenceHash: block.disputeFinalizationEvidenceHash }
    : {}),
});

export const buildUnsignedJEventRange = (
  state: EntityState,
  history: ValidatorJHistory,
): Omit<JurisdictionEventData, 'from' | 'signature' | 'observedAt'> | null => {
  const baseHeight = state.lastFinalizedJHeight;
  if (history.scannedThroughHeight <= baseHeight) return null;
  const blocks = [...history.eventBlocks.values()]
    .filter((block) => block.jHeight > baseHeight && block.jHeight <= history.scannedThroughHeight)
    .sort((left, right) => left.jHeight - right.jHeight)
    .map(toWireBlock);
  const eventHistoryRoot = foldJHistoryRoot(finalizedJHistoryRoot(state), blocks.map((block) => ({
    jurisdictionRef: history.jurisdictionRef,
    jHeight: block.blockNumber,
    jBlockHash: block.blockHash,
    eventsHash: block.eventsHash,
  })));
  return {
    jurisdictionRef: history.jurisdictionRef,
    baseHeight,
    scannedThroughHeight: history.scannedThroughHeight,
    tipBlockHash: history.tipBlockHash,
    eventHistoryRoot,
    rangeHash: canonicalJEventRangeHash(history.jurisdictionRef, blocks),
    blocks,
  };
};

export const getJEventRangeValidationError = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
  data: JurisdictionEventData,
  activeProposerId: string,
): string | null => {
  if (normalizedText(data.from) !== normalizedText(activeProposerId)) return 'J_RANGE_NOT_ACTIVE_PROPOSER';
  const jurisdictionRef = normalizedText(data.jurisdictionRef);
  if (!history || normalizedText(history.jurisdictionRef) !== jurisdictionRef) return 'J_RANGE_LOCAL_HISTORY_MISSING';
  if (data.baseHeight !== state.lastFinalizedJHeight) return 'J_RANGE_BASE_HEIGHT_MISMATCH';
  if (!Number.isSafeInteger(data.scannedThroughHeight) || data.scannedThroughHeight <= data.baseHeight) {
    return 'J_RANGE_HEIGHT_INVALID';
  }
  if (history.scannedThroughHeight < data.scannedThroughHeight) return 'J_RANGE_LOCAL_HISTORY_BEHIND';
  const localBlocks = [...history.eventBlocks.values()]
    .filter((block) => block.jHeight > data.baseHeight && block.jHeight <= data.scannedThroughHeight)
    .sort((left, right) => left.jHeight - right.jHeight);
  if (localBlocks.length !== data.blocks.length) return 'J_RANGE_EVENT_BLOCK_COUNT_MISMATCH';
  for (let index = 0; index < data.blocks.length; index += 1) {
    const proposed = data.blocks[index]!;
    const local = localBlocks[index]!;
    const normalized = normalizeEventBlock(jurisdictionRef, {
      jurisdictionRef,
      jHeight: proposed.blockNumber,
      jBlockHash: proposed.blockHash,
      eventsHash: proposed.eventsHash,
      events: proposed.events,
      ...(proposed.disputeFinalizationEvidence ? { disputeFinalizationEvidence: proposed.disputeFinalizationEvidence } : {}),
      ...(proposed.disputeFinalizationEvidenceHash
        ? { disputeFinalizationEvidenceHash: proposed.disputeFinalizationEvidenceHash }
        : {}),
    });
    if (normalized.jHeight !== local.jHeight || blockIdentity(normalized) !== blockIdentity(local)) {
      return 'J_RANGE_EVENT_BLOCK_MISMATCH';
    }
  }
  const knownTipHash = history.blockHashes.get(data.scannedThroughHeight);
  if (!knownTipHash) return 'J_RANGE_LOCAL_TIP_UNKNOWN';
  if (normalizedText(knownTipHash) !== normalizedText(data.tipBlockHash)) {
    return 'J_RANGE_TIP_HASH_MISMATCH';
  }
  if (canonicalJEventRangeHash(jurisdictionRef, data.blocks) !== normalizedText(data.rangeHash)) {
    return 'J_RANGE_BODY_HASH_MISMATCH';
  }
  const expectedRoot = foldJHistoryRoot(finalizedJHistoryRoot(state), localBlocks);
  if (expectedRoot !== normalizedText(data.eventHistoryRoot)) return 'J_RANGE_HISTORY_ROOT_MISMATCH';
  return null;
};

export const pruneFinalizedValidatorJHistory = (
  history: ValidatorJHistory | undefined,
  finalizedThroughHeight: number,
): ValidatorJHistory | undefined => {
  if (!history) return undefined;
  return {
    ...history,
    eventBlocks: new Map([...history.eventBlocks].filter(([height]) => height > finalizedThroughHeight)),
    // Keep the finalized anchor itself. It lets the watcher distinguish a
    // recoverable reorg in the private suffix from a settlement-chain finality
    // violation, without retaining the full finalized header history.
    blockHashes: new Map([...history.blockHashes].filter(([height]) => height >= finalizedThroughHeight)),
  };
};

export const getValidatorJExpectedBlockHash = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
  jHeight: number,
): string | null => {
  const localHash = history?.blockHashes.get(jHeight);
  if (localHash) return normalizedText(localHash);
  const finality = state.jHistoryFinality;
  if (finality?.finalizedThroughHeight === jHeight) return normalizedText(finality.tipBlockHash);
  return null;
};

/** Drop only validator-private evidence above the last E-certified J height. */
export const rewindValidatorJHistory = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
): ValidatorJHistory | undefined => {
  if (!history) return undefined;
  const finalizedHeight = Number(state.lastFinalizedJHeight || 0);
  if (!Number.isSafeInteger(finalizedHeight) || finalizedHeight < 0) {
    throw new Error('J_HISTORY_REWIND_FINALIZED_HEIGHT_INVALID');
  }
  const jurisdictionRef = normalizedText(history.jurisdictionRef);
  const finalizedHash = getValidatorJExpectedBlockHash(state, history, finalizedHeight);
  if (finalizedHeight === 0 || !finalizedHash) return undefined;
  return {
    jurisdictionRef,
    scannedThroughHeight: finalizedHeight,
    tipBlockHash: finalizedHash,
    eventBlocks: new Map(),
    blockHashes: new Map([[finalizedHeight, finalizedHash]]),
  };
};
