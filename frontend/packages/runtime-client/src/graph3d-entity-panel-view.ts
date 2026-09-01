// Framework-neutral view model for the compact Graph3D entity panel. It owns
// historical-frame selection plus the Map-or-Record projections produced by
// browser serialization. Rendering, Svelte stores, and click effects remain in
// the framework facade.

import type { EnvSnapshot, RuntimeReplica } from '@xln/core/api/public/runtime-module';

export type Graph3dEntityDeltaLike = Readonly<{
  collateral?: unknown;
  ondelta?: unknown;
}>;

export type Graph3dEntityAccountLike = Readonly<{
  state: Readonly<{
    deltas?: ReadonlyMap<number, Graph3dEntityDeltaLike> | Record<string, Graph3dEntityDeltaLike>;
  }>;
}>;

export type Graph3dEntityReplicaLike = Readonly<{
  state?: Readonly<{
    reserves?: ReadonlyMap<unknown, unknown> | Record<string, unknown>;
    accounts?: ReadonlyMap<string, Graph3dEntityAccountLike> | Record<string, Graph3dEntityAccountLike>;
  }>;
}>;

export type Graph3dEntityFrameLike = Readonly<{
  state: Readonly<{
    eReplicas?: ReadonlyMap<string, Graph3dEntityReplicaLike> | Record<string, Graph3dEntityReplicaLike>;
  }>;
}>;

export type Graph3dEntityAccountPreview = Readonly<{
  counterpartyId: string;
  ondelta: bigint;
}>;

export type Graph3dEntityPanelView = Readonly<{
  title: string;
  reserve: bigint;
  totalCollateral: bigint;
  accountCount: number;
  accountPreviews: readonly Graph3dEntityAccountPreview[];
  remainingAccountCount: number;
}>;

type Graph3dEntityPanelInput = Readonly<{
  entityId: string;
  entityName: string;
  liveFrame: RuntimeReplica | null;
  history: readonly EnvSnapshot[];
  timeIndex: number;
}>;

const TOKEN_ID = 1;
const PREVIEW_LIMIT = 3;

const isReadonlyMap = <K, V>(
  value: ReadonlyMap<K, V> | Record<string, V>,
): value is ReadonlyMap<K, V> =>
  typeof Reflect.get(value, 'entries') === 'function'
  && typeof Reflect.get(value, 'get') === 'function';

const collectionEntries = <T>(
  collection: ReadonlyMap<string, T> | Record<string, T> | undefined,
): Array<[string, T]> => {
  if (!collection) return [];
  return isReadonlyMap(collection) ? Array.from(collection.entries()) : Object.entries(collection);
};

export const graph3dEntityBigInt = (value: unknown): bigint => {
  if (value === undefined || value === null) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') return BigInt(value.replace(/n$/, '') || '0');
  return BigInt(String(value));
};

export const selectGraph3dEntityFrame = (
  liveFrame: RuntimeReplica | null,
  history: readonly EnvSnapshot[],
  timeIndex: number,
): RuntimeReplica | EnvSnapshot | null => {
  if (timeIndex < 0 || history.length === 0) return liveFrame;
  return history[Math.min(timeIndex, history.length - 1)] ?? null;
};

const findEntityReplica = (
  frame: Graph3dEntityFrameLike | null,
  entityId: string,
): Graph3dEntityReplicaLike | null => {
  const replicas = frame?.state.eReplicas;
  if (!replicas) return null;
  return collectionEntries(replicas)
    .find(([key]) => key.startsWith(`${entityId}:`))?.[1] ?? null;
};

const reserveValue = (
  reserves: ReadonlyMap<unknown, unknown> | Record<string, unknown> | undefined,
  tokenId: number,
): bigint => {
  if (!reserves) return 0n;
  if (isReadonlyMap(reserves)) return graph3dEntityBigInt(reserves.get(String(tokenId)));
  return graph3dEntityBigInt(reserves[String(tokenId)]);
};

const accountDelta = (
  account: Graph3dEntityAccountLike,
  tokenId: number,
): Graph3dEntityDeltaLike | null => {
  const deltas = account.state.deltas;
  if (!deltas) return null;
  return isReadonlyMap(deltas) ? deltas.get(tokenId) ?? null : deltas[String(tokenId)] ?? null;
};

export const createGraph3dEntityPanelView = ({
  entityId,
  entityName,
  liveFrame,
  history,
  timeIndex,
}: Graph3dEntityPanelInput): Graph3dEntityPanelView => {
  const frame = selectGraph3dEntityFrame(liveFrame, history, timeIndex);
  const replica = findEntityReplica(frame, entityId);
  const accounts = collectionEntries(replica?.state?.accounts);
  const totalCollateral = accounts.reduce((sum, [, account]) =>
    sum + graph3dEntityBigInt(accountDelta(account, TOKEN_ID)?.collateral), 0n);
  const accountPreviews = accounts.slice(0, PREVIEW_LIMIT).map(([counterpartyId, account]) => ({
    counterpartyId,
    ondelta: graph3dEntityBigInt(accountDelta(account, TOKEN_ID)?.ondelta),
  }));

  return {
    title: entityName || entityId,
    reserve: reserveValue(replica?.state?.reserves, TOKEN_ID),
    totalCollateral,
    accountCount: accounts.length,
    accountPreviews,
    remainingAccountCount: Math.max(0, accounts.length - PREVIEW_LIMIT),
  };
};
