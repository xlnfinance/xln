type ReplicaMapLike = Map<string, any> | Record<string, any> | null | undefined;

function toReplicaEntries(eReplicas: ReplicaMapLike): Array<[string, any]> {
  if (!eReplicas) return [];
  if (eReplicas instanceof Map) return Array.from(eReplicas.entries());
  return Object.entries(eReplicas);
}

export function normalizeEntityId(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function matchesCounterparty(
  account: any,
  ownerEntityId: string,
  counterpartyEntityId: string,
): boolean {
  const owner = normalizeEntityId(ownerEntityId);
  const target = normalizeEntityId(counterpartyEntityId);
  if (!target) return false;

  const cp = normalizeEntityId(account?.counterpartyEntityId);
  if (cp === target) return true;

  const left = normalizeEntityId(account?.leftEntity);
  const right = normalizeEntityId(account?.rightEntity);
  if (left && right) {
    if (left === owner && right === target) return true;
    if (right === owner && left === target) return true;
  }

  return false;
}

function resolveCounterpartyFromAccount(account: any, ownerEntityId: string): string {
  const cp = normalizeEntityId(account?.counterpartyEntityId);
  if (cp) return cp;
  const owner = normalizeEntityId(ownerEntityId);
  const left = normalizeEntityId(account?.leftEntity);
  const right = normalizeEntityId(account?.rightEntity);
  if (left && right) {
    if (left === owner) return right;
    if (right === owner) return left;
  }
  return '';
}

export function getReplicaEntryForEntity(envLike: any, entityId: string): [string, any] | null {
  const entries = toReplicaEntries(envLike?.eReplicas);
  const target = normalizeEntityId(entityId);
  for (const [key, replica] of entries) {
    const [replicaEntityId] = String(key).split(':');
    if (normalizeEntityId(replicaEntityId) === target) return [String(key), replica];
  }
  return null;
}

export function getReplicaForEntity(envLike: any, entityId: string): any | null {
  return getReplicaEntryForEntity(envLike, entityId)?.[1] ?? null;
}

export function getSignerIdForEntity(envLike: any, entityId: string, fallback = '1'): string {
  const key = getReplicaEntryForEntity(envLike, entityId)?.[0];
  if (!key) return fallback;
  return String(key).split(':')[1] || fallback;
}

export function getCounterpartyAccount(
  envLike: any,
  ownerEntityId: string,
  counterpartyEntityId: string,
): { key: string; account: any } | null {
  const replica = getReplicaForEntity(envLike, ownerEntityId);
  const accounts = replica?.state?.accounts;
  if (!(accounts instanceof Map)) return null;
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
  envLike: any,
  ownerEntityId: string,
  counterpartyEntityId: string,
): boolean {
  return !!getCounterpartyAccount(envLike, ownerEntityId, counterpartyEntityId);
}

export function getConnectedCounterpartyIds(envLike: any, ownerEntityId: string): Set<string> {
  const connected = new Set<string>();
  const replica = getReplicaForEntity(envLike, ownerEntityId);
  const accounts = replica?.state?.accounts;
  if (!(accounts instanceof Map)) return connected;
  for (const [accountKey, account] of accounts.entries()) {
    const byKey = normalizeEntityId(accountKey);
    if (byKey) connected.add(byKey);
    const canonical = resolveCounterpartyFromAccount(account, ownerEntityId);
    if (canonical) connected.add(canonical);
  }
  return connected;
}
