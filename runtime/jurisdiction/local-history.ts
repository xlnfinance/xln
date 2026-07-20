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
  getJEventJurisdictionRef,
  normalizeDisputeFinalizationEvidence,
} from './event-observation';
import {
  compareCanonicalJurisdictionEvents,
  normalizeJurisdictionEvents,
} from './event-normalization';
import {
  canonicalJEventRangeHash,
  EMPTY_J_HISTORY_ROOT,
  foldJHistoryRoot,
  getJHistoryRegistrationBaseHeight,
} from './history-consensus';
import {
  type JEventRangeSignatureVerifier,
  validateJEventRangeEnvelope,
} from './j-event-range-validation';

/** Bounded UI/audit cache. It is never consulted as consensus authority. */
export const MAX_CERTIFIED_J_EVENT_BLOCKS = 256;

const normalizedText = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const normalizedHistoryRoot = (value: unknown, errorCode: string): string => {
  const root = normalizedText(value);
  if (!/^0x[0-9a-f]{64}$/.test(root)) throw new Error(errorCode);
  return root;
};

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
  const evidence = normalizeDisputeFinalizationEvidence(block.disputeFinalizationEvidence ?? []);
  const evidenceHash = evidence.length ? canonicalDisputeFinalizationEvidenceHash(evidence) : '';
  if (normalizedText(block.disputeFinalizationEvidenceHash) !== evidenceHash) {
    throw new Error('J_HISTORY_LOCAL_EVIDENCE_HASH_MISMATCH');
  }
  return {
    jurisdictionRef,
    jHeight,
    jBlockHash,
    eventsHash,
    events,
    ...(evidence.length ? { disputeFinalizationEvidence: evidence } : {}),
    ...(evidenceHash ? { disputeFinalizationEvidenceHash: evidenceHash } : {}),
  };
};

type ExactJBlockIdentity = Pick<
  ValidatorJEventBlock,
  'jBlockHash' | 'eventsHash' | 'disputeFinalizationEvidenceHash'
>;

/** Reducer identity also commits calldata evidence that is absent from logs. */
const blockIdentity = (block: ExactJBlockIdentity): string =>
  `${normalizedText(block.jBlockHash)}:${normalizedText(block.eventsHash)}:` +
  normalizedText(block.disputeFinalizationEvidenceHash);

export const isCertifiedJHistoryCorruption = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /^J_HISTORY_(?:FINALITY|FINALIZED)_/.test(message);
};

export type EntityCertifiedJAnchor = {
  height: number;
  hash: string;
  jurisdictionRef: string;
  eventHistoryRoot: string;
};

/**
 * Entity consensus needs one settlement-chain anchor, not historical leaves.
 * Once a range commits, its events are already reflected in Entity state.
 */
export const getEntityCertifiedJAnchor = (state: EntityState): EntityCertifiedJAnchor | null => {
  const finality = state.jHistoryFinality;
  const stateHeight = Number(state.lastFinalizedJHeight || 0);
  if (!Number.isSafeInteger(stateHeight) || stateHeight < 0) {
    throw new Error(`J_HISTORY_FINALITY_HEIGHT_CORRUPTION:state=${String(state.lastFinalizedJHeight)}`);
  }
  if (!finality) {
    const registrationBase = getJHistoryRegistrationBaseHeight(state.config.jurisdiction);
    if (stateHeight !== registrationBase || state.jBlockChain.length !== 0) {
      throw new Error(
        `J_HISTORY_FINALITY_MISSING:state=${stateHeight}:registrationBase=${registrationBase}:blocks=${state.jBlockChain.length}`,
      );
    }
    return null;
  }
  const height = Number(finality.finalizedThroughHeight);
  if (!Number.isSafeInteger(height) || height <= 0 || height !== stateHeight) {
    throw new Error(
      `J_HISTORY_FINALITY_HEIGHT_CORRUPTION:state=${stateHeight}:anchor=${String(finality.finalizedThroughHeight)}`,
    );
  }
  const hash = normalizedText(finality.tipBlockHash);
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('J_HISTORY_FINALITY_HASH_CORRUPTION');
  const jurisdictionRef = normalizedText(finality.jurisdictionRef);
  if (!jurisdictionRef) throw new Error('J_HISTORY_FINALITY_JURISDICTION_CORRUPTION');
  const eventHistoryRoot = normalizedHistoryRoot(
    finality.eventHistoryRoot,
    'J_HISTORY_FINALITY_ROOT_CORRUPTION:certified-root-invalid',
  );
  return { height, hash, jurisdictionRef, eventHistoryRoot };
};

const assertDisplayBlockIntegrity = (
  block: EntityState['jBlockChain'][number],
  anchor: EntityCertifiedJAnchor,
  previousHeight: number,
): number => {
  const height = Number(block.jHeight);
  if (!Number.isSafeInteger(height) || height <= previousHeight || height > anchor.height) {
    const code = height === previousHeight
      ? 'J_HISTORY_FINALITY_DUPLICATE_BLOCK'
      : 'J_HISTORY_FINALITY_BLOCK_HEIGHT_CORRUPTION';
    throw new Error(`${code}:${String(height)}`);
  }
  if (normalizedText(block.jurisdictionRef) !== anchor.jurisdictionRef) {
    throw new Error(`J_HISTORY_FINALITY_BLOCK_JURISDICTION_CORRUPTION:${height}`);
  }
  const blockHash = normalizedText(block.jBlockHash);
  if (!/^0x[0-9a-f]{64}$/.test(blockHash)) {
    throw new Error(`J_HISTORY_FINALITY_BLOCK_HASH_CORRUPTION:${height}`);
  }
  const normalizedEvents = normalizeJurisdictionEvents(block.events);
  if (!Array.isArray(block.events) || normalizedEvents.length !== block.events.length) {
    throw new Error(`J_HISTORY_FINALITY_EVENT_BODY_CORRUPTION:${height}`);
  }
  if (normalizedEvents.length === 0) throw new Error(`J_HISTORY_FINALITY_EMPTY_EVENT_BLOCK:${height}`);
  const orderedEvents = [...normalizedEvents].sort(compareCanonicalJurisdictionEvents);
  for (let index = 0; index < orderedEvents.length; index += 1) {
    if (
      canonicalJurisdictionEventsHash([normalizedEvents[index]!]) !==
      canonicalJurisdictionEventsHash([orderedEvents[index]!])
    ) {
      throw new Error(`J_HISTORY_FINALITY_EVENT_ORDER_CORRUPTION:${height}`);
    }
    const event = orderedEvents[index]!;
    if (Number(event.blockNumber) !== height || normalizedText(event.blockHash) !== blockHash) {
      throw new Error(`J_HISTORY_FINALITY_EVENT_BLOCK_CORRUPTION:${height}`);
    }
  }
  if (canonicalJurisdictionEventsHash(orderedEvents) !== normalizedText(block.eventsHash)) {
    throw new Error(`J_HISTORY_FINALITY_EVENTS_HASH_CORRUPTION:${height}`);
  }
  if (height === anchor.height && blockHash !== anchor.hash) {
    throw new Error(`J_HISTORY_FINALITY_TIP_CORRUPTION:${height}`);
  }
  return height;
};

/**
 * Restore validates the current anchor plus the bounded display cache. The
 * cache may be deleted without changing authority; it is never folded to
 * reconstruct the certified root.
 */
export const assertCertifiedJHistoryIntegrity = (state: EntityState): void => {
  const anchor = getEntityCertifiedJAnchor(state);
  if (!anchor) return;
  if (state.jBlockChain.length > MAX_CERTIFIED_J_EVENT_BLOCKS) {
    throw new Error(`J_HISTORY_FINALITY_DISPLAY_OVERFLOW:${state.jBlockChain.length}`);
  }
  let previousHeight = 0;
  for (const block of state.jBlockChain) {
    previousHeight = assertDisplayBlockIntegrity(block, anchor, previousHeight);
  }
};

const assertValidatorJHistoryMatchesAnchor = (
  anchor: EntityCertifiedJAnchor | null,
  history: ValidatorJHistory | undefined,
): void => {
  if (!history) return;
  const scannedThroughHeight = Number(history.scannedThroughHeight);
  const contiguousThroughHeight = Number(history.contiguousThroughHeight);
  if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight <= 0) {
    throw new Error(`J_HISTORY_LOCAL_SCANNED_HEIGHT_CORRUPTION:${String(history.scannedThroughHeight)}`);
  }
  if (
    !Number.isSafeInteger(contiguousThroughHeight) ||
    contiguousThroughHeight < 0 ||
    contiguousThroughHeight > scannedThroughHeight
  ) {
    throw new Error(
      `J_HISTORY_LOCAL_CONTIGUOUS_HEIGHT_CORRUPTION:${String(history.contiguousThroughHeight)}:${scannedThroughHeight}`,
    );
  }
  const localTipHash = history.blockHashes.get(scannedThroughHeight);
  if (!localTipHash || normalizedText(localTipHash) !== normalizedText(history.tipBlockHash)) {
    throw new Error(`J_HISTORY_LOCAL_TIP_CORRUPTION:${scannedThroughHeight}`);
  }
  if (!anchor) return;
  if (normalizedText(history.jurisdictionRef) !== anchor.jurisdictionRef) {
    throw new Error('J_HISTORY_FINALITY_JURISDICTION_CONFLICT');
  }
  const localAnchorHash = history.blockHashes.get(anchor.height);
  if (localAnchorHash && normalizedText(localAnchorHash) !== anchor.hash) {
    throw new Error(`J_HISTORY_FINALIZED_REORG:${anchor.height}`);
  }
  const localAnchorBlock = history.eventBlocks.get(anchor.height);
  if (localAnchorBlock && normalizedText(localAnchorBlock.jBlockHash) !== anchor.hash) {
    throw new Error(`J_HISTORY_FINALIZED_REORG:${anchor.height}`);
  }
};

export const assertValidatorJHistoryMatchesCertifiedAnchor = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
): void => assertValidatorJHistoryMatchesAnchor(getEntityCertifiedJAnchor(state), history);

/** Full persisted-history check. Hot-path recording only needs the O(1) checks above. */
export const assertValidatorJHistoryIntegrity = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
): void => {
  const anchor = getEntityCertifiedJAnchor(state);
  assertValidatorJHistoryMatchesAnchor(anchor, history);
  if (!history) return;
  const baseHeight = Number(state.lastFinalizedJHeight);
  for (
    let height = baseHeight + 1;
    height <= Math.max(baseHeight, history.contiguousThroughHeight);
    height += 1
  ) {
    if (!history.blockHashes.has(height)) {
      throw new Error(`J_HISTORY_LOCAL_CONTIGUOUS_HEADER_MISSING:${height}`);
    }
  }
};

/**
 * Resolve the cached frontier against the Entity-certified base. The base can
 * advance when a frame commits, so an older cache value below it is harmless;
 * the certified anchor itself supplies that prefix authority.
 */
export const getValidatorJContiguousThroughHeight = (
  state: EntityState,
  history: ValidatorJHistory,
): number => {
  assertValidatorJHistoryMatchesAnchor(getEntityCertifiedJAnchor(state), history);
  const baseHeight = Number(state.lastFinalizedJHeight || 0);
  if (history.scannedThroughHeight < baseHeight) {
    throw new Error(
      `J_HISTORY_LOCAL_BEHIND_FINALIZED_ANCHOR:${history.scannedThroughHeight}:${baseHeight}`,
    );
  }
  let contiguousThroughHeight = Math.max(baseHeight, history.contiguousThroughHeight);
  while (
    contiguousThroughHeight < history.scannedThroughHeight &&
    history.blockHashes.has(contiguousThroughHeight + 1)
  ) {
    contiguousThroughHeight += 1;
  }
  return contiguousThroughHeight;
};

export const recordValidatorJHistory = (
  current: ValidatorJHistory | undefined,
  input: {
    jurisdictionRef: string;
    scannedThroughHeight: number;
    tipBlockHash: string;
    headers?: ValidatorJBlockHeader[];
    blocks: ValidatorJEventBlock[];
  },
  state?: EntityState,
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

  const anchor = state ? getEntityCertifiedJAnchor(state) : null;
  if (anchor && anchor.jurisdictionRef !== jurisdictionRef) {
    throw new Error('J_HISTORY_FINALITY_JURISDICTION_CONFLICT');
  }
  if (anchor && scannedThroughHeight < anchor.height) {
    throw new Error(`J_HISTORY_LOCAL_BEHIND_FINALIZED_ANCHOR:${scannedThroughHeight}:${anchor.height}`);
  }
  assertValidatorJHistoryMatchesAnchor(anchor, current);

  const minimumRetainedHeight = state ? Number(state.lastFinalizedJHeight) : 0;
  const eventBlocks = new Map(
    [...(current?.eventBlocks ?? [])].filter(([height]) => height >= minimumRetainedHeight),
  );
  const blockHashes = new Map(
    [...(current?.blockHashes ?? [])].filter(([height]) => height >= minimumRetainedHeight),
  );
  if (anchor) blockHashes.set(anchor.height, anchor.hash);

  for (const header of input.headers ?? []) {
    const jHeight = Number(header.jHeight);
    const jBlockHash = normalizedText(header.jBlockHash);
    if (!Number.isSafeInteger(jHeight) || jHeight <= 0 || jHeight > scannedThroughHeight) {
      throw new Error('J_HISTORY_LOCAL_HEADER_HEIGHT_INVALID');
    }
    if (!jBlockHash) throw new Error('J_HISTORY_LOCAL_HEADER_HASH_MISSING');
    if (anchor && jHeight < anchor.height) continue;
    if (anchor && jHeight === anchor.height && jBlockHash !== anchor.hash) {
      throw new Error(`J_HISTORY_FINALIZED_REORG:${jHeight}`);
    }
    const existingHash = blockHashes.get(jHeight);
    if (existingHash && normalizedText(existingHash) !== jBlockHash) {
      if (anchor?.height === jHeight) throw new Error(`J_HISTORY_FINALIZED_REORG:${jHeight}`);
      throw new Error(`J_HISTORY_LOCAL_REORG_AT_BLOCK:${jHeight}`);
    }
    blockHashes.set(jHeight, jBlockHash);
  }

  for (const rawBlock of input.blocks) {
    const block = normalizeEventBlock(jurisdictionRef, rawBlock);
    if (block.jHeight > scannedThroughHeight) throw new Error('J_HISTORY_LOCAL_BLOCK_ABOVE_SCAN_TIP');
    if (anchor && block.jHeight < anchor.height) continue;
    if (anchor && block.jHeight === anchor.height && block.jBlockHash !== anchor.hash) {
      throw new Error(`J_HISTORY_FINALIZED_REORG:${block.jHeight}`);
    }
    const existing = eventBlocks.get(block.jHeight);
    if (existing && blockIdentity(existing) !== blockIdentity(block)) {
      if (anchor?.height === block.jHeight) throw new Error(`J_HISTORY_FINALIZED_REORG:${block.jHeight}`);
      throw new Error(`J_HISTORY_LOCAL_REORG_AT_EVENT_BLOCK:${block.jHeight}`);
    }
    const existingHash = blockHashes.get(block.jHeight);
    if (existingHash && normalizedText(existingHash) !== block.jBlockHash) {
      if (anchor?.height === block.jHeight) throw new Error(`J_HISTORY_FINALIZED_REORG:${block.jHeight}`);
      throw new Error(`J_HISTORY_LOCAL_REORG_AT_BLOCK:${block.jHeight}`);
    }
    eventBlocks.set(block.jHeight, block);
    blockHashes.set(block.jHeight, block.jBlockHash);
  }

  const existingTipHash = blockHashes.get(scannedThroughHeight);
  if (existingTipHash && normalizedText(existingTipHash) !== tipBlockHash) {
    if (anchor?.height === scannedThroughHeight) {
      throw new Error(`J_HISTORY_FINALIZED_REORG:${scannedThroughHeight}`);
    }
    throw new Error(`J_HISTORY_LOCAL_REORG_AT_TIP:${scannedThroughHeight}`);
  }
  blockHashes.set(scannedThroughHeight, tipBlockHash);
  const previousScanned = current?.scannedThroughHeight ?? 0;
  const nextScannedThroughHeight = Math.max(previousScanned, scannedThroughHeight);
  let contiguousThroughHeight = Math.max(
    current?.contiguousThroughHeight ?? minimumRetainedHeight,
    minimumRetainedHeight,
  );
  while (
    contiguousThroughHeight < nextScannedThroughHeight &&
    blockHashes.has(contiguousThroughHeight + 1)
  ) {
    contiguousThroughHeight += 1;
  }
  const recorded: ValidatorJHistory = {
    jurisdictionRef,
    scannedThroughHeight: nextScannedThroughHeight,
    contiguousThroughHeight,
    tipBlockHash: scannedThroughHeight >= previousScanned ? tipBlockHash : current!.tipBlockHash,
    eventBlocks,
    blockHashes,
  };
  assertValidatorJHistoryMatchesAnchor(anchor, recorded);
  return recorded;
};

export const finalizedJHistoryRoot = (state: EntityState): string =>
  getEntityCertifiedJAnchor(state)?.eventHistoryRoot ?? EMPTY_J_HISTORY_ROOT;

export type ReconciledJEventRange =
  | { kind: 'noop' }
  | {
      kind: 'suffix';
      baseHeight: number;
      scannedThroughHeight: number;
      tipBlockHash: string;
      eventHistoryRoot: string;
      blocks: JurisdictionEventBlock[];
    };

/**
 * The settlement chain is a linked list. A committed range is applied once;
 * any fully stale authenticated delivery is therefore a no-op regardless of
 * its body. A delayed crossing delivery is rebased onto the one current
 * Entity-certified head. The discarded body is never replayed or trusted;
 * the signed resulting root must still equal current certified root + suffix.
 */
export const reconcileJEventRangeWithFinalizedState = (
  state: EntityState,
  data: JurisdictionEventData,
): ReconciledJEventRange => {
  const baseHeight = Number(data.baseHeight);
  const scannedThroughHeight = Number(data.scannedThroughHeight);
  const finalizedHeight = Number(state.lastFinalizedJHeight || 0);
  if (!Number.isSafeInteger(baseHeight) || baseHeight < 0) {
    throw new Error(`J_RANGE_BASE_HEIGHT_INVALID:${String(data.baseHeight)}`);
  }
  if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight <= baseHeight) {
    throw new Error('J_RANGE_HEIGHT_INVALID');
  }
  if (scannedThroughHeight <= finalizedHeight) return { kind: 'noop' };
  if (baseHeight > finalizedHeight) {
    throw new Error(`J_RANGE_BASE_HEIGHT_AHEAD:${baseHeight}:${finalizedHeight}`);
  }
  const anchor = getEntityCertifiedJAnchor(state);
  const jurisdictionRef = normalizedText(data.jurisdictionRef);
  if (anchor && jurisdictionRef !== anchor.jurisdictionRef) {
    throw new Error('J_HISTORY_FINALITY_JURISDICTION_CONFLICT');
  }
  const suffixBlocks = data.blocks.filter((block) => Number(block.blockNumber) > finalizedHeight);
  const eventHistoryRoot = foldJHistoryRoot(
    finalizedJHistoryRoot(state),
    suffixBlocks.map((block) => ({
      jurisdictionRef,
      jHeight: Number(block.blockNumber),
      jBlockHash: normalizedText(block.blockHash),
      eventsHash: normalizedText(block.eventsHash),
      ...(block.disputeFinalizationEvidenceHash
        ? { disputeFinalizationEvidenceHash: normalizedText(block.disputeFinalizationEvidenceHash) }
        : {}),
    })),
  );
  if (eventHistoryRoot !== normalizedText(data.eventHistoryRoot)) {
    throw new Error('J_RANGE_HISTORY_ROOT_MISMATCH');
  }
  return {
    kind: 'suffix',
    baseHeight: finalizedHeight,
    scannedThroughHeight,
    tipBlockHash: normalizedText(data.tipBlockHash),
    eventHistoryRoot,
    blocks: suffixBlocks,
  };
};

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

export const buildUnsignedJEventRangeAtHeight = (
  state: EntityState,
  history: ValidatorJHistory,
  scannedThroughHeight: number,
): Omit<JurisdictionEventData, 'from' | 'signature' | 'observedAt'> | null => {
  const baseHeight = state.lastFinalizedJHeight;
  if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight <= baseHeight) return null;
  if (scannedThroughHeight > history.scannedThroughHeight) {
    throw new Error(`J_PREFIX_LOCAL_HISTORY_BEHIND:${history.scannedThroughHeight}:${scannedThroughHeight}`);
  }
  const tipBlockHash = history.blockHashes.get(scannedThroughHeight);
  if (!tipBlockHash) throw new Error(`J_PREFIX_LOCAL_TIP_HASH_MISSING:${scannedThroughHeight}`);
  const blocks = [...history.eventBlocks.values()]
    .filter((block) => block.jHeight > baseHeight && block.jHeight <= scannedThroughHeight)
    .sort((left, right) => left.jHeight - right.jHeight)
    .map(toWireBlock);
  const eventHistoryRoot = foldJHistoryRoot(finalizedJHistoryRoot(state), blocks.map((block) => ({
    jurisdictionRef: history.jurisdictionRef,
    jHeight: block.blockNumber,
    jBlockHash: block.blockHash,
    eventsHash: block.eventsHash,
    ...(block.disputeFinalizationEvidenceHash
      ? { disputeFinalizationEvidenceHash: block.disputeFinalizationEvidenceHash }
      : {}),
  })));
  return {
    jurisdictionRef: history.jurisdictionRef,
    baseHeight,
    scannedThroughHeight,
    tipBlockHash,
    eventHistoryRoot,
    rangeHash: canonicalJEventRangeHash(history.jurisdictionRef, blocks),
    blocks,
  };
};

export const buildUnsignedJEventRange = (
  state: EntityState,
  history: ValidatorJHistory,
): Omit<JurisdictionEventData, 'from' | 'signature' | 'observedAt'> | null =>
  buildUnsignedJEventRangeAtHeight(state, history, history.scannedThroughHeight);

export const buildValidatorJPrefixHeaders = (
  state: EntityState,
  history: ValidatorJHistory,
  scannedThroughHeight: number,
): ValidatorJBlockHeader[] => {
  const baseHeight = state.lastFinalizedJHeight;
  if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight <= baseHeight) return [];
  if (scannedThroughHeight > history.scannedThroughHeight) {
    throw new Error(`J_PREFIX_LOCAL_HISTORY_BEHIND:${history.scannedThroughHeight}:${scannedThroughHeight}`);
  }
  return Array.from({ length: scannedThroughHeight - baseHeight }, (_, index) => {
    const jHeight = baseHeight + index + 1;
    const jBlockHash = history.blockHashes.get(jHeight);
    if (!jBlockHash) throw new Error(`J_PREFIX_LOCAL_HEADER_MISSING:${jHeight}`);
    return { jHeight, jBlockHash };
  });
};

export const getJEventRangeValidationError = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
  data: JurisdictionEventData,
  activeProposerId: string,
  verifySignature: JEventRangeSignatureVerifier,
): string | null => {
  // Certified state is local authority. Corruption must halt independently of
  // whether the incoming proposer envelope is valid or attacker-controlled.
  const anchor = getEntityCertifiedJAnchor(state);
  const validated = validateJEventRangeEnvelope({
    entityId: state.entityId,
    expectedJurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    activeProposerId,
    data,
    verifySignature,
  });
  if (!validated.ok) return validated.code;
  const canonicalData = validated.range.data;
  const jurisdictionRef = validated.range.jurisdictionRef;
  if (anchor && anchor.jurisdictionRef !== jurisdictionRef) return 'J_RANGE_JURISDICTION_MISMATCH';
  const normalizedProposedBlocks = canonicalData.blocks.map((proposed): ValidatorJEventBlock => ({
    jurisdictionRef,
    jHeight: proposed.blockNumber,
    jBlockHash: proposed.blockHash,
    eventsHash: proposed.eventsHash,
    events: proposed.events,
    ...(proposed.disputeFinalizationEvidence
      ? { disputeFinalizationEvidence: proposed.disputeFinalizationEvidence }
      : {}),
    ...(proposed.disputeFinalizationEvidenceHash
      ? { disputeFinalizationEvidenceHash: proposed.disputeFinalizationEvidenceHash }
      : {}),
  }));
  const reconciliation = reconcileJEventRangeWithFinalizedState(state, canonicalData);
  if (reconciliation.kind === 'noop') return null;
  if (!history || normalizedText(history.jurisdictionRef) !== jurisdictionRef) {
    return 'J_RANGE_LOCAL_HISTORY_MISSING';
  }
  assertValidatorJHistoryMatchesAnchor(anchor, history);
  if (history.scannedThroughHeight < canonicalData.scannedThroughHeight) return 'J_RANGE_LOCAL_HISTORY_BEHIND';
  const normalizedSuffixBlocks = normalizedProposedBlocks.filter(
    block => block.jHeight > reconciliation.baseHeight,
  );
  const localBlocks = [...history.eventBlocks.values()]
    .filter((block) => block.jHeight > reconciliation.baseHeight && block.jHeight <= canonicalData.scannedThroughHeight)
    .sort((left, right) => left.jHeight - right.jHeight);
  if (localBlocks.length !== normalizedSuffixBlocks.length) return 'J_RANGE_EVENT_BLOCK_COUNT_MISMATCH';
  for (let index = 0; index < normalizedSuffixBlocks.length; index += 1) {
    const normalized = normalizedSuffixBlocks[index]!;
    const local = localBlocks[index]!;
    if (normalized.jHeight !== local.jHeight || blockIdentity(normalized) !== blockIdentity(local)) {
      return 'J_RANGE_EVENT_BLOCK_MISMATCH';
    }
  }
  const knownTipHash = history.blockHashes.get(canonicalData.scannedThroughHeight);
  if (!knownTipHash) return 'J_RANGE_LOCAL_TIP_UNKNOWN';
  if (normalizedText(knownTipHash) !== canonicalData.tipBlockHash) {
    return 'J_RANGE_TIP_HASH_MISMATCH';
  }
  return null;
};

/** Drop old display bodies; the current head/root live in jHistoryFinality. */
export const pruneCertifiedJHistory = (state: EntityState): EntityState => {
  if (state.jBlockChain.length <= MAX_CERTIFIED_J_EVENT_BLOCKS) return state;
  return {
    ...state,
    jBlockChain: state.jBlockChain.slice(-MAX_CERTIFIED_J_EVENT_BLOCKS),
  };
};

export const pruneFinalizedValidatorJHistory = (
  history: ValidatorJHistory | undefined,
  finalizedThroughHeight: number,
): ValidatorJHistory | undefined => {
  if (!history) return undefined;
  if (
    !Number.isSafeInteger(finalizedThroughHeight) ||
    finalizedThroughHeight < 0 ||
    finalizedThroughHeight > history.scannedThroughHeight
  ) {
    throw new Error(
      `J_HISTORY_LOCAL_PRUNE_HEIGHT_INVALID:${String(finalizedThroughHeight)}:${history.scannedThroughHeight}`,
    );
  }
  return {
    ...history,
    contiguousThroughHeight: Math.max(history.contiguousThroughHeight, finalizedThroughHeight),
    eventBlocks: new Map([...history.eventBlocks].filter(([height]) => height > finalizedThroughHeight)),
    blockHashes: new Map([...history.blockHashes].filter(([height]) => height >= finalizedThroughHeight)),
  };
};

export const getValidatorJExpectedBlockHash = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
  jHeight: number,
): string | null => {
  const anchor = getEntityCertifiedJAnchor(state);
  if (anchor && jHeight === anchor.height) {
    const localHash = history?.blockHashes.get(jHeight);
    if (localHash && normalizedText(localHash) !== anchor.hash) {
      throw new Error(`J_HISTORY_FINALIZED_REORG:${jHeight}`);
    }
    return anchor.hash;
  }
  if (anchor && jHeight < anchor.height) return null;
  const localHash = history?.blockHashes.get(jHeight);
  return localHash ? normalizedText(localHash) : null;
};

/** Drop validator-private suffix and resume from the one Entity-certified head. */
export const rewindValidatorJHistory = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
): ValidatorJHistory | undefined => {
  if (!history) return undefined;
  const anchor = getEntityCertifiedJAnchor(state);
  if (!anchor) return undefined;
  const localAnchorHash = history.blockHashes.get(anchor.height);
  if (localAnchorHash && normalizedText(localAnchorHash) !== anchor.hash) {
    throw new Error(`J_HISTORY_FINALIZED_REORG:${anchor.height}`);
  }
  return {
    jurisdictionRef: normalizedText(history.jurisdictionRef),
    scannedThroughHeight: anchor.height,
    contiguousThroughHeight: anchor.height,
    tipBlockHash: anchor.hash,
    eventBlocks: new Map(),
    blockHashes: new Map([[anchor.height, anchor.hash]]),
  };
};
