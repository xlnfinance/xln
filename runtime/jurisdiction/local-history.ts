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

/**
 * Reducer-semantic block identity. `eventsHash` commits the receipt logs, but a
 * DisputeFinalized reducer also consumes finalNonce and transformer arguments
 * reconstructed from transaction calldata. Comparing only the log hash lets a
 * proposer substitute those values, re-sign its own range, and make validators
 * replay a state transition they never observed.
 */
const blockIdentity = (block: ExactJBlockIdentity): string =>
  `${normalizedText(block.jBlockHash)}:${normalizedText(block.eventsHash)}:` +
  normalizedText(block.disputeFinalizationEvidenceHash);

export const isCertifiedJHistoryCorruption = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /^J_HISTORY_(?:FINALITY|FINALIZED)_/.test(message);
};

const certifiedAnchor = (state: EntityState): { height: number; hash: string; jurisdictionRef: string } | null => {
  const finality = state.jHistoryFinality;
  const stateHeight = Number(state.lastFinalizedJHeight || 0);
  if (!Number.isSafeInteger(stateHeight) || stateHeight < 0) {
    throw new Error(`J_HISTORY_FINALITY_HEIGHT_CORRUPTION:state=${String(state.lastFinalizedJHeight)}`);
  }
  if (!finality) {
    const registrationBase = getJHistoryRegistrationBaseHeight(state.config.jurisdiction);
    // Before the first post-registration range there is intentionally no
    // certificate. Once state advances—or retains any certified leaf—silently
    // treating the local watcher as authoritative would let restore corruption
    // erase the Entity-certified anchor.
    if (stateHeight !== registrationBase || state.jBlockChain.length !== 0) {
      throw new Error(
        `J_HISTORY_FINALITY_MISSING:state=${stateHeight}:registrationBase=${registrationBase}:blocks=${state.jBlockChain.length}`,
      );
    }
    return null;
  }
  const height = Number(finality.finalizedThroughHeight);
  if (!Number.isSafeInteger(height) || height <= 0 || height !== stateHeight) {
    throw new Error(`J_HISTORY_FINALITY_HEIGHT_CORRUPTION:state=${stateHeight}:anchor=${String(finality.finalizedThroughHeight)}`);
  }
  const hash = normalizedText(finality.tipBlockHash);
  if (!hash) throw new Error('J_HISTORY_FINALITY_HASH_CORRUPTION');
  const jurisdictionRef = normalizedText(finality.jurisdictionRef);
  if (!jurisdictionRef) throw new Error('J_HISTORY_FINALITY_JURISDICTION_CORRUPTION');
  return { height, hash, jurisdictionRef };
};

type CertifiedJHistoryView = {
  anchor: ReturnType<typeof certifiedAnchor>;
  blocks: ValidatorJEventBlock[];
  byHeight: Map<number, ValidatorJEventBlock>;
  prefixRoots: Array<{ height: number; root: string }>;
  root: string;
};

const buildCertifiedJHistoryView = (state: EntityState): CertifiedJHistoryView => {
  const anchor = certifiedAnchor(state);
  if (!anchor) {
    return {
      anchor: null,
      blocks: [],
      byHeight: new Map(),
      prefixRoots: [],
      root: EMPTY_J_HISTORY_ROOT,
    };
  }
  const seenHeights = new Set<number>();
  const blocks = state.jBlockChain
    .map((block) => ({
      jurisdictionRef: normalizedText(block.jurisdictionRef),
      jHeight: Number(block.jHeight),
      jBlockHash: normalizedText(block.jBlockHash),
      eventsHash: normalizedText(block.eventsHash),
      ...(block.disputeFinalizationEvidenceHash
        ? { disputeFinalizationEvidenceHash: normalizedText(block.disputeFinalizationEvidenceHash) }
        : {}),
      events: block.events,
    }))
    .sort((left, right) => left.jHeight - right.jHeight);
  for (const block of blocks) {
    if (!Number.isSafeInteger(block.jHeight) || block.jHeight <= 0 || block.jHeight > anchor.height) {
      throw new Error(`J_HISTORY_FINALITY_BLOCK_HEIGHT_CORRUPTION:${String(block.jHeight)}`);
    }
    if (block.jurisdictionRef !== anchor.jurisdictionRef) {
      throw new Error(`J_HISTORY_FINALITY_BLOCK_JURISDICTION_CORRUPTION:${block.jHeight}`);
    }
    if (seenHeights.has(block.jHeight)) {
      throw new Error(`J_HISTORY_FINALITY_DUPLICATE_BLOCK:${block.jHeight}`);
    }
    seenHeights.add(block.jHeight);
  }
  let computedRoot = EMPTY_J_HISTORY_ROOT;
  const prefixRoots: Array<{ height: number; root: string }> = [];
  for (const block of blocks) {
    computedRoot = foldJHistoryRoot(computedRoot, [block]);
    prefixRoots.push({ height: block.jHeight, root: computedRoot });
  }
  const certifiedRoot = normalizedText(state.jHistoryFinality?.eventHistoryRoot);
  if (computedRoot !== certifiedRoot) {
    throw new Error(`J_HISTORY_FINALITY_ROOT_CORRUPTION:expected=${computedRoot}:certified=${certifiedRoot || 'missing'}`);
  }
  const eventAtAnchor = blocks.find((block) => block.jHeight === anchor.height);
  if (eventAtAnchor && eventAtAnchor.jBlockHash !== anchor.hash) {
    throw new Error(`J_HISTORY_FINALITY_TIP_CORRUPTION:${anchor.height}`);
  }
  return {
    anchor,
    blocks,
    byHeight: new Map(blocks.map((block) => [block.jHeight, block])),
    prefixRoots,
    root: computedRoot,
  };
};

const certifiedRootAtHeight = (
  state: EntityState,
  view: CertifiedJHistoryView,
  height: number,
): string => {
  if (!Number.isSafeInteger(height) || height < 0 || height > state.lastFinalizedJHeight) {
    throw new Error(`J_RANGE_BASE_HEIGHT_INVALID:${height}`);
  }
  let low = 0;
  let high = view.prefixRoots.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (view.prefixRoots[middle]!.height <= height) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match < 0 ? EMPTY_J_HISTORY_ROOT : view.prefixRoots[match]!.root;
};

const assertValidatorJHistoryMatchesView = (
  view: CertifiedJHistoryView,
  history: ValidatorJHistory | undefined,
): void => {
  const { anchor } = view;
  if (!anchor) return;
  if (!history) return;
  if (normalizedText(history.jurisdictionRef) !== anchor.jurisdictionRef) {
    throw new Error('J_HISTORY_FINALITY_JURISDICTION_CONFLICT');
  }
  for (const [height, localHash] of history.blockHashes) {
    const certifiedHash = height === anchor.height
      ? anchor.hash
      : view.byHeight.get(height)?.jBlockHash;
    if (certifiedHash && normalizedText(localHash) !== certifiedHash) {
      throw new Error(`J_HISTORY_FINALIZED_REORG:${height}`);
    }
  }
  for (const [height, localBlock] of history.eventBlocks) {
    if (height > anchor.height) continue;
    const certified = view.byHeight.get(height);
    if (!certified || blockIdentity(localBlock) !== blockIdentity(certified)) {
      throw new Error(`J_HISTORY_FINALIZED_EVENT_CONFLICT:${height}`);
    }
  }
};

export const assertValidatorJHistoryMatchesCertifiedAnchor = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
): void => assertValidatorJHistoryMatchesView(buildCertifiedJHistoryView(state), history);

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

  const eventBlocks = new Map(current?.eventBlocks ?? []);
  const blockHashes = new Map(current?.blockHashes ?? []);
  const certifiedView = state ? buildCertifiedJHistoryView(state) : null;
  const anchor = certifiedView?.anchor ?? null;
  const certifiedByHeight = certifiedView?.byHeight ?? new Map<number, ValidatorJEventBlock>();
  if (anchor) {
    if (anchor.jurisdictionRef !== jurisdictionRef) {
      throw new Error('J_HISTORY_FINALITY_JURISDICTION_CONFLICT');
    }
    const existingAnchorHash = blockHashes.get(anchor.height);
    if (existingAnchorHash && normalizedText(existingAnchorHash) !== anchor.hash) {
      throw new Error(`J_HISTORY_FINALIZED_REORG:${anchor.height}`);
    }
    // Certified Entity state is the source of truth. Seeding the missing local
    // anchor makes a restored validator compare every crossing scan against it.
    blockHashes.set(anchor.height, anchor.hash);
    assertValidatorJHistoryMatchesView(certifiedView!, current);
  }
  for (const header of input.headers ?? []) {
    const jHeight = Number(header.jHeight);
    const jBlockHash = normalizedText(header.jBlockHash);
    if (!Number.isSafeInteger(jHeight) || jHeight <= 0 || jHeight > scannedThroughHeight) {
      throw new Error('J_HISTORY_LOCAL_HEADER_HEIGHT_INVALID');
    }
    if (!jBlockHash) throw new Error('J_HISTORY_LOCAL_HEADER_HASH_MISSING');
    const certifiedHash = jHeight === anchor?.height
      ? anchor.hash
      : certifiedByHeight.get(jHeight)?.jBlockHash;
    if (certifiedHash && certifiedHash !== jBlockHash) {
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
    if (anchor && block.jHeight <= anchor.height) {
      const certified = certifiedByHeight.get(block.jHeight);
      if (!certified || blockIdentity(certified) !== blockIdentity(block)) {
        throw new Error(`J_HISTORY_FINALIZED_EVENT_CONFLICT:${block.jHeight}`);
      }
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
  const recorded = {
    jurisdictionRef,
    scannedThroughHeight: Math.max(previousScanned, scannedThroughHeight),
    tipBlockHash: scannedThroughHeight >= previousScanned ? tipBlockHash : current!.tipBlockHash,
    eventBlocks,
    blockHashes,
  };
  if (certifiedView) assertValidatorJHistoryMatchesView(certifiedView, recorded);
  return recorded;
};

export const finalizedJHistoryRoot = (state: EntityState): string => {
  return buildCertifiedJHistoryView(state).root;
};

const finalizedJHistoryRootAtHeight = (
  state: EntityState,
  height: number,
  view = buildCertifiedJHistoryView(state),
): string => certifiedRootAtHeight(state, view, height);

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
 * Reconcile an authenticated older observation with the current certified
 * Entity prefix. Matching finalized blocks are idempotent; only the unseen
 * suffix may execute. Any differing or omitted finalized event block is
 * corruption/equivocation and must stop before state mutation.
 */
const reconcileJEventRangeWithCertifiedView = (
  state: EntityState,
  data: JurisdictionEventData,
  certifiedView: CertifiedJHistoryView,
): ReconciledJEventRange => {
  const baseHeight = Number(data.baseHeight);
  const scannedThroughHeight = Number(data.scannedThroughHeight);
  const finalizedHeight = Number(state.lastFinalizedJHeight || 0);
  if (!Number.isSafeInteger(baseHeight) || baseHeight < 0 || baseHeight > finalizedHeight) {
    throw new Error(`J_RANGE_BASE_HEIGHT_AHEAD:${baseHeight}`);
  }
  if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight <= baseHeight) {
    throw new Error('J_RANGE_HEIGHT_INVALID');
  }
  const jurisdictionRef = normalizedText(data.jurisdictionRef);
  const { anchor } = certifiedView;
  const allCertifiedBlocks = certifiedView.blocks;
  const overlapEnd = Math.min(scannedThroughHeight, finalizedHeight);
  const proposedPrefix = data.blocks.filter((block) =>
    Number(block.blockNumber) > baseHeight && Number(block.blockNumber) <= overlapEnd);
  const certifiedPrefix = allCertifiedBlocks
    .filter((block) =>
      normalizedText(block.jurisdictionRef) === jurisdictionRef &&
      block.jHeight > baseHeight &&
      block.jHeight <= overlapEnd)
    .sort((left, right) => left.jHeight - right.jHeight);
  if (proposedPrefix.length !== certifiedPrefix.length) {
    throw new Error(`J_RANGE_FINALIZED_PREFIX_COUNT_CONFLICT:${overlapEnd}`);
  }
  for (let index = 0; index < certifiedPrefix.length; index += 1) {
    const proposed = proposedPrefix[index]!;
    const certified = certifiedPrefix[index]!;
    if (
      Number(proposed.blockNumber) !== certified.jHeight ||
      normalizedText(proposed.blockHash) !== normalizedText(certified.jBlockHash) ||
      normalizedText(proposed.eventsHash) !== normalizedText(certified.eventsHash) ||
      normalizedText(proposed.disputeFinalizationEvidenceHash) !==
        normalizedText(certified.disputeFinalizationEvidenceHash)
    ) {
      throw new Error(`J_RANGE_FINALIZED_PREFIX_CONFLICT:${certified.jHeight}`);
    }
  }
  const expectedOriginalRoot = foldJHistoryRoot(
    finalizedJHistoryRootAtHeight(state, baseHeight, certifiedView),
    data.blocks.map((block) => ({
      jurisdictionRef,
      jHeight: Number(block.blockNumber),
      jBlockHash: normalizedText(block.blockHash),
      eventsHash: normalizedText(block.eventsHash),
      ...(block.disputeFinalizationEvidenceHash
        ? { disputeFinalizationEvidenceHash: normalizedText(block.disputeFinalizationEvidenceHash) }
        : {}),
    })),
  );
  if (expectedOriginalRoot !== normalizedText(data.eventHistoryRoot)) {
    throw new Error('J_RANGE_HISTORY_ROOT_MISMATCH');
  }
  if (scannedThroughHeight <= finalizedHeight) {
    const certifiedTipHash = scannedThroughHeight === anchor?.height
      ? anchor.hash
      : allCertifiedBlocks.find((block) => block.jHeight === scannedThroughHeight)?.jBlockHash;
    if (certifiedTipHash && normalizedText(data.tipBlockHash) !== certifiedTipHash) {
      throw new Error(`J_RANGE_FINALIZED_TIP_CONFLICT:${scannedThroughHeight}`);
    }
    return { kind: 'noop' };
  }
  return {
    kind: 'suffix',
    baseHeight: finalizedHeight,
    scannedThroughHeight,
    tipBlockHash: normalizedText(data.tipBlockHash),
    eventHistoryRoot: normalizedText(data.eventHistoryRoot),
    blocks: data.blocks.filter((block) => Number(block.blockNumber) > finalizedHeight),
  };
};

export const reconcileJEventRangeWithFinalizedState = (
  state: EntityState,
  data: JurisdictionEventData,
): ReconciledJEventRange => reconcileJEventRangeWithCertifiedView(
  state,
  data,
  buildCertifiedJHistoryView(state),
);

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
    ...(block.disputeFinalizationEvidenceHash
      ? { disputeFinalizationEvidenceHash: block.disputeFinalizationEvidenceHash }
      : {}),
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
  const certifiedView = buildCertifiedJHistoryView(state);
  const normalizedProposedBlocks = data.blocks.map((proposed) => normalizeEventBlock(jurisdictionRef, {
    jurisdictionRef,
    jHeight: proposed.blockNumber,
    jBlockHash: proposed.blockHash,
    eventsHash: proposed.eventsHash,
    events: proposed.events,
    ...(proposed.disputeFinalizationEvidence ? { disputeFinalizationEvidence: proposed.disputeFinalizationEvidence } : {}),
    ...(proposed.disputeFinalizationEvidenceHash
      ? { disputeFinalizationEvidenceHash: proposed.disputeFinalizationEvidenceHash }
      : {}),
  }));
  const reconciliation = reconcileJEventRangeWithCertifiedView(state, data, certifiedView);
  if (history) assertValidatorJHistoryMatchesView(certifiedView, history);
  if (data.scannedThroughHeight > state.lastFinalizedJHeight) {
    if (!history || normalizedText(history.jurisdictionRef) !== jurisdictionRef) return 'J_RANGE_LOCAL_HISTORY_MISSING';
  }
  if (!Number.isSafeInteger(data.scannedThroughHeight) || data.scannedThroughHeight <= data.baseHeight) {
    return 'J_RANGE_HEIGHT_INVALID';
  }
  if (history && history.scannedThroughHeight < data.scannedThroughHeight) return 'J_RANGE_LOCAL_HISTORY_BEHIND';
  const certifiedBlocks = certifiedView.blocks
    .filter((block) =>
      normalizedText(block.jurisdictionRef) === jurisdictionRef &&
      block.jHeight > data.baseHeight &&
      block.jHeight <= Math.min(state.lastFinalizedJHeight, data.scannedThroughHeight));
  const localSuffixBlocks = [...(history?.eventBlocks.values() ?? [])]
    .filter((block) => block.jHeight > state.lastFinalizedJHeight && block.jHeight <= data.scannedThroughHeight);
  const localBlocks = [...certifiedBlocks, ...localSuffixBlocks]
    .sort((left, right) => left.jHeight - right.jHeight);
  if (localBlocks.length !== data.blocks.length) return 'J_RANGE_EVENT_BLOCK_COUNT_MISMATCH';
  for (let index = 0; index < data.blocks.length; index += 1) {
    const normalized = normalizedProposedBlocks[index]!;
    const local = localBlocks[index]!;
    if (normalized.jHeight !== local.jHeight || blockIdentity(normalized) !== blockIdentity(local)) {
      return 'J_RANGE_EVENT_BLOCK_MISMATCH';
    }
  }
  const knownTipHash = history?.blockHashes.get(data.scannedThroughHeight);
  if (reconciliation.kind === 'suffix' && !knownTipHash) return 'J_RANGE_LOCAL_TIP_UNKNOWN';
  if (knownTipHash && normalizedText(knownTipHash) !== normalizedText(data.tipBlockHash)) {
    return 'J_RANGE_TIP_HASH_MISMATCH';
  }
  if (canonicalJEventRangeHash(jurisdictionRef, data.blocks) !== normalizedText(data.rangeHash)) {
    return 'J_RANGE_BODY_HASH_MISMATCH';
  }
  // Reconciliation already verified eventHistoryRoot over the proposed body;
  // the exact block-by-block comparison above proves that body is the local
  // canonical range. Folding the same N blocks again adds no safety property.
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
  const finality = state.jHistoryFinality;
  if (finality?.finalizedThroughHeight === jHeight) {
    const certifiedHash = normalizedText(finality.tipBlockHash);
    const localHash = history?.blockHashes.get(jHeight);
    if (localHash && normalizedText(localHash) !== certifiedHash) {
      throw new Error(`J_HISTORY_FINALIZED_REORG:${jHeight}`);
    }
    return certifiedHash;
  }
  const localHash = history?.blockHashes.get(jHeight);
  if (localHash) return normalizedText(localHash);
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
