export type RuntimeDropdownSource = 'browser' | 'remote';
export type RuntimeDotStatus = 'connected' | 'syncing' | 'reconnecting' | 'disconnected' | 'error' | 'inactive';

export type RuntimeDropdownSigner = {
  address?: string;
  name?: string;
  entityId?: string;
  jurisdiction?: string;
};

export type RuntimeDropdownVaultRuntime = {
  id: string;
  label?: string;
  signers?: RuntimeDropdownSigner[];
};

export type RuntimeDropdownHubJurisdiction = {
  name?: string;
  address?: string;
  chainId?: number | string;
};

export type RuntimeDropdownHubEntity = {
  entityId?: string;
  runtimeId?: string;
  label?: string;
  jurisdiction?: RuntimeDropdownHubJurisdiction;
};

export type RuntimeDropdownRemoteRuntime = {
  id: string;
  label?: string;
  wsUrl?: string;
  permissions?: 'read' | 'write';
  status?: RuntimeDotStatus;
  entityCount?: number;
  hubEntityId?: string;
  hubName?: string;
  hubJurisdiction?: RuntimeDropdownHubJurisdiction;
  hubEntities?: RuntimeDropdownHubEntity[];
};

export type RuntimeDropdownEntity = {
  id: string;
  label: string;
};

export type RuntimeDropdownJurisdictionGroup = {
  id: string;
  label: string;
  entities: RuntimeDropdownEntity[];
};

export type RuntimeDropdownEntry = {
  id: string;
  label: string;
  title: string;
  meta: string;
  source: RuntimeDropdownSource;
  status: RuntimeDotStatus;
  signers: number;
  groups: RuntimeDropdownJurisdictionGroup[];
};

export const shortRuntimeId = (value: string): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 16) return raw;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
};

export const remoteHostLabel = (
  runtime: Pick<RuntimeDropdownRemoteRuntime, 'label' | 'id' | 'wsUrl'> | null | undefined,
  fallbackEndpoint = '',
): string => {
  const raw = String(runtime?.label || runtime?.wsUrl || runtime?.id || fallbackEndpoint || 'remote runtime');
  const match = raw.match(/wss?:\/\/[^/\s]+(?:\/[^\s]*)?/);
  if (!match) return raw.replace(/^Remote\s+/i, '');
  try {
    const url = new URL(match[0]);
    return `${url.host}${url.pathname}`;
  } catch {
    return match[0];
  }
};

const normalizeId = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const jurisdictionLabel = (jurisdiction: RuntimeDropdownHubJurisdiction | string | null | undefined): string => {
  if (typeof jurisdiction === 'string') return jurisdiction.trim() || 'Unknown jurisdiction';
  const name = String(jurisdiction?.name || '').trim();
  const chainId = String(jurisdiction?.chainId || '').trim();
  const address = String(jurisdiction?.address || '').trim();
  return name || (chainId ? `chain ${chainId}` : '') || address || 'Unknown jurisdiction';
};

const groupEntitiesByJurisdiction = (
  rows: Array<{ jurisdiction: string; entity: RuntimeDropdownEntity }>,
): RuntimeDropdownJurisdictionGroup[] => {
  const groups = new Map<string, RuntimeDropdownJurisdictionGroup>();
  for (const row of rows) {
    const label = row.jurisdiction || 'Unknown jurisdiction';
    const id = normalizeId(label) || 'unknown';
    const existing = groups.get(id);
    if (existing) {
      existing.entities.push(row.entity);
    } else {
      groups.set(id, { id, label, entities: [row.entity] });
    }
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    entities: group.entities.sort((a, b) => a.label.localeCompare(b.label)),
  })).sort((a, b) => a.label.localeCompare(b.label));
};

const browserRuntimeGroups = (runtime: RuntimeDropdownVaultRuntime): RuntimeDropdownJurisdictionGroup[] =>
  groupEntitiesByJurisdiction((runtime.signers || []).flatMap((signer) => {
    const entityId = normalizeId(signer.entityId);
    if (!entityId) return [];
    const label = String(signer.name || entityId || 'Entity').trim();
    return [{
      jurisdiction: jurisdictionLabel(signer.jurisdiction || 'Browser'),
      entity: { id: entityId, label },
    }];
  }));

const remoteRuntimeGroups = (runtime: RuntimeDropdownRemoteRuntime): RuntimeDropdownJurisdictionGroup[] => {
  const runtimeId = normalizeId(runtime.id);
  const rows = (runtime.hubEntities || []).filter((entity) => {
    const ownerRuntimeId = normalizeId(entity.runtimeId);
    return !ownerRuntimeId || ownerRuntimeId === runtimeId;
  }).flatMap((entity) => {
    const entityId = normalizeId(entity.entityId);
    if (!entityId) return [];
    return [{
      jurisdiction: jurisdictionLabel(entity.jurisdiction ?? runtime.hubJurisdiction),
      entity: {
        id: entityId,
        label: String(entity.label || runtime.hubName || entityId).trim(),
      },
    }];
  });
  if (rows.length > 0) return groupEntitiesByJurisdiction(rows);
  const entityId = normalizeId(runtime.hubEntityId);
  if (!entityId) return [];
  return groupEntitiesByJurisdiction([{
    jurisdiction: jurisdictionLabel(runtime.hubJurisdiction),
    entity: {
      id: entityId,
      label: String(runtime.hubName || runtime.label || entityId).trim(),
    },
  }]);
};

export const runtimeDropdownEntryFromVaultRuntime = (
  runtime: RuntimeDropdownVaultRuntime,
  activeRuntimeId: string,
  connStatus: RuntimeDotStatus,
): RuntimeDropdownEntry => {
  const signers = runtime.signers || [];
  const signerAddress = signers[0]?.address || '';
  return {
    id: runtime.id,
    label: signerAddress ? `${shortRuntimeId(signerAddress)} (${runtime.label || 'Browser runtime'})` : runtime.label || 'Browser runtime',
    title: signerAddress || runtime.id,
    meta: `${signers.length} signer${signers.length === 1 ? '' : 's'}`,
    source: 'browser',
    status: runtime.id === activeRuntimeId ? connStatus : 'inactive',
    signers: signers.length,
    groups: browserRuntimeGroups(runtime),
  };
};

export const runtimeDropdownEntryFromRemoteRuntime = (
  runtime: RuntimeDropdownRemoteRuntime,
  runtimeAdapterDotStatus: RuntimeDotStatus,
  fallbackEndpoint = '',
): RuntimeDropdownEntry => ({
  id: runtime.id,
  label: runtime.label || remoteHostLabel(runtime, fallbackEndpoint),
  title: runtime.id,
  meta: `${runtime.permissions === 'write' ? 'full' : 'read'} · ${runtime.status || 'disconnected'}`,
  source: 'remote',
  status: runtime.status || runtimeAdapterDotStatus,
  signers: 0,
  groups: remoteRuntimeGroups(runtime),
});

export const buildRuntimeDropdownEntries = (input: {
  remoteRuntimes: RuntimeDropdownRemoteRuntime[];
  vaultRuntimes: RuntimeDropdownVaultRuntime[];
  activeRuntimeId: string;
  connStatus: RuntimeDotStatus;
  runtimeAdapterDotStatus: RuntimeDotStatus;
  runtimeControllerEndpoint?: string;
}): RuntimeDropdownEntry[] => [
  ...input.remoteRuntimes.map((runtime) =>
    runtimeDropdownEntryFromRemoteRuntime(runtime, input.runtimeAdapterDotStatus, input.runtimeControllerEndpoint || '')
  ),
  ...input.vaultRuntimes.map((runtime) =>
    runtimeDropdownEntryFromVaultRuntime(runtime, input.activeRuntimeId, input.connStatus)
  ),
];
