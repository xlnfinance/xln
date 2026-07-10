import type { NavigationSelection } from '$lib/stores/appStateStore';
import type { Runtime as VaultRuntime } from '$lib/stores/vaultStore';

export type NavigationItem = {
  id: string;
  label: string;
  count?: number;
};

export type RuntimeNavigationRuntime = {
  id: string;
  type?: 'local' | 'remote';
  label: string;
  entityCount?: number;
};

export type RuntimeNavigationViewProjection = {
  runtimeId?: string;
  entities?: Array<{
    entityId?: string;
    signerId?: string;
    label?: string;
    jurisdiction?: {
      name?: string;
      address?: string;
      chainId?: number | string;
    };
  }>;
  frame?: {
    activeEntityId?: string | null;
    activeEntity?: {
      summary?: {
        entityId?: string;
      };
      accounts?: {
        items?: Array<{
          leftEntity?: string;
          rightEntity?: string;
        }>;
        totalItems?: number | null;
      };
    } | null;
  } | null;
};

export type HierarchicalNavigationView = {
  runtimeItems: NavigationItem[];
  jurisdictionItems: NavigationItem[];
  signerItems: NavigationItem[];
  entityItems: NavigationItem[];
  accountItems: NavigationItem[];
};

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

const runtimeMatchesView = (runtimeId: string, runtimeView: RuntimeNavigationViewProjection | null | undefined): boolean =>
  normalizeId(runtimeId) === normalizeId(runtimeView?.runtimeId);

const jurisdictionItem = (
  jurisdiction: NonNullable<RuntimeNavigationViewProjection['entities']>[number]['jurisdiction'],
): NavigationItem | null => {
  if (!jurisdiction) return null;
  const id = String(jurisdiction.address || jurisdiction.name || jurisdiction.chainId || '').trim();
  const label = String(jurisdiction.name || jurisdiction.address || jurisdiction.chainId || id).trim();
  return id && label ? { id, label, count: 0 } : null;
};

const entityAccountCount = (
  entityId: string,
  runtimeView: RuntimeNavigationViewProjection | null | undefined,
): number => {
  const active = runtimeView?.frame?.activeEntity;
  const activeEntityId = normalizeId(runtimeView?.frame?.activeEntityId || active?.summary?.entityId);
  if (!active || activeEntityId !== normalizeId(entityId)) return 0;
  const totalItems = Number(active.accounts?.totalItems);
  return Number.isFinite(totalItems)
    ? Math.max(0, Math.floor(totalItems))
    : Math.max(0, active.accounts?.items?.length ?? 0);
};

const accountCounterpartyId = (entityId: string, account: { leftEntity?: string; rightEntity?: string }): string => {
  const selected = normalizeId(entityId);
  const left = normalizeId(account.leftEntity);
  const right = normalizeId(account.rightEntity);
  return left === selected ? right : left || right;
};

export function buildHierarchicalNavigationView(
  runtimes: ReadonlyMap<string, RuntimeNavigationRuntime>,
  navigation: NavigationSelection,
  activeVaultRuntime: Pick<VaultRuntime, 'id' | 'signers'> | null | undefined,
  runtimeView: RuntimeNavigationViewProjection | null | undefined = null,
): HierarchicalNavigationView {
  const selectedRuntimeId = String(navigation.runtime || '').trim();
  const selectedJurisdictionId = normalizeId(navigation.jurisdiction);
  const selectedSignerId = normalizeId(navigation.signer);
  const selectedEntityId = normalizeId(navigation.entity);
  const selectedRuntimeHasProjection = runtimeMatchesView(selectedRuntimeId, runtimeView);
  const projectedEntities = selectedRuntimeHasProjection ? (runtimeView?.entities ?? []) : [];
  const selectedRuntime = Array.from(runtimes.values())
    .find((runtime) => normalizeId(runtime.id) === normalizeId(selectedRuntimeId));
  const usesActiveVault = selectedRuntime?.type !== 'remote'
    && normalizeId(activeVaultRuntime?.id) === normalizeId(selectedRuntimeId);

  const runtimeItems = Array.from(runtimes.values()).map((runtime) => ({
    id: runtime.id,
    label: runtime.label,
    count: runtimeMatchesView(runtime.id, runtimeView)
      ? projectedEntities.length
      : Math.max(0, Math.floor(Number(runtime.entityCount || 0))),
  }));

  const jurisdictionsById = new Map<string, NavigationItem>();
  for (const entity of projectedEntities) {
    const item = jurisdictionItem(entity.jurisdiction);
    if (!item) continue;
    const key = normalizeId(item.id);
    const existing = jurisdictionsById.get(key);
    if (existing) existing.count = (existing.count ?? 0) + 1;
    else jurisdictionsById.set(key, { ...item, count: 1 });
  }
  const jurisdictionItems = Array.from(jurisdictionsById.values());

  const signerItems = (usesActiveVault ? activeVaultRuntime?.signers ?? [] : []).map((signer) => ({
    id: signer.address,
    label: signer.name,
  }));

  const entityItems: NavigationItem[] = [];
  for (const entity of projectedEntities) {
    const entityId = normalizeId(entity.entityId);
    if (!entityId) continue;
    const entityJurisdictionId = normalizeId(jurisdictionItem(entity.jurisdiction)?.id);
    if (selectedJurisdictionId && entityJurisdictionId !== selectedJurisdictionId) continue;
    const signerId = normalizeId(entity.signerId);
    if (usesActiveVault && selectedSignerId && signerId && signerId !== selectedSignerId) continue;
    entityItems.push({
      id: entityId,
      label: String(entity.label || entityId),
      count: entityAccountCount(entityId, runtimeView),
    });
  }

  const active = runtimeView?.frame?.activeEntity;
  const activeEntityId = normalizeId(runtimeView?.frame?.activeEntityId || active?.summary?.entityId);
  const accountItems: NavigationItem[] = selectedRuntimeHasProjection && active && selectedEntityId && activeEntityId === selectedEntityId
    ? (active.accounts?.items ?? []).map((account) => {
      const id = accountCounterpartyId(selectedEntityId, account);
      return {
        id,
        label: `A${id.slice(0, 8)}`,
      };
    }).filter((item) => item.id)
    : [];

  return {
    runtimeItems,
    jurisdictionItems,
    signerItems,
    entityItems,
    accountItems,
  };
}
