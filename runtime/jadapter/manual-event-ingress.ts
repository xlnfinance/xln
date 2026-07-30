import { isHexString } from 'ethers';
import type { RuntimeInput, RuntimeState, RuntimeTx } from '../runtime/types';
import { enqueueRuntimeInput } from '../runtime/input-queue';
import { indexReserveUpdatedEvents } from '../jurisdiction/event-evidence';
import {
  bindLocalJEventIngressSource,
  type LocalJEventIngressSource,
} from './local-ingress-source';
import { isCanonicalEvent } from './event-relevance';
import {
  assertJEventIngressOpen,
  buildJEventObservationInput,
  type EventBatchCounter,
} from './event-observation';
import {
  appendJHistoryRange,
  buildJHistoryRangeRuntimeInput,
} from './history-ingress';
import type { JEvent, JEventIngress } from './types';

const normalizeManualJEvents = (
  events: JEvent[],
  label: string,
): JEventIngress[] => {
  if (!Array.isArray(events)) throw new Error(`J_EVENT_MANUAL_BATCH_INVALID:${label}`);
  return events.map((event, index) => {
    if (!event || typeof event.name !== 'string' || !isCanonicalEvent(event)) {
      throw new Error(`J_EVENT_MANUAL_EVENT_INVALID:${label}:${index}:${String(event?.name ?? 'missing')}`);
    }
    if (!Number.isSafeInteger(event.blockNumber) || event.blockNumber < 0) {
      throw new Error(`J_EVENT_MANUAL_BLOCK_NUMBER_INVALID:${label}:${index}:${String(event.blockNumber)}`);
    }
    if (!isHexString(event.blockHash, 32)) {
      throw new Error(`J_EVENT_MANUAL_BLOCK_HASH_INVALID:${label}:${index}:${String(event.blockHash)}`);
    }
    if (!String(event.transactionHash || '').trim()) {
      throw new Error(`J_EVENT_MANUAL_TRANSACTION_HASH_MISSING:${label}:${index}`);
    }
    if (
      event.name !== 'ExternalWalletSnapshot' &&
      (!Number.isSafeInteger(event.logIndex) || Number(event.logIndex) < 0)
    ) {
      throw new Error(`J_EVENT_MANUAL_LOG_INDEX_MISSING:${label}:${index}:${event.name}`);
    }
    if (!event.args || typeof event.args !== 'object' || Array.isArray(event.args)) {
      throw new Error(`J_EVENT_MANUAL_ARGS_INVALID:${label}:${index}:${event.name}`);
    }
    return {
      name: event.name,
      args: event.args as Record<string, unknown>,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      transactionHash: event.transactionHash,
      ...(event.logIndex === undefined ? {} : { logIndex: event.logIndex }),
    };
  });
};

const buildFromIngress = (
  env: RuntimeState,
  events: JEventIngress[],
  label: string,
  source: LocalJEventIngressSource,
): RuntimeInput | null => {
  if (events.length === 0) return null;
  assertJEventIngressOpen(env, label);
  const boundSource = bindLocalJEventIngressSource(env, source, label);
  const groups = new Map<number, JEventIngress[]>();
  for (const event of events) {
    const blockNumber = Number(event.blockNumber ?? 0);
    groups.set(blockNumber, [...(groups.get(blockNumber) || []), event]);
  }

  const txCounter: EventBatchCounter = { value: 0 };
  const runtimeTxs: RuntimeTx[] = [];
  let timestamp = 0;
  let tipBlockHash = '';
  for (const [blockNumber, group] of groups) {
    const blockHash = group[0]?.blockHash;
    if (!blockHash) {
      throw new Error(`J_EVENT_MANUAL_BLOCK_HASH_MISSING:${label}:${blockNumber}`);
    }
    if (group.some(event => event.blockHash?.toLowerCase() !== blockHash.toLowerCase())) {
      throw new Error(`J_EVENT_MANUAL_BLOCK_HASH_MISMATCH:${label}:${blockNumber}`);
    }
    const built = buildJEventObservationInput(env, group.filter(isCanonicalEvent), {
      blockNumber,
      blockHash,
      adapterLabel: label,
      txCounter,
      logBatch: false,
      emitSettledDebugEvents: false,
      localSourceReplica: boundSource.replica,
    });
    if (!built?.input.runtimeTxs.length) continue;
    runtimeTxs.push(...built.input.runtimeTxs);
    timestamp = Math.max(timestamp, Number(built.input.timestamp ?? 0));
    if (blockNumber === timestamp) tipBlockHash = blockHash;
  }
  if (runtimeTxs.length === 0) return null;
  const observed: RuntimeInput = { timestamp, runtimeTxs, entityInputs: [] };
  const range = buildJHistoryRangeRuntimeInput(
    env, [observed], timestamp, tipBlockHash, undefined, [], undefined, 'observed',
  );
  return appendJHistoryRange(observed, range?.input ?? null);
};

export const buildJEventsRuntimeInput = (
  env: RuntimeState,
  events: JEvent[],
  label: string,
  source: LocalJEventIngressSource,
): RuntimeInput | null =>
  events.length === 0
    ? null
    : buildFromIngress(env, normalizeManualJEvents(events, label), label, source);

export const applyJEventsToEnv = (
  env: RuntimeState,
  events: JEvent[],
  label: string,
  source: LocalJEventIngressSource,
): void => {
  if (events.length === 0) return;
  assertJEventIngressOpen(env, label);
  const ingress = normalizeManualJEvents(events, label);
  const input = buildFromIngress(env, ingress, label, source);
  if (!input) return;
  for (const event of ingress) {
    if (event.name !== 'ExternalWalletSnapshot') continue;
    const entityId = String(event.args['entityId'] ?? '').trim().toLowerCase();
    const owner = String(event.args['owner'] ?? '').trim().toLowerCase();
    if (!entityId || !/^0x[0-9a-f]{40}$/.test(owner)) {
      throw new Error(`J_EVENT_EXTERNAL_WALLET_IDENTITY_INVALID:${label}:${entityId || 'missing'}:${owner || 'missing'}`);
    }
    const runtimeState = env.runtimeState ??= {};
    const watches = runtimeState.externalWalletWatchOwners ??= new Map();
    const owners = watches.get(entityId) ?? new Map<string, number>();
    const blockNumber = Number(event.blockNumber ?? 0);
    owners.set(owner, Math.max(owners.get(owner) ?? 0, Number.isFinite(blockNumber) ? blockNumber : 0));
    watches.set(entityId, owners);
  }
  indexReserveUpdatedEvents(env, ingress);
  enqueueRuntimeInput(env, input);
};
