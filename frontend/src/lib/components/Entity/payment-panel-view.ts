import type {
  AccountMachine,
  EntityReplica,
  PaymentRoute,
  Profile as GossipProfile,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame,
} from '@xln/runtime/xln-api';

import type { LocalAccountLike, LocalReplicaLike } from './payment-routing';
import { normalizeEntityId } from './payment-routing';

export type PaymentRuntimeGraph = {
  findPaths?: (
    fromEntityId: string,
    toEntityId: string,
    amount: bigint,
    tokenId: number,
  ) => Promise<PaymentRoute[]>;
};

export type PaymentReplicaView = LocalReplicaLike & {
  state: LocalReplicaLike['state'] & {
    lockBook: Map<string, unknown>;
  };
};

export type PaymentPanelView = {
  replicaMap: Map<string, PaymentReplicaView>;
  profiles: GossipProfile[];
  knownRecipientEntities: string[];
  blockedCounterpartyIds: Set<string>;
  networkGraph: PaymentRuntimeGraph | null;
};

export const emptyPaymentPanelView = (): PaymentPanelView => ({
  replicaMap: new Map(),
  profiles: [],
  knownRecipientEntities: [],
  blockedCounterpartyIds: new Set(),
  networkGraph: null,
});

type PaymentAccountSource = Pick<AccountMachine, 'leftEntity' | 'rightEntity'> & {
  deltas?: AccountMachine['deltas'];
  activeDispute?: unknown;
  status?: unknown;
};

function clonePaymentAccount(account: PaymentAccountSource): LocalAccountLike {
  return {
    leftEntity: account.leftEntity,
    rightEntity: account.rightEntity,
    deltas: account.deltas instanceof Map ? new Map(account.deltas) : new Map(),
  };
}

function getCounterpartyForAccount(ownerEntityId: string, account: PaymentAccountSource): string {
  const owner = normalizeEntityId(ownerEntityId);
  const left = normalizeEntityId(account.leftEntity);
  const right = normalizeEntityId(account.rightEntity);
  if (left === owner) return right;
  if (right === owner) return left;
  return '';
}

function isBlockedAccount(account: PaymentAccountSource): boolean {
  return Boolean(account.activeDispute)
    || String(account.status || '').trim().toLowerCase() === 'disputed';
}

function projectSummaryJurisdiction(summary: RuntimeAdapterEntitySummary): GossipProfile['metadata']['jurisdiction'] | undefined {
  const source = summary.jurisdiction;
  const name = String(source?.name || '').trim();
  if (!name) return undefined;
  const rawChainId = Number(source?.chainId);
  return {
    name,
    ...(Number.isFinite(rawChainId) ? { chainId: Math.floor(rawChainId) } : {}),
    ...(source?.entityProviderAddress ? { entityProviderAddress: source.entityProviderAddress } : {}),
    ...(source?.depositoryAddress ? { depositoryAddress: source.depositoryAddress } : {}),
  };
}

function projectSummaryProfile(summary: RuntimeAdapterEntitySummary): GossipProfile | null {
  const entityId = normalizeEntityId(summary.entityId);
  if (!entityId) return null;
  const jurisdiction = projectSummaryJurisdiction(summary);
  return {
    entityId,
    name: String(summary.label || entityId),
    avatar: '',
    bio: '',
    website: '',
    lastUpdated: Math.max(0, Math.floor(Number(summary.height || 0))),
    runtimeId: '',
    runtimeEncPubKey: '',
    publicAccounts: [],
    wsUrl: null,
    relays: [],
    metadata: {
      isHub: summary.isHub === true,
      routingFeePPM: 0,
      baseFee: 0n,
      board: { threshold: 0, validators: [], encryptionAttestations: [] },
      ...(jurisdiction ? { jurisdiction } : {}),
    },
    accounts: [],
  };
}

export function buildPaymentPanelViewFromRuntimeView(input: {
  entityId: string;
  frame: RuntimeAdapterViewFrame | null | undefined;
}): PaymentPanelView {
  const frame = input.frame;
  if (!frame) return emptyPaymentPanelView();

  const requestedEntityId = normalizeEntityId(input.entityId);
  const active = frame.activeEntity;
  const activeEntityId = normalizeEntityId(active?.core?.entityId || active?.summary?.entityId || '');
  const self = requestedEntityId || activeEntityId;
  const profiles = (frame.entities || [])
    .map(projectSummaryProfile)
    .filter((profile): profile is GossipProfile => profile !== null);
  const knownRecipientEntities = profiles
    .map((profile) => normalizeEntityId(profile.entityId))
    .filter((option) => option && option !== self)
    .sort();

  const replicaMap = new Map<string, PaymentReplicaView>();
  const blockedCounterpartyIds = new Set<string>();
  if (active && activeEntityId && (!requestedEntityId || activeEntityId === requestedEntityId)) {
    const accounts = new Map<string, LocalAccountLike>();
    for (const account of active.accounts.items || []) {
      const counterpartyId = getCounterpartyForAccount(activeEntityId, account);
      if (!counterpartyId) continue;
      accounts.set(counterpartyId, clonePaymentAccount(account));
      if (isBlockedAccount(account)) blockedCounterpartyIds.add(counterpartyId);
    }
    const signerId = String(active.core.signerId || active.summary.entityId || activeEntityId).trim().toLowerCase();
    replicaMap.set(`${activeEntityId}:${signerId}`, {
      state: {
        accounts,
        lockBook: active.core.lockBook instanceof Map ? new Map(active.core.lockBook) : new Map(),
      },
    });
  }

  return {
    replicaMap,
    profiles,
    knownRecipientEntities,
    blockedCounterpartyIds,
    networkGraph: null,
  };
}

function projectReplica(replica: EntityReplica): PaymentReplicaView {
  const accounts = new Map<string, LocalAccountLike>();
  for (const [counterpartyId, account] of replica.state.accounts.entries()) {
    accounts.set(String(counterpartyId), clonePaymentAccount(account));
  }
  return {
    state: {
      accounts,
      lockBook: replica.state.lockBook instanceof Map ? new Map(replica.state.lockBook) : new Map(),
    },
  };
}

function buildBlockedCounterparties(
  entityId: string,
  replicas: Map<string, EntityReplica> | null | undefined,
): Set<string> {
  const blocked = new Set<string>();
  const self = normalizeEntityId(entityId);
  if (!self || !(replicas instanceof Map)) return blocked;
  for (const [replicaKey, replica] of replicas.entries()) {
    const [replicaEntityId] = String(replicaKey).split(':');
    if (normalizeEntityId(replicaEntityId) !== self) continue;
    for (const account of replica.state.accounts.values()) {
      if (!isBlockedAccount(account)) continue;
      const counterpartyId = getCounterpartyForAccount(entityId, account);
      if (counterpartyId) blocked.add(counterpartyId);
    }
  }
  return blocked;
}

export function buildPaymentPanelView(input: {
  entityId: string;
  replicas: Map<string, EntityReplica> | null | undefined;
  profiles: GossipProfile[];
  networkGraph?: PaymentRuntimeGraph | null;
}): PaymentPanelView {
  const replicaMap = new Map<string, PaymentReplicaView>();
  if (input.replicas instanceof Map) {
    for (const [key, replica] of input.replicas.entries()) {
      replicaMap.set(String(key), projectReplica(replica));
    }
  }

  const self = normalizeEntityId(input.entityId);
  const profiles = Array.isArray(input.profiles) ? [...input.profiles] : [];
  const knownRecipientEntities = profiles
    .map((profile) => normalizeEntityId(profile.entityId))
    .filter((option) => option && option !== self)
    .sort();

  return {
    replicaMap,
    profiles,
    knownRecipientEntities,
    blockedCounterpartyIds: buildBlockedCounterparties(input.entityId, input.replicas),
    networkGraph: input.networkGraph ?? null,
  };
}
