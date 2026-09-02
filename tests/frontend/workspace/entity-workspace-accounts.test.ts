import { describe, expect, test } from 'bun:test';

import {
  emptyEntityWorkspaceAccounts,
  projectEntityWorkspaceAccounts,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-accounts';
import {
  projectEntityWorkspaceContext,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-context';

const account = (leftEntity: string, rightEntity: string, frameHeight: number, stateHash: string) => ({
  state: { leftEntity, rightEntity },
  currentFrame: { height: frameHeight, stateHash },
});

const frameWithAccounts = (items: unknown[], overrides: Record<string, unknown> = {}) => ({
  height: 27,
  activeEntityId: '0xaaaa',
  activeEntity: {
    summary: { entityId: '0xaaaa', label: 'Treasury' },
    core: { entityId: '0xaaaa' },
    accounts: {
      items,
      pageIndex: 0,
      pageCount: items.length === 0 ? 0 : 1,
      totalItems: items.length,
      limit: 8,
      ...overrides,
    },
  },
});

const FRAME = frameWithAccounts([
  account('0xAAAA', '0xBBBB', 4, '0xSTATEB'),
  account('0xCCCC', '0xaaaa', 7, '0xSTATEC'),
]);

const CONTEXT = projectEntityWorkspaceContext({ runtimeId: 'runtime-a', frame: FRAME });

describe('Entity workspace Accounts page projection', () => {
  test('preserves adapter order and projects committed frame headers only', () => {
    expect(projectEntityWorkspaceAccounts({ context: CONTEXT, frame: FRAME })).toEqual({
      status: 'selected',
      entityId: '0xaaaa',
      items: [
        { counterpartyId: '0xbbbb', frameHeight: 4, stateHash: '0xSTATEB' },
        { counterpartyId: '0xcccc', frameHeight: 7, stateHash: '0xSTATEC' },
      ],
      pageIndex: 0,
      pageCount: 1,
      totalItems: 2,
      limit: 8,
    });
  });

  test('represents an Entity-empty Runtime without inventing an Account page', () => {
    const context = projectEntityWorkspaceContext({ runtimeId: 'runtime-a', frame: { height: 2, activeEntity: null } });
    expect(projectEntityWorkspaceAccounts({ context, frame: { height: 2, activeEntity: null } }))
      .toEqual(emptyEntityWorkspaceAccounts());
  });

  test('accepts a later bounded page without presenting it as a total', () => {
    const frame = frameWithAccounts([
      account('0xaaaa', '0xdddd', 9, '0xstated'),
    ], { pageIndex: 1, pageCount: 2, totalItems: 9 });
    expect(projectEntityWorkspaceAccounts({ context: CONTEXT, frame })).toMatchObject({
      status: 'selected', pageIndex: 1, pageCount: 2, totalItems: 9,
      items: [{ counterpartyId: '0xdddd' }],
    });
  });

  test('rejects malformed or contradictory page metadata', () => {
    expect(() => projectEntityWorkspaceAccounts({
      context: CONTEXT,
      frame: frameWithAccounts([], { pageCount: 1, totalItems: 0 }),
    })).toThrow('ENTITY_WORKSPACE_ACCOUNT_PAGE_METADATA_MISMATCH');
    expect(() => projectEntityWorkspaceAccounts({
      context: CONTEXT,
      frame: frameWithAccounts([account('0xaaaa', '0xbbbb', 1, '0xhash')], { limit: 0 }),
    })).toThrow('ENTITY_WORKSPACE_ACCOUNT_LIMIT_INVALID');
    expect(() => projectEntityWorkspaceAccounts({
      context: CONTEXT,
      frame: frameWithAccounts([account('0xaaaa', '0xbbbb', 1, '')]),
    })).toThrow('ENTITY_WORKSPACE_ACCOUNT_STATE_HASH_INVALID');
  });

  test('rejects foreign, self, or duplicate bilateral Accounts', () => {
    expect(() => projectEntityWorkspaceAccounts({
      context: CONTEXT,
      frame: frameWithAccounts([account('0xdddd', '0xbbbb', 1, '0xhash')]),
    })).toThrow('ENTITY_WORKSPACE_ACCOUNT_PERSPECTIVE_MISMATCH');
    expect(() => projectEntityWorkspaceAccounts({
      context: CONTEXT,
      frame: frameWithAccounts([account('0xaaaa', '0xaaaa', 1, '0xhash')]),
    })).toThrow('ENTITY_WORKSPACE_ACCOUNT_PERSPECTIVE_MISMATCH');
    expect(() => projectEntityWorkspaceAccounts({
      context: CONTEXT,
      frame: frameWithAccounts([
        account('0xaaaa', '0xbbbb', 1, '0xhash1'),
        account('0xbbbb', '0xaaaa', 2, '0xhash2'),
      ]),
    })).toThrow('ENTITY_WORKSPACE_ACCOUNT_COUNTERPARTY_DUPLICATE');
  });
});
