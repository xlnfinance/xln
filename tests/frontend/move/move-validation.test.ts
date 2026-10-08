import { describe, expect, test } from 'bun:test';

import {
  canAddMoveRouteToDraft,
  getMovePrimaryActionLabel,
  isImmediateMoveExecutionRoute,
} from '../../../frontend/src/lib/components/Entity/move-routes';
import {
  getMoveValidationErrorForContext,
  type MoveValidationContext,
} from '../../../frontend/src/lib/components/Entity/move/move-validation';

const selfEntityId = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hubId = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const targetId = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const eoa = '0x1111111111111111111111111111111111111111';

function ctx(patch: Partial<MoveValidationContext> = {}): MoveValidationContext {
  return {
    mode: 'draft',
    from: 'external',
    to: 'reserve',
    amountInput: '1',
    executing: false,
    activeIsLive: true,
    awaitingCounterparty: false,
    hasSentBatch: false,
    sourceAccountId: hubId,
    targetEntityId: targetId,
    targetHubId: hubId,
    selfEntityId,
    selfExternalAddress: eoa,
    reserveRecipientEntityId: selfEntityId,
    externalRecipient: eoa,
    reserveToken: { decimals: 6 },
    externalToken: { decimals: 6 },
    sourceAvailableBalance: 2_000_000n,
    allowanceRequired: false,
    allowanceLoading: false,
    allowanceError: null,
    allowanceRaw: null,
    ...patch,
  };
}

describe('move route helpers', () => {
  test('keeps direct wallet route out of draft batches', () => {
    expect(canAddMoveRouteToDraft('external', 'reserve')).toBe(true);
    expect(canAddMoveRouteToDraft('account', 'account')).toBe(true);
    expect(canAddMoveRouteToDraft('external', 'external')).toBe(false);
    expect(isImmediateMoveExecutionRoute('external', 'external')).toBe(true);
    expect(getMovePrimaryActionLabel('external', 'external')).toBe('Send Direct');
    expect(getMovePrimaryActionLabel('reserve', 'account')).toBe('Add to Batch');
  });
});

describe('move validation', () => {
  test('requires live mode for non-direct routes', () => {
    expect(getMoveValidationErrorForContext(ctx({ activeIsLive: false }))).toBe('Switch to LIVE mode to add this route to batch');
    expect(getMoveValidationErrorForContext(ctx({
      mode: 'broadcast',
      activeIsLive: false,
    }))).toBe('Switch to LIVE mode to submit this route');
    expect(getMoveValidationErrorForContext(ctx({
      from: 'external',
      to: 'external',
      mode: 'broadcast',
      activeIsLive: false,
      externalRecipient: '0x2222222222222222222222222222222222222222',
    }))).toBe(null);
  });

  test('blocks invalid account and self routes before parsing amount', () => {
    expect(getMoveValidationErrorForContext(ctx({
      from: 'account',
      to: 'account',
      targetEntityId: selfEntityId,
      targetHubId: hubId,
    }))).toBe('Cannot transfer to same account');
    expect(getMoveValidationErrorForContext(ctx({
      from: 'reserve',
      to: 'reserve',
      reserveRecipientEntityId: selfEntityId,
    }))).toBe('Reserve → Reserve to self is meaningless');
    expect(getMoveValidationErrorForContext(ctx({
      from: 'external',
      to: 'external',
      mode: 'broadcast',
      externalRecipient: eoa,
    }))).toBe('External → External to self is meaningless');
  });

  test('handles draft allowance requirements', () => {
    expect(getMoveValidationErrorForContext(ctx({
      allowanceRequired: true,
      allowanceLoading: true,
    }))).toBe('Checking ERC20 allowance');
    expect(getMoveValidationErrorForContext(ctx({
      allowanceRequired: true,
      allowanceError: 'RPC down',
    }))).toBe('RPC down');
    expect(getMoveValidationErrorForContext(ctx({
      allowanceRequired: true,
      allowanceRaw: 1n,
    }))).toBe('Allow ERC20 before adding to batch');
    expect(getMoveValidationErrorForContext(ctx({
      allowanceRequired: true,
      allowanceRaw: 1_000_000n,
    }))).toBe(null);
  });
});

describe('native Tron external recipient boundary', () => {
  const recipient = 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC';
  test('accepts a checksummed base58 recipient only for the actual Tron adapter', () => {
    expect(getMoveValidationErrorForContext(ctx({ from: 'reserve', to: 'external',
      externalRecipient: recipient, jurisdictionMode: 'tron' }))).toBeNull();
    expect(getMoveValidationErrorForContext(ctx({ from: 'reserve', to: 'external',
      externalRecipient: recipient, jurisdictionMode: 'rpc' }))).toBe('Recipient must be a valid EOA address');
  });
  test('rejects a bad checksum without lowercasing the base58 input', () => {
    expect(getMoveValidationErrorForContext(ctx({ from: 'reserve', to: 'external',
      externalRecipient: `${recipient.slice(0, -1)}D`, jurisdictionMode: 'tron' })))
      .toBe('Recipient must be a valid EOA address');
  });
  test('compares Tron base58 and hex aliases when rejecting a direct self transfer', () => {
    expect(getMoveValidationErrorForContext(ctx({ mode: 'broadcast', from: 'external', to: 'external',
      externalRecipient: recipient, selfExternalAddress: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
      jurisdictionMode: 'tron' }))).toBe('External → External to self is meaningless');
  });
});
