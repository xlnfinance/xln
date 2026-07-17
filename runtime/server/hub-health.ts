import { getTokenInfo } from '../account/utils';
import { scaleWholeTokenAmount, type Env } from '../types';
import type { JTokenInfo } from '../jadapter/types';
import { getBootstrapTokenAmount } from '../jurisdiction/bootstrap-economy';
import {
  getAccountMachine,
  getEntityOutCapacity,
  getEntityReplicaById,
  hasAccount,
} from './entity-lookup';

export const HUB_MESH_TOKEN_ID = 1;
export const HUB_MESH_CREDIT_AMOUNT = getBootstrapTokenAmount(
  HUB_MESH_TOKEN_ID,
  getTokenInfo(HUB_MESH_TOKEN_ID).decimals,
);
export const HUB_MESH_REQUIRED_HUBS = 3;
export const HUB_REQUIRED_TOKEN_COUNT = 3;

const REQUEST_CREDIT_CAP_WHOLE = 1_000n;

export const getRequestCreditCap = (tokenId: number): bigint => {
  return scaleWholeTokenAmount(REQUEST_CREDIT_CAP_WHOLE, getTokenInfo(tokenId).decimals);
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

  const tokenCatalog = await options.loadTokenCatalog();
  const bootstrapTokens = tokenCatalog
    .slice(0, HUB_REQUIRED_TOKEN_COUNT)
    .map((token) => {
      const tokenId = Number(token.tokenId);
      const decimals = Number(token.decimals);
      return {
        tokenId,
        symbol: String(token.symbol || `token-${token.tokenId}`),
        decimals,
        expectedMin: getBootstrapTokenAmount(tokenId, decimals),
      };
    });

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
      return {
        tokenId: token.tokenId,
        symbol: token.symbol,
        decimals: token.decimals,
        current: current.toString(),
        expectedMin: token.expectedMin.toString(),
        ready: current >= token.expectedMin,
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
