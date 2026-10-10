import type { JurisdictionEventBlock, JurisdictionEventData } from '../../../types/jurisdiction-events';
import {
  canonicalJurisdictionEventKey,
  compareCanonicalJurisdictionEvents,
  requireCanonicalJurisdictionEvents,
} from '../events/event-normalization';
import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  normalizeDisputeFinalizationEvidence,
} from '../event-observation';
import { buildJEventRangeDigest, canonicalJEventRangeHash } from '../history-consensus';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary/boundary-primitives';

export type JEventRangeSignatureVerifier = (
  signerId: string,
  digest: string,
  signature: string,
) => boolean;

type ValidatedJEventRange = {
  signerId: string;
  jurisdictionRef: string;
  data: JurisdictionEventData;
};

export type JEventRangeValidationResult =
  | { ok: true; range: ValidatedJEventRange }
  | { ok: false; code: string };

const text = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const height = (value: unknown, code: string): number => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error(code);
  return normalized;
};

const hash = (value: unknown, code: string): string => {
  const normalized = text(value);
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
};

/**
 * Canonical order is strictly increasing. An equal key is one log carried
 * twice: it would enter eventsHash and apply twice. Rust canonical_events
 * rejects the same block as a duplicate.
 */
const canonicalEventOrderError = (events: JurisdictionEventBlock['events']): 'DUPLICATE' | 'ORDER_INVALID' | null => {
  const keys = events.map(canonicalJurisdictionEventKey);
  if (new Set(keys).size !== keys.length) return 'DUPLICATE';
  const ordered = [...events].sort(compareCanonicalJurisdictionEvents);
  return ordered.every((event, index) => canonicalJurisdictionEventKey(event) === keys[index])
    ? null
    : 'ORDER_INVALID';
};

/**
 * Strict wire-block decoder shared by J-prefix and J-range validation.
 * It never sorts attacker-controlled events: sorting here would make preflight
 * accept bytes that the reducer later rejects, turning a bad proposal into a
 * replica halt instead of an ordinary consensus rejection.
 */
export const normalizeStrictJEventBlock = (
  value: unknown,
  previousHeight: number,
  scannedThroughHeight: number,
  codePrefix = 'J_RANGE',
): JurisdictionEventBlock => {
  const raw = requireBoundaryRecord(value, `${codePrefix}_BLOCK_INVALID`);
  requireExactBoundaryKeys(
    raw,
    ['blockNumber', 'blockHash', 'eventsHash', 'events'],
    ['disputeFinalizationEvidence', 'disputeFinalizationEvidenceHash'],
    `${codePrefix}_BLOCK_FIELDS_INVALID`,
  );
  const blockNumber = height(raw['blockNumber'], `${codePrefix}_BLOCK_HEIGHT_INVALID`);
  if (blockNumber <= previousHeight || blockNumber > scannedThroughHeight) {
    throw new Error(`${codePrefix}_BLOCK_ORDER_INVALID`);
  }
  const blockHash = hash(raw['blockHash'], `${codePrefix}_BLOCK_HASH_INVALID`);
  if (!Array.isArray(raw['events']) || raw['events'].length === 0) {
    throw new Error(`${codePrefix}_EVENT_BLOCK_EMPTY`);
  }
  const events = requireCanonicalJurisdictionEvents(raw['events']);
  const orderError = canonicalEventOrderError(events);
  if (orderError) throw new Error(`${codePrefix}_EVENT_${orderError}`);
  for (const event of events) {
    if (Number(event.blockNumber) !== blockNumber || text(event.blockHash) !== blockHash) {
      throw new Error(`${codePrefix}_EVENT_BLOCK_MISMATCH`);
    }
  }
  const eventsHash = canonicalJurisdictionEventsHash(events);
  if (hash(raw['eventsHash'], `${codePrefix}_EVENTS_HASH_INVALID`) !== eventsHash) {
    throw new Error(`${codePrefix}_EVENTS_HASH_MISMATCH`);
  }

  if (
    raw['disputeFinalizationEvidence'] !== undefined &&
    !Array.isArray(raw['disputeFinalizationEvidence'])
  ) {
    throw new Error(`${codePrefix}_EVIDENCE_INVALID`);
  }
  const evidence = normalizeDisputeFinalizationEvidence(
    raw['disputeFinalizationEvidence'] ?? [],
  );
  const evidenceHash = evidence.length > 0
    ? canonicalDisputeFinalizationEvidenceHash(evidence)
    : '';
  if (text(raw['disputeFinalizationEvidenceHash']) !== evidenceHash) {
    throw new Error(`${codePrefix}_EVIDENCE_HASH_MISMATCH`);
  }
  return {
    blockNumber,
    blockHash,
    eventsHash,
    events,
    ...(evidence.length > 0 ? { disputeFinalizationEvidence: evidence } : {}),
    ...(evidenceHash ? { disputeFinalizationEvidenceHash: evidenceHash } : {}),
  };
};

export const validateJEventRangeEnvelope = (input: {
  entityId: string;
  expectedJurisdictionRef: string;
  activeProposerId: string;
  data: JurisdictionEventData;
  verifySignature: JEventRangeSignatureVerifier;
}): JEventRangeValidationResult => {
  try {
    const signerId = text(input.data.from);
    if (!signerId || signerId !== text(input.activeProposerId)) {
      return { ok: false, code: 'J_RANGE_NOT_ACTIVE_PROPOSER' };
    }
    const jurisdictionRef = text(input.data.jurisdictionRef);
    if (jurisdictionRef !== text(input.expectedJurisdictionRef)) {
      return { ok: false, code: 'J_RANGE_JURISDICTION_MISMATCH' };
    }
    const baseHeight = height(input.data.baseHeight, 'J_RANGE_BASE_HEIGHT_INVALID');
    const scannedThroughHeight = height(input.data.scannedThroughHeight, 'J_RANGE_SCANNED_HEIGHT_INVALID');
    if (scannedThroughHeight <= baseHeight) return { ok: false, code: 'J_RANGE_HEIGHT_INVALID' };
    if (height(input.data.observedAt, 'J_RANGE_OBSERVED_AT_INVALID') !== scannedThroughHeight) {
      return { ok: false, code: 'J_RANGE_OBSERVED_AT_MISMATCH' };
    }
    const tipBlockHash = hash(input.data.tipBlockHash, 'J_RANGE_TIP_HASH_INVALID');
    if (!Array.isArray(input.data.blocks)) return { ok: false, code: 'J_RANGE_BLOCKS_INVALID' };
    let previousHeight = baseHeight;
    const blocks = input.data.blocks.map((block) => {
      const normalized = normalizeStrictJEventBlock(block, previousHeight, scannedThroughHeight);
      previousHeight = normalized.blockNumber;
      return normalized;
    });
    const rangeHash = canonicalJEventRangeHash(jurisdictionRef, blocks);
    if (hash(input.data.rangeHash, 'J_RANGE_BODY_HASH_INVALID') !== rangeHash) {
      return { ok: false, code: 'J_RANGE_BODY_HASH_MISMATCH' };
    }
    const eventHistoryRoot = hash(input.data.eventHistoryRoot, 'J_RANGE_HISTORY_ROOT_INVALID');
    const signature = text(input.data.signature);
    if (!signature) return { ok: false, code: 'J_RANGE_PROPOSER_SIGNATURE_INVALID' };
    const digest = buildJEventRangeDigest({
      entityId: input.entityId,
      jurisdictionRef,
      signerId,
      baseHeight,
      scannedThroughHeight,
      tipBlockHash,
      eventHistoryRoot,
      rangeHash,
    });
    if (!input.verifySignature(signerId, digest, signature)) {
      return { ok: false, code: 'J_RANGE_PROPOSER_SIGNATURE_INVALID' };
    }
    return {
      ok: true,
      range: {
        signerId,
        jurisdictionRef,
        data: {
          from: signerId,
          jurisdictionRef,
          baseHeight,
          scannedThroughHeight,
          observedAt: scannedThroughHeight,
          tipBlockHash,
          eventHistoryRoot,
          rangeHash,
          blocks,
          signature,
        },
      },
    };
  } catch (error) {
    return { ok: false, code: error instanceof Error ? error.message : 'J_RANGE_INVALID' };
  }
};
