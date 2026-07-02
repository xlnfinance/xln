import type { RuntimeAdapterEntitySummary, RuntimeAdapterViewFrame } from '@xln/runtime/xln-api';

export type EntityWorkspaceLensId = 'wallet' | 'ops' | 'liquidity' | 'audit';

export type RuntimeWorkspaceMode = 'embedded' | 'remote';
export type RuntimeWorkspaceAuthLevel = 'inspect' | 'admin' | null;

export type EntityWorkspaceRuntime = {
  mode: RuntimeWorkspaceMode;
  authLevel: RuntimeWorkspaceAuthLevel;
};

export type EntityWorkspaceEntity = {
  entityId: string;
  isHub?: boolean;
  accountCount?: number;
  bookCount?: number;
  proposalCount?: number;
  reserveCount?: number;
};

export type EntityWorkspaceView = EntityWorkspaceEntity & {
  runtimeId: string | null;
  height: number;
};

export type EntityWorkspaceProjection = Pick<
  RuntimeAdapterViewFrame,
  'height' | 'entities' | 'activeEntityId' | 'activeEntity'
> & {
  runtimeId?: string | null;
};

export type EntityWorkspaceLens = {
  id: EntityWorkspaceLensId;
  enabled: boolean;
  canWrite: boolean;
  reason: string | null;
};

export type EntityWorkspaceCapabilities = {
  entityId: string;
  canRead: boolean;
  canWrite: boolean;
  readOnlyReason: string | null;
  lenses: EntityWorkspaceLens[];
};

export const entityWorkspaceLensOrder: readonly EntityWorkspaceLensId[] = ['wallet', 'ops', 'liquidity', 'audit'];

const hasCount = (value: unknown): boolean => Number(value || 0) > 0;

const normalizeId = (value: string | null | undefined): string => String(value || '').trim().toLowerCase();

const safeSize = (value: unknown): number => {
  if (!value) return 0;
  if (value instanceof Map || value instanceof Set) return value.size;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length;
  return 0;
};

const pageCount = (page: { totalItems?: number; items?: unknown[] } | null | undefined): number =>
  Number.isFinite(Number(page?.totalItems)) ? Math.max(0, Math.floor(Number(page?.totalItems))) : safeSize(page?.items);

const entitySummaryMatches = (summary: RuntimeAdapterEntitySummary | null | undefined, entityId: string): boolean =>
  normalizeId(summary?.entityId) === normalizeId(entityId);

export const buildEntityWorkspaceView = (
  source: EntityWorkspaceProjection | null | undefined,
  entityId: string,
): EntityWorkspaceView => {
  const normalizedEntityId = normalizeId(entityId || source?.activeEntityId || source?.activeEntity?.summary?.entityId);
  const activeEntity = entitySummaryMatches(source?.activeEntity?.summary, normalizedEntityId) ||
    normalizeId(source?.activeEntityId) === normalizedEntityId
    ? source?.activeEntity
    : null;
  const summary = activeEntity?.summary ??
    source?.entities.find((candidate) => entitySummaryMatches(candidate, normalizedEntityId)) ??
    null;
  const core = activeEntity?.core ?? null;
  return {
    entityId: normalizedEntityId || entityId,
    runtimeId: source?.runtimeId || null,
    height: Math.max(0, Math.floor(Number(source?.height || 0))),
    isHub: summary?.isHub === true ||
      (core?.profile as { isHub?: boolean } | undefined)?.isHub === true ||
      Boolean(core?.orderbookHubProfile),
    accountCount: pageCount(activeEntity?.accounts),
    bookCount: pageCount(activeEntity?.books),
    proposalCount: safeSize(core?.proposals),
    reserveCount: safeSize(core?.reserves),
  };
};

export const canMutateRuntime = (runtime: EntityWorkspaceRuntime): boolean =>
  runtime.mode === 'embedded' || runtime.authLevel === 'admin';

export const resolveEntityWorkspaceCapabilities = (
  runtime: EntityWorkspaceRuntime,
  entity: EntityWorkspaceEntity,
): EntityWorkspaceCapabilities => {
  const entityId = String(entity.entityId || '').trim().toLowerCase();
  const canRead = entityId.length > 0;
  const canWrite = canRead && canMutateRuntime(runtime);
  const readOnlyReason = canRead && !canWrite
    ? 'Remote runtime is connected with inspect access.'
    : null;
  const inspectOnly = canRead && !canWrite;
  const hasAccounts = hasCount(entity.accountCount);
  const hasBooks = hasCount(entity.bookCount);
  const hasOpsSurface = entity.isHub === true || hasAccounts || hasCount(entity.proposalCount) || hasCount(entity.reserveCount);
  const hasLiquiditySurface = entity.isHub === true || hasBooks;
  const auditEnabled = canRead && (runtime.mode === 'remote' || runtime.authLevel === 'inspect' || runtime.authLevel === 'admin');
  const inspectOnlyReason = 'Inspect access exposes audit surfaces only.';

  return {
    entityId,
    canRead,
    canWrite,
    readOnlyReason,
    lenses: [
      { id: 'wallet', enabled: canRead && !inspectOnly, canWrite, reason: canRead ? (inspectOnly ? inspectOnlyReason : null) : 'Select an entity.' },
      { id: 'ops', enabled: canRead && !inspectOnly && hasOpsSurface, canWrite, reason: inspectOnly ? inspectOnlyReason : hasOpsSurface ? null : 'No operational surface detected.' },
      { id: 'liquidity', enabled: canRead && !inspectOnly && hasLiquiditySurface, canWrite, reason: inspectOnly ? inspectOnlyReason : hasLiquiditySurface ? null : 'No liquidity surface detected.' },
      { id: 'audit', enabled: auditEnabled, canWrite: false, reason: auditEnabled ? null : 'Audit lens requires a selected remote/runtime view.' },
    ],
  };
};

export const defaultLensForCapabilities = (capabilities: EntityWorkspaceCapabilities): EntityWorkspaceLensId => {
  for (const id of entityWorkspaceLensOrder) {
    if (capabilities.lenses.find((lens) => lens.id === id && lens.enabled)) return id;
  }
  return 'wallet';
};

export const entityWorkspaceTabForLens = (
  lens: EntityWorkspaceLensId,
): { activeTab: 'assets' | 'accounts' | 'settings'; accountWorkspaceTab?: string; settingsSubview?: string } => {
  switch (lens) {
    case 'ops':
      return { activeTab: 'accounts', accountWorkspaceTab: 'activity' };
    case 'liquidity':
      return { activeTab: 'accounts', accountWorkspaceTab: 'swap' };
    case 'audit':
      return { activeTab: 'accounts', accountWorkspaceTab: 'activity' };
    case 'wallet':
    default:
      return { activeTab: 'assets' };
  }
};
