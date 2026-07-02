import type { AccountMachine, EntityReplica, Env, Profile as GossipProfile, RuntimeInput } from '@xln/runtime/xln-api';
import { getJurisdictionStackId } from '@xln/runtime/xln-api';
import {
  buildOpenAccountTx,
  type OpenAccountRebalancePolicy,
} from './entity-action-txs';

import {
  hasUsableOpenAccountCounterpartyProfile,
  waitForCounterpartyRuntimeRoutes,
} from '../../utils/p2pPrefetch';
import {
  isCommittedAccount,
  isOpeningAccount,
  normalizeEntityId,
} from '../../utils/entityReplica';
import type { Runtime } from '../../stores/runtimeStore';

export type HubProfileSeedResult = {
  ready: boolean;
  error?: string;
};

export type HubOpenAccountProfile = {
  entityId: string;
  runtimeId?: string | null;
  metadata?: {
    isHub?: boolean;
    jurisdiction?: unknown;
  };
};

export type HubOpenAccountPermissionInput = {
  adapterMode?: string | null;
  authLevel?: string | null;
};

export type HubOpenAccountRebalancePolicy = {
  r2cRequestSoftLimit: bigint;
  hardLimit: bigint;
  maxAcceptableFee: bigint;
};

export type HubOpenAccountRuntimeInputRequest = {
  sourceEntityId: string;
  signerId: string;
  hubEntityId: string;
  creditAmount: bigint;
  tokenId?: number;
  rebalancePolicy?: HubOpenAccountRebalancePolicy | null;
};

export type DirectOpenAccountRuntimeInputRequest = {
  sourceEntityId: string;
  signerId: string;
  targetEntityId: string;
  rebalancePolicy?: OpenAccountRebalancePolicy | null;
};

export type HubDiscoveryJurisdiction = {
  name?: string;
  chainId?: number | string;
  depositoryAddress?: string;
};

export type HubDiscoveryHub = {
  entityId: string;
  name: string;
  metadata: {
    description?: string;
    website?: string;
    jurisdiction?: HubDiscoveryJurisdiction;
    isHub: boolean;
    fee: number;
    peerCount: number;
  };
  runtimeId: string;
  wsUrl: string | null;
  lastSeen: number;
  raw: string;
  avatar: string;
  isConnected: boolean;
  isOpening: boolean;
};

export type HubDiscoveryRemoteHub = {
  entityId: string;
  name: string;
  runtimeId: string;
  wsUrl: string | null;
  jurisdiction?: HubDiscoveryJurisdiction;
  height?: number;
  lastSeen?: number;
};

export function buildHubDiscoveryRemoteHubsFromRuntimes(
  runtimes: Iterable<Runtime>,
): HubDiscoveryRemoteHub[] {
  return Array.from(runtimes).flatMap((runtime): HubDiscoveryRemoteHub[] => {
    if (runtime.type !== 'remote') return [];
    const hubEntities = runtime.hubEntities?.length
      ? runtime.hubEntities
      : runtime.hubEntityId
        ? [{
            entityId: runtime.hubEntityId,
            label: runtime.hubName || runtime.label,
            height: 0,
            ...(runtime.hubJurisdiction ? { jurisdiction: runtime.hubJurisdiction } : {}),
          }]
        : [];
    return hubEntities.map((hub) => ({
      entityId: hub.entityId,
      name: hub.label || runtime.hubName || runtime.label,
      runtimeId: runtime.id,
      wsUrl: runtime.wsUrl ?? null,
      ...(hub.jurisdiction ?? runtime.hubJurisdiction ? { jurisdiction: hub.jurisdiction ?? runtime.hubJurisdiction } : {}),
      height: hub.height,
      lastSeen: runtime.lastSynced ?? hub.height,
    }));
  });
}

export type HubDiscoveryConnectionState = {
  isConnected: boolean;
  isOpening: boolean;
};

export type HubDiscoveryProjection = {
  discoveryKey: string;
  entityJurisdictionKey: string;
  sourceSignerId: string;
  localHubs: HubDiscoveryHub[];
  connectionByHubId: Map<string, HubDiscoveryConnectionState>;
};

export const HUB_OPEN_ACCOUNT_REQUIRES_ADMIN =
  'Account opening requires admin runtime access.';

type RuntimeProfileSourceEnv = Env & {
  gossip?: {
    getProfiles?: () => unknown[];
  };
  runtimeState?: {
    p2p?: {
      ensureProfiles?: (entityIds: string[]) => Promise<boolean>;
    };
  };
};

export const normalizeHubEntityId = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

export const isSameEntityId = (left: unknown, right: unknown): boolean => {
  const leftId = normalizeHubEntityId(left);
  const rightId = normalizeHubEntityId(right);
  return Boolean(leftId && rightId && leftId === rightId);
};

export function buildHubOpenAccountRuntimeInput(request: HubOpenAccountRuntimeInputRequest): RuntimeInput {
  const sourceEntityId = normalizeHubEntityId(request.sourceEntityId);
  const signerId = String(request.signerId || '').trim();
  const hubEntityId = normalizeHubEntityId(request.hubEntityId);
  const creditAmount = BigInt(request.creditAmount);
  const tokenId = Math.max(1, Math.floor(Number(request.tokenId ?? 1)));
  if (!sourceEntityId) throw new Error('Entity is required for hub account setup.');
  if (!signerId) throw new Error('Signer is required for hub account setup.');
  if (!hubEntityId) throw new Error('Hub entity is required for hub account setup.');
  if (sourceEntityId === hubEntityId) throw new Error('Cannot open an account with the same entity.');
  if (creditAmount <= 0n) throw new Error('Hub account credit amount must be positive.');
  if (!Number.isFinite(tokenId) || tokenId <= 0) throw new Error('Hub account token id must be positive.');

  return {
    runtimeTxs: [],
    entityInputs: [{
      entityId: sourceEntityId,
      signerId,
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: hubEntityId,
          creditAmount,
          tokenId,
          ...(request.rebalancePolicy ? { rebalancePolicy: request.rebalancePolicy } : {}),
        },
      }],
    }],
  };
}

export function buildDirectOpenAccountRuntimeInput(request: DirectOpenAccountRuntimeInputRequest): RuntimeInput {
  const sourceEntityId = normalizeHubEntityId(request.sourceEntityId);
  const signerId = String(request.signerId || '').trim();
  const targetEntityId = normalizeHubEntityId(request.targetEntityId);
  if (!sourceEntityId) throw new Error('Entity is required for account setup.');
  if (!signerId) throw new Error('Signer is required for account setup.');
  if (!targetEntityId) throw new Error('Target entity is required for account setup.');
  if (sourceEntityId === targetEntityId) throw new Error('Cannot open an account with the same entity.');

  return {
    runtimeTxs: [],
    entityInputs: [{
      entityId: sourceEntityId,
      signerId,
      entityTxs: [
        buildOpenAccountTx(targetEntityId, request.rebalancePolicy ?? null),
      ],
    }],
  };
}

export const emptyHubDiscoveryProjection = (): HubDiscoveryProjection => ({
  discoveryKey: '',
  entityJurisdictionKey: '',
  sourceSignerId: '',
  localHubs: [],
  connectionByHubId: new Map(),
});

export const hubDiscoveryJurisdictionKey = (value: unknown): string => {
  if (value && typeof value === 'object') {
    const jurisdiction = value as HubDiscoveryJurisdiction;
    const chainId = Number(jurisdiction.chainId);
    const depositoryAddress = String(jurisdiction.depositoryAddress ?? '').trim().toLowerCase();
    if (!Number.isFinite(chainId) || chainId <= 0 || !depositoryAddress) return '';
    return getJurisdictionStackId({ chainId, depositoryAddress });
  }
  return '';
};

function findReplicaForEntity(
  replicas: Map<string, EntityReplica> | null | undefined,
  entityId: string,
): EntityReplica | null {
  const target = normalizeHubEntityId(entityId);
  if (!target || !(replicas instanceof Map)) return null;
  for (const [key, replica] of replicas.entries()) {
    const [keyEntityId] = String(key || '').split(':');
    const stateEntityId = normalizeEntityId(replica?.entityId || replica?.state?.entityId);
    if (normalizeEntityId(keyEntityId) === target || stateEntityId === target) return replica;
  }
  return null;
}

function findReplicaSignerId(
  replicas: Map<string, EntityReplica> | null | undefined,
  entityId: string,
  replica: EntityReplica | null,
): string {
  const directSigner = String(replica?.signerId || '').trim();
  if (directSigner) return directSigner;
  const target = normalizeHubEntityId(entityId);
  if (!target || !(replicas instanceof Map)) return '';
  for (const [key, candidate] of replicas.entries()) {
    const [keyEntityId, keySignerId] = String(key || '').split(':');
    const stateEntityId = normalizeEntityId(candidate?.entityId || candidate?.state?.entityId);
    if ((normalizeEntityId(keyEntityId) === target || stateEntityId === target) && keySignerId) {
      return String(keySignerId).trim();
    }
  }
  return '';
}

export function resolveHubDiscoveryEntityJurisdictionKey(
  replicas: Map<string, EntityReplica> | null | undefined,
  entityId: string,
): string {
  const replica = findReplicaForEntity(replicas, entityId);
  return hubDiscoveryJurisdictionKey(replica?.state?.config?.jurisdiction)
    || hubDiscoveryJurisdictionKey(replica?.position?.jurisdiction);
}

function getAccountCounterpartyId(account: AccountMachine, ownerEntityId: string): string {
  const owner = normalizeHubEntityId(ownerEntityId);
  const left = normalizeHubEntityId(account.leftEntity);
  const right = normalizeHubEntityId(account.rightEntity);
  if (left === owner) return right;
  if (right === owner) return left;
  return '';
}

function findAccountForCounterparty(
  ownerReplica: EntityReplica | null,
  ownerEntityId: string,
  counterpartyEntityId: string,
): AccountMachine | null {
  const accounts = ownerReplica?.state?.accounts;
  const target = normalizeHubEntityId(counterpartyEntityId);
  if (!target || !(accounts instanceof Map)) return null;
  const direct = accounts.get(target) ?? accounts.get(counterpartyEntityId);
  if (direct) return direct as AccountMachine;
  for (const [key, account] of accounts.entries()) {
    if (normalizeHubEntityId(key) === target) return account as AccountMachine;
    if (getAccountCounterpartyId(account as AccountMachine, ownerEntityId) === target) {
      return account as AccountMachine;
    }
  }
  return null;
}

function getHubConnectionState(
  ownerReplica: EntityReplica | null,
  ownerEntityId: string,
  hubEntityId: string,
): HubDiscoveryConnectionState {
  const account = findAccountForCounterparty(ownerReplica, ownerEntityId, hubEntityId);
  return {
    isConnected: isCommittedAccount(account),
    isOpening: isOpeningAccount(account),
  };
}

function buildAccountConnectionStates(
  ownerReplica: EntityReplica | null,
  ownerEntityId: string,
): Map<string, HubDiscoveryConnectionState> {
  const accounts = ownerReplica?.state?.accounts;
  if (!(accounts instanceof Map)) return new Map();

  const owner = normalizeHubEntityId(ownerEntityId);
  const states = new Map<string, HubDiscoveryConnectionState>();
  for (const [key, account] of accounts.entries()) {
    const counterpartyId = getAccountCounterpartyId(account as AccountMachine, ownerEntityId)
      || normalizeHubEntityId(key);
    if (!counterpartyId || counterpartyId === owner) continue;
    states.set(counterpartyId, {
      isConnected: isCommittedAccount(account as AccountMachine),
      isOpening: isOpeningAccount(account as AccountMachine),
    });
  }
  return states;
}

type BuildHubDiscoveryProjectionInput = {
  entityId: string;
  runtimeId?: string | null;
  replicas: Map<string, EntityReplica> | null | undefined;
  profiles?: readonly GossipProfile[] | null | undefined;
  remoteHubs?: readonly HubDiscoveryRemoteHub[] | null | undefined;
  formatRawProfile?: (profile: unknown) => string;
  avatarForEntity?: (entityId: string) => string;
};

export function buildHubDiscoveryProjection(input: BuildHubDiscoveryProjectionInput): HubDiscoveryProjection {
  const entityId = normalizeHubEntityId(input.entityId);
  const runtimeId = String(input.runtimeId || '');
  const entityJurisdictionKey = resolveHubDiscoveryEntityJurisdictionKey(input.replicas, entityId);
  if (!entityId || !entityJurisdictionKey || !(input.replicas instanceof Map)) {
    return emptyHubDiscoveryProjection();
  }

  const ownerReplica = findReplicaForEntity(input.replicas, entityId);
  const sourceSignerId = findReplicaSignerId(input.replicas, entityId, ownerReplica);
  const connectionByHubId = buildAccountConnectionStates(ownerReplica, entityId);
  const localHubById = new Map<string, HubDiscoveryHub>();

  const addHub = (hub: HubDiscoveryHub): void => {
    const hubId = normalizeHubEntityId(hub.entityId);
    if (!hubId || hubId === entityId) return;
    localHubById.set(hubId, {
      ...(localHubById.get(hubId) ?? {}),
      ...hub,
    });
  };

  for (const replica of input.replicas.values()) {
    const state = replica?.state;
    const profile = state?.profile;
    const hubEntityId = normalizeHubEntityId(replica?.entityId || state?.entityId);
    if (!hubEntityId || profile?.isHub !== true) continue;

    const hubJurisdictionKey = hubDiscoveryJurisdictionKey(state?.config?.jurisdiction)
      || hubDiscoveryJurisdictionKey(replica?.position?.jurisdiction);
    if (!hubJurisdictionKey || hubJurisdictionKey !== entityJurisdictionKey) continue;

    const connection = connectionByHubId.get(hubEntityId)
      ?? getHubConnectionState(ownerReplica, entityId, hubEntityId);
    connectionByHubId.set(hubEntityId, connection);
    const fullEntityId = hubEntityId.startsWith('0x') ? hubEntityId : `0x${hubEntityId}`;
    addHub({
      entityId: replica.entityId || state?.entityId || hubEntityId,
      name: String(profile.name || replica.entityId || state?.entityId || hubEntityId),
      metadata: {
        isHub: true,
        description: String(profile.bio || 'Payment hub'),
        ...(profile.website ? { website: String(profile.website) } : {}),
        ...(state?.config?.jurisdiction ? { jurisdiction: state.config.jurisdiction } : {}),
        fee: Number((profile as { routingFeePPM?: number })?.routingFeePPM ?? 0),
        peerCount: state?.accounts instanceof Map ? state.accounts.size : 0,
      },
      runtimeId,
      wsUrl: null,
      lastSeen: Number(state?.timestamp || 0),
      raw: input.formatRawProfile ? input.formatRawProfile(profile) : '',
      avatar: input.avatarForEntity ? input.avatarForEntity(fullEntityId) : '',
      ...connection,
    });
  }

  for (const profile of input.profiles ?? []) {
    const hubEntityId = normalizeHubEntityId(profile?.entityId);
    if (!hubEntityId || profile?.metadata?.isHub !== true) continue;

    const hubJurisdictionKey = hubDiscoveryJurisdictionKey(profile.metadata?.jurisdiction);
    if (!hubJurisdictionKey || hubJurisdictionKey !== entityJurisdictionKey) continue;

    const connection = connectionByHubId.get(hubEntityId)
      ?? getHubConnectionState(ownerReplica, entityId, hubEntityId);
    connectionByHubId.set(hubEntityId, connection);
    const fullEntityId = hubEntityId.startsWith('0x') ? hubEntityId : `0x${hubEntityId}`;
    addHub({
      entityId: profile.entityId || hubEntityId,
      name: String(profile.name || profile.metadata?.hubName || profile.entityId || hubEntityId),
      metadata: {
        isHub: true,
        description: String(profile.bio || 'Payment hub'),
        ...(profile.website ? { website: String(profile.website) } : {}),
        ...(profile.metadata?.jurisdiction ? { jurisdiction: profile.metadata.jurisdiction } : {}),
        fee: Number(profile.metadata?.routingFeePPM ?? 0),
        peerCount: Array.isArray(profile.publicAccounts)
          ? profile.publicAccounts.length
          : Array.isArray(profile.accounts)
            ? profile.accounts.length
            : 0,
      },
      runtimeId: String(profile.runtimeId || runtimeId),
      wsUrl: profile.wsUrl ?? null,
      lastSeen: Number(profile.lastUpdated || 0),
      raw: input.formatRawProfile ? input.formatRawProfile(profile) : '',
      avatar: profile.avatar || (input.avatarForEntity ? input.avatarForEntity(fullEntityId) : ''),
      ...connection,
    });
  }

  for (const remoteHub of input.remoteHubs ?? []) {
    const hubEntityId = normalizeHubEntityId(remoteHub.entityId);
    if (!hubEntityId) continue;

    const hubJurisdictionKey = hubDiscoveryJurisdictionKey(remoteHub.jurisdiction);
    if (!hubJurisdictionKey || hubJurisdictionKey !== entityJurisdictionKey) continue;

    const connection = connectionByHubId.get(hubEntityId)
      ?? getHubConnectionState(ownerReplica, entityId, hubEntityId);
    connectionByHubId.set(hubEntityId, connection);
    const fullEntityId = hubEntityId.startsWith('0x') ? hubEntityId : `0x${hubEntityId}`;
    addHub({
      entityId: remoteHub.entityId,
      name: remoteHub.name || remoteHub.entityId,
      metadata: {
        isHub: true,
        description: 'Remote runtime hub',
        ...(remoteHub.jurisdiction ? { jurisdiction: remoteHub.jurisdiction } : {}),
        fee: 0,
        peerCount: 0,
      },
      runtimeId: remoteHub.runtimeId,
      wsUrl: remoteHub.wsUrl,
      lastSeen: Math.max(0, Math.floor(Number(remoteHub.lastSeen ?? remoteHub.height ?? 0))),
      raw: '',
      avatar: input.avatarForEntity ? input.avatarForEntity(fullEntityId) : '',
      ...connection,
    });
  }

  return {
    discoveryKey: `${runtimeId}:${entityId}:${entityJurisdictionKey}`,
    entityJurisdictionKey,
    sourceSignerId,
    localHubs: Array.from(localHubById.values()),
    connectionByHubId,
  };
}

export function hubHasPublishedRuntimeRoute(hub: HubOpenAccountProfile): boolean {
  return Boolean(
    normalizeHubEntityId(hub.entityId)
      && hub.metadata?.isHub === true
      && String(hub.runtimeId || '').trim(),
  );
}

export function canSubmitHubOpenAccount(input: HubOpenAccountPermissionInput): boolean {
  return input.adapterMode !== 'remote' || input.authLevel === 'admin';
}

export function getHubOpenAccountPermissionError(input: HubOpenAccountPermissionInput): string | null {
  return canSubmitHubOpenAccount(input) ? null : HUB_OPEN_ACCOUNT_REQUIRES_ADMIN;
}

function hasLiveRuntimeProfileSource(env: Env | null | undefined): boolean {
  const runtimeEnv = env as RuntimeProfileSourceEnv | null | undefined;
  return Boolean(
    runtimeEnv?.runtimeState?.p2p?.ensureProfiles
      || runtimeEnv?.gossip?.getProfiles,
  );
}

export async function ensureHubOpenAccountProfileReady(input: {
  env: Env | null | undefined;
  sourceEntityId: string;
  hub: HubOpenAccountProfile;
  seedProfiles?: (hubId: string) => Promise<HubProfileSeedResult>;
  timeoutMs?: number;
}): Promise<void> {
  const hubId = normalizeHubEntityId(input.hub.entityId);
  const sourceId = normalizeHubEntityId(input.sourceEntityId);
  if (!sourceId) throw new Error('Entity is not ready for account opening.');
  if (!hubId) throw new Error('Hub entity ID is missing.');
  if (sourceId === hubId) throw new Error('Cannot open an account with the same entity.');

  if (hasUsableOpenAccountCounterpartyProfile(input.env, sourceId, hubId, { requireHub: true })) {
    return;
  }

  const seed = input.seedProfiles ? await input.seedProfiles(hubId) : { ready: false };
  if (hasUsableOpenAccountCounterpartyProfile(input.env, sourceId, hubId, { requireHub: true })) {
    return;
  }

  const hasLiveSource = hasLiveRuntimeProfileSource(input.env);
  if (!hasLiveSource && (seed.ready || hubHasPublishedRuntimeRoute(input.hub))) return;

  if (hasLiveSource) {
    const ready = await waitForCounterpartyRuntimeRoutes(
      input.env,
      [hubId],
      input.timeoutMs ?? 5_000,
    );
    if (ready) return;
  }

  const detail = seed.error ? ` Last profile fetch error: ${seed.error}` : '';
  throw new Error(`Hub routing profile is not ready. Refresh hubs and try again.${detail}`);
}
