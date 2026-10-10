import { describe, expect, test } from 'bun:test';
import { frozenAccountInputLogLevel } from '../../../entity/tx/handlers/account/index';
import { canProcessAccountTxForDisputeStatus } from '../../../account/consensus/dispute/policy';
import type { AccountInput, AccountState } from '../../../types/account';

const account = (
  observedOnChain: boolean | undefined,
): Pick<AccountState, 'status' | 'activeDispute'> => ({
  status: 'disputed',
  ...(observedOnChain === undefined
    ? {}
    : { activeDispute: { observedOnChain } as AccountState['activeDispute'] }),
});

const input = (kind: AccountInput['kind']): Pick<AccountInput, 'kind'> => ({ kind });

describe('frozen Account input severity', () => {
  test('defers local J bookkeeping until dispute preparation returns active', () => {
    expect(canProcessAccountTxForDisputeStatus('active')).toBe(true);
    expect(canProcessAccountTxForDisputeStatus('dispute_preparing')).toBe(false);
    expect(canProcessAccountTxForDisputeStatus('disputed')).toBe(false);
  });

  test('classifies an authenticated in-flight ack_frame after durable on-chain freeze as expected terminal traffic', () => {
    expect(frozenAccountInputLogLevel(account(true), input('ack_frame'))).toBe('info');
    expect(frozenAccountInputLogLevel(account(undefined), input('ack_frame'))).toBe('info');
  });

  test('classifies a retried ACK during either freeze phase as a visible non-fatal no-op', () => {
    expect(frozenAccountInputLogLevel({ status: 'dispute_preparing' }, input('ack'))).toBe('warn');
    expect(frozenAccountInputLogLevel(account(false), input('ack'))).toBe('warn');
    expect(frozenAccountInputLogLevel(account(true), input('ack'))).toBe('warn');
  });

  test('keeps pre-finality and non-ACK frozen traffic at error severity', () => {
    expect(frozenAccountInputLogLevel(account(false), input('ack_frame'))).toBe('error');
    expect(frozenAccountInputLogLevel(account(true), input('dispute'))).toBe('error');
    expect(frozenAccountInputLogLevel(account(true), input('board_hanko_refresh'))).toBe('error');
  });
});
