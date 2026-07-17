import { keccak256, toUtf8Bytes } from 'ethers';
import type { Env, RuntimeTx } from '../types';

export const MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES = 1_024;

export type RuntimeAdapterCommandFrontier = {
  lastContiguousSequence: number;
  lastInputHash: string;
  lastCommandId: string;
  observedHeight: number;
  expiresAtMs: number | null;
};

export type RuntimeAdapterCommandMarkerData = Extract<
  RuntimeTx,
  { type: 'recordRuntimeAdapterCommand' }
>['data'];

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export const runtimeAdapterCommandLaneId = (keyId: string, tokenId: string): string =>
  keccak256(toUtf8Bytes(`xln-radapter-command-lane-v1\0${keyId}\0${tokenId}`)).toLowerCase();

export const runtimeAdapterOwnerCommandLaneId = (runtimeIdValue: string): string => {
  const runtimeId = String(runtimeIdValue || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(runtimeId)) {
    throw new Error('RADAPTER_OWNER_COMMAND_LANE_RUNTIME_ID_INVALID');
  }
  return keccak256(toUtf8Bytes(`xln-radapter-owner-command-lane-v1\0${runtimeId}`)).toLowerCase();
};

export const normalizeRuntimeAdapterCommandSequence = (value: unknown): number => {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error(`RADAPTER_COMMAND_SEQUENCE_INVALID:${String(value)}`);
  }
  return sequence;
};

export const validateRuntimeAdapterCommandMarker = (
  data: RuntimeAdapterCommandMarkerData,
): RuntimeAdapterCommandMarkerData => {
  const laneId = String(data.laneId || '').trim().toLowerCase();
  const commandId = String(data.commandId || '').trim();
  const inputHash = String(data.inputHash || '').trim().toLowerCase();
  const sequence = normalizeRuntimeAdapterCommandSequence(data.sequence);
  const expiresAtMs = data.expiresAtMs === null ? null : Number(data.expiresAtMs);
  if (!HASH_PATTERN.test(laneId)) throw new Error('RADAPTER_COMMAND_LANE_INVALID');
  if (!COMMAND_ID_PATTERN.test(commandId)) throw new Error('RADAPTER_COMMAND_ID_INVALID');
  if (!HASH_PATTERN.test(inputHash)) throw new Error('RADAPTER_COMMAND_INPUT_HASH_INVALID');
  if (expiresAtMs !== null && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0)) {
    throw new Error(`RADAPTER_COMMAND_EXPIRY_INVALID:${String(data.expiresAtMs)}`);
  }
  return { laneId, sequence, commandId, inputHash, expiresAtMs };
};

export const readRuntimeAdapterCommandFrontier = (
  env: Env,
  laneId: string,
): RuntimeAdapterCommandFrontier | undefined => {
  const frontier = env.runtimeState?.runtimeAdapterCommandFrontiers?.get(laneId.toLowerCase());
  if (!frontier) return undefined;
  return frontier.expiresAtMs === null
    || frontier.expiresAtMs > Math.max(0, Number(env.timestamp || 0))
    ? frontier
    : undefined;
};

export const countActiveRuntimeAdapterCommandLanes = (env: Env): number => {
  const nowMs = Math.max(0, Number(env.timestamp || 0));
  let count = 0;
  for (const frontier of env.runtimeState?.runtimeAdapterCommandFrontiers?.values() ?? []) {
    if (frontier.expiresAtMs === null || frontier.expiresAtMs > nowMs) count += 1;
  }
  return count;
};

const pruneExpiredCommandFrontiers = (
  frontiers: Map<string, RuntimeAdapterCommandFrontier>,
  nowMs: number,
): void => {
  for (const [laneId, frontier] of frontiers) {
    if (frontier.expiresAtMs !== null && frontier.expiresAtMs <= nowMs) frontiers.delete(laneId);
  }
};

export const applyRuntimeAdapterCommandMarker = (
  env: Env,
  raw: RuntimeAdapterCommandMarkerData,
): void => {
  const data = validateRuntimeAdapterCommandMarker(raw);
  env.runtimeState ??= {};
  const frontiers = env.runtimeState.runtimeAdapterCommandFrontiers ?? new Map();
  pruneExpiredCommandFrontiers(frontiers, Math.max(0, Number(env.timestamp || 0)));
  const prior = frontiers.get(data.laneId);
  const expectedSequence = (prior?.lastContiguousSequence ?? 0) + 1;
  if (data.sequence !== expectedSequence) {
    throw new Error(
      `RADAPTER_COMMAND_FRONTIER_NONCONTIGUOUS:lane=${data.laneId}:` +
      `expected=${expectedSequence}:actual=${data.sequence}`,
    );
  }
  if (!prior && frontiers.size >= MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES) {
    throw new Error(`RADAPTER_COMMAND_FRONTIER_CAPACITY_EXCEEDED:${frontiers.size}`);
  }
  frontiers.set(data.laneId, {
    lastContiguousSequence: data.sequence,
    lastInputHash: data.inputHash,
    lastCommandId: data.commandId,
    observedHeight: Math.max(0, Number(env.height || 0)) + 1,
    expiresAtMs: data.expiresAtMs,
  });
  env.runtimeState.runtimeAdapterCommandFrontiers = frontiers;
};
