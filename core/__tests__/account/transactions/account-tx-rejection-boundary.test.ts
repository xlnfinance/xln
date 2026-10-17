import { describe, expect, test } from 'bun:test';

import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { ACCOUNT_TX_REJECTION_CODES } from '../../../account/tx/apply-types';
import { decodeAccountTx } from '../../../account/tx-validation';
import { TOKENS } from '../../../config/constants';
import type { AccountTx } from '../../../types/account';
import { entity, makeAccount } from '../../helpers/cross-j';

const LEFT = entity('11');
const RIGHT = entity('22');
const CLOCK = { timestamp: 1_000, jHeight: 0 };
const OUT_OF_DOMAIN = 70_000;

const expectTokenRejection = async (tx: AccountTx) => {
  const account = makeAccount(LEFT, RIGHT);
  const rowsBefore = account.state.deltas.size;
  const result = await applyAccountTxToMutableReplica(
    account,
    tx,
    true,
    1_000,
    0,
    false,
    undefined,
    undefined,
    undefined,
    CLOCK,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected rejection');
  expect(result.rejection).toEqual({
    kind: 'delta_token_invalid',
    code: ACCOUNT_TX_REJECTION_CODES.deltaTokenInvalid,
    message: `ACCOUNT_DELTA_TOKEN_INVALID:${OUT_OF_DOMAIN}`,
    tokenId: OUT_OF_DOMAIN,
  });
  expect(account.state.deltas.size).toBe(rowsBefore);
  expect(TOKENS.MAX_TOKEN_ID).toBeLessThan(OUT_OF_DOMAIN);
};

describe('one reject boundary for token-domain failures', () => {
  test('direct_payment.rejects_token_id_above_max_without_throw', async () => {
    await expectTokenRejection({
      type: 'direct_payment',
      data: {
        tokenId: OUT_OF_DOMAIN,
        amount: 1n,
        route: [RIGHT],
        fromEntityId: LEFT,
        toEntityId: RIGHT,
        deliveryMode: 'direct',
      },
    });
  });

  test('set_credit_limit.rejects_token_id_above_max', async () => {
    await expectTokenRejection({ type: 'set_credit_limit', data: { tokenId: OUT_OF_DOMAIN, amount: 1n } });
  });

  test('htlc_lock.rejects_token_id_above_max_without_throw', async () => {
    await expectTokenRejection({
      type: 'htlc_lock',
      data: {
        lockId: `0x${'ab'.repeat(32)}`,
        hashlock: `0x${'ab'.repeat(32)}`,
        timelock: 60_000n,
        revealBeforeHeight: 10,
        amount: 1n,
        tokenId: OUT_OF_DOMAIN,
      },
    });
  });

  test('decode.rejects_every_token_id_field_above_max_at_the_wire_boundary', () => {
    expect(() =>
      decodeAccountTx({ type: 'set_credit_limit', data: { tokenId: OUT_OF_DOMAIN, amount: 1n } }, 'X'),
    ).toThrow('X_DATA_TOKENID_DOMAIN');
    expect(() =>
      decodeAccountTx(
        {
          type: 'direct_payment',
          data: {
            tokenId: OUT_OF_DOMAIN,
            amount: 1n,
            route: [RIGHT],
            deliveryMode: 'direct',
            fromEntityId: LEFT,
            toEntityId: RIGHT,
          },
        },
        'X',
      ),
    ).toThrow('X_DATA_TOKENID_DOMAIN');
    expect(() =>
      decodeAccountTx(
        {
          type: 'swap_offer',
          data: {
            offerId: 'o',
            giveTokenId: 1,
            giveTokenDecimals: 6,
            giveAmount: 1n,
            wantTokenId: OUT_OF_DOMAIN,
            wantTokenDecimals: 6,
            wantAmount: 1n,
            maxFee: 0n,
            minNetReceive: 1n,
          },
        },
        'X',
      ),
    ).toThrow('X_DATA_WANTTOKENID_DOMAIN');
    expect(() =>
      decodeAccountTx(
        {
          type: 'request_collateral',
          data: { tokenId: 1, amount: 1n, feeAmount: 1n, policyVersion: 1, feeTokenId: OUT_OF_DOMAIN },
        },
        'X',
      ),
    ).toThrow('X_DATA_FEETOKENID_DOMAIN');
    expect(decodeAccountTx({ type: 'add_delta', data: { tokenId: TOKENS.MAX_TOKEN_ID } }, 'X')).toEqual({
      type: 'add_delta',
      data: { tokenId: TOKENS.MAX_TOKEN_ID },
    });
  });
});
