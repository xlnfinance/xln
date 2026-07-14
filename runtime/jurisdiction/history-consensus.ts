import { ethers } from 'ethers';
import type { JurisdictionEventBlock, ValidatorJEventBlock } from '../types';

const HISTORY_EMPTY_DOMAIN = 'xln:j-history-empty:v1';
const HISTORY_LEAF_DOMAIN = 'xln:j-history-event-block:v1';
const HISTORY_FOLD_DOMAIN = 'xln:j-history-fold:v1';
const HISTORY_RANGE_DOMAIN = 'xln:j-history-range:v1';
const HISTORY_RANGE_BODY_DOMAIN = 'xln:j-history-range-body:v1';

export const EMPTY_J_HISTORY_ROOT = ethers.keccak256(ethers.toUtf8Bytes(HISTORY_EMPTY_DOMAIN));

export const getJHistoryRegistrationBaseHeight = (jurisdiction: unknown): number => {
  if (!jurisdiction || typeof jurisdiction !== 'object') return 0;
  const registrationBlock = Number((jurisdiction as { registrationBlock?: unknown }).registrationBlock ?? 0);
  if (!Number.isSafeInteger(registrationBlock) || registrationBlock <= 1) return 0;
  return registrationBlock - 1;
};

const textHash = (value: unknown): string =>
  ethers.keccak256(ethers.toUtf8Bytes(String(value ?? '').trim().toLowerCase()));

const normalizeRoot = (value: unknown, label: string): string => {
  const root = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(root)) throw new Error(`J_HISTORY_INVALID_${label}`);
  return root;
};

const normalizeHeight = (value: unknown, label: string): number => {
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error(`J_HISTORY_INVALID_${label}`);
  return height;
};

type JHistoryBlockIdentity = Pick<
  ValidatorJEventBlock,
  'jurisdictionRef' | 'jHeight' | 'jBlockHash' | 'eventsHash' | 'disputeFinalizationEvidenceHash'
>;

export const canonicalJHistoryObservationLeaf = (
  observation: JHistoryBlockIdentity,
): string => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ['bytes32', 'bytes32', 'uint64', 'bytes32', 'bytes32', 'bytes32'],
  [
    textHash(HISTORY_LEAF_DOMAIN),
    textHash(observation.jurisdictionRef),
    normalizeHeight(observation.jHeight, 'OBSERVATION_HEIGHT'),
    textHash(observation.jBlockHash),
    normalizeRoot(observation.eventsHash, 'EVENTS_ROOT'),
    observation.disputeFinalizationEvidenceHash
      ? normalizeRoot(observation.disputeFinalizationEvidenceHash, 'EVIDENCE_ROOT')
      : ethers.ZeroHash,
  ],
));

export const foldJHistoryRoot = (
  baseRoot: string,
  observations: ReadonlyArray<JHistoryBlockIdentity>,
): string => {
  let root = normalizeRoot(baseRoot, 'BASE_ROOT');
  const byHeight = new Map<number, string>();
  const ordered = [...observations].sort((left, right) =>
    normalizeHeight(left.jHeight, 'OBSERVATION_HEIGHT') - normalizeHeight(right.jHeight, 'OBSERVATION_HEIGHT'));

  for (const observation of ordered) {
    const height = normalizeHeight(observation.jHeight, 'OBSERVATION_HEIGHT');
    const leaf = canonicalJHistoryObservationLeaf(observation);
    const existing = byHeight.get(height);
    if (existing && existing !== leaf) throw new Error(`J_HISTORY_EQUIVOCATION_AT_HEIGHT:${height}`);
    if (existing) continue;
    byHeight.set(height, leaf);
    root = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32'],
      [textHash(HISTORY_FOLD_DOMAIN), root, leaf],
    ));
  }
  return root;
};

const normalizeRangeBlocks = (
  jurisdictionRef: string,
  blocks: readonly JurisdictionEventBlock[],
): JHistoryBlockIdentity[] => {
  let previousHeight = -1;
  return blocks.map((block) => {
    const jHeight = normalizeHeight(block.blockNumber, 'RANGE_BLOCK_HEIGHT');
    if (jHeight <= previousHeight) throw new Error('J_HISTORY_RANGE_BLOCK_ORDER_INVALID');
    previousHeight = jHeight;
    return {
      jurisdictionRef,
      jHeight,
      jBlockHash: String(block.blockHash || '').trim().toLowerCase(),
      eventsHash: normalizeRoot(block.eventsHash, 'RANGE_EVENTS_ROOT'),
      ...(block.disputeFinalizationEvidenceHash
        ? {
            disputeFinalizationEvidenceHash: normalizeRoot(
              block.disputeFinalizationEvidenceHash,
              'RANGE_EVIDENCE_ROOT',
            ),
          }
        : {}),
    };
  });
};

export const canonicalJEventRangeHash = (
  jurisdictionRef: string,
  blocks: readonly JurisdictionEventBlock[],
): string => {
  const identities = normalizeRangeBlocks(jurisdictionRef, blocks);
  const evidenceHashes = blocks.map((block) => {
    const evidenceHash = String(block.disputeFinalizationEvidenceHash || '').trim().toLowerCase();
    return evidenceHash ? normalizeRoot(evidenceHash, 'RANGE_EVIDENCE_ROOT') : ethers.ZeroHash;
  });
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint64[]', 'bytes32[]', 'bytes32[]', 'bytes32[]'],
    [
      textHash(HISTORY_RANGE_BODY_DOMAIN),
      identities.map((block) => block.jHeight),
      identities.map((block) => textHash(block.jBlockHash)),
      identities.map((block) => block.eventsHash),
      evidenceHashes,
    ],
  ));
};

export type JEventRangeDigestInput = {
  entityId: string;
  jurisdictionRef: string;
  signerId: string;
  baseHeight: number;
  scannedThroughHeight: number;
  tipBlockHash: string;
  eventHistoryRoot: string;
  rangeHash: string;
};

export const buildJEventRangeDigest = (input: JEventRangeDigestInput): string => {
  const baseHeight = normalizeHeight(input.baseHeight, 'BASE_HEIGHT');
  const scannedThroughHeight = normalizeHeight(input.scannedThroughHeight, 'SCANNED_HEIGHT');
  if (scannedThroughHeight <= baseHeight) throw new Error('J_HISTORY_RANGE_EMPTY');
  if (!String(input.tipBlockHash || '').trim()) throw new Error('J_HISTORY_RANGE_TIP_HASH_MISSING');
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'uint64', 'bytes32', 'bytes32', 'bytes32'],
    [
      textHash(HISTORY_RANGE_DOMAIN),
      textHash(input.entityId),
      textHash(input.jurisdictionRef),
      textHash(input.signerId),
      baseHeight,
      scannedThroughHeight,
      textHash(input.tipBlockHash),
      normalizeRoot(input.eventHistoryRoot, 'EVENT_HISTORY_ROOT'),
      normalizeRoot(input.rangeHash, 'RANGE_ROOT'),
    ],
  ));
};
