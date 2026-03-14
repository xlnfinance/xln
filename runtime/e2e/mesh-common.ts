import type { AccountMachine, Delta, EntityInput, Env, JEvent } from '../types';
import { enqueueRuntimeInput } from '../runtime.ts';

export const HUB_MESH_TOKEN_ID = 1;
export const HUB_MESH_CREDIT_AMOUNT = 1_000_000n * 10n ** 18n;
export const DEFAULT_ACCOUNT_TOKEN_IDS = [1, 3, 2] as const; // USDC, USDT, WETH
export const DEFAULT_USER_HUB_CREDIT_AMOUNT = 10_000n * 10n ** 18n;
export const HUB_REQUIRED_TOKEN_COUNT = 3;
export const HUB_RESERVE_TARGET_UNITS = 1_000_000_000n;
export const HUB_DEFAULT_SUPPORTED_PAIRS = ['1/2', '1/3', '2/3'] as const;
export const HUB_DEFAULT_MIN_TRADE_SIZE = 10n * 10n ** 18n;
export const BOOTSTRAP_POLL_MS = Math.max(10, Number(process.env.BOOTSTRAP_POLL_MS || '40'));
export const RUNTIME_SETTLE_POLL_MS = Math.max(10, Number(process.env.RUNTIME_SETTLE_POLL_MS || '25'));

export const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

export const hasPendingRuntimeWork = (env: Env): boolean => {
  if (env.pendingOutputs?.length) return true;
  if (env.networkInbox?.length) return true;
  if (env.runtimeInput?.runtimeTxs?.length) return true;
  if ((env as any).runtimeMempool?.entityInputs?.length) return true;
  if ((env as any).runtimeMempool?.runtimeTxs?.length) return true;

  if (env.jReplicas) {
    for (const replica of env.jReplicas.values()) {
      if ((replica.mempool?.length ?? 0) > 0) return true;
    }
  }

  return false;
};

export const settleRuntimeFor = async (env: Env, rounds = 30): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    if (!hasPendingRuntimeWork(env)) break;
    await sleep(RUNTIME_SETTLE_POLL_MS);
  }
};

export const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  maxAttempts = 120,
  stepMs = BOOTSTRAP_POLL_MS,
): Promise<boolean> => {
  for (let i = 0; i < maxAttempts; i += 1) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
};

export const applyJEventsToEnv = async (env: Env, events: JEvent[], label = 'J-EVENTS'): Promise<void> => {
  if (!events || events.length === 0) return;

  const grouped = new Map<
    string,
    {
      events: Array<{ type: string; data: Record<string, unknown> }>;
      blockNumber: number;
      blockHash: string;
      transactionHash: string;
    }
  >();

  for (const event of events) {
    const entity =
      (event as any)?.args?.entity ||
      (event as any)?.args?.entityId ||
      (event as any)?.args?.leftEntity;
    if (!entity) continue;
    const key = String(entity).toLowerCase();
    const entry = grouped.get(key) ?? {
      events: [],
      blockNumber: Number(event.blockNumber ?? 0),
      blockHash: event.blockHash ?? '0x',
      transactionHash: event.transactionHash ?? '0x',
    };
    entry.events.push({
      type: event.name ?? (event as any).type ?? 'Unknown',
      data: (event as any).args ?? {},
    });
    grouped.set(key, entry);
  }

  const observedAt = Date.now();
  const entityInputs: EntityInput[] = [];
  for (const [entityId, entry] of grouped.entries()) {
    entityInputs.push({
      entityId,
      signerId: 'j-event',
      entityTxs: [
        {
          type: 'j_event',
          data: {
            from: 'j-event',
            events: entry.events,
            observedAt,
            blockNumber: entry.blockNumber,
            blockHash: entry.blockHash,
            transactionHash: entry.transactionHash,
          },
        },
      ],
    });
  }

  if (entityInputs.length === 0) return;
  console.log(`[${label}] Queueing ${entityInputs.length} J-events`);
  enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs });
};

export const getEntityReplicaById = (env: Env, entityId: string): any | null => {
  const target = String(entityId || '').toLowerCase();
  if (!target || !env.eReplicas) return null;
  for (const [key, replica] of env.eReplicas.entries()) {
    if (typeof key === 'string' && key.toLowerCase().startsWith(`${target}:`)) {
      return replica;
    }
  }
  return null;
};

const accountMatchesCounterparty = (
  account: any,
  ownerEntityId: string,
  counterpartyId: string,
): boolean => {
  const needle = String(counterpartyId || '').toLowerCase();
  if (!needle) return false;

  const cp = typeof account?.counterpartyEntityId === 'string' ? account.counterpartyEntityId.toLowerCase() : '';
  if (cp === needle) return true;

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
  const needle = String(counterpartyId || '').toLowerCase();
  for (const [key, account] of replica.state.accounts.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === needle) return true;
    if (accountMatchesCounterparty(account, entityId, counterpartyId)) return true;
  }
  return false;
};

export const getAccountMachine = (
  env: Env,
  entityId: string,
  counterpartyId: string,
): AccountMachine | null => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return null;
  const needle = String(counterpartyId || '').toLowerCase();
  for (const [key, account] of replica.state.accounts.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === needle) return account ?? null;
    if (accountMatchesCounterparty(account, entityId, counterpartyId)) return account ?? null;
  }
  return null;
};

export const getAccountDelta = (
  env: Env,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
): Delta | null => {
  const account = getAccountMachine(env, entityId, counterpartyId);
  if (!account?.deltas) return null;
  return account.deltas.get(tokenId) ?? null;
};

export const getCreditGrantedByEntity = (
  account: AccountMachine,
  ownerEntityId: string,
  tokenId: number,
): bigint => {
  const delta = account.deltas.get(tokenId);
  if (!delta) return 0n;
  const owner = String(ownerEntityId || '').toLowerCase();
  const left = String(account.leftEntity || '').toLowerCase();
  const isOwnerLeft = owner.length > 0 && owner === left;
  return BigInt(isOwnerLeft ? (delta.rightCreditLimit ?? 0n) : (delta.leftCreditLimit ?? 0n));
};

export const hasPairMutualCredit = (
  env: Env,
  leftEntityId: string,
  rightEntityId: string,
  tokenId: number,
  amount: bigint,
): boolean => {
  const delta = getAccountDelta(env, leftEntityId, rightEntityId, tokenId);
  if (!delta) return false;
  return (delta.leftCreditLimit ?? 0n) >= amount && (delta.rightCreditLimit ?? 0n) >= amount;
};

export const hasPairMutualCredits = (
  env: Env,
  leftEntityId: string,
  rightEntityId: string,
  tokenIds: readonly number[],
  amount: bigint,
): boolean => tokenIds.every((tokenId) => hasPairMutualCredit(env, leftEntityId, rightEntityId, tokenId, amount));

export const serializeReserves = (reserves: ReadonlyMap<string | number, bigint>): Record<string, string> => {
  const entries = Array.from(reserves.entries())
    .map(([tokenId, amount]) => [String(tokenId), amount.toString()] as const)
    .sort(([left], [right]) => {
      const leftNum = Number(left);
      const rightNum = Number(right);
      if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
        return leftNum - rightNum;
      }
      return left.localeCompare(right);
    });
  return Object.fromEntries(entries);
};
