import { deriveDelta } from '../account-utils';
import type { AccountMachine, EntityReplica, Env } from '../types';

export const getEntityReplicaById = (env: Env, entityId: string): EntityReplica | null => {
  if (!env.eReplicas) return null;
  const target = entityId.toLowerCase();
  for (const [key, replica] of env.eReplicas.entries()) {
    if (typeof key === 'string' && key.toLowerCase().startsWith(`${target}:`)) {
      return replica;
    }
  }
  return null;
};

const accountMatchesCounterparty = (
  account: AccountMachine | null | undefined,
  ownerEntityId: string,
  counterpartyId: string,
): boolean => {
  const needle = String(counterpartyId || '').toLowerCase();
  if (!needle) return false;

  const me = String(ownerEntityId || '').toLowerCase();
  const left = typeof account?.leftEntity === 'string' ? account.leftEntity.toLowerCase() : '';
  const right = typeof account?.rightEntity === 'string' ? account.rightEntity.toLowerCase() : '';

  if (left && right) {
    if (left === me && right === needle) return true;
    if (right === me && left === needle) return true;
  }

  return false;
};

export const hasAccount = (env: Env, entityId: string, counterpartyId: string): boolean => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return false;
  const needle = counterpartyId.toLowerCase();
  for (const [key, account] of replica.state.accounts.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === needle) {
      return true;
    }
    if (accountMatchesCounterparty(account, entityId, counterpartyId)) return true;
  }
  return false;
};

export const getAccountMachine = (env: Env, entityId: string, counterpartyId: string): AccountMachine | null => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return null;
  const needle = counterpartyId.toLowerCase();
  for (const [key, account] of replica.state.accounts.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === needle) {
      return account ?? null;
    }
    if (accountMatchesCounterparty(account, entityId, counterpartyId)) {
      return account ?? null;
    }
  }
  return null;
};

export const getEntityOutCapacity = (
  account: AccountMachine | null,
  ownerEntityId: string,
  tokenId: number,
): bigint => {
  if (!account) return 0n;
  const delta = account.deltas.get(tokenId);
  if (!delta) return 0n;
  return deriveDelta(delta, account.leftEntity === ownerEntityId).outCapacity;
};

const compareText = (left: string, right: string): number => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const serializeReserveMap = (reserves: ReadonlyMap<string | number, bigint>): Record<string, string> => {
  const entries = Array.from(reserves.entries())
    .map(([tokenId, amount]) => [String(tokenId), amount.toString()] as const)
    .sort(([left], [right]) => {
      const leftNum = Number(left);
      const rightNum = Number(right);
      if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
        return leftNum - rightNum;
      }
      return compareText(left, right);
    });
  return Object.fromEntries(entries);
};

export const getReplicaReserveSnapshot = (env: Env, entityId: string): Record<string, string> | undefined => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.reserves || replica.state.reserves.size === 0) return undefined;
  return serializeReserveMap(replica.state.reserves);
};

export const getReplicaAccountCount = (env: Env, entityId: string): number | undefined => {
  const replica = getEntityReplicaById(env, entityId);
  return replica?.state?.accounts?.size;
};
