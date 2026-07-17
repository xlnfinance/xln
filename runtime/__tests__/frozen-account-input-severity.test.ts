import { describe, expect, test } from 'bun:test';
import { frozenAccountInputLogLevel } from '../entity/tx/handlers/account';
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
  test('classifies an authenticated in-flight frame_ack after durable on-chain freeze as expected terminal traffic', () => {
    expect(frozenAccountInputLogLevel(account(true), input('frame_ack'))).toBe('info');
    expect(frozenAccountInputLogLevel(account(undefined), input('frame_ack'))).toBe('info');
  });

  test('keeps pre-finality and non-ACK frozen traffic at error severity', () => {
    expect(frozenAccountInputLogLevel(account(false), input('frame_ack'))).toBe('error');
    expect(frozenAccountInputLogLevel(account(true), input('frame'))).toBe('error');
    expect(frozenAccountInputLogLevel(account(true), input('proposal'))).toBe('error');
  });
});
