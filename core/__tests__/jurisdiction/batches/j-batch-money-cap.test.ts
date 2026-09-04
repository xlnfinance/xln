import { describe, expect, test } from 'bun:test';

import { MAX_MONEY, MoneyCapExceededError } from '../../../protocol/money-cap';
import { createEmptyBatch, encodeJBatch, decodeJBatch } from '../../../jurisdiction/machine/batch';
import { validateJBatch } from '../../../jurisdiction/machine/batch-validation';
import { createSettlementHashWithNonce } from '../../../protocol/dispute/proof-builder';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const DOMAIN = { chainId: 31337, depositoryAddress: '0x1111111111111111111111111111111111111111' };

describe('MAX_MONEY (2^200) is enforced before signing/submission', () => {
  test('constant matches Types.sol', () => {
    expect(MAX_MONEY).toBe(1n << 200n);
  });

  test('batch amounts at the cap pass and one above it reject with MONEY_CAP_EXCEEDED', () => {
    const batch = createEmptyBatch();
    batch.reserveToReserve.push({ receivingEntity: RIGHT, tokenId: 1, amount: MAX_MONEY });
    expect(() => validateJBatch(batch, 'T')).not.toThrow();
    expect(decodeJBatch(encodeJBatch(batch))).toEqual(batch);

    batch.reserveToReserve[0]!.amount = MAX_MONEY + 1n;
    expect(() => validateJBatch(batch, 'T')).toThrow(MoneyCapExceededError);
    expect(() => validateJBatch(batch, 'T')).toThrow('MONEY_CAP_EXCEEDED:T_R2R_0_AMOUNT');
  });

  test('settlement diffs and proof-body offdeltas are magnitude-capped', () => {
    const batch = createEmptyBatch();
    batch.settlements.push({
      leftEntity: LEFT,
      rightEntity: RIGHT,
      diffs: [{ tokenId: 1, leftDiff: -(MAX_MONEY + 1n), rightDiff: 0n, collateralDiff: MAX_MONEY + 1n, ondeltaDiff: 0n }],
      forgiveDebtsInTokenIds: [],
      sig: '0x',
      nonce: 1,
    });
    expect(() => validateJBatch(batch, 'T')).toThrow('MONEY_CAP_EXCEEDED:T_SETTLEMENTS_0_DIFFS_0_LEFTDIFF');

    const account = { leftEntity: LEFT, rightEntity: RIGHT };
    const capped = [{ tokenId: 1, leftDiff: -MAX_MONEY, rightDiff: MAX_MONEY, collateralDiff: 0n, ondeltaDiff: 0n }];
    expect(() => createSettlementHashWithNonce(account, capped, [], DOMAIN, 1)).not.toThrow();
    const over = [{ tokenId: 1, leftDiff: 0n, rightDiff: 0n, collateralDiff: 0n, ondeltaDiff: -(MAX_MONEY + 1n) }];
    expect(() => createSettlementHashWithNonce(account, over, [], DOMAIN, 1))
      .toThrow('MONEY_CAP_EXCEEDED:SETTLEMENT_ONDELTA_DIFF:token=1');
  });
});
