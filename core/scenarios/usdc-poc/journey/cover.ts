import { deriveDelta, isLeftEntity } from '../../../account/utils';
import { accountTxFrameDigest } from '../../../account/consensus/frame/hash';
import { ACCOUNT_TX_REJECTION_CODES } from '../../../account/tx/apply-types';
import { withRuntimeCommittedRead } from '../../../runtime/frame/lifecycle/writer-lock';
import { registerRuntimeFrameCommitCallback } from '../../../runtime/loop/loop-environment';
import type { EntityTx } from '../../../types/entity-tx';
import { verifyHubCommit } from '../hub-proof';
import { send, userReplica, waitFor, type PocUser } from '../user';
import { readPocPayoutTimestamp, requirePayoutTerms } from './payout-terms';

type CoverRequest = Extract<EntityTx, { type: 'requestCollateral' }>;
export type CoverGuard = Readonly<{ validThrough: number; verifyBacking(amount: bigint): Promise<void> }>;

const readRequestOutcome = (target: PocUser, request: CoverRequest, net: bigint, policyRejected: boolean) => {
  const { counterpartyEntityId: hub, tokenId, policyVersion, feeAmount, feeTokenId } = request.data;
  const entity = userReplica(target);
  const account = entity.state.accounts.get(hub);
  const delta = account?.state.deltas.get(tokenId);
  if (!account || !delta) throw new Error('USDC_POC_COVER_ACCOUNT_MISSING');
  const fee = account.state.requestedRebalanceFeeState.get(tokenId);
  const view = deriveDelta(delta, isLeftEntity(target.entityId, hub));
  if (fee || view.outCollateral > 0n) {
    const matches = fee
      ? fee.policyVersion === policyVersion &&
        fee.requestedAmount === net &&
        fee.feePaidUpfront === feeAmount &&
        fee.feeTokenId === feeTokenId &&
        fee.requestedByLeft === isLeftEntity(target.entityId, hub)
      : view.outCollateral === net && view.outPeerCredit === 0n;
    if (!matches) throw new Error('USDC_POC_COVER_REQUEST_MISMATCH');
    return 'accepted';
  }
  if (entity.mempool.length || entity.proposal || account.pendingFrame || account.mempool.length) return null;
  if (policyRejected) return 'repricing';
  throw new Error('USDC_POC_COVER_REQUEST_NOT_COMMITTED');
};

const awaitRequestOutcome = async (target: PocUser, request: CoverRequest, net: bigint) => {
  const expected = request.data;
  const { counterpartyEntityId, ...accountData } = expected;
  const txDigest = accountTxFrameDigest({ type: 'request_collateral', data: accountData });
  let committed = false;
  let policyRejected = false;
  const result: { outcome: ReturnType<typeof readRequestOutcome> } = { outcome: null };
  const unsubscribe = registerRuntimeFrameCommitCallback(target.env, ({ runtimeInput, events }) => {
    if (
      runtimeInput.entityInputs.some(
        input =>
          input.entityId === target.entityId &&
          input.signerId === target.signerId &&
          input.entityTxs?.some(
            tx =>
              tx.type === 'requestCollateral' &&
              tx.data.counterpartyEntityId === expected.counterpartyEntityId &&
              tx.data.tokenId === expected.tokenId &&
              tx.data.feeTokenId === expected.feeTokenId &&
              tx.data.amount === expected.amount &&
              tx.data.policyVersion === expected.policyVersion &&
              tx.data.feeAmount === expected.feeAmount,
          ),
      )
    )
      committed = true;
    if (
      committed &&
      events.some(
        event =>
          event.message === ACCOUNT_TX_REJECTION_CODES.collateralPolicyVersion &&
          event.data?.['entityId'] === target.entityId &&
          event.data['counterpartyId'] === counterpartyEntityId &&
          event.data['txDigest'] === txDigest,
      )
    )
      policyRejected = true;
  });
  try {
    send(target, [request]);
    await waitFor('target-cover-request-resolved', async () => {
      if (!committed) return false;
      result.outcome = await withRuntimeCommittedRead(target.env, () =>
        readRequestOutcome(target, request, net, policyRejected),
      );
      return result.outcome !== null;
    });
    if (result.outcome === null) throw new Error('USDC_POC_COVER_OUTCOME_MISSING');
    return result.outcome;
  } finally {
    unsubscribe();
  }
};

export const requestCover = async (
  target: PocUser,
  hub: string,
  gross: bigint,
  workDir: string,
  guard?: CoverGuard,
) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tariffProof = await verifyHubCommit(target, hub, workDir);
    const account = userReplica(target).state.accounts.get(hub);
    if (!account) throw new Error('USDC_POC_COVER_ACCOUNT_MISSING');
    if (account.currentFrame.stateHash !== tariffProof.stateHash) throw new Error('USDC_POC_QUOTE_OR_TARIFF_CHANGED');
    const payout = requirePayoutTerms(
      account,
      isLeftEntity(target.entityId, hub),
      gross,
      readPocPayoutTimestamp(target.env.state.timestamp),
      guard?.validThrough,
    );
    await guard?.verifyBacking(payout.backingRequired);
    const request: CoverRequest = {
      type: 'requestCollateral',
      data: {
        counterpartyEntityId: hub,
        tokenId: 1,
        amount: gross,
        feeTokenId: 1,
        feeAmount: payout.fee,
        policyVersion: payout.policy.policyVersion,
      },
    };
    // A stale request is evicted by Account before it can debit a fee. Wait for
    // that exact result before trying the new version. A delayed ACK or an
    // existing cover must never cause us to request a second debit.
    if ((await awaitRequestOutcome(target, request, payout.net)) === 'accepted') return { ...payout, tariffProof };
    console.log(`USDC_POC_COVER_TARIFF_STALE:${payout.policy.policyVersion}`);
  }
  throw new Error('USDC_POC_COVER_TARIFF_CHANGED');
};
