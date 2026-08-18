import type { AccountReplica, EntityReplica, RuntimeReplica } from '@xln/core/api/public/runtime-module';

// These helpers operate on validated runtime state only.
// The only nullable boundary is the outer env reference before a runtime is attached.
// Do not widen these helpers to ad hoc partial frontend shapes: missing accounts/deltas
// inside a live replica is a bug and must fail at the real decode/validation layer.
type EnvLike = RuntimeReplica | null | undefined;

function toReplicaEntries(envLike: EnvLike): Array<[string, EntityReplica]> {
  if (!envLike) return [];
  return Array.from(envLike.state.eReplicas.entries());
}

export function normalizeEntityId(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function matchesCounterparty(
  account: AccountReplica,
  ownerEntityId: string,
  counterpartyEntityId: string,
): boolean {
  const owner = normalizeEntityId(ownerEntityId);
  const target = normalizeEntityId(counterpartyEntityId);
  if (!target) return false;

  const left = normalizeEntityId(account.state.leftEntity);
  const right = normalizeEntityId(account.state.rightEntity);
  return (left === owner && right === target) || (right === owner && left === target);
}

export function getReplicaEntryForEntity(envLike: EnvLike, entityId: string): [string, EntityReplica] | null {
  const entries = toReplicaEntries(envLike);
  const target = normalizeEntityId(entityId);
  for (const [key, replica] of entries) {
    const [replicaEntityId] = String(key).split(':');
    if (normalizeEntityId(replicaEntityId) === target) return [String(key), replica];
  }
  return null;
}

export function getReplicaForEntity(envLike: EnvLike, entityId: string): EntityReplica | null {
  return getReplicaEntryForEntity(envLike, entityId)?.[1] ?? null;
}

export function getSignerIdForEntity(envLike: EnvLike, entityId: string, defaultSignerId = '1'): string {
  const key = getReplicaEntryForEntity(envLike, entityId)?.[0];
  if (!key) return defaultSignerId;
  return String(key).split(':')[1] || defaultSignerId;
}

export function requireSignerIdForEntity(envLike: EnvLike, entityId: string, context = 'entity-action'): string {
  const signerId = getSignerIdForEntity(envLike, entityId, '');
  if (signerId) return signerId;
  const normalized = normalizeEntityId(entityId) || String(entityId || 'unknown');
  throw new Error(`No local signer replica found for entity ${normalized} (${context})`);
}

export function getCounterpartyAccount(
  envLike: EnvLike,
  ownerEntityId: string,
  counterpartyEntityId: string,
) : { key: string; account: AccountReplica } | null {
  const replica = getReplicaForEntity(envLike, ownerEntityId);
  if (!replica) return null;
  const accounts = replica.state.accounts;
  const target = normalizeEntityId(counterpartyEntityId);
  const direct = accounts.get(target) ?? accounts.get(String(counterpartyEntityId || ''));
  if (direct) {
    return { key: target || String(counterpartyEntityId || ''), account: direct };
  }
  for (const [accountKey, account] of accounts.entries()) {
    if (normalizeEntityId(accountKey) === target) {
      return { key: String(accountKey), account };
    }
    if (matchesCounterparty(account, ownerEntityId, counterpartyEntityId)) {
      return { key: String(accountKey), account };
    }
  }
  return null;
}

export function isCommittedAccount(account: AccountReplica | null | undefined): boolean {
  if (!account) return false;
  return Number(account.currentFrame?.height ?? account.currentHeight ?? 0) > 0;
}

export function isOpeningAccount(account: AccountReplica | null | undefined): boolean {
  if (!account) return false;
  return !isCommittedAccount(account);
}
