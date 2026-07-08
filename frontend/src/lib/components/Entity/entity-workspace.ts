import type { RuntimeAdapterEntitySummary, RuntimeAdapterViewFrame } from '@xln/runtime/xln-api';

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

export type EntityWorkspaceCapabilities = {
  entityId: string;
  canRead: boolean;
};

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

export const resolveEntityWorkspaceCapabilities = (
  _runtime: EntityWorkspaceRuntime,
  entity: EntityWorkspaceEntity,
): EntityWorkspaceCapabilities => {
  const entityId = String(entity.entityId || '').trim().toLowerCase();
  const canRead = entityId.length > 0;
  return {
    entityId,
    canRead,
  };
};
