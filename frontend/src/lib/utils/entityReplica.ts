import type { AccountMachine, EntityReplica, Env } from '@xln/runtime/xln-api';

// These helpers operate on validated runtime state only.
// The only nullable boundary is the outer env reference before a runtime is attached.
// Do not widen these helpers to ad hoc partial frontend shapes: missing accounts/deltas
// inside a live replica is a bug and must fail at the real decode/validation layer.
type EnvLike = Env | null | undefined;

function toReplicaEntries(envLike: EnvLike): Array<[string, EntityReplica]> {
  if (!envLike) return [];
  return Array.from(envLike.eReplicas.entries());
}

export function normalizeEntityId(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function matchesCounterparty(
  account: AccountMachine,
  ownerEntityId: string,
  counterpartyEntityId: string,
): boolean {
  const owner = normalizeEntityId(ownerEntityId);
  const target = normalizeEntityId(counterpartyEntityId);
  if (!target) return false;

  const left = normalizeEntityId(account.leftEntity);
  const right = normalizeEntityId(account.rightEntity);
  return (left === owner && right === target) || (right === owner && left === target);
}

function resolveCounterpartyFromAccount(account: AccountMachine, ownerEntityId: string): string {
  const owner = normalizeEntityId(ownerEntityId);
  const left = normalizeEntityId(account.leftEntity);
  const right = normalizeEntityId(account.rightEntity);
  if (left === owner) return right;
  if (right === owner) return left;
  return '';
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

export function getSignerIdForEntity(envLike: EnvLike, entityId: string, fallback = '1'): string {
  const key = getReplicaEntryForEntity(envLike, entityId)?.[0];
  if (!key) return fallback;
  return String(key).split(':')[1] || fallback;
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
) : { key: string; account: AccountMachine } | null {
  const replica = getReplicaForEntity(envLike, ownerEntityId);
  if (!replica) return null;
  const accounts = replica.state.accounts;
  const target = normalizeEntityId(counterpartyEntityId);
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

export function hasCounterpartyAccount(
  envLike: EnvLike,
  ownerEntityId: string,
  counterpartyEntityId: string,
): boolean {
  return !!getCounterpartyAccount(envLike, ownerEntityId, counterpartyEntityId);
}

export function getConnectedCounterpartyIds(envLike: EnvLike, ownerEntityId: string): Set<string> {
  const connected = new Set<string>();
  const replica = getReplicaForEntity(envLike, ownerEntityId);
  if (!replica) return connected;
  const accounts = replica.state.accounts;
  for (const [accountKey, account] of accounts.entries()) {
    const byKey = normalizeEntityId(accountKey);
    if (byKey) connected.add(byKey);
    const canonical = resolveCounterpartyFromAccount(account, ownerEntityId);
    if (canonical) connected.add(canonical);
  }
  return connected;
}
