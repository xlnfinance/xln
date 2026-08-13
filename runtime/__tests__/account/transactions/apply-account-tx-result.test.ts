import { describe, expect, test } from 'bun:test';

import type { AccountConsensusContext } from '../../../account/consensus/context';
import { applyAccountTx } from '../../../account/tx/apply';
import { handleAddDelta } from '../../../account/tx/handlers/balance/add-delta';
import { handleDirectPayment } from '../../../account/tx/handlers/balance/direct-payment';
import { handleHtlcLock } from '../../../account/tx/handlers/htlc/lock';
import { handleHtlcResolve } from '../../../account/tx/handlers/htlc/resolve';
import { createSettlementWorkspaceHash } from '../../../account/tx/handlers/settlement/transition';
import { ACCOUNT_TX_REJECTION_CODES } from '../../../account/tx/apply-types';
import {
  toHashlock,
  toHtlcSecret,
  toLockId,
  toTokenAmount,
  toTokenId,
} from '../../../account/tx/units';
import {
  toJHeight,
  toUnixMs,
  toUnixS,
  unixMsToUnixSFloor,
  unixSToUnixMs,
} from '../../../protocol/units';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { createDefaultDelta } from '../../../account/state/delta';
import { LIMITS, TOKENS } from '../../../config/constants';
import type { AccountTx } from '../../../types/account';
import { entity, makeAccount } from '../../helpers/cross-j';

const LEFT = entity('11');
const RIGHT = entity('22');
const HEX32 = (byte: string): string => `0x${byte.repeat(32)}`;

const consensusContext = (): AccountConsensusContext => ({
  runtimeTimestamp: 2_000,
  quietLogs: true,
  emitRuntimeEvents: false,
  jReplicas: new Map(),
  jClaimNodeStore: new Map(),
  verifyHanko: async () => ({ valid: true, entityId: null }),
  resolveSettlementBoardAuthority: async () => undefined,
});

const payment = (amount = 7n): Extract<AccountTx, { type: 'direct_payment' }> => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount,
    route: [RIGHT],
    fromEntityId: LEFT,
    toEntityId: RIGHT,
    deliveryMode: 'direct',
  },
});

const rejectionOf = (result: Awaited<ReturnType<typeof applyAccountTx>>) => {
  if (result.ok) throw new Error(`ACCOUNT_TX_TEST_EXPECTED_REJECTION:${result.outcome}`);
  return result.rejection;
};

describe('ApplyAccountTxResult units', () => {
  test('constructors validate before minting brands', () => {
    expect(() => toHashlock('not-a-hashlock')).toThrow('ACCOUNT_TX_HASHLOCK_INVALID');
    expect(() => toHtlcSecret('0x1234')).toThrow('ACCOUNT_TX_HTLC_SECRET_INVALID');
    expect(() => toLockId('lock:colon')).toThrow('ACCOUNT_TX_LOCK_ID_INVALID');
    expect(() => toTokenId(TOKENS.MAX_TOKEN_ID + 1)).toThrow('ACCOUNT_TX_TOKEN_ID_INVALID');
    expect(() => toTokenAmount(-1n)).toThrow('ACCOUNT_TX_TOKEN_AMOUNT_INVALID');
    expect(() => toUnixMs(-1)).toThrow('PROTOCOL_UNIX_MS_INVALID');
    expect(() => toJHeight(1.5)).toThrow('PROTOCOL_J_HEIGHT_INVALID');
    expect(toLockId('lock-timeout-boundary')).toBe('lock-timeout-boundary');
    expect(toHashlock(HEX32('21'))).toBe(HEX32('21'));
  });

  test('Unix ms/seconds conversions are named and floor unaligned boundaries', () => {
    expect(unixMsToUnixSFloor(toUnixMs(2_000))).toBe(2);
    expect(unixMsToUnixSFloor(toUnixMs(2_999))).toBe(2);
    expect(unixSToUnixMs(toUnixS(2))).toBe(2_000);
  });
});

describe('ApplyAccountTxResult payment/HTLC/settlement dispositions', () => {
  test('add_delta rejects an over-capacity token without mutation', () => {
    const account = makeAccount(LEFT, RIGHT);
    for (let tokenId = 2; tokenId <= LIMITS.MAX_ACCOUNT_TOKEN_ROWS; tokenId += 1) {
      account.state.deltas.set(tokenId, createDefaultDelta(tokenId));
    }
    expect(account.state.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
    const result = handleAddDelta(account.state, {
      type: 'add_delta',
      data: { tokenId: LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1 },
    });
    const rejection = rejectionOf(result);
    expect(rejection).toEqual({
      kind: 'delta_row_limit_exceeded',
      code: ACCOUNT_TX_REJECTION_CODES.deltaRowLimitExceeded,
      message:
        `ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:` +
        `${LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1}:${LIMITS.MAX_ACCOUNT_TOKEN_ROWS}`,
    });
    expect(result.events).toEqual([rejection.message]);
    expect(account.state.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
  });

  test('add_delta rejects a token id outside the canonical domain', () => {
    const account = makeAccount(LEFT, RIGHT);
    const result = handleAddDelta(account.state, {
      type: 'add_delta',
      data: { tokenId: TOKENS.MAX_TOKEN_ID + 1 },
    });
    const rejection = rejectionOf(result);
    expect(rejection).toEqual({
      kind: 'delta_token_invalid',
      code: ACCOUNT_TX_REJECTION_CODES.deltaTokenInvalid,
      message: `ACCOUNT_DELTA_TOKEN_INVALID:${TOKENS.MAX_TOKEN_ID + 1}`,
      tokenId: TOKENS.MAX_TOKEN_ID + 1,
    });
    expect(account.state.deltas.size).toBe(1);
  });

  test('direct_payment applies and rejects forged direction without mutation', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const applied = handleDirectPayment(account, payment(), true);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('ACCOUNT_TX_TEST_EXPECTED_APPLIED');
    expect(applied.outcome).toBe('applied');
    expect(account.state.deltas.get(1)?.offdelta).toBe(-7n);

    const forged = handleDirectPayment(account, {
      ...payment(1n),
      data: { ...payment(1n).data, fromEntityId: RIGHT, toEntityId: LEFT },
    }, true);
    const rejection = rejectionOf(forged);
    expect(rejection.kind).toBe('validation');
    expect(rejection.message).toContain('must match the frame proposer');
    expect(account.state.deltas.get(1)?.offdelta).toBe(-7n);
  });

  test('htlc lock then secret resolve returns branded htlc_secret without leftover lock', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const secret = HEX32('44');
    const hashlock = hashHtlcSecret(secret);
    const lockId = 'lock-secret-ok';
    const locked = await handleHtlcLock(account, {
      type: 'htlc_lock',
      data: {
        lockId,
        hashlock,
        timelock: 60_000n,
        revealBeforeHeight: 10,
        amount: 7n,
        tokenId: 1,
      },
    }, true, {
      committedTimestamp: 1_000,
      enforcementTimestamp: 1_000,
      enforcementJHeight: 0,
    });
    expect(locked.ok).toBe(true);
    expect(account.state.locks.has(lockId)).toBe(true);
    expect(account.state.deltas.get(1)?.leftHold).toBe(7n);

    const revealed = await handleHtlcResolve(
      account.state,
      { type: 'htlc_resolve', data: { lockId, outcome: 'secret', secret } },
      false,
      1,
      1_000,
    );
    expect(revealed.ok).toBe(true);
    if (!revealed.ok || revealed.outcome !== 'htlc_secret') {
      throw new Error('ACCOUNT_TX_TEST_EXPECTED_HTLC_SECRET');
    }
    expect(revealed.secret).toBe(secret);
    expect(revealed.hashlock).toBe(hashlock);
    expect(revealed.amount).toBe(7n);
    expect(revealed.tokenId).toBe(1);
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.state.deltas.get(1)?.offdelta).toBe(-7n);
  });

  test('htlc timeout returns htlc_error and releases the hold', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const lockId = 'lock-timeout-boundary';
    const hashlock = HEX32('21');
    account.state.deltas.get(1)!.leftHold = 7n;
    account.state.locks.set(lockId, {
      lockId,
      tokenId: 1,
      amount: 7n,
      senderIsLeft: true,
      hashlock,
      revealBeforeHeight: 100,
      timelock: 1_000n,
      createdHeight: 0,
      createdTimestamp: 0,
    });
    const result = await handleHtlcResolve(
      account.state,
      { type: 'htlc_resolve', data: { lockId, outcome: 'error', reason: 'timeout' } },
      true,
      1,
      1_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.outcome !== 'htlc_error') {
      throw new Error('ACCOUNT_TX_TEST_EXPECTED_HTLC_ERROR');
    }
    expect(result.hashlock).toBe(hashlock);
    expect(account.state.locks.has(lockId)).toBe(false);
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
  });

  test('signed settlement workspace freezes direct_payment with typed rejection', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const upsert: AccountTx = {
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        revision: 1,
        ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
        executorIsLeft: false,
      },
    };
    const upserted = await applyAccountTx(account, upsert, true, 1_000);
    expect(upserted.ok).toBe(true);
    account.state.settlementWorkspace!.leftHanko = '0x1234';
    const before = account.state.deltas.get(1)?.offdelta;
    const frozen = await applyAccountTx(account, payment(1n), true, 2_000);
    const rejection = rejectionOf(frozen);
    expect(rejection).toEqual({
      kind: 'settlement_signed_account_frozen',
      code: ACCOUNT_TX_REJECTION_CODES.settlementSignedAccountFrozen,
      message: 'SETTLEMENT_SIGNED_ACCOUNT_FROZEN:direct_payment',
      txType: 'direct_payment',
    });
    expect(account.state.deltas.get(1)?.offdelta).toBe(before);
    expect(createSettlementWorkspaceHash(account.state, account.state.settlementWorkspace!))
      .toBe(account.state.settlementWorkspace!.workspaceHash);
  });

  test('settlement seal nonce mismatch is typed and leaves the workspace unsigned', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const upserted = await applyAccountTx(account, {
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        revision: 1,
        ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
        executorIsLeft: false,
      },
    }, true, 1_000);
    expect(upserted.ok).toBe(true);
    account.proofHeader.nextProofNonce = 5;
    const workspaceHash = account.state.settlementWorkspace!.workspaceHash;
    const result = await applyAccountTx(account, {
      type: 'settle_transition',
      data: {
        kind: 'seal',
        revision: 1,
        workspaceHash,
        settlementNonce: 6,
        settlementHash: HEX32('91'),
        postProof: {
          nonce: 7,
          proofBodyHash: HEX32('92'),
          disputeHash: HEX32('93'),
          hanko: '0x1234',
        },
        settlementHanko: '0x5678',
      },
    }, true, 2_000, 0, false, consensusContext());
    const rejection = rejectionOf(result);
    expect(rejection.kind).toBe('settlement_seal_nonce_mismatch');
    if (rejection.kind !== 'settlement_seal_nonce_mismatch') throw new Error('ACCOUNT_TX_TEST_SEAL_KIND');
    expect(rejection.code).toBe(ACCOUNT_TX_REJECTION_CODES.settlementSealNonceMismatch);
    expect(rejection.message).toContain('SETTLEMENT_SEAL_NONCE_MISMATCH:6:5');
    expect(rejection.suppliedNonce).toBe(6);
    expect(rejection.requiredNonce).toBe(5);
    expect(rejection.basis).toBe('account');
    expect(account.state.settlementWorkspace?.nonceAtSign).toBeUndefined();
    expect(account.state.settlementWorkspace?.leftHanko).toBeUndefined();
  });

  test('disputed account rejects financial txs as account_closed_for_dispute', async () => {
    const account = makeAccount(LEFT, RIGHT);
    account.status = 'disputed';
    const result = await applyAccountTx(account, payment(1n), true, 2_000);
    const rejection = rejectionOf(result);
    expect(rejection).toEqual({
      kind: 'account_closed_for_dispute',
      code: ACCOUNT_TX_REJECTION_CODES.closedForDispute,
      message: 'ACCOUNT_CLOSED_FOR_DISPUTE:status=disputed;tx=direct_payment',
      status: 'disputed',
      txType: 'direct_payment',
    });
    expect(account.state.deltas.get(1)?.offdelta).toBe(0n);
  });
});
