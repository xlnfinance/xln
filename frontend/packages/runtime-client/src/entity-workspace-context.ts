import {
  isUnknownRecord,
  requireFiniteNumber,
  requireUnknownRecord,
} from './boundary';

type EmptyEntityWorkspaceContext = Readonly<{
  status: 'empty';
  runtimeId: string | null;
  height: number;
  entityId: null;
  entityName: null;
  signerId: string | null;
  jurisdictionName: null;
  accountCount: null;
}>;

type SelectedEntityWorkspaceContext = Readonly<{
  status: 'selected';
  runtimeId: string | null;
  height: number;
  entityId: string;
  entityName: string;
  signerId: string | null;
  jurisdictionName: string | null;
  accountCount: number;
}>;

export type EntityWorkspaceContext = EmptyEntityWorkspaceContext | SelectedEntityWorkspaceContext;

export type EntityWorkspaceReadState =
  | Readonly<{ status: 'ready'; message: '' }>
  | Readonly<{
    status: 'unavailable' | 'connecting' | 'loading' | 'error';
    message: string;
  }>;

export type EntityWorkspaceContextInput = Readonly<{
  runtimeId?: unknown;
  frame?: unknown;
}>;

const optionalText = (value: unknown, code: string): string => {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new Error(code);
  return value.trim();
};

const nestedText = (value: unknown, path: readonly string[], code: string): string => {
  let current = value;
  for (const key of path) {
    if (current === null || current === undefined) return '';
    if (!isUnknownRecord(current)) throw new Error(code);
    current = current[key];
  }
  return optionalText(current, code);
};

const selectedEntityId = (values: readonly unknown[]): string => {
  const ids = values
    .map((value) => optionalText(value, 'ENTITY_WORKSPACE_ENTITY_ID_INVALID').toLowerCase())
    .filter(Boolean);
  if (!ids[0]) throw new Error('ENTITY_WORKSPACE_ENTITY_ID_MISSING');
  if (ids.some((id) => id !== ids[0])) throw new Error('ENTITY_WORKSPACE_ENTITY_ID_MISMATCH');
  return ids[0];
};

const frameHeight = (frame: Record<string, unknown>): number => {
  const height = requireFiniteNumber(frame['height'], 'ENTITY_WORKSPACE_FRAME_HEIGHT_INVALID');
  if (!Number.isSafeInteger(height) || height < 0) throw new Error('ENTITY_WORKSPACE_FRAME_HEIGHT_INVALID');
  return height;
};

const selectedAccountCount = (active: Record<string, unknown>): number => {
  const accounts = requireUnknownRecord(active['accounts'], 'ENTITY_WORKSPACE_ACCOUNTS_INVALID');
  const items = accounts['items'];
  if (!Array.isArray(items)) throw new Error('ENTITY_WORKSPACE_ACCOUNTS_INVALID');
  if (accounts['totalItems'] === undefined) return items.length;
  const total = requireFiniteNumber(accounts['totalItems'], 'ENTITY_WORKSPACE_ACCOUNT_COUNT_INVALID');
  if (!Number.isSafeInteger(total) || total < items.length) throw new Error('ENTITY_WORKSPACE_ACCOUNT_COUNT_INVALID');
  return total;
};

export const emptyEntityWorkspaceContext = (runtimeId: unknown = null): EmptyEntityWorkspaceContext => ({
  status: 'empty',
  runtimeId: optionalText(runtimeId, 'ENTITY_WORKSPACE_RUNTIME_ID_INVALID') || null,
  height: 0,
  entityId: null,
  entityName: null,
  signerId: null,
  jurisdictionName: null,
  accountCount: null,
});

export function projectEntityWorkspaceContext(input: EntityWorkspaceContextInput): EntityWorkspaceContext {
  const runtimeId = optionalText(input.runtimeId, 'ENTITY_WORKSPACE_RUNTIME_ID_INVALID') || null;
  if (input.frame === null || input.frame === undefined) return emptyEntityWorkspaceContext(runtimeId);
  const frame = requireUnknownRecord(input.frame, 'ENTITY_WORKSPACE_FRAME_INVALID');
  const height = frameHeight(frame);
  if (frame['activeEntity'] === null || frame['activeEntity'] === undefined) {
    return { ...emptyEntityWorkspaceContext(runtimeId), height };
  }
  const active = requireUnknownRecord(frame['activeEntity'], 'ENTITY_WORKSPACE_ACTIVE_ENTITY_INVALID');
  const summary = requireUnknownRecord(active['summary'], 'ENTITY_WORKSPACE_SUMMARY_INVALID');
  const core = requireUnknownRecord(active['core'], 'ENTITY_WORKSPACE_CORE_INVALID');
  const entityId = selectedEntityId([frame['activeEntityId'], summary['entityId'], core['entityId']]);
  const coreName = nestedText(core, ['profile', 'name'], 'ENTITY_WORKSPACE_ENTITY_NAME_INVALID');
  const summaryName = optionalText(summary['label'], 'ENTITY_WORKSPACE_ENTITY_NAME_INVALID');
  const coreJurisdiction = nestedText(core, ['config', 'jurisdiction', 'name'], 'ENTITY_WORKSPACE_JURISDICTION_INVALID');
  const summaryJurisdiction = nestedText(summary, ['jurisdiction', 'name'], 'ENTITY_WORKSPACE_JURISDICTION_INVALID');
  const entityName = coreName || summaryName || entityId;
  const jurisdictionName = coreJurisdiction || summaryJurisdiction || null;
  const signerId = optionalText(core['signerId'], 'ENTITY_WORKSPACE_SIGNER_ID_INVALID').toLowerCase() || null;
  return {
    status: 'selected', runtimeId, height, entityId, entityName, signerId,
    jurisdictionName, accountCount: selectedAccountCount(active),
  };
}
