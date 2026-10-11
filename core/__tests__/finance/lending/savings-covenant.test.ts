import { expect, test } from 'bun:test';
import { makeAccount, entity, putTestAccountDelta } from '../../helpers/cross-j';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { buildAccountProofBody } from '../../../protocol/dispute/proof-builder';
import { assertAccountLendingCovenants, lendingExitAmount } from '../../../protocol/dispute/lending-covenant';
import { accountDisputeGasCharge } from '../../../account/validation/dispute-gas-budget';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { computeFrameHash } from '../../../account/consensus/frame/hash';
import { encodeBuffer, decodeValidatedBuffer } from '../../../storage/codec/codec';
import { projectPortableAccountDoc, hydrateAccountDocFromStorage } from '../../../storage/read/projections';
import { validateStorageAccountDocValue } from '../../../storage/schema/authoritative-schema';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import type { AccountTx } from '../../../types/account';
import { applyAccountDisputeFinality } from '../../../account/settlement/j-finality';
import { accountLendingRisk } from '../../../account/validation/lending-risk';
import { compactAccountDocForView } from '../../../api/runtime-adapter/read/compact-view';

const LEFT = entity('11');
const RIGHT = entity('22');
const TRANSFORMER = `0x${'33'.repeat(20)}`;
const POSITION = 'lend-1111111111111111';
const fundTx = (saverIsLeft: boolean, interestBps: number): AccountTx => ({ type: 'lending_fund', data: {
  positionId: POSITION, lenderEntityId: saverIsLeft ? LEFT : RIGHT, hubEntityId: saverIsLeft ? RIGHT : LEFT,
  tokenId: 1, amount: 10_000n, termId: '1d', interestBps,
} });

const funded = async (saverIsLeft: boolean, interestBps = 100) => {
  const account = makeAccount(LEFT, RIGHT);
  putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 20_000n, ondelta: 10_000n });
  const result = await applyAccountTxToMutableReplica(account, fundTx(saverIsLeft, interestBps), saverIsLeft, 1_000);
  expect(result.ok).toBe(true);
  return account;
};

test('lending_fund commits the promised return into the root and executable proof', async () => {
  const a = await funded(true, 100);
  const b = await funded(true, 200);
  expect(computeAccountStateRoot(a.state)).not.toBe(computeAccountStateRoot(b.state));
  expect(buildAccountProofBody(a, TRANSFORMER).proofBodyHash).not.toBe(buildAccountProofBody(b, TRANSFORMER).proofBodyHash);
  expect(accountDisputeGasCharge(a.state)).toBe(3_274_000);
});

for (const saverIsLeft of [true, false]) {
  test(`lending_close_payout removes exactly the paid savings claim, left=${saverIsLeft}`, async () => {
    const account = await funded(saverIsLeft);
    const before = computeAccountStateRoot(account.state);
    const tx = (amount: bigint): AccountTx => ({ type: 'lending_close_payout', data: {
      positionId: POSITION, hubEntityId: saverIsLeft ? RIGHT : LEFT, lenderEntityId: saverIsLeft ? LEFT : RIGHT,
      tokenId: 1, amount,
    } });
    const invalid = await applyAccountTxToMutableReplica(account, tx(1n), !saverIsLeft, 2_000);
    expect(invalid.ok).toBe(false);
    expect(computeAccountStateRoot(account.state)).toBe(before);
    expect((await applyAccountTxToMutableReplica(account, tx(10_100n), !saverIsLeft, 86_401_000)).ok).toBe(true);
    expect(account.state.subcontracts?.size).toBe(0);
    expect(buildAccountProofBody(account, TRANSFORMER).proofBodyStruct.transformers).toHaveLength(0);
    const delta = account.state.deltas.get(1)!;
    expect(delta.offdelta).toBe(saverIsLeft ? 100n : -100n);
    await expect(applyAccountTxToMutableReplica(account, tx(10_100n), !saverIsLeft, 86_402_000)).rejects.toThrow('LENDING_INTENT_REPLAY');
  });
}

test('signed savings terms survive canonical storage validation and hydration', async () => {
  const account = await funded(false);
  account.currentFrame = { ...account.currentFrame, height: 1, timestamp: 1_000,
    accountStateRoot: computeAccountStateRoot(account.state), prevFrameHash: 'genesis' };
  account.currentFrame.stateHash = computeFrameHash(account.currentFrame);
  account.currentHeight = 1;
  const doc = decodeValidatedBuffer(encodeBuffer(projectPortableAccountDoc(account)), validateStorageAccountDocValue);
  const restored = hydrateAccountDocFromStorage(doc);
  expect(computeAccountStateRoot(restored.state)).toBe(computeAccountStateRoot(account.state));
  expect(buildAccountProofBody(restored, TRANSFORMER)).toEqual(buildAccountProofBody(account, TRANSFORMER));
  const claim = restored.state.subcontracts!.get(POSITION)!;
  if (!('kind' in claim)) throw new Error('Expected signed savings covenant');
  expect(lendingExitAmount(claim, 1_000)).toBe(10_000n);
  expect(lendingExitAmount(claim, 43_201_000)).toBe(10_050n);
  expect(lendingExitAmount(claim, 86_401_000)).toBe(10_100n);
  expect(lendingExitAmount(claim, 172_801_000)).toBe(10_100n);
});

test('unsigned historical savings are rejected, never assigned fabricated authority', async () => {
  const account = await funded(true);
  account.state = { ...account.state, subcontracts: PersistentAccountStateMap.empty('subcontracts') };
  expect(() => assertAccountLendingCovenants(account.state)).toThrow('LENDING_UNSIGNED_SAVINGS_MIGRATION_REQUIRED');
  account.currentFrame = { ...account.currentFrame, height: 1, timestamp: 1_000,
    accountStateRoot: computeAccountStateRoot(account.state), prevFrameHash: 'genesis' };
  account.currentFrame.stateHash = computeFrameHash(account.currentFrame);
  account.currentHeight = 1;
  expect(() => decodeValidatedBuffer(encodeBuffer(projectPortableAccountDoc(account)), validateStorageAccountDocValue))
    .toThrow('LENDING_UNSIGNED_SAVINGS_MIGRATION_REQUIRED');
});

for (const saverIsLeft of [true, false]) {
  test(`dispute finality retires the savings claim without inventing a payout, left=${saverIsLeft}`, async () => {
    const account = await funded(saverIsLeft);
    applyAccountDisputeFinality(account, 4, [1]);
    expect(buildAccountProofBody(account, TRANSFORMER).proofBodyStruct.transformers).toHaveLength(0);
    expect(account.state.lendingIntents?.get(`dispute:${POSITION}`)).toBe('dispute-close');
    expect(account.state.lendingIntents?.has(`payout:${POSITION}`)).toBe(false);
    expect(() => assertAccountLendingCovenants(account.state)).not.toThrow();
    account.currentFrame = { ...account.currentFrame, height: 1, timestamp: 1_000,
      accountStateRoot: computeAccountStateRoot(account.state), prevFrameHash: 'genesis' };
    account.currentFrame.stateHash = computeFrameHash(account.currentFrame);
    account.currentHeight = 1;
    const doc = decodeValidatedBuffer(encodeBuffer(projectPortableAccountDoc(account)), validateStorageAccountDocValue);
    const restored = hydrateAccountDocFromStorage(doc);
    expect(computeAccountStateRoot(restored.state)).toBe(computeAccountStateRoot(account.state));
    applyAccountDisputeFinality(restored, 4, [1]);
    expect(computeAccountStateRoot(restored.state)).toBe(computeAccountStateRoot(account.state));
    expect(restored.state.lendingIntents?.get(`fund:${POSITION}`)).toBe('fund');
    expect((await applyAccountTxToMutableReplica(restored, fundTx(saverIsLeft, 100), saverIsLeft, 2_000)).ok).toBe(false);
    expect(computeAccountStateRoot(restored.state)).toBe(computeAccountStateRoot(account.state));
  });
}

test('noncanonical position ids and overflowing maturity are rejected before funding', async () => {
  for (const badId of [true, false]) {
    const account = makeAccount(LEFT, RIGHT);
    putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 20_000n, ondelta: 10_000n });
    const tx = fundTx(true, 100);
    if (tx.type !== 'lending_fund') throw new Error('Expected savings funding');
    if (badId) tx.data.positionId = 'LEND-1111111111111111';
    const before = computeAccountStateRoot(account.state);
    const result = await applyAccountTxToMutableReplica(account, tx, true, badId ? 1_000 : Number.MAX_SAFE_INTEGER);
    expect(result.ok).toBe(false);
    expect(computeAccountStateRoot(account.state)).toBe(before);
  }
});

test('savings interest cannot create unsecured bank debt above the saver credit limit', async () => {
  const account = makeAccount(LEFT, RIGHT);
  putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 10_000n, ondelta: 10_000n,
    leftCreditLimit: 0n, rightCreditLimit: 0n });
  const before = computeAccountStateRoot(account.state);
  const result = await applyAccountTxToMutableReplica(account, fundTx(true, 100), true, 1_000);
  expect(result.ok).toBe(false);
  expect(computeAccountStateRoot(account.state)).toBe(before);
});

for (const saverIsLeft of [true, false]) for (const bankCollateral of [0n, 100n, 200n]) {
  test(`savings coupon capacity matches admission and the full wallet projection, left=${saverIsLeft}, collateral=${bankCollateral}`, async () => {
    const account = makeAccount(LEFT, RIGHT);
    putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 10_000n + bankCollateral,
      ondelta: saverIsLeft ? 10_000n : bankCollateral, leftCreditLimit: 0n, rightCreditLimit: 0n });
    const risk = accountLendingRisk(account).get(1)!;
    const capacity = saverIsLeft ? risk.rightCouponCapacity : risk.leftCouponCapacity;
    expect(capacity).toBe(bankCollateral);
    expect(compactAccountDocForView(account).lendingRisk.get(1)).toEqual(risk);
    const result = await applyAccountTxToMutableReplica(account, fundTx(saverIsLeft, 100), saverIsLeft, 1_000);
    expect(result.ok).toBe(capacity >= 100n);
    if (result.ok) {
      const after = accountLendingRisk(account).get(1)!;
      expect(saverIsLeft ? after.rightCouponCapacity : after.leftCouponCapacity).toBe(capacity - 100n);
    }
  });
}

test('ordinary spending shares the unsecured limit with the bank savings obligation', async () => {
  const account = makeAccount(LEFT, RIGHT);
  putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 11_000n, ondelta: 10_000n,
    leftCreditLimit: 0n, rightCreditLimit: 0n });
  expect((await applyAccountTxToMutableReplica(account, fundTx(true, 100), true, 1_000)).ok).toBe(true);
  const before = computeAccountStateRoot(account.state);
  const payment: AccountTx = { type: 'direct_payment', data: {
    tokenId: 1, amount: 1_000n, route: [LEFT], fromEntityId: RIGHT, toEntityId: LEFT, deliveryMode: 'direct',
  } };
  const result = await applyAccountTxToMutableReplica(account, payment, false, 2_000);
  expect(result.ok).toBe(false);
  expect(computeAccountStateRoot(account.state)).toBe(before);
});

for (const saverIsLeft of [true, false]) {
  const saver = saverIsLeft ? LEFT : RIGHT;
  const bank = saverIsLeft ? RIGHT : LEFT;
  const riskAccount = (bankCapital: bigint, bankLimit: bigint) => {
    const account = makeAccount(LEFT, RIGHT);
    putTestAccountDelta(account, { ...account.state.deltas.get(1)!,
      collateral: 10_000n + bankCapital, ondelta: saverIsLeft ? 10_000n : bankCapital,
      leftCreditLimit: saverIsLeft ? 0n : bankLimit, rightCreditLimit: saverIsLeft ? bankLimit : 0n,
    });
    return account;
  };
  test(`savings collateral cannot be withdrawn or reserved twice, left=${saverIsLeft}`, async () => {
    for (const kind of ['c2r', 'swap'] as const) {
      const account = riskAccount(1_000n, 0n);
      expect((await applyAccountTxToMutableReplica(account, fundTx(saverIsLeft, 100), saverIsLeft, 1_000)).ok).toBe(true);
      const before = computeAccountStateRoot(account.state);
      const tx: AccountTx = kind === 'c2r' ? { type: 'settle_transition', data: {
        kind: 'upsert', revision: 1, executorIsLeft: !saverIsLeft,
        ops: [{ type: 'c2r', tokenId: 1, amount: 1_000n }],
      } } : { type: 'swap_offer', data: {
        offerId: 'savings-reservation', giveTokenId: 1, giveTokenDecimals: 0, giveAmount: 1_000n,
        wantTokenId: 2, wantTokenDecimals: 0, wantAmount: 1_000n, maxFee: 0n, minNetReceive: 1_000n,
      } };
      const result = await applyAccountTxToMutableReplica(account, tx, !saverIsLeft, 2_000);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected credit exposure rejection');
      expect(result.rejection.message).toContain('LENDING_CREDIT_EXPOSURE_EXCEEDED');
      expect(computeAccountStateRoot(account.state)).toBe(before);
      const valid: AccountTx = { type: 'direct_payment', data: {
        tokenId: 1, amount: 900n, route: [saver], fromEntityId: bank, toEntityId: saver, deliveryMode: 'direct',
      } };
      expect((await applyAccountTxToMutableReplica(account, valid, !saverIsLeft, 2_001)).ok).toBe(true);
    }
  });
  test(`lowering credit preserves the claim and still admits a collateral top-up, left=${saverIsLeft}`, async () => {
    const account = riskAccount(0n, 100n);
    expect((await applyAccountTxToMutableReplica(account, fundTx(saverIsLeft, 100), saverIsLeft, 1_000)).ok).toBe(true);
    const proof = buildAccountProofBody(account, TRANSFORMER).proofBodyHash;
    expect((await applyAccountTxToMutableReplica(account, { type: 'set_credit_limit', data: {
      tokenId: 1, amount: 0n,
    } }, saverIsLeft, 2_000)).ok).toBe(true);
    expect(buildAccountProofBody(account, TRANSFORMER).proofBodyHash).toBe(proof);
    const topup: AccountTx = { type: 'settle_transition', data: {
      kind: 'upsert', revision: 1, executorIsLeft: !saverIsLeft,
      ops: [{ type: 'r2c', tokenId: 1, amount: 100n }],
    } };
    const result = await applyAccountTxToMutableReplica(account, topup, !saverIsLeft, 3_000);
    expect(result.ok, result.ok ? undefined : result.rejection.message).toBe(true);
    expect(account.state.subcontracts?.has(POSITION)).toBe(true);
  });
}
