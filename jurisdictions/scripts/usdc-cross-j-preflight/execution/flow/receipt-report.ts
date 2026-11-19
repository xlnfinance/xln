import { Transaction } from 'ethers';
import { ERC20Mock__factory } from '../../../../typechain-types';
import { decodeJBatch } from '../../../../../core/jurisdiction/machine/batch';
import { getCrossJurisdictionRouteRemainingAmounts } from '../../../../../core/extensions/cross-j/orderbook';
import { targetUser } from '../../../../../core/scenarios/usdc-poc/journey/context';
import { userReplica, type PocUser } from '../../../../../core/scenarios/usdc-poc/user';
import { verifyHubCommit } from '../../../../../core/scenarios/usdc-poc/hub-proof';
import { buildIngressEvidence, receiptFields } from '../../../../../core/scenarios/usdc-poc/evidence';
import {
  buildTargetReceiptEvidence,
  requireTokenTransfer,
} from '../../../../../core/scenarios/usdc-poc/target-evidence';
import { readNonceReceipt } from '../nonce-receipt';
import { verifyBatchReceipt } from '../receipt-event';
import { validateAuthorizedWire } from '../calls';
import type { ChainAuthority, ExecutionAuthority, PayerGrant } from '../authority';
import type { ExecutionProviders } from '../providers';

const readAuthorizedReceipt = async (
  authority: ExecutionAuthority,
  providers: ExecutionProviders,
  chain: ChainAuthority,
  payer: PayerGrant,
  nonce: number,
) => {
  const entry = await readNonceReceipt(providers, chain, payer, nonce);
  if (!entry) throw new Error(`USDC_EXECUTION_RUN_RECEIPT_MISSING:${chain.chainId}:${payer.role}:${nonce}`);
  const { transaction, receipt } = entry;
  const wire = validateAuthorizedWire(authority, chain, Transaction.from(transaction).serialized);
  if (
    wire.payer.address !== payer.address ||
    wire.transaction.nonce !== nonce ||
    wire.transaction.hash !== transaction.hash ||
    receipt.hash !== transaction.hash ||
    receipt.from.toLowerCase() !== payer.address ||
    receipt.to?.toLowerCase() !== wire.transaction.to?.toLowerCase() ||
    receipt.blockHash !== transaction.blockHash ||
    receipt.blockNumber !== transaction.blockNumber
  )
    throw new Error(`USDC_EXECUTION_RUN_RECEIPT_MISMATCH:${receipt.hash}`);
  if (wire.batch) verifyBatchReceipt(chain, receipt, wire.batch);
  return { ...entry, batch: wire.batch };
};

export const reportCompletedRun = async (
  user: PocUser,
  authority: ExecutionAuthority,
  runIndex: number,
  sourceProvider: ExecutionProviders,
  targetProvider: ExecutionProviders,
) => {
  const source = authority.chains[0]!,
    targetChain = authority.chains[1]!;
  const sourcePayer = source.payers.find(payer => payer.role === 'source-user')!;
  const exitPayer = targetChain.payers.find(payer => payer.role === 'target-user')!;
  const hubPayer = targetChain.payers.find(payer => payer.role === 'target-hub')!;
  const nonce = sourcePayer.firstNonce + runIndex * 3;
  const [approval, deposit, collateral, cover, exit] = await Promise.all([
    readAuthorizedReceipt(authority, sourceProvider, source, sourcePayer, nonce),
    readAuthorizedReceipt(authority, sourceProvider, source, sourcePayer, nonce + 1),
    readAuthorizedReceipt(authority, sourceProvider, source, sourcePayer, nonce + 2),
    readAuthorizedReceipt(authority, targetProvider, targetChain, hubPayer, hubPayer.firstNonce + runIndex),
    readAuthorizedReceipt(authority, targetProvider, targetChain, exitPayer, exitPayer.firstNonce + runIndex),
  ]);
  const route = userReplica(user).state.crossJurisdictionSwaps?.get(user.orderId);
  const remaining = route && getCrossJurisdictionRouteRemainingAmounts(route);
  if (
    !route ||
    route.status !== 'settled' ||
    route.source.amount !== 1_000_000n ||
    !remaining ||
    remaining.sourceRemaining !== 0n ||
    remaining.targetRemaining !== 0n
  )
    throw new Error('USDC_EXECUTION_RUN_NOT_FULLY_SETTLED');
  if (!cover.batch || !exit.batch) throw new Error('USDC_EXECUTION_RUN_TARGET_BATCH_MISSING');
  const paid = decodeJBatch(exit.batch.encoded).reserveToExternalToken[0]!.amount;
  if (
    decodeJBatch(cover.batch.encoded).reserveToCollateral[0]!.pairs[0]!.amount !== paid ||
    paid < 850_000n ||
    1_000_000n - paid > 150_000n ||
    paid > route.target.amount
  )
    throw new Error('USDC_EXECUTION_RUN_ECONOMICS_MISMATCH');
  const target = targetUser(user, authority.apiBase);
  requireTokenTransfer(
    { receipts: [receiptFields(deposit)] },
    { token: source.token, from: sourcePayer.address, to: source.depository, amount: route.source.amount },
  );
  const transfers = requireTokenTransfer(
    { receipts: [receiptFields(exit)] },
    { token: targetChain.token, from: targetChain.depository, to: target.signerId, amount: paid },
  );
  const first = cover.receipt.blockNumber;
  const last = exit.receipt.blockNumber;
  const token = ERC20Mock__factory.connect(targetChain.token, targetProvider.historical);
  const [before, after, ingress, evidence] = await Promise.all([
    token.balanceOf(target.signerId, { blockTag: first - 1 }),
    token.balanceOf(target.signerId, { blockTag: last }),
    buildIngressEvidence(
      sourceProvider.historical,
      [approval, deposit, collateral],
      approval.receipt.blockNumber,
      collateral.receipt.blockNumber,
    ),
    buildTargetReceiptEvidence(targetProvider.historical, [cover, exit], first, last),
  ]);
  if (after - before !== paid) throw new Error('USDC_EXECUTION_RUN_PAYOUT_DELTA_MISMATCH');
  return {
    status: 'complete',
    runId: user.runId,
    orderId: user.orderId,
    sourceAmount: route.source.amount,
    grossTargetAmount: route.target.amount,
    paid,
    fee: route.target.amount - paid,
    recipient: target.signerId,
    before,
    after,
    ingress,
    target: evidence,
    transfers,
    sourceProof: await verifyHubCommit(user, source.hubEntity, ''),
    targetProof: await verifyHubCommit(target, targetChain.hubEntity, ''),
    externalPayout: true,
    fullSourcePocSuccess: true,
  };
};
