import { deriveDelta } from '../../../account/utils';
import type { AccountReplica, AccountState } from '../../../types/account';
import type { RuntimeReplica } from '../../../runtime/types';
import { getEntityReplicaById } from '../../../entity/replica/replica-lookup';
import { findAccountByCounterparty } from '../../../account/state/account-lookup';
export { getEntityReplicaById } from '../../../entity/replica/replica-lookup';

export const hasAccount = (env: RuntimeReplica, entityId: string, counterpartyId: string): boolean => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return false;
  return findAccountByCounterparty(replica.state.accounts, entityId, counterpartyId) !== null;
};

export const getAccountReplica = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
): AccountReplica | null => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return null;
  return findAccountByCounterparty(replica.state.accounts, entityId, counterpartyId);
};

export const getEntityOutCapacity = (
  account: AccountState | null,
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

export const getReplicaReserveSnapshot = (env: RuntimeReplica, entityId: string): Record<string, string> | undefined => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.reserves || replica.state.reserves.size === 0) return undefined;
  return serializeReserveMap(replica.state.reserves);
};

export const getReplicaAccountCount = (env: RuntimeReplica, entityId: string): number | undefined => {
  const replica = getEntityReplicaById(env, entityId);
  return replica?.state?.accounts?.size;
};
