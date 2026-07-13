import { ethers } from 'ethers';
import type { JBlockObservation } from '../types';
import { compareStableText } from '../protocol/serialization';

const HISTORY_EMPTY_DOMAIN = 'xln:j-history-empty:v1';
const HISTORY_LEAF_DOMAIN = 'xln:j-history-event-block:v1';
const HISTORY_FOLD_DOMAIN = 'xln:j-history-fold:v1';
const HISTORY_CHECKPOINT_DOMAIN = 'xln:j-history-checkpoint:v1';

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

export type JHistoryCheckpointDigestInput = {
  entityId: string;
  jurisdictionRef: string;
  signerId: string;
  baseHeight: number;
  scannedThroughHeight: number;
  tipBlockHash: string;
  eventHistoryRoot: string;
};

export const canonicalJHistoryObservationLeaf = (
  observation: Pick<JBlockObservation, 'jurisdictionRef' | 'jHeight' | 'jBlockHash' | 'eventsHash'>,
): string => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ['bytes32', 'bytes32', 'uint64', 'bytes32', 'bytes32'],
  [
    textHash(HISTORY_LEAF_DOMAIN),
    textHash(observation.jurisdictionRef),
    normalizeHeight(observation.jHeight, 'OBSERVATION_HEIGHT'),
    textHash(observation.jBlockHash),
    normalizeRoot(observation.eventsHash, 'EVENTS_ROOT'),
  ],
));

const observationKey = (
  observation: Pick<JBlockObservation, 'jHeight' | 'jBlockHash' | 'eventsHash'>,
): string => [
  normalizeHeight(observation.jHeight, 'OBSERVATION_HEIGHT').toString().padStart(16, '0'),
  String(observation.jBlockHash || '').toLowerCase(),
  String(observation.eventsHash || '').toLowerCase(),
].join(':');

export const foldJHistoryRoot = (
  baseRoot: string,
  observations: ReadonlyArray<Pick<JBlockObservation, 'jurisdictionRef' | 'jHeight' | 'jBlockHash' | 'eventsHash'>>,
): string => {
  let root = normalizeRoot(baseRoot, 'BASE_ROOT');
  const byHeight = new Map<number, string>();
  const ordered = [...observations].sort((left, right) => compareStableText(observationKey(left), observationKey(right)));

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

export const buildJHistoryCheckpointDigest = (input: JHistoryCheckpointDigestInput): string => {
  const baseHeight = normalizeHeight(input.baseHeight, 'BASE_HEIGHT');
  const scannedThroughHeight = normalizeHeight(input.scannedThroughHeight, 'SCANNED_HEIGHT');
  if (scannedThroughHeight <= baseHeight) throw new Error('J_HISTORY_CHECKPOINT_EMPTY_RANGE');
  if (!String(input.tipBlockHash || '').trim()) throw new Error('J_HISTORY_CHECKPOINT_TIP_HASH_MISSING');

  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'uint64', 'bytes32', 'bytes32'],
    [
      textHash(HISTORY_CHECKPOINT_DOMAIN),
      textHash(input.entityId),
      textHash(input.jurisdictionRef),
      textHash(input.signerId),
      baseHeight,
      scannedThroughHeight,
      textHash(input.tipBlockHash),
      normalizeRoot(input.eventHistoryRoot, 'EVENT_HISTORY_ROOT'),
    ],
  ));
};
