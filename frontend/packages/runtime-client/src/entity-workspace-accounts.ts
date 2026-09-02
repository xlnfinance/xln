import {
  requireFiniteNumber,
  requireUnknownRecord,
} from './boundary';
import type { EntityWorkspaceContext } from './entity-workspace-context';

export type EntityWorkspaceAccountItem = Readonly<{
  counterpartyId: string;
  frameHeight: number;
  stateHash: string;
}>;

type EmptyEntityWorkspaceAccounts = Readonly<{
  status: 'empty';
}>;

type SelectedEntityWorkspaceAccounts = Readonly<{
  status: 'selected';
  entityId: string;
  items: readonly EntityWorkspaceAccountItem[];
  pageIndex: number;
  pageCount: number;
  totalItems: number;
  limit: number;
}>;

export type EntityWorkspaceAccounts =
  | EmptyEntityWorkspaceAccounts
  | SelectedEntityWorkspaceAccounts;

export type EntityWorkspaceAccountsInput = Readonly<{
  context: EntityWorkspaceContext;
  frame?: unknown;
}>;

export const emptyEntityWorkspaceAccounts = (): EmptyEntityWorkspaceAccounts => ({ status: 'empty' });

const requiredText = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};

const normalizedId = (value: unknown, code: string): string => requiredText(value, code).toLowerCase();

const nonnegativeInteger = (value: unknown, code: string): number => {
  const parsed = requireFiniteNumber(value, code);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
};

const positiveInteger = (value: unknown, code: string): number => {
  const parsed = nonnegativeInteger(value, code);
  if (parsed === 0) throw new Error(code);
  return parsed;
};

const accountItem = (
  value: unknown,
  entityId: string,
): EntityWorkspaceAccountItem => {
  const account = requireUnknownRecord(value, 'ENTITY_WORKSPACE_ACCOUNT_INVALID');
  const state = requireUnknownRecord(account['state'], 'ENTITY_WORKSPACE_ACCOUNT_STATE_INVALID');
  const leftEntity = normalizedId(state['leftEntity'], 'ENTITY_WORKSPACE_ACCOUNT_LEFT_INVALID');
  const rightEntity = normalizedId(state['rightEntity'], 'ENTITY_WORKSPACE_ACCOUNT_RIGHT_INVALID');
  if (leftEntity === rightEntity || (leftEntity !== entityId && rightEntity !== entityId)) {
    throw new Error('ENTITY_WORKSPACE_ACCOUNT_PERSPECTIVE_MISMATCH');
  }
  const currentFrame = requireUnknownRecord(
    account['currentFrame'],
    'ENTITY_WORKSPACE_ACCOUNT_FRAME_INVALID',
  );
  const stateHash = requiredText(
    currentFrame['stateHash'],
    'ENTITY_WORKSPACE_ACCOUNT_STATE_HASH_INVALID',
  );
  return {
    counterpartyId: leftEntity === entityId ? rightEntity : leftEntity,
    frameHeight: nonnegativeInteger(
      currentFrame['height'],
      'ENTITY_WORKSPACE_ACCOUNT_FRAME_HEIGHT_INVALID',
    ),
    stateHash,
  };
};

const validatePage = (
  page: Record<string, unknown>,
  visibleItems: number,
): Readonly<{ pageIndex: number; pageCount: number; totalItems: number; limit: number }> => {
  const pageIndex = nonnegativeInteger(page['pageIndex'], 'ENTITY_WORKSPACE_ACCOUNT_PAGE_INVALID');
  const pageCount = nonnegativeInteger(page['pageCount'], 'ENTITY_WORKSPACE_ACCOUNT_PAGE_COUNT_INVALID');
  const totalItems = nonnegativeInteger(page['totalItems'], 'ENTITY_WORKSPACE_ACCOUNT_TOTAL_INVALID');
  const limit = positiveInteger(page['limit'], 'ENTITY_WORKSPACE_ACCOUNT_LIMIT_INVALID');
  const expectedPageCount = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
  const expectedVisibleItems = pageCount === 0 ? 0 : Math.min(limit, totalItems - pageIndex * limit);
  if (
    visibleItems !== expectedVisibleItems || pageCount !== expectedPageCount ||
    (pageCount === 0 ? pageIndex !== 0 : pageIndex >= pageCount)
  ) throw new Error('ENTITY_WORKSPACE_ACCOUNT_PAGE_METADATA_MISMATCH');
  return { pageIndex, pageCount, totalItems, limit };
};

export function projectEntityWorkspaceAccounts(
  input: EntityWorkspaceAccountsInput,
): EntityWorkspaceAccounts {
  if (input.context.status === 'empty') return emptyEntityWorkspaceAccounts();
  const frame = requireUnknownRecord(input.frame, 'ENTITY_WORKSPACE_ACCOUNTS_FRAME_INVALID');
  const active = requireUnknownRecord(frame['activeEntity'], 'ENTITY_WORKSPACE_ACCOUNTS_ACTIVE_ENTITY_INVALID');
  const page = requireUnknownRecord(active['accounts'], 'ENTITY_WORKSPACE_ACCOUNTS_PAGE_INVALID');
  if (!Array.isArray(page['items'])) throw new Error('ENTITY_WORKSPACE_ACCOUNT_ITEMS_INVALID');
  const entityId = input.context.entityId;
  const items = page['items'].map((value) => accountItem(value, entityId));
  if (new Set(items.map(({ counterpartyId }) => counterpartyId)).size !== items.length) {
    throw new Error('ENTITY_WORKSPACE_ACCOUNT_COUNTERPARTY_DUPLICATE');
  }
  return {
    status: 'selected',
    entityId,
    items,
    ...validatePage(page, items.length),
  };
}
