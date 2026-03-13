import type { Delta, DerivedDelta, Profile as GossipProfile } from '@xln/runtime/xln-api';
import { getTokenCapacity, normalizeBigInt } from '@xln/runtime/routing/capacity';

export type CapacitySnapshot = {
  inCapacity: bigint;
  outCapacity: bigint;
};

export type DeriveDeltaFn = (delta: Delta, isLeftPerspective: boolean) => DerivedDelta;

export type LocalReplicaLike = {
  state: {
    entityEncPubKey: string;
    accounts: Map<string, LocalAccountLike>;
  };
};

export type LocalAccountLike = {
  leftEntity: string;
  rightEntity: string;
  deltas: Map<number, Delta>;
};

export type HopQuote = {
  fee: bigint;
  feePPM: number;
  baseFee: bigint;
  outCap: bigint;
  inCap: bigint;
};

export function normalizeEntityId(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

export function sanitizeBigInt(raw: unknown): bigint {
  const normalized = normalizeBigInt(raw);
  return normalized < 0n ? 0n : normalized;
}

export function sanitizeFeePPM(raw: unknown, defaultFeePPM = 1): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultFeePPM;
  const value = Math.floor(n);
  if (value < 0) return 0;
  if (value > 1_000_000) return 1_000_000;
  return value;
}

export function normalizeEnvelopeKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(prefixed)) return prefixed.toLowerCase();
  if (trimmed.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return trimmed;
  return null;
}

export function findProfileByEntityId(
  profiles: readonly GossipProfile[],
  entityId: string,
): GossipProfile | null {
  const targetId = normalizeEntityId(entityId);
  if (!targetId) return null;
  for (const profile of profiles) {
    if (normalizeEntityId(profile.entityId) === targetId) {
      return profile;
    }
  }
  return null;
}

function findTokenDelta(
  account: LocalAccountLike,
  tokenId: number,
): Delta | null {
  const directDelta = account.deltas.get(tokenId);
  if (directDelta) return directDelta;
  for (const [deltaTokenId, delta] of account.deltas.entries()) {
    if (Number(deltaTokenId) === tokenId) {
      return delta;
    }
  }
  return null;
}

function resolveReplicaPerspective(
  account: LocalAccountLike,
  fromEntityId: string,
  toEntityId: string,
): boolean {
  const fromNorm = normalizeEntityId(fromEntityId);
  const leftNorm = normalizeEntityId(account.leftEntity);
  const rightNorm = normalizeEntityId(account.rightEntity);
  if (leftNorm) return leftNorm === fromNorm;
  if (rightNorm) return rightNorm !== fromNorm;
  return fromNorm < normalizeEntityId(toEntityId);
}

export function getLocalAccountCapacity(
  replicaMap: ReadonlyMap<string, LocalReplicaLike>,
  deriveDelta: DeriveDeltaFn,
  fromEntityId: string,
  toEntityId: string,
  tokenId: number,
): CapacitySnapshot | null {
  const fromNorm = normalizeEntityId(fromEntityId);
  const toNorm = normalizeEntityId(toEntityId);

  for (const [replicaKey, replica] of replicaMap.entries()) {
    const [replicaEntityId] = replicaKey.split(':');
    if (normalizeEntityId(replicaEntityId) !== fromNorm) continue;
    for (const [counterpartyId, account] of replica.state.accounts.entries()) {
      if (normalizeEntityId(counterpartyId) !== toNorm) continue;
      const delta = findTokenDelta(account, tokenId);
      if (!delta) return null;
      const derived = deriveDelta(delta, resolveReplicaPerspective(account, fromEntityId, toEntityId));
      const outCapacity = sanitizeBigInt(derived.outCapacity);
      const inCapacity = sanitizeBigInt(derived.inCapacity);
      if (outCapacity <= 0n && inCapacity <= 0n) return null;
      return { outCapacity, inCapacity };
    }
  }

  return null;
}

export function getGossipAccountCapacity(
  profiles: readonly GossipProfile[],
  ownerEntityId: string,
  counterpartyEntityId: string,
  tokenId: number,
): CapacitySnapshot | null {
  const ownerProfile = findProfileByEntityId(profiles, ownerEntityId);
  if (!ownerProfile) return null;
  const counterpartyNorm = normalizeEntityId(counterpartyEntityId);
  const account = ownerProfile.accounts.find(
    (entry) => normalizeEntityId(entry.counterpartyId) === counterpartyNorm,
  );
  if (!account) return null;
  const capacity = getTokenCapacity(account.tokenCapacities, tokenId);
  if (!capacity) return null;
  if (capacity.outCapacity <= 0n && capacity.inCapacity <= 0n) return null;
  return capacity;
}

export function getDirectionalEdgeCapacity(
  replicaMap: ReadonlyMap<string, LocalReplicaLike>,
  profiles: readonly GossipProfile[],
  deriveDelta: DeriveDeltaFn,
  fromEntityId: string,
  toEntityId: string,
  tokenId: number,
): bigint {
  const fromLocal = getLocalAccountCapacity(replicaMap, deriveDelta, fromEntityId, toEntityId, tokenId);
  const toLocal = getLocalAccountCapacity(replicaMap, deriveDelta, toEntityId, fromEntityId, tokenId);
  const fromGossip = getGossipAccountCapacity(profiles, fromEntityId, toEntityId, tokenId);
  const toGossip = getGossipAccountCapacity(profiles, toEntityId, fromEntityId, tokenId);

  const fromOut = [fromLocal?.outCapacity ?? 0n, fromGossip?.outCapacity ?? 0n]
    .reduce((currentMax, value) => value > currentMax ? value : currentMax, 0n);
  const toIn = [toLocal?.inCapacity ?? 0n, toGossip?.inCapacity ?? 0n]
    .reduce((currentMax, value) => value > currentMax ? value : currentMax, 0n);

  if (fromOut > 0n && toIn > 0n) return fromOut < toIn ? fromOut : toIn;
  return fromOut > toIn ? fromOut : toIn;
}

export function extractEntityEncPubKey(
  replicaMap: ReadonlyMap<string, LocalReplicaLike>,
  profiles: readonly GossipProfile[],
  entityId: string,
): string | null {
  const targetId = normalizeEntityId(entityId);
  if (!targetId) return null;

  for (const [replicaKey, replica] of replicaMap.entries()) {
    const [replicaEntityId] = replicaKey.split(':');
    if (normalizeEntityId(replicaEntityId) !== targetId) continue;
    const normalized = normalizeEnvelopeKey(replica.state.entityEncPubKey);
    if (normalized) return normalized;
  }

  const profile = findProfileByEntityId(profiles, entityId);
  if (!profile) return null;
  return normalizeEnvelopeKey(profile.metadata.entityEncPubKey);
}

export function quoteHop(
  replicaMap: ReadonlyMap<string, LocalReplicaLike>,
  profiles: readonly GossipProfile[],
  deriveDelta: DeriveDeltaFn,
  fromEntityId: string,
  toEntityId: string,
  tokenId: number,
  amountIn: bigint,
  defaultUnknownHopFeePPM: number,
): HopQuote | null {
  const profile = findProfileByEntityId(profiles, fromEntityId);
  const directionalOutCap = getDirectionalEdgeCapacity(
    replicaMap,
    profiles,
    deriveDelta,
    fromEntityId,
    toEntityId,
    tokenId,
  );
  if (directionalOutCap <= 0n) return null;

  const tokenCapacity =
    getLocalAccountCapacity(replicaMap, deriveDelta, fromEntityId, toEntityId, tokenId)
    ?? getGossipAccountCapacity(profiles, fromEntityId, toEntityId, tokenId);
  const feePPM = sanitizeFeePPM(profile?.metadata.routingFeePPM, defaultUnknownHopFeePPM);
  const baseFee = sanitizeBigInt(profile?.metadata.baseFee ?? 0n);
  const ppmFee = (amountIn * BigInt(feePPM)) / 1_000_000n;

  return {
    fee: baseFee + ppmFee,
    feePPM,
    baseFee,
    outCap: directionalOutCap,
    inCap: sanitizeBigInt(tokenCapacity?.inCapacity ?? 0n),
  };
}
