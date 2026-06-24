import { describe, expect, test } from 'bun:test';

import type { AccountMachine, EntityState } from '../../runtime';
import {
  buildDisputedAccountViews,
  formatCrossJTargetDisputeRiskLabel,
  getCrossJTargetDisputeRiskForState,
} from '../../frontend/src/lib/components/Entity/account-dispute-view';

describe('account dispute view helpers', () => {
  test('builds active disputes before finalized disputed accounts', () => {
    const accounts = new Map<string, AccountMachine>([
      ['0xbb', { status: 'disputed' } as AccountMachine],
      ['0xaa', { status: 'disputed', activeDispute: { nonce: 1 } } as unknown as AccountMachine],
      ['0xcc', { status: 'open' } as AccountMachine],
    ]);

    expect(buildDisputedAccountViews(accounts)).toEqual([
      { counterpartyId: '0xaa', status: 'active' },
      { counterpartyId: '0xbb', status: 'finalized' },
    ]);
  });

  test('finds cross-j target dispute risk only when the target pull is still held', () => {
    const state = {
      entityId: '0xself',
      accounts: new Map<string, AccountMachine>([
        ['0xpeer', { pulls: new Map([['pull-1', {}]]) } as unknown as AccountMachine],
      ]),
      crossJurisdictionSwaps: new Map([
        ['ignored-source', {
          target: {
            counterpartyEntityId: '0xother',
            entityId: '0xpeer',
            amount: 10n,
            tokenId: 1,
          },
          targetPull: { pullId: 'pull-1' },
        }],
        ['matched', {
          target: {
            counterpartyEntityId: '0xself',
            entityId: '0xpeer',
            amount: 25n,
            tokenId: 2,
          },
          targetPull: { pullId: 'pull-1' },
        }],
      ]),
    } as unknown as EntityState;

    expect(getCrossJTargetDisputeRiskForState(state, '0xpeer')).toEqual({ amount: 25n, tokenId: 2 });
    expect(getCrossJTargetDisputeRiskForState(state, '0xmissing')).toBeNull();
  });

  test('formats cross-j target dispute risk labels through injected token metadata', () => {
    expect(formatCrossJTargetDisputeRiskLabel({
      risk: { amount: 1_250_000n, tokenId: 2 },
      resolveToken: () => ({ symbol: 'USDC', decimals: 6 }),
      formatTokenInputAmount: (amount, decimals) => `${amount / (10n ** BigInt(decimals))}.25`,
    })).toBe('1.25 USDC');
  });
});
