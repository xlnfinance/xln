import { describe, expect, test } from 'bun:test';

import {
  matchWorkspaceAccountId,
  openDisputedAccountNavigation,
  returnToAccountsWorkspace,
  selectAccountNavigation,
  selectTopLevelTabNavigation,
} from '../../frontend/src/lib/components/Entity/account-workspace-navigation';

describe('account workspace navigation helpers', () => {
  test('matches workspace account ids case-insensitively', () => {
    expect(matchWorkspaceAccountId(['0xAbC', '0xDef'], '0xabc')).toBe('0xAbC');
    expect(matchWorkspaceAccountId(['0xAbC'], '0x999')).toBe('0x999');
    expect(matchWorkspaceAccountId(['0xAbC'], '   ')).toBe('');
  });

  test('selects accounts and preserves workspace when there is no match', () => {
    expect(selectAccountNavigation(['0xAbC'], '0xabc')).toEqual({
      selectedAccountId: '0xabc',
      workspaceAccountId: '0xAbC',
    });
    expect(selectAccountNavigation(['0xAbC'], '0x999')).toEqual({
      selectedAccountId: '0x999',
    });
    expect(selectAccountNavigation(['0xAbC'], '')).toEqual({ selectedAccountId: null });
  });

  test('returns focused account views to account workspace tabs', () => {
    expect(returnToAccountsWorkspace({ selectedAccountId: '0xabc' }, ['0xAbC'], 'activity')).toEqual({
      workspaceAccountId: '0xAbC',
      selectedAccountId: null,
      activeTab: 'accounts',
      accountWorkspaceTab: 'activity',
    });
    expect(returnToAccountsWorkspace({ selectedAccountId: null }, ['0xAbC'], 'open')).toEqual({
      selectedAccountId: null,
      activeTab: 'accounts',
      accountWorkspaceTab: 'open',
    });
  });

  test('selects top-level tabs while clearing focused account state', () => {
    expect(selectTopLevelTabNavigation({ selectedAccountId: '0xabc' }, ['0xAbC'], 'accounts')).toMatchObject({
      workspaceAccountId: '0xAbC',
      selectedAccountId: null,
      activeTab: 'accounts',
      accountWorkspaceTab: 'activity',
    });
    expect(selectTopLevelTabNavigation({ selectedAccountId: '0xabc' }, ['0xAbC'], 'assets')).toEqual({
      selectedAccountId: null,
      activeTab: 'assets',
    });
    expect(selectTopLevelTabNavigation({ selectedAccountId: null }, ['0xAbC'], 'settings')).toEqual({
      activeTab: 'settings',
    });
  });

  test('opens disputed accounts only when the id is non-empty', () => {
    expect(openDisputedAccountNavigation('0xabc')).toEqual({
      selectedAccountId: '0xabc',
      activeTab: 'accounts',
    });
    expect(openDisputedAccountNavigation('  ')).toEqual({});
  });
});
