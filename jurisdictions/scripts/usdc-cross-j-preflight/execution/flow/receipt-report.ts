import { ERC20Mock__factory } from '../../../../typechain-types';
import { decodeJBatch } from '../../../../../core/jurisdiction/machine/batch';
import { getCrossJurisdictionRouteRemainingAmounts } from '../../../../../core/extensions/cross-j/orderbook';
import { targetUser } from '../../../../../core/scenarios/usdc-poc/journey/context';
import { userReplica, type PocUser } from '../../../../../core/scenarios/usdc-poc/user';
import { verifyHubCommit } from '../../../../../core/scenarios/usdc-poc/hub-proof';
import { requireBoundaryRecord } from '../../../../../core/protocol/boundary-validation';
import { evmAttemptSlot } from '../../../../../core/storage/queries/evm-attempts';
import { withStorageConsistentRead } from '../../../../../core/storage/runtime-dbs';
import { buildIngressEvidence, receiptFields } from '../../../../../core/scenarios/usdc-poc/evidence';
import {
  buildTargetReceiptEvidence,
  requireTokenTransfer,
} from '../../../../../core/scenarios/usdc-poc/target-evidence';
import { readNonceReceipt } from '../nonce-receipt';
import { receiptSlots, verifyAuthorizedReceipt } from '../receipt-event';
import { hex, list } from '../boundary';
import { observeBoundSlots } from '../status/chain';
import type { ChainAuthority, ExecutionAuthority, PayerGrant } from '../authority';
import { connectGatewayObservation, type ExecutionProviders } from '../providers';
import { inspectUserWal } from '../status/wal';
import { readCrossJProof } from './cross-j-proof';

const readAuthorizedReceipt = async (
  authority: ExecutionAuthority,
  providers: ExecutionProviders,
  chain: ChainAuthority,
  payer: PayerGrant,
  nonce: number,
) => {
  const entry = await readNonceReceipt(providers, chain, payer, nonce);
  return entry && verifyAuthorizedReceipt(authority, chain, payer, nonce, entry);
};

const readLiveCover = async (user: PocUser, [, , chain, payer, nonce]: ReturnType<typeof receiptSlots>[3]) => {
  const { wsUrl, authKey } = user.hubConnection ?? {};
  if (!wsUrl || !authKey) throw new Error('USDC_EXECUTION_HUB_INSPECTION_UNBOUND');
  const url = new URL('/api/control/evm-attempts', wsUrl);
  url.protocol = 'http:';
  url.search = new URLSearchParams({
    chainId: String(chain.chainId),
    payer: payer.address,
    nonce: String(nonce),
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${authKey}` },
      signal: AbortSignal.timeout(4_000),
      redirect: 'error',
    });
  } catch (error) {
    return {
      hashes: [],
      error: `USDC_EXECUTION_HUB_ATTEMPT_READ:${error instanceof Error ? error.name : 'unavailable'}`,
    };
  }
  if (!response.ok) return { hashes: [], error: `USDC_EXECUTION_HUB_ATTEMPT_READ:HTTP_${response.status}` };
  const result = requireBoundaryRecord(await response.json(), 'USDC_EXECUTION_HUB_ATTEMPT_RESPONSE');
  if (typeof result['complete'] !== 'boolean') throw new Error('USDC_EXECUTION_HUB_ATTEMPT_RESPONSE');
  return {
    hashes: list(result['hashes']).map(hash => hex(hash, 32)),
    error: result['complete'] ? null : 'USDC_STATUS_WAL_ATTEMPT_HISTORY_BUDGET',
  };
};

export const reportStoppedRun = async (
  user: PocUser,
  authority: ExecutionAuthority,
  runIndex: number,
  providers: readonly ExecutionProviders[],
) => {
  const expected = receiptSlots(authority, runIndex);
  const [wal, cover] = await Promise.all([
    withStorageConsistentRead(user.env, () => inspectUserWal(authority, user.runId, expected, user.env)),
    readLiveCover(user, expected[3]),
  ]);
  const [source, target] = wal.state?.entities ?? [];
  const [, , coverChain, coverPayer, coverNonce] = expected[3];
  wal.hashes.set(evmAttemptSlot(coverChain.chainId, coverPayer.address, coverNonce), cover.hashes);
  const observed = await Promise.all(
    authority.chains.map(async (chain, index) => {
      const current = connectGatewayObservation(authority.apiBase, chain.chainId);
      try {
        return await observeBoundSlots(
          authority,
          chain,
          expected.filter(slot => slot[1] === index),
          wal.hashes,
          current,
          providers[index]!.historical,
        );
      } finally {
        current.destroy();
      }
    }),
  );
  const slots = observed.flatMap(chain =>
    chain.slots.map(({ entry, ...slot }) => ({ ...slot, receipt: entry ? receiptFields(entry) : null })),
  );
  return {
    slots,
    runtimeHeight: wal.state?.height ?? null,
    walHeights: wal.heights,
    lastConfirmedStep: slots.findLast(slot => slot.status === 'confirmed')?.step ?? null,
    source: source ?? null,
    target: target ?? null,
    route: source?.route ?? null,
    userWalReadError: wal.error ?? wal.historyError,
    hubAttemptReadError: cover.error,
  };
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
  const [approval, deposit, collateral, cover, exit] = await Promise.all(
    receiptSlots(authority, runIndex).map(async ([step, index, chain, payer, nonce]) => {
      const provider = index === 0 ? sourceProvider : targetProvider;
      const receipt = await readAuthorizedReceipt(authority, provider, chain, payer, nonce);
      if (!receipt)
        throw new Error(`USDC_EXECUTION_RUN_RECEIPT_MISSING:${step}:${chain.chainId}:${payer.role}:${nonce}`);
      return receipt;
    }),
  );
  if (!approval || !deposit || !collateral || !cover || !exit)
    throw new Error('USDC_EXECUTION_RUN_RECEIPTS_INCOMPLETE');
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
  const targetRoute = userReplica(target).state.crossJurisdictionSwaps?.get(user.orderId);
  if (targetRoute?.status !== 'settled' || targetRoute.routeHash !== route.routeHash)
    throw new Error('USDC_EXECUTION_TARGET_ROUTE_NOT_SETTLED');
  requireTokenTransfer(
    { receipts: [receiptFields(deposit)] },
    { token: source.token, from: source.userSigner, to: source.depository, amount: route.source.amount },
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
    crossJ: await readCrossJProof(user.env, source, targetChain, route),
    routes: { source: route, target: targetRoute },
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
