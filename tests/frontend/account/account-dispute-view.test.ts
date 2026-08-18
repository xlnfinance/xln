import { describe, expect, test } from 'bun:test';

import type { AccountState } from '../../../core/types/account';
import { buildDisputedAccountViews } from '../../../frontend/src/lib/components/Entity/account/account-dispute-view';

describe('account dispute view helpers', () => {
  test('builds active disputes before finalized disputed accounts', () => {
    const accounts = new Map<string, AccountState>([
      ['0xbb', { status: 'disputed' } as AccountState],
      ['0xaa', { status: 'disputed', activeDispute: { nonce: 1 } } as unknown as AccountState],
      ['0xcc', { status: 'open' } as AccountState],
    ]);

    expect(buildDisputedAccountViews(accounts)).toEqual([
      { counterpartyId: '0xaa', status: 'active' },
      { counterpartyId: '0xbb', status: 'finalized' },
    ]);
  });
});
