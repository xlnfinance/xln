import { expect } from 'chai';
import hre from 'hardhat';
import { Depository__factory } from '../../typechain-types/index.js';
import { deployStand, pairFor, fundGroup, type Pair, type Stand } from '../helpers/entitlement-chain.ts';
import { buildSingleSignerHanko, emptyBatch, encodeBatch } from '../helpers/hanko.ts';
import { hashDepositoryBatchHankoPayload, hashDisputeProofHankoPayload } from '../../../core/hanko/onchain-domain.ts';
import { makeAccount, putTestAccountDelta } from '../../../core/__tests__/helpers/cross-j.ts';
import { applyAccountTxToMutableReplica } from '../../../core/account/tx/apply.ts';
import { buildAccountProofBody } from '../../../core/protocol/dispute/proof-builder.ts';
import { assertLendingCovenant, lendingCovenantHash, lendingExitAmount } from '../../../core/protocol/dispute/lending-covenant.ts';
import { decodeUint768 } from '../../../core/protocol/crypto/abi-money.ts';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');

const TERM_MS = 86_400_000;

const submit = async (stand: Stand, actor: Pair['left'], batch: Record<string, unknown>) => {
  const encoded = encodeBatch(batch);
  const nonce = actor.nonce + 1n;
  const signature = buildSingleSignerHanko(actor.entityId, hashDepositoryBatchHankoPayload(stand.domain, encoded, nonce), actor.privateKey);
  const receipt = await (await stand.target.processBatch(encoded, signature, nonce, { gasLimit: 5_000_000 })).wait();
  if (!receipt || receipt.status !== 1) throw new Error('SAVINGS_BATCH_FAILED');
  actor.nonce = nonce;
  return receipt;
};

describe('signed term claims on the production Depository', function () {
  let maximumGas = 0n;
  after(() => console.log(`SAVINGS_FINALIZATION_MAX_GAS=${maximumGas}`));
  for (const kind of ['savings', 'loan'] as const) for (const creditorIsLeft of [true, false]) for (const elapsedMs of [0, TERM_MS / 2, TERM_MS, TERM_MS * 2, TERM_MS * 3]) for (const debtorCapital of [0n, 10_000n]) for (const partial of kind === 'loan' && elapsedMs >= TERM_MS / 2 ? [false, true] : [false]) {
    it(`recovers ${kind} with the debtor offline: left=${creditorIsLeft}, elapsed=${elapsedMs}, debtorCapital=${debtorCapital}, partial=${partial}`, async function () {
      const stand = await deployStand(1000n + BigInt(elapsedMs) + (creditorIsLeft ? 1n : 2n), false);
      const pair = pairFor(stand, 0);
      const creditor = creditorIsLeft ? pair.left : pair.right;
      const debtor = creditorIsLeft ? pair.right : pair.left;
      const collateral = 10_000n + debtorCapital;
      const ondelta = creditorIsLeft ? 10_000n : debtorCapital;
      await fundGroup(stand, pair, [{ tokenId: 1, state: {
        collateral, ondelta, offdelta: 0n,
        leftReserve: 0n, rightReserve: 0n, priorDebt: null,
      } }]);
      const account = makeAccount(creditor.entityId, debtor.entityId, {
        chainId: Number(stand.domain.chainId), depositoryAddress: stand.domain.depositoryAddress,
      });
      account.state.disputeConfig = { leftResponseSeconds: 1, rightResponseSeconds: 1 };
      putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral, ondelta });
      const start = (await networkHelpers.time.latest()) + 3;
      const claimId = kind === 'savings' ? 'lend-1111111111111111' : 'loan-1111111111111111';
      const authorization = {
        requestId: 'borrow-1111111111111111', hubEntityId: creditor.entityId, borrowerEntityId: debtor.entityId,
        tokenId: 1, amount: 10_000n, termId: '1d' as const, maxInterestBps: 100, maxLateMs: TERM_MS, expiresAt: start * 1000 + 1_000,
      };
      if (kind === 'loan') expect((await applyAccountTxToMutableReplica(account,
        { type: 'lending_borrow_request', data: authorization }, !creditorIsLeft, start * 1000 - elapsedMs - 1)).ok).to.equal(true);
      const funding = await applyAccountTxToMutableReplica(account, kind === 'savings' ? { type: 'lending_fund', data: {
        positionId: claimId, hubEntityId: debtor.entityId, lenderEntityId: creditor.entityId,
        tokenId: 1, amount: 10_000n, termId: '1d', interestBps: 100,
      } } : { type: 'lending_disburse', data: {
        ...authorization, loanId: claimId, interestBps: 100, lateMs: TERM_MS,
      } }, creditorIsLeft, start * 1000 - elapsedMs);
      expect(funding.ok).to.equal(true);
      if (partial) {
        const initialClaim = account.state.subcontracts!.get(claimId);
        assertLendingCovenant(initialClaim);
        // At half term, 50 interest is paid before 5,000 principal. The same
        // signed Account retains the remaining claim; no external receipt or
        // additional debtor signature is needed when its creditor exits later.
        const repayment = await applyAccountTxToMutableReplica(account, { type: 'lending_repay', data: {
          loanId: claimId, hubEntityId: creditor.entityId, borrowerEntityId: debtor.entityId,
          tokenId: 1, amount: 5_050n, claimHash: lendingCovenantHash(initialClaim),
        } }, !creditorIsLeft, start * 1000 - elapsedMs + TERM_MS / 2 + (elapsedMs >= TERM_MS ? 1_000 : 0));
        expect(repayment.ok).to.equal(true);
        const remaining = account.state.subcontracts!.get(claimId);
        assertLendingCovenant(remaining);
        expect(remaining.principal).to.equal(5_000n);
        expect(remaining.accruedInterest).to.equal(0n);
        expect(remaining.interestRemainder).to.equal(elapsedMs >= TERM_MS ? 1_000_000_000n : 0n);
      }
      const depository = Depository__factory.connect(stand.domain.depositoryAddress, (await ethers.getSigners())[0]);
      const proof = buildAccountProofBody(account, await depository.deltaTransformer());
      const debtorIsLeft = !creditorIsLeft;
      const hash = hashDisputeProofHankoPayload(stand.domain, pair.accountKey, 1n, debtorIsLeft, proof.proofBodyHash, account.state.watchSeed);
      const bankSignature = buildSingleSignerHanko(debtor.entityId, hash, debtor.privateKey);
      await networkHelpers.time.setNextBlockTimestamp(start);
      await submit(stand, creditor, emptyBatch({ disputeStarts: [{
        counterentity: debtor.entityId, nonce: 1n, proposerIsLeft: debtorIsLeft,
        proofbodyHash: proof.proofBodyHash, initialProofbody: proof.proofBodyStruct,
        watchSeed: account.state.watchSeed, sig: bankSignature,
        starterInitialArguments: '0x', starterCounterArguments: '0x', starterCounterProofCommitment: ethers.ZeroHash,
      }] }));
      const timeout = (await stand.target._accounts(pair.accountKey)).disputeTimeout;
      // Advancing EVM time tests the deterministic settlement rule; this is not
      // the separate real-clock tower drill. Delay must not add another coupon.
      await networkHelpers.time.increaseTo(Number(timeout) + 86_400);
      const finalization = emptyBatch({ disputeFinalizations: [{
        counterentity: debtor.entityId, initialNonce: 1n, finalNonce: 1n, proposerIsLeft: debtorIsLeft,
        initialProofbodyHash: proof.proofBodyHash, finalProofbody: proof.proofBodyStruct,
        starterArguments: '0x', otherArguments: '0x', sig: '0x', startedByLeft: creditorIsLeft, cooperative: false,
      }] });
      const receipt = await submit(stand, creditor, finalization);
      if (receipt.gasUsed > maximumGas) maximumGas = receipt.gasUsed;
      const claim = account.state.subcontracts!.get(claimId)!;
      if (!('kind' in claim)) throw new Error('Missing signed savings covenant');
      const cappedElapsed = Math.min(elapsedMs, TERM_MS * (kind === 'loan' ? 2 : 1));
      const due = lendingExitAmount(claim, start * 1000) + (partial ? 5_050n : 0n);
      const expectedInterest = partial
        ? 50n + 50n * BigInt(cappedElapsed - TERM_MS / 2) / BigInt(TERM_MS)
        : 100n * BigInt(cappedElapsed) / BigInt(TERM_MS);
      expect(due).to.equal(10_000n + expectedInterest);
      const paid = due > collateral ? collateral : due;
      expect(await stand.target._reserves(creditor.entityId, 1)).to.equal(paid);
      expect(await stand.target._reserves(debtor.entityId, 1)).to.equal(collateral - paid);
      expect((await stand.target._collaterals(pair.accountKey, 1)).collateral).to.equal(0n);
      expect(decodeUint768(await stand.target.debtOutstanding(debtor.entityId, 1))).to.equal(due - paid);
      expect(receipt.gasUsed).to.be.lessThan(5_000_000n);
      expect(debtor.nonce).to.equal(0n);
      await expect(submit(stand, creditor, finalization)).to.be.rejected;
      expect(await stand.target._reserves(creditor.entityId, 1)).to.equal(paid);
    });
  }
});
