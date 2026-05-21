import { getTokenInfo } from '../account-utils';
import type { Env } from '../types';
import type { JTokenInfo } from '../jadapter/types';
import {
  getAccountMachine,
  getEntityOutCapacity,
  getEntityReplicaById,
  hasAccount,
} from './entity-lookup';

export const HUB_MESH_TOKEN_ID = 1;
export const HUB_MESH_CREDIT_AMOUNT = 1_000_000n * 10n ** 18n;
export const HUB_MESH_REQUIRED_HUBS = 3;
export const HUB_REQUIRED_TOKEN_COUNT = 3;
export const HUB_RESERVE_TARGET_UNITS = 1_000_000_000n;

const REQUEST_CREDIT_CAP_WHOLE = 1_000n;

export const getRequestCreditCap = (tokenId: number): bigint => {
  const decimals = Number(getTokenInfo(tokenId).decimals);
  const normalizedDecimals = Number.isFinite(decimals) && decimals >= 0 ? Math.floor(decimals) : 18;
  return REQUEST_CREDIT_CAP_WHOLE * 10n ** BigInt(normalizedDecimals);
};

export const getHubMeshHealth = (env: Env | null, activeHubEntityIds: readonly string[]) => {
  if (!env) {
    return {
      requiredHubCount: HUB_MESH_REQUIRED_HUBS,
      tokenId: HUB_MESH_TOKEN_ID,
      requiredCredit: HUB_MESH_CREDIT_AMOUNT.toString(),
      hubIds: [] as string[],
      pairs: [] as Array<{
        left: string;
        right: string;
        tokenId: number;
        requiredCredit: string;
        leftHasAccount: boolean;
        rightHasAccount: boolean;
        leftOutCapacity: string;
        rightOutCapacity: string;
        ok: boolean;
      }>,
      ok: false,
    };
  }
  const hubIds = activeHubEntityIds.slice(0, HUB_MESH_REQUIRED_HUBS);
  const pairStatuses: Array<{
    left: string;
    right: string;
    tokenId: number;
    requiredCredit: string;
    leftHasAccount: boolean;
    rightHasAccount: boolean;
    leftOutCapacity: string;
    rightOutCapacity: string;
    ok: boolean;
  }> = [];

  for (let i = 0; i < hubIds.length; i++) {
    for (let j = i + 1; j < hubIds.length; j++) {
      const left = hubIds[i]!;
      const right = hubIds[j]!;
      const leftAccount = getAccountMachine(env, left, right);
      const rightAccount = getAccountMachine(env, right, left);
      const leftHasAccount = hasAccount(env, left, right);
      const rightHasAccount = hasAccount(env, right, left);
      const leftOutCapacity = getEntityOutCapacity(leftAccount, left, HUB_MESH_TOKEN_ID);
      const rightOutCapacity = getEntityOutCapacity(rightAccount, right, HUB_MESH_TOKEN_ID);
      const ok =
        leftHasAccount &&
        rightHasAccount &&
        leftOutCapacity >= HUB_MESH_CREDIT_AMOUNT &&
        rightOutCapacity >= HUB_MESH_CREDIT_AMOUNT;

      pairStatuses.push({
        left,
        right,
        tokenId: HUB_MESH_TOKEN_ID,
        requiredCredit: HUB_MESH_CREDIT_AMOUNT.toString(),
        leftHasAccount,
        rightHasAccount,
        leftOutCapacity: leftOutCapacity.toString(),
        rightOutCapacity: rightOutCapacity.toString(),
        ok,
      });
    }
  }

  const ok = hubIds.length >= HUB_MESH_REQUIRED_HUBS && pairStatuses.length > 0 && pairStatuses.every(p => p.ok);

  return {
    requiredHubCount: HUB_MESH_REQUIRED_HUBS,
    tokenId: HUB_MESH_TOKEN_ID,
    requiredCredit: HUB_MESH_CREDIT_AMOUNT.toString(),
    hubIds,
    pairs: pairStatuses,
    ok,
  };
};

type BootstrapReserveTokenHealth = {
  tokenId: number;
  symbol: string;
  decimals: number;
  current: string;
  expectedMin: string;
  ready: boolean;
};

type BootstrapReserveEntityHealth = {
  entityId: string;
  role: 'hub' | 'market-maker';
  ready: boolean;
  tokens: BootstrapReserveTokenHealth[];
};

export type BootstrapReserveHealth = {
  ok: boolean;
  requiredTokenCount: number;
  entityCount: number;
  entities: BootstrapReserveEntityHealth[];
};

export const getBootstrapReserveHealth = async (
  env: Env | null,
  options: {
    activeHubEntityIds: readonly string[];
    marketMakerEntityId?: string | null;
    loadTokenCatalog: () => Promise<JTokenInfo[]>;
  },
): Promise<BootstrapReserveHealth> => {
  if (!env) {
    return {
      ok: false,
      requiredTokenCount: HUB_REQUIRED_TOKEN_COUNT,
      entityCount: 0,
      entities: [],
    };
  }

  const tokenCatalog = await options.loadTokenCatalog().catch(() => []);
  const bootstrapTokens = tokenCatalog
    .slice(0, HUB_REQUIRED_TOKEN_COUNT)
    .map((token) => ({
      tokenId: Number(token.tokenId),
      symbol: String(token.symbol || `token-${token.tokenId}`),
      decimals: Number.isFinite(token.decimals) ? Number(token.decimals) : 18,
    }))
    .filter((token) => Number.isFinite(token.tokenId) && token.tokenId > 0);

  const marketMakerEntityId = options.marketMakerEntityId?.toLowerCase() ?? null;
  const entityIds = Array.from(
    new Set(
      [
        ...options.activeHubEntityIds.map((entityId) => entityId.toLowerCase()),
        ...(marketMakerEntityId ? [marketMakerEntityId] : []),
      ].filter((entityId) => entityId.length > 0),
    ),
  );

  const entities = entityIds.map<BootstrapReserveEntityHealth>((entityId) => {
    const replica = getEntityReplicaById(env, entityId);
    const role: 'hub' | 'market-maker' =
      marketMakerEntityId && entityId === marketMakerEntityId ? 'market-maker' : 'hub';
    const tokens = bootstrapTokens.map<BootstrapReserveTokenHealth>((token) => {
      const current = replica?.state?.reserves?.get(token.tokenId) ?? 0n;
      const expectedMin = HUB_RESERVE_TARGET_UNITS * 10n ** BigInt(token.decimals);
      return {
        tokenId: token.tokenId,
        symbol: token.symbol,
        decimals: token.decimals,
        current: current.toString(),
        expectedMin: expectedMin.toString(),
        ready: current >= expectedMin,
      };
    });
    return {
      entityId,
      role,
      ready: tokens.length >= HUB_REQUIRED_TOKEN_COUNT && tokens.every((token) => token.ready),
      tokens,
    };
  });

  return {
    ok:
      bootstrapTokens.length >= HUB_REQUIRED_TOKEN_COUNT &&
      entities.length > 0 &&
      entities.every((entity) => entity.ready),
    requiredTokenCount: HUB_REQUIRED_TOKEN_COUNT,
    entityCount: entities.length,
    entities,
  };
};
