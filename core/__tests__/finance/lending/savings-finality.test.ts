import { expect, test } from 'bun:test';
import { authorizeTestLending } from '../lending/bank-policy-fixture';
import { createEmptyEnv } from '../../../runtime';
import { addReplica, addr, entity, getTestAccountForWrite, installJurisdictions, makeAccount, makeJurisdiction, makeState, openWritableEntityAccounts, putTestAccountDelta, registerTestSigner } from '../../helpers/cross-j';
import { applyJEventRange } from '../../helpers/j-history';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { applyCommittedLendingFollowup } from '../../../lendbook/committed';
import { buildAccountProofBody } from '../../../protocol/dispute/proof-builder';
import { getJEventJurisdictionRef } from '../../../jurisdiction/machine/event-observation';
import { summarizeLendingState } from '../../../lendbook/state';
import type { AccountTx } from '../../../types/account';
import type { AccountTxTarget } from '../../../entity/tx/handlers/account/orderbook/queue';
import { settleOverdueLendingLoan } from '../../../lendbook/lifecycle';

for (const saverIsLeft of [true, false]) for (const overdue of [false, true]) {
  test(`authenticated DisputeFinalized retires both bank claims, left=${saverIsLeft}, overdue=${overdue}`, async () => {
    const seed = `savings-finality-${saverIsLeft}`;
    const env = createEmptyEnv(seed);
    const signer = registerTestSigner(env, seed);
    const saver = entity(saverIsLeft ? '11' : '22');
    const bank = entity(saverIsLeft ? '22' : '11');
    const jurisdiction = makeJurisdiction('savings-finality', 31_337, 'dd', 'ee');
    installJurisdictions(env, jurisdiction);
    const state = makeState(bank, signer, jurisdiction, saver);
    state.profile = { name: 'Bank', isHub: true, avatar: '', bio: '', website: '' };
    addReplica(env, state, signer);
    const account = getTestAccountForWrite(state, saver);
    putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 20_000n, ondelta: 10_000n });
    const positionId = 'lend-1111111111111111';
    const tx: AccountTx = { type: 'lending_fund', data: {
      positionId, hubEntityId: bank, lenderEntityId: saver, tokenId: 1,
      amount: 10_000n, interestBps: 100, termId: '1d',
    } };
    expect((await applyAccountTxToMutableReplica(account, tx, saverIsLeft, state.timestamp)).ok).toBe(true);
    applyCommittedLendingFollowup(state, saver, tx, { ...account.currentFrame, accountTxs: [tx] }, saverIsLeft, []);
    const borrower = entity('33');
    const borrowerAccount = makeAccount(bank, borrower);
    putTestAccountDelta(borrowerAccount, { ...borrowerAccount.state.deltas.get(1)!, collateral: 20_000n, ondelta: 20_000n });
    openWritableEntityAccounts(state).set(borrower, borrowerAccount);
    authorizeTestLending(state, borrower);
    const borrow: AccountTx = { type: 'lending_borrow_request', data: {
      requestId: 'borrow-2222222222222222', hubEntityId: bank, borrowerEntityId: borrower,
      tokenId: 1, amount: 2_500n, termId: '1d', maxInterestBps: 100, maxLateMs: 0, expiresAt: 9_000_000_000_000,
    } };
    expect((await applyAccountTxToMutableReplica(borrowerAccount, borrow, false, state.timestamp)).ok).toBe(true);
    const followups: AccountTxTarget[] = [];
    applyCommittedLendingFollowup(state, borrower, borrow, { ...borrowerAccount.currentFrame, accountTxs: [borrow] }, false, followups);
    const disburse = followups[0]?.tx;
    if (!disburse || disburse.type !== 'lending_disburse') throw new Error('Expected funded loan disbursement');
    expect((await applyAccountTxToMutableReplica(borrowerAccount, disburse, true, state.timestamp)).ok).toBe(true);
    applyCommittedLendingFollowup(state, borrower, disburse, { ...borrowerAccount.currentFrame, accountTxs: [disburse] }, true, []);
    const proof = buildAccountProofBody(account, addr('99'));
    expect(state.lending?.savings.get(positionId)?.principalAmount).toBe(10_000n);
    const result = await applyJEventRange(state, {
      from: signer, jurisdictionRef: getJEventJurisdictionRef(jurisdiction),
      blockNumber: 22, blockHash: entity('aa'), observedAt: 22, transactionHash: entity('bb'),
      event: { type: 'DisputeFinalized', data: {
        sender: saver, counterentity: bank, initialNonce: '7',
        initialProofbodyHash: proof.proofBodyHash, finalProofbodyHash: proof.proofBodyHash,
        finalizationEvidenceHash: entity('00'), finalProofbody: proof.proofBodyStruct,
      } },
    }, env);
    expect(result.newState.lending?.savings.get(positionId)).toMatchObject({ status: 'disputed', principalAmount: 10_000n });
    expect(result.newState.reserves).toEqual(state.reserves);
    expect(summarizeLendingState(result.newState).totals.savingsPrincipalAmount).toBe('0');
    expect(summarizeLendingState(result.newState).totals.loanPrincipalAmount).toBe('2500');
    expect(result.newState.accounts.get(saver)?.state.subcontracts?.size).toBe(0);
    expect(result.newState.accounts.get(saver)?.state.lendingIntents?.has(`payout:${positionId}`)).toBe(false);
    expect(state.lending?.savings.get(positionId)?.status).toBe('open');
    expect(result.newState.lending?.loans.get(disburse.data.loanId)).toEqual(state.lending?.loans.get(disburse.data.loanId));
    if (overdue) {
      result.newState.timestamp += 86_400_001;
      settleOverdueLendingLoan(result.newState, disburse.data.loanId, []);
    }
    expect(result.newState.lending?.loans.get(disburse.data.loanId)).toMatchObject({ status: overdue ? 'defaulted' : 'active', repaymentAmount: 2_525n, repaidAmount: 0n });
    const borrowerProof = buildAccountProofBody(result.newState.accounts.get(borrower)!, addr('99'));
    const finalized = await applyJEventRange(result.newState, {
      from: signer, jurisdictionRef: getJEventJurisdictionRef(jurisdiction),
      blockNumber: 23, blockHash: entity('cc'), observedAt: 23, transactionHash: entity('dd'),
      event: { type: 'DisputeFinalized', data: {
        sender: bank, counterentity: borrower, initialNonce: '8',
        initialProofbodyHash: borrowerProof.proofBodyHash, finalProofbodyHash: borrowerProof.proofBodyHash,
        finalizationEvidenceHash: entity('00'), finalProofbody: borrowerProof.proofBodyStruct,
      } },
    }, env);
    expect(finalized.newState.lending?.loans.get(disburse.data.loanId)).toMatchObject({ status: 'disputed', repaymentAmount: 2_525n, repaidAmount: 0n });
    expect(finalized.newState.lending?.savings.get(positionId)).toMatchObject({ status: 'disputed', principalAmount: 10_000n });
    expect(finalized.newState.accounts.get(borrower)?.state.subcontracts?.size).toBe(0);
    expect(finalized.newState.accounts.get(borrower)?.state.lendingIntents?.has(`repay:${disburse.data.loanId}`)).toBe(false);
    expect(finalized.newState.reserves).toEqual(state.reserves);
  });
}

test.each([true, false])('borrower J finality releases an undisbursed reservation without inventing repayment, bank left=%s', async bankIsLeft => {
  const seed = `opening-loan-finality-${bankIsLeft}`;
  const env = createEmptyEnv(seed);
  const signer = registerTestSigner(env, seed);
  const bank = entity(bankIsLeft ? '11' : '44');
  const saver = entity('22');
  const borrower = entity('33');
  const jurisdiction = makeJurisdiction('opening-finality', 31_337, 'dd', 'ee');
  installJurisdictions(env, jurisdiction);
  const state = makeState(bank, signer, jurisdiction, saver);
  state.profile = { name: 'Bank', isHub: true, avatar: '', bio: '', website: '' };
  addReplica(env, state, signer);
  const saverAccount = getTestAccountForWrite(state, saver);
  putTestAccountDelta(saverAccount, { ...saverAccount.state.deltas.get(1)!, collateral: 20_000n, ondelta: 10_000n });
  const positionId = 'lend-1111111111111111';
  const fund: AccountTx = { type: 'lending_fund', data: {
    positionId, hubEntityId: bank, lenderEntityId: saver, tokenId: 1,
    amount: 10_000n, interestBps: 100, termId: '1d',
  } };
  expect((await applyAccountTxToMutableReplica(saverAccount, fund, !bankIsLeft, state.timestamp)).ok).toBe(true);
  applyCommittedLendingFollowup(state, saver, fund, { ...saverAccount.currentFrame, accountTxs: [fund] }, !bankIsLeft, []);
  const borrowerAccount = makeAccount(bank, borrower);
  openWritableEntityAccounts(state).set(borrower, borrowerAccount);
  authorizeTestLending(state, borrower);
  const borrow: AccountTx = { type: 'lending_borrow_request', data: {
    requestId: 'borrow-2222222222222222', hubEntityId: bank, borrowerEntityId: borrower,
    tokenId: 1, amount: 2_500n, termId: '1d', maxInterestBps: 100, maxLateMs: 0, expiresAt: 9_000_000_000_000,
  } };
  expect((await applyAccountTxToMutableReplica(borrowerAccount, borrow, !bankIsLeft, state.timestamp)).ok).toBe(true);
  const outputs: AccountTxTarget[] = [];
  applyCommittedLendingFollowup(state, borrower, borrow, { ...borrowerAccount.currentFrame, accountTxs: [borrow] }, !bankIsLeft, outputs);
  const disburse = outputs[0]?.tx;
  if (!disburse || disburse.type !== 'lending_disburse') throw new Error('Expected pending loan');
  expect(state.lending?.loans.get(disburse.data.loanId)?.status).toBe('opening');
  expect(borrowerAccount.state.subcontracts?.size ?? 0).toBe(0);
  const proof = buildAccountProofBody(borrowerAccount, addr('99'));
  const finality = {
    from: signer, jurisdictionRef: getJEventJurisdictionRef(jurisdiction),
    blockNumber: 22, blockHash: entity('aa'), observedAt: 22, transactionHash: entity('bb'),
    event: { type: 'DisputeFinalized' as const, data: {
      sender: bank, counterentity: borrower, initialNonce: '7',
      initialProofbodyHash: proof.proofBodyHash, finalProofbodyHash: proof.proofBodyHash,
      finalizationEvidenceHash: entity('00'), finalProofbody: proof.proofBodyStruct,
    } },
  };
  const { newState } = await applyJEventRange(state, finality, env);
  expect(newState.lending?.loans.get(disburse.data.loanId)).toMatchObject({ status: 'disputed', repaidAmount: 0n });
  expect(newState.lending?.savings.get(positionId)).toMatchObject({ status: 'open', principalAmount: 10_000n });
  expect(newState.accounts.get(saver)?.state.subcontracts?.has(positionId)).toBe(true);
  expect(newState.accounts.get(borrower)?.state.lendingIntents?.has(`repay:${disburse.data.loanId}`)).toBe(false);
  expect(newState.reserves).toEqual(state.reserves);
  expect(state.lending?.loans.get(disburse.data.loanId)?.status).toBe('opening');
});
