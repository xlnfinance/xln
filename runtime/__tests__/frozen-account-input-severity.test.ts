import { describe, expect, test } from 'bun:test';
import { canProcessFrozenAccountInput, frozenAccountInputLogLevel } from '../entity/tx/handlers/account';
import type { AccountInput, AccountMachine } from '../types';

const account = (
  observedOnChain: boolean | undefined,
): Pick<AccountMachine, 'status' | 'activeDispute'> => ({
  status: 'disputed',
  ...(observedOnChain === undefined
    ? {}
    : { activeDispute: { observedOnChain } as AccountMachine['activeDispute'] }),
});

const input = (kind: AccountInput['kind']): Pick<AccountInput, 'kind'> => ({ kind });

describe('frozen Account input severity', () => {
  test('rejects every external AccountInput from prepare through on-chain dispute', () => {
    expect(canProcessFrozenAccountInput('dispute_preparing', false, false, ['swap_resolve'])).toBe(false);
    expect(canProcessFrozenAccountInput('dispute_preparing', false, true, [])).toBe(false);
    expect(canProcessFrozenAccountInput('disputed', true, true, ['j_event_claim'])).toBe(false);
    expect(canProcessFrozenAccountInput('active', false, true, [])).toBe(true);
  });

  test('allows only the explicit reopen frame and ACK after finalization', () => {
    expect(canProcessFrozenAccountInput('disputed', false, false, ['reopen_disputed'])).toBe(true);
    expect(canProcessFrozenAccountInput('disputed', false, true, ['reopen_disputed'])).toBe(true);
    expect(canProcessFrozenAccountInput('disputed', true, false, ['reopen_disputed'])).toBe(false);
    expect(canProcessFrozenAccountInput('disputed', false, false, ['reopen_disputed', 'add_delta'])).toBe(false);
  });

  test('classifies an authenticated in-flight frame_ack after durable on-chain freeze as expected terminal traffic', () => {
    expect(frozenAccountInputLogLevel(account(true), input('frame_ack'))).toBe('info');
    expect(frozenAccountInputLogLevel(account(undefined), input('frame_ack'))).toBe('info');
  });

  test('classifies a retried ACK during either freeze phase as a visible non-fatal no-op', () => {
    expect(frozenAccountInputLogLevel({ status: 'dispute_preparing' }, input('ack'))).toBe('warn');
    expect(frozenAccountInputLogLevel(account(false), input('ack'))).toBe('warn');
    expect(frozenAccountInputLogLevel(account(true), input('ack'))).toBe('warn');
  });

  test('keeps pre-finality and non-ACK frozen traffic at error severity', () => {
    expect(frozenAccountInputLogLevel(account(false), input('frame_ack'))).toBe('error');
    expect(frozenAccountInputLogLevel(account(true), input('frame'))).toBe('error');
    expect(frozenAccountInputLogLevel(account(true), input('proposal'))).toBe('error');
  });
});
