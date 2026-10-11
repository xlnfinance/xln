import { expect, test } from 'bun:test';
import { entity, makeAccount, putTestAccountDelta } from '../../helpers/cross-j';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { computeFrameHash } from '../../../account/consensus/frame/hash';
import { buildAccountProofBody } from '../../../protocol/dispute/proof-builder';
import { applyAccountDisputeFinality } from '../../../account/settlement/j-finality';
import { encodeBuffer, decodeValidatedBuffer } from '../../../storage/codec/codec';
import { projectPortableAccountDoc, hydrateAccountDocFromStorage } from '../../../storage/read/projections';
import { validateStorageAccountDocValue } from '../../../storage/schema/authoritative-schema';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { assertLendingCovenant, lendingCovenantHash, lendingExitAmount } from '../../../protocol/dispute/lending-covenant';
import type { AccountReplica, AccountTx } from '../../../types/account';
import { decodeAccountTx } from '../../../account/tx-validation';

const LEFT = entity('11');
const RIGHT = entity('22');
const ID = 'loan-1111111111111111';
const TRANSFORMER = `0x${'33'.repeat(20)}`;
test('signed late interest accrues simply, stops at its cap and never compounds', () => {
  const claim = { kind: 'loan' as const, tokenId: 1, creditorIsLeft: true,
    principal: 10_000n, interestBps: 100, openedAt: 1_000, accruedAt: 1_000, accruedInterest: 0n, interestRemainder: 0n, termMs: 10_000, lateMs: 20_000 };
  expect(lendingExitAmount(claim, 1_000)).toBe(10_000n);
  expect(lendingExitAmount(claim, 6_000)).toBe(10_050n);
  expect(lendingExitAmount(claim, 11_000)).toBe(10_100n);
  expect(lendingExitAmount(claim, 16_000)).toBe(10_150n);
  expect(lendingExitAmount(claim, 31_000)).toBe(10_300n);
  expect(lendingExitAmount(claim, 1_000_000)).toBe(10_300n);
});
const draw = (bankIsLeft: boolean, interestBps = 100, lateMs = 0): Extract<AccountTx, { type: 'lending_disburse' }> => ({ type: 'lending_disburse', data: {
  loanId: ID, hubEntityId: bankIsLeft ? LEFT : RIGHT, borrowerEntityId: bankIsLeft ? RIGHT : LEFT,
  tokenId: 1, amount: 2_500n, termId: '1d', interestBps,
  requestId: 'borrow-1111111111111111', maxInterestBps: interestBps, maxLateMs: lateMs, lateMs, expiresAt: 60_000,
} });
test('peer ingress admits the exact signed late terms and rejects missing terms', () => {
  const disburse = draw(true, 100, 86_400_000);
  expect(decodeAccountTx(disburse, 'PEER')).toEqual(disburse);
  const { loanId, interestBps, lateMs, ...data } = disburse.data;
  expect(loanId).toBe(ID);
  expect(interestBps).toBe(100);
  expect(lateMs).toBe(86_400_000);
  const borrow = { type: 'lending_borrow_request', data };
  expect(decodeAccountTx(borrow, 'PEER')).toEqual(borrow);
  const { maxLateMs, ...unsigned } = data;
  expect(maxLateMs).toBe(lateMs);
  expect(() => decodeAccountTx({ ...borrow, data: unsigned }, 'PEER')).toThrow('missing=maxLateMs');
});
const request = async (account: AccountReplica, bankIsLeft: boolean, interestBps = 100, windowMs = 0) => {
  const { loanId, interestBps: coupon, lateMs, ...data } = draw(bankIsLeft, interestBps, windowMs).data;
  expect(loanId).toBe(ID);
  expect(coupon).toBe(interestBps);
  expect(lateMs).toBe(windowMs);
  expect((await applyAccountTxToMutableReplica(account, { type: 'lending_borrow_request', data }, !bankIsLeft, 999)).ok).toBe(true);
};
const funded = async (bankIsLeft: boolean, interestBps = 100, lateMs = 0) => {
  const account = makeAccount(LEFT, RIGHT);
  putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 20_000n, ondelta: 10_000n });
  await request(account, bankIsLeft, interestBps, lateMs);
  expect((await applyAccountTxToMutableReplica(account, draw(bankIsLeft, interestBps, lateMs), bankIsLeft, 1_000)).ok).toBe(true);
  return account;
};
const restore = (account: AccountReplica) => {
  account.currentFrame = { ...account.currentFrame, height: 1, timestamp: 1_000,
    accountStateRoot: computeAccountStateRoot(account.state), prevFrameHash: 'genesis' };
  account.currentFrame.stateHash = computeFrameHash(account.currentFrame);
  account.currentHeight = 1;
  return hydrateAccountDocFromStorage(decodeValidatedBuffer(encodeBuffer(projectPortableAccountDoc(account)), validateStorageAccountDocValue));
};

test('a bank cannot create coupon debt without the borrower requesting that loan', async () => {
  const account = makeAccount(LEFT, RIGHT);
  putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 20_000n, ondelta: 10_000n });
  const before = computeAccountStateRoot(account.state);
  const result = await applyAccountTxToMutableReplica(account, draw(true), true, 1_000);
  expect(result.ok).toBe(false);
  expect(computeAccountStateRoot(account.state)).toBe(before);
});

test('lending_disburse binds different returns into different executable borrower claims', async () => {
  const a = await funded(true, 100);
  const b = await funded(true, 200);
  expect(computeAccountStateRoot(a.state)).not.toBe(computeAccountStateRoot(b.state));
  expect(buildAccountProofBody(a, TRANSFORMER).proofBodyHash).not.toBe(buildAccountProofBody(b, TRANSFORMER).proofBodyHash);
  expect(a.state.deltas.get(1)?.offdelta).toBe(-2_500n);
  expect(b.state.deltas.get(1)?.offdelta).toBe(-2_500n);
});

for (const bankIsLeft of [true, false]) {
  test(`partial repayment pays interest first and accrues only on remaining principal, bankLeft=${bankIsLeft}`, async () => {
    const account = restore(await funded(bankIsLeft, 200));
    const initial = account.state.subcontracts?.get(ID);
    assertLendingCovenant(initial);
    const at = initial.openedAt + initial.termMs / 2;
    const partial: AccountTx = { type: 'lending_repay', data: {
      loanId: ID, hubEntityId: bankIsLeft ? LEFT : RIGHT, borrowerEntityId: bankIsLeft ? RIGHT : LEFT,
      tokenId: 1, amount: 1_025n, claimHash: lendingCovenantHash(initial),
    } };
    expect((await applyAccountTxToMutableReplica(account, partial, !bankIsLeft, at)).ok).toBe(true);
    const outstanding = account.state.subcontracts?.get(ID);
    assertLendingCovenant(outstanding);
    expect(outstanding.principal).toBe(1_500n);
    expect(lendingExitAmount(outstanding, at)).toBe(1_500n);
    expect(lendingExitAmount(outstanding, at + initial.termMs / 4)).toBe(1_507n);
    expect(lendingExitAmount(outstanding, initial.openedAt + initial.termMs)).toBe(1_515n);
    expect(account.state.deltas.get(1)?.offdelta).toBe(bankIsLeft ? -1_475n : 1_475n);
    expect(account.state.lendingIntents?.has(`repay:${ID}`)).toBe(false);
    expect(computeAccountStateRoot(restore(account).state)).toBe(computeAccountStateRoot(account.state));
    const after = computeAccountStateRoot(account.state);
    expect((await applyAccountTxToMutableReplica(account, partial, !bankIsLeft, at + 1)).ok).toBe(false);
    expect(computeAccountStateRoot(account.state)).toBe(after);
  });
  test(`early repayment charges the same earned interest as unilateral exit, bankLeft=${bankIsLeft}`, async () => {
    const account = restore(await funded(bankIsLeft, 200));
    const claim = account.state.subcontracts?.get(ID);
    assertLendingCovenant(claim);
    const at = claim.openedAt + claim.termMs / 2;
    expect(lendingExitAmount(claim, at)).toBe(2_525n);
    const repay: AccountTx = { type: 'lending_repay', data: {
      loanId: ID, hubEntityId: bankIsLeft ? LEFT : RIGHT, borrowerEntityId: bankIsLeft ? RIGHT : LEFT,
      tokenId: 1, amount: 2_550n, claimHash: lendingCovenantHash(claim),
    } };
    expect((await applyAccountTxToMutableReplica(account, repay, !bankIsLeft, at)).ok).toBe(true);
    expect(account.state.deltas.get(1)?.offdelta).toBe(bankIsLeft ? 25n : -25n);
    expect(account.state.subcontracts?.size).toBe(0);
    expect(computeAccountStateRoot(restore(account).state)).toBe(computeAccountStateRoot(account.state));
    await expect(applyAccountTxToMutableReplica(account, repay, !bankIsLeft, at + 1)).rejects.toThrow('LENDING_INTENT_REPLAY');
  });
  test(`loan repayment consumes one exact claim and survives recovery, bankLeft=${bankIsLeft}`, async () => {
    const account = await funded(bankIsLeft);
    const restored = restore(account);
    expect(buildAccountProofBody(restored, TRANSFORMER)).toEqual(buildAccountProofBody(account, TRANSFORMER));
    const before = computeAccountStateRoot(restored.state);
    const claim = restored.state.subcontracts?.get(ID);
    assertLendingCovenant(claim);
    const repay = (amount: bigint): AccountTx => ({ type: 'lending_repay', data: {
      loanId: ID, hubEntityId: bankIsLeft ? LEFT : RIGHT, borrowerEntityId: bankIsLeft ? RIGHT : LEFT,
      tokenId: 1, amount, claimHash: lendingCovenantHash(claim),
    } });
    const forged = repay(1n);
    if (forged.type !== 'lending_repay') throw new Error('Expected repayment');
    forged.data.claimHash = `0x${'00'.repeat(32)}`;
    expect((await applyAccountTxToMutableReplica(restored, forged, !bankIsLeft, 2_000)).ok).toBe(false);
    expect(computeAccountStateRoot(restored.state)).toBe(before);
    expect((await applyAccountTxToMutableReplica(restored, repay(2_525n), !bankIsLeft, 86_401_000)).ok).toBe(true);
    expect(restored.state.subcontracts?.size).toBe(0);
    expect(restored.state.deltas.get(1)?.offdelta).toBe(bankIsLeft ? 25n : -25n);
    expect(buildAccountProofBody(restored, TRANSFORMER).proofBodyStruct.transformers).toHaveLength(0);
    expect(computeAccountStateRoot(restore(restored).state)).toBe(computeAccountStateRoot(restored.state));
    await expect(applyAccountTxToMutableReplica(restored, repay(2_525n), !bankIsLeft, 86_402_000)).rejects.toThrow('LENDING_INTENT_REPLAY');
  });
  test(`on-chain loan finality cannot resurrect a receivable after recovery, bankLeft=${bankIsLeft}`, async () => {
    const account = await funded(bankIsLeft);
    applyAccountDisputeFinality(account, 4, [1]);
    const restored = restore(account);
    expect(restored.state.subcontracts?.size).toBe(0);
    expect(restored.state.lendingIntents?.get(`dispute:${ID}`)).toBe('dispute-close');
    expect(restored.state.lendingIntents?.has(`repay:${ID}`)).toBe(false);
    expect(computeAccountStateRoot(restored.state)).toBe(computeAccountStateRoot(account.state));
  });
  test(`first loan coupon cannot exceed the bank's accepted unsecured risk, bankLeft=${bankIsLeft}`, async () => {
    const account = makeAccount(LEFT, RIGHT);
    putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 10_000n,
      ondelta: bankIsLeft ? 10_000n : 0n, leftCreditLimit: 0n, rightCreditLimit: 0n });
    await request(account, bankIsLeft);
    const before = computeAccountStateRoot(account.state);
    const result = await applyAccountTxToMutableReplica(account, draw(bankIsLeft), bankIsLeft, 1_000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected risk rejection');
    expect(result.rejection.message).toContain('LENDING_CREDIT_EXPOSURE_EXCEEDED');
    expect(computeAccountStateRoot(account.state)).toBe(before);
  });
}

for (const bankIsLeft of [true, false]) {
  test(`borrower authority survives restore, binds terms and funds exactly once, bankLeft=${bankIsLeft}`, async () => {
    const initial = makeAccount(LEFT, RIGHT);
    putTestAccountDelta(initial, { ...initial.state.deltas.get(1)!, collateral: 20_000n, ondelta: 10_000n });
    await request(initial, bankIsLeft, 200);
    const account = restore(initial);
    const before = computeAccountStateRoot(account.state);
    const authorized = draw(bankIsLeft, 200);
    for (const change of [{ amount: 2_501n }, { termId: '1h' as const }, { maxInterestBps: 201 },
      { interestBps: 201 }, { maxLateMs: 1 }, { lateMs: 1 }, { expiresAt: 60_001 }, { requestId: 'borrow-2222222222222222' }]) {
      expect((await applyAccountTxToMutableReplica(account, { ...authorized, data: { ...authorized.data, ...change } }, bankIsLeft, 1_000)).ok).toBe(false);
      expect(computeAccountStateRoot(account.state)).toBe(before);
    }
    expect((await applyAccountTxToMutableReplica(account, authorized, bankIsLeft, 60_000)).ok).toBe(false);
    expect(computeAccountStateRoot(account.state)).toBe(before);
    // A lower bank rate remains within the signed maximum. Principal and term are exact.
    expect((await applyAccountTxToMutableReplica(account, { ...authorized, data: { ...authorized.data, interestBps: 100 } }, bankIsLeft, 1_000)).ok).toBe(true);
    const fundedRoot = computeAccountStateRoot(account.state);
    expect((await applyAccountTxToMutableReplica(account, { ...authorized, data: { ...authorized.data, loanId: 'loan-2222222222222222' } }, bankIsLeft, 1_001)).ok).toBe(false);
    expect(computeAccountStateRoot(account.state)).toBe(fundedRoot);
    const settled = restore(initial);
    applyAccountDisputeFinality(settled, 4, [1]);
    const settledRoot = computeAccountStateRoot(settled.state);
    expect((await applyAccountTxToMutableReplica(settled, authorized, bankIsLeft, 1_000)).ok).toBe(false);
    expect(computeAccountStateRoot(settled.state)).toBe(settledRoot);
  });
}

test('unsigned historical borrower obligations fail restore rather than gain fabricated signatures', async () => {
  const account = await funded(true);
  account.state.subcontracts = PersistentAccountStateMap.empty('subcontracts');
  expect(() => restore(account)).toThrow('LENDING_UNSIGNED_LOAN_MIGRATION_REQUIRED');
});

test('late terms are committed and missing historical terms reject cold restore', async () => {
  const zero = await funded(true);
  const late = await funded(true, 100, 86_400_000);
  expect(computeAccountStateRoot(zero.state)).not.toBe(computeAccountStateRoot(late.state));
  expect(buildAccountProofBody(zero, TRANSFORMER).proofBodyHash).not.toBe(buildAccountProofBody(late, TRANSFORMER).proofBodyHash);
  const claim = late.state.subcontracts?.get(ID);
  assertLendingCovenant(claim);
  const { lateMs, ...unsigned } = claim;
  expect(lateMs).toBe(86_400_000);
  const doc = projectPortableAccountDoc(late);
  const old = { ...doc, state: { ...doc.state, subcontracts: new Map([[ID, unsigned]]) } };
  expect(() => decodeValidatedBuffer(encodeBuffer(old), validateStorageAccountDocValue)).toThrow('LENDING_COVENANT_FIELDS');
  expect(() => assertLendingCovenant({ ...claim, lateMs: Number.MAX_SAFE_INTEGER })).toThrow('LENDING_COVENANT_MATURITY');
  expect(() => assertLendingCovenant({ ...claim, principal: (1n << 256n) - 26n })).toThrow('LENDING_COVENANT_AMOUNT');
  expect(() => assertLendingCovenant({ ...claim, kind: 'savings' })).toThrow('LENDING_SAVINGS_LATE_INTEREST');
});

for (const bankIsLeft of [true, false]) {
  test(`late repayment after restore debits the committed quote, not its maximum, bankLeft=${bankIsLeft}`, async () => {
    const original = await funded(bankIsLeft, 100, 2 * 86_400_000);
    const account = restore(original);
    expect(buildAccountProofBody(account, TRANSFORMER)).toEqual(buildAccountProofBody(original, TRANSFORMER));
    const at = 1_000 + 86_400_000 * 3 / 2;
    const claim = account.state.subcontracts?.get(ID);
    assertLendingCovenant(claim);
    const repay: AccountTx = { type: 'lending_repay', data: { loanId: ID,
      hubEntityId: bankIsLeft ? LEFT : RIGHT, borrowerEntityId: bankIsLeft ? RIGHT : LEFT, tokenId: 1, amount: 2_575n, claimHash: lendingCovenantHash(claim) } };
    const root = computeAccountStateRoot(account.state);
    expect((await applyAccountTxToMutableReplica(account, { ...repay, data: { ...repay.data, claimHash: `0x${'00'.repeat(32)}` } }, !bankIsLeft, at)).ok).toBe(false);
    expect(computeAccountStateRoot(account.state)).toBe(root);
    expect((await applyAccountTxToMutableReplica(account, repay, !bankIsLeft, at)).ok).toBe(true);
    expect(account.state.deltas.get(1)?.offdelta).toBe(bankIsLeft ? 37n : -37n);
    expect(account.state.subcontracts?.size).toBe(0);
    expect(computeAccountStateRoot(restore(account).state)).toBe(computeAccountStateRoot(account.state));
    await expect(applyAccountTxToMutableReplica(account, repay, !bankIsLeft, at + 1)).rejects.toThrow('LENDING_INTENT_REPLAY');
  });
  test(`loan admission reserves all authorized late interest, bankLeft=${bankIsLeft}`, async () => {
    const account = makeAccount(LEFT, RIGHT);
    putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 10_000n,
      ondelta: bankIsLeft ? 10_000n : 0n, leftCreditLimit: 25n, rightCreditLimit: 25n });
    await request(account, bankIsLeft, 100, 86_400_000);
    const root = computeAccountStateRoot(account.state);
    const rejected = await applyAccountTxToMutableReplica(account, draw(bankIsLeft, 100, 86_400_000), bankIsLeft, 1_000);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('Expected full late-interest reservation');
    expect(rejected.rejection.message).toContain('LENDING_CREDIT_EXPOSURE_EXCEEDED');
    expect(computeAccountStateRoot(account.state)).toBe(root);
    putTestAccountDelta(account, { ...account.state.deltas.get(1)!, leftCreditLimit: 50n, rightCreditLimit: 50n });
    expect((await applyAccountTxToMutableReplica(account, draw(bankIsLeft, 100, 86_400_000), bankIsLeft, 1_000)).ok).toBe(true);
  });
}
