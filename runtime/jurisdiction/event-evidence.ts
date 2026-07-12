import type { Env } from '../types';

export type RecentJEvent = {
  name: string;
  args: Record<string, unknown>;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  observedAt: number;
};

export type RecentReserveUpdatedEvent = RecentJEvent & {
  name: 'ReserveUpdated';
};

const RECENT_J_EVENT_LIMIT = 1_000;

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

const toRecentJEvent = (
  env: Env,
  event: {
    name?: string;
    args?: Record<string, unknown>;
    blockNumber?: number;
    blockHash?: string;
    transactionHash?: string;
  },
): RecentJEvent | null => {
  if (
    typeof event.name !== 'string' ||
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

const ensureReserveUpdatedIndex = (env: Env): Map<string, RecentReserveUpdatedEvent> => {
  if (!env.runtimeState) env.runtimeState = {};
  const current = env.runtimeState.recentReserveUpdatedEvents;
  if (current instanceof Map) return current;
  const next = new Map<string, RecentReserveUpdatedEvent>();
  if (current && typeof current === 'object') {
    for (const [key, value] of Object.entries(current as Record<string, RecentReserveUpdatedEvent>)) {
      if (value?.name === 'ReserveUpdated') next.set(key, value);
    }
  }
  env.runtimeState.recentReserveUpdatedEvents = next;
  return next;
};

const copyRecentJEvent = <T extends RecentJEvent>(event: T): T => ({
  ...event,
  args: { ...event.args },
});

export const rememberRecentJEvents = (
  env: Env,
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

  const canonicalEvents = events
    .map((event) => toRecentJEvent(env, event))
    .filter((event): event is RecentJEvent => event !== null);
  if (canonicalEvents.length === 0) return;

  const previous = env.runtimeState.recentJEvents ?? [];
  env.runtimeState.recentJEvents = [...previous, ...canonicalEvents].slice(-RECENT_J_EVENT_LIMIT);

  const reserveIndex = ensureReserveUpdatedIndex(env);
  for (const event of canonicalEvents) {
    if (event.name !== 'ReserveUpdated') continue;
    const key = reserveIndexKeyFromArgs(event.args);
    if (!key) continue;
    reserveIndex.set(key, event as RecentReserveUpdatedEvent);
  }
};

export const findRecentReserveUpdatedEvent = (
  env: Env,
  entityId: string,
  tokenId: number,
  expectedMin: bigint,
): RecentReserveUpdatedEvent | null => {
  const normalizedEntityId = String(entityId || '').trim().toLowerCase();
  const normalizedTokenId = Number(tokenId);
  const reserveIndex = env.runtimeState?.recentReserveUpdatedEvents;
  const indexedEvent = reserveIndex instanceof Map
    ? reserveIndex.get(`${normalizedEntityId}:${normalizedTokenId}`)
    : undefined;
  if (indexedEvent) {
    const indexedBalance = readDecimalBigInt(indexedEvent.args['newBalance']);
    return indexedBalance !== null && indexedBalance >= expectedMin ? copyRecentJEvent(indexedEvent) : null;
  }

  const events = env.runtimeState?.recentJEvents ?? [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event || event.name !== 'ReserveUpdated') continue;
    const args = event.args ?? {};
    const eventEntity = String(args['entity'] ?? '').trim().toLowerCase();
    const eventTokenId = Number(args['tokenId']);
    const newBalance = readDecimalBigInt(args['newBalance']);
    if (eventEntity !== normalizedEntityId) continue;
    if (eventTokenId !== normalizedTokenId) continue;
    if (newBalance === null || newBalance < expectedMin) continue;
    return copyRecentJEvent(event as RecentReserveUpdatedEvent);
  }
  return null;
};
