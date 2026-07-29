import type { RuntimeState } from '../runtime/types';

export type ReserveUpdatedEvidence = {
  name: 'ReserveUpdated';
  args: Record<string, unknown>;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  observedAt: number;
};

const normalizeArgValue = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeArgValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, normalizeArgValue(entry)]),
    );
  }
  return value;
};

const readDecimalBigInt = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
};

const toReserveUpdatedEvidence = (
  env: RuntimeState,
  event: {
    name?: string;
    args?: Record<string, unknown>;
    blockNumber?: number;
    blockHash?: string;
    transactionHash?: string;
  },
): ReserveUpdatedEvidence | null => {
  if (
    event.name !== 'ReserveUpdated' ||
    event.args === undefined ||
    typeof event.blockNumber !== 'number' ||
    typeof event.blockHash !== 'string' ||
    typeof event.transactionHash !== 'string'
  ) {
    return null;
  }

  return {
    name: event.name,
    args: Object.fromEntries(
      Object.entries(event.args).map(([key, value]) => [key, normalizeArgValue(value)]),
    ),
    blockNumber: event.blockNumber,
    blockHash: event.blockHash,
    transactionHash: event.transactionHash,
    observedAt: Number(env.timestamp ?? 0),
  };
};

const reserveIndexKeyFromArgs = (args: Record<string, unknown>): string | null => {
  const entity = String(args['entity'] ?? '').trim().toLowerCase();
  const tokenId = Number(args['tokenId']);
  if (!entity || !Number.isFinite(tokenId)) return null;
  return `${entity}:${tokenId}`;
};

const ensureReserveUpdatedIndex = (env: RuntimeState): Map<string, ReserveUpdatedEvidence> => {
  if (!env.runtimeState) env.runtimeState = {};
  const current = env.runtimeState.recentReserveUpdatedEvents;
  if (current instanceof Map) return current;
  const next = new Map<string, ReserveUpdatedEvidence>();
  if (current && typeof current === 'object') {
    for (const [key, value] of Object.entries(current as Record<string, ReserveUpdatedEvidence>)) {
      if (value?.name === 'ReserveUpdated') next.set(key, value);
    }
  }
  env.runtimeState.recentReserveUpdatedEvents = next;
  return next;
};

const copyReserveUpdatedEvidence = (event: ReserveUpdatedEvidence): ReserveUpdatedEvidence => ({
  ...event,
  args: { ...event.args },
});

export const indexReserveUpdatedEvents = (
  env: RuntimeState,
  events: Array<{
    name?: string;
    args?: Record<string, unknown>;
    blockNumber?: number;
    blockHash?: string;
    transactionHash?: string;
  }> | undefined,
): void => {
  if (!events || events.length === 0) return;
  if (!env.runtimeState) env.runtimeState = {};

  const evidence = events
    .map((event) => toReserveUpdatedEvidence(env, event))
    .filter((event): event is ReserveUpdatedEvidence => event !== null);
  if (evidence.length === 0) return;

  const reserveIndex = ensureReserveUpdatedIndex(env);
  for (const event of evidence) {
    const key = reserveIndexKeyFromArgs(event.args);
    if (!key) continue;
    reserveIndex.set(key, event);
  }
};

export const findReserveUpdatedEvidence = (
  env: RuntimeState,
  entityId: string,
  tokenId: number,
  expectedMin: bigint,
): ReserveUpdatedEvidence | null => {
  const normalizedEntityId = String(entityId || '').trim().toLowerCase();
  const normalizedTokenId = Number(tokenId);
  const reserveIndex = env.runtimeState?.recentReserveUpdatedEvents;
  const indexedEvent = reserveIndex instanceof Map
    ? reserveIndex.get(`${normalizedEntityId}:${normalizedTokenId}`)
    : undefined;
  if (indexedEvent) {
    const indexedBalance = readDecimalBigInt(indexedEvent.args['newBalance']);
    return indexedBalance !== null && indexedBalance >= expectedMin
      ? copyReserveUpdatedEvidence(indexedEvent)
      : null;
  }
  return null;
};
