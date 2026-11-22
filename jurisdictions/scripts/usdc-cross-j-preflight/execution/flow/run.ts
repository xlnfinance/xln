import { join } from 'node:path';
import { Contract, JsonRpcProvider } from 'ethers';
import {
  bootUser,
  closeUser,
  openPocAccount,
  userReplica,
  type PocUser,
} from '../../../../../core/scenarios/usdc-poc/user';
import { runOrderId } from '../../../../../core/scenarios/usdc-poc/journey/context';
import { ensureSourceCollateral } from '../../../../../core/scenarios/usdc-poc/journey/ingress';
import { executeCrossSwap, resumeCrossSwap } from '../../../../../core/scenarios/usdc-poc/cross-swap';
import { runtimeProof } from '../../../../../core/scenarios/usdc-poc/recovery/evidence';
import { deriveRuntimeAdapterCapabilityToken } from '../../../../../core/api/runtime-adapter/security/auth';
import { readVaultSeed } from '../../identities';
import { acquireStoreOwnership } from '../../operators/session/stores';
import {
  authorityDigest,
  readAuthority,
  requireCurrentAuthority,
  payerSlots,
  verifyExecutionBindings,
  type ExecutionAuthority,
} from '../authority';
import { verifyExecutionChain, verifyConsumedPayerSlots } from '../submission';
import { readNonceReceipt } from '../nonce-receipt';
import { reconcileSourceApproval, submitSourceApproval } from './approval';
import { reportCompletedRun, reportStoppedRun } from './receipt-report';
import type { ExecutionConfig } from '../config';
import { connectExecutionProviders, type ExecutionProviders } from '../providers';
import { preflightFreshRun, requireTargetBacking, refreshApprovalBacking } from './preflight';
import { finishPayout } from './payout';
import { activateUser } from './operator-barrier';
import {
  reasonText,
  runReportEvidence,
  throwAfter,
  withCleanup,
  writeReport,
  type FreshPreflight,
  type RecordApprovalAttempt,
} from './run-report';

const verifyPayerBudgets = async (
  authority: ExecutionAuthority,
  providers: readonly ExecutionProviders[],
): Promise<void> => {
  for (const [index, chain] of authority.chains.entries()) {
    const provider = providers[index]!;
    await verifyExecutionChain(provider, chain);
    if ((await provider.current.send('xln_executionAuthority', [])) !== authorityDigest(authority))
      throw new Error('USDC_EXECUTION_GATEWAY_AUTHORITY_MISMATCH');
    await verifyConsumedPayerSlots(authority, provider, chain);
    for (const payer of chain.payers) {
      const nonce = await provider.current.getTransactionCount(payer.address, 'latest');
      const end = payer.firstNonce + payerSlots(authority, payer);
      if (nonce < payer.firstNonce || nonce > end) throw new Error('USDC_EXECUTION_PAYER_NONCE_OUTSIDE_SCOPE');
      const balance = await provider.current.getBalance(payer.address);
      if (balance < BigInt(end - nonce) * payer.gasLimit * payer.maxFeePerGasWei)
        throw new Error(`USDC_EXECUTION_PAYER_NATIVE_INSUFFICIENT:${payer.role}`);
    }
  }
};

const openUser = async (config: ExecutionConfig, authority: ExecutionAuthority): Promise<PocUser> => {
  const seed = readVaultSeed(join(config.directory, 'hub'));
  const connection = {
    mode: 'remote' as const,
    wsUrl: config.hubUrl,
    runtimeId: authority.chains[0]!.hubSigner,
    get authKey() {
      return deriveRuntimeAdapterCapabilityToken(seed, 'inspect', Date.now() + 600_000, {
        audience: 'poc-usdc',
      });
    },
  };
  return bootUser(config.apiBase, join(config.directory, 'user'), true, config.runId, connection);
};

const requirePreviousRun = async (
  user: PocUser,
  authority: ExecutionAuthority,
  runIndex: number,
  provider: ExecutionProviders,
): Promise<void> => {
  if (runIndex === 0) return;
  const previous = runOrderId(user.entityId, authority.runIds[runIndex - 1]!);
  const route = userReplica(user).state.crossJurisdictionSwaps?.get(previous);
  const target = authority.chains[1]!;
  const payer = target.payers.find(value => value.role === 'target-user')!;
  if (
    route?.status !== 'settled' ||
    !(await readNonceReceipt(provider, target, payer, payer.firstNonce + runIndex - 1))
  )
    throw new Error('USDC_EXECUTION_PREVIOUS_RUN_UNRESOLVED');
};

const requireSourcePrincipal = async (
  user: PocUser,
  authority: ExecutionAuthority,
  provider: JsonRpcProvider,
): Promise<void> => {
  const source = authority.chains[0]!;
  const state = userReplica(user).state;
  if (state.crossJurisdictionSwaps?.has(user.orderId)) return;
  const account = state.accounts.get(source.hubEntity);
  const accepted = state.jBatchState;
  const ingressAccepted = Boolean(
    accepted?.sentBatch ||
    accepted?.batch.externalTokenToReserve.length ||
    accepted?.batch.reserveToCollateral.length ||
    state.reserves.get(1) ||
    account?.state.deltas.get(1)?.collateral,
  );
  const token = new Contract(source.token, ['function balanceOf(address) view returns(uint256)'], provider);
  if (!ingressAccepted && (await token.getFunction('balanceOf')(user.signerId)) < 1_000_000n)
    throw new Error('USDC_EXECUTION_SOURCE_PRINCIPAL_MISSING');
};

const requireRunIdentity = async (
  user: PocUser,
  authority: ExecutionAuthority,
  runIndex: number,
  provider: ExecutionProviders,
): Promise<void> => {
  if (!userReplica(user).state.crossJurisdictionSwaps?.has(user.orderId)) return;
  const source = authority.chains[0]!;
  const payer = source.payers.find(value => value.role === 'source-user')!;
  if (!(await readNonceReceipt(provider, source, payer, payer.firstNonce + runIndex * 3)))
    throw new Error('USDC_EXECUTION_RUN_ID_ALREADY_USED_BY_ANOTHER_CAMPAIGN');
};

const finishFinancialFlow = async (
  user: PocUser,
  authority: ExecutionAuthority,
  runIndex: number,
  providers: readonly ExecutionProviders[],
  requireAuthority: () => void,
  preflight: FreshPreflight | null,
  recordApproval: RecordApprovalAttempt,
) => {
  const source = authority.chains[0]!,
    targetChain = authority.chains[1]!;
  const exit = targetChain.payers.find(payer => payer.role === 'target-user')!;
  if (await readNonceReceipt(providers[1]!, targetChain, exit, exit.firstNonce + runIndex)) return;
  await openPocAccount(user, authority.apiBase, source.hubEntity);
  const guard = {
    validThrough: authority.expiresAt,
    async verifyBacking(amount: bigint) {
      await requireTargetBacking(targetChain, providers[1]!, amount);
      requireAuthority();
    },
  };
  let route = userReplica(user).state.crossJurisdictionSwaps?.get(user.orderId);
  if (!route) {
    if (preflight) {
      let confirmedPreflight = preflight;
      await submitSourceApproval(
        user,
        authority,
        providers[0]!.current,
        runIndex,
        async () => {
          confirmedPreflight = await refreshApprovalBacking(user, authority, providers[1]!, preflight);
          requireAuthority();
        },
        hash => recordApproval(hash, confirmedPreflight),
      );
    }
    await ensureSourceCollateral(user, source.hubEntity, source.token);
    await executeCrossSwap(user, source.hubEntity, authority.apiBase, '', false, 120_000, guard);
    route = userReplica(user).state.crossJurisdictionSwaps?.get(user.orderId);
  } else if (route.status !== 'settled') {
    if (route.status === 'cancelled' || route.status === 'expired')
      throw new Error('USDC_EXECUTION_PARTIAL_OR_CANCELLED_RUN');
    await resumeCrossSwap(user, source.hubEntity, authority.apiBase, '');
  }
  if (!route) throw new Error('USDC_EXECUTION_ROUTE_MISSING');
  await finishPayout(user, authority, runIndex, providers[1]!, guard);
};

const executeAndReport = async (
  user: PocUser,
  config: ExecutionConfig,
  authority: ExecutionAuthority,
  runIndex: number,
  providers: readonly ExecutionProviders[],
  requireAuthority: () => void,
  observeRestored?: (user: PocUser) => void,
) => {
  const evidence = runReportEvidence(config, authority);
  let preflight: FreshPreflight | null = null;
  try {
    const restored = runtimeProof(user);
    await requirePreviousRun(user, authority, runIndex, providers[1]!);
    await requireRunIdentity(user, authority, runIndex, providers[0]!);
    await requireSourcePrincipal(user, authority, providers[0]!.current);
    if (observeRestored) observeRestored(user);
    await activateUser(user, config, requireAuthority);
    const approved = await reconcileSourceApproval(authority, providers[0]!, runIndex, user.env);
    if (!approved) preflight = await preflightFreshRun(user, authority, providers, runIndex);
    requireAuthority();
    await finishFinancialFlow(
      user,
      authority,
      runIndex,
      providers,
      requireAuthority,
      preflight,
      evidence.recordApproval,
    );
    const result = await reportCompletedRun(user, authority, runIndex, providers[0]!, providers[1]!);
    writeReport(config.output, {
      ...result,
      ...evidence.binding,
      restored,
      runtime: runtimeProof(user),
      preflight: evidence.preflightFor(result.ingress.receipts[0]!.hash),
    });
    console.log(`USDC_EXECUTION_RUN_COMPLETE:${config.runId}:paid=${result.paid}`);
  } catch (error) {
    await throwAfter(error, async () => {
      const progress = await reportStoppedRun(user, authority, runIndex, providers);
      const approval = progress.slots[0]?.hash;
      writeReport(config.output, {
        ...evidence.binding,
        ...progress,
        status: 'stopped',
        reason: reasonText(error),
        preflight: approval ? (evidence.preflightFor(approval) ?? preflight) : preflight,
      });
    });
  }
};

/** The owning host may attach ordinary commit observers before live delivery.
 * Observers are ephemeral; Runtime WAL and chain evidence still decide recovery. */
export const executeRun = async (config: ExecutionConfig, observeRestored?: (user: PocUser) => void): Promise<void> => {
  const authority = readAuthority(config.authorityPath);
  const requireAuthority = () => requireCurrentAuthority(authority, join(config.directory, 'jurisdictions.json'));
  requireAuthority();
  const runIndex = authority.runIds.indexOf(config.runId);
  if (runIndex < 0) throw new Error('USDC_EXECUTION_RUN_NOT_AUTHORIZED');
  verifyExecutionBindings(config.directory, config.apiBase, authority);
  const release = acquireStoreOwnership([['user', config.store]]);
  const providers = authority.chains.map(chain => connectExecutionProviders(config.apiBase, chain.chainId));
  const priorDeadline = process.env['USDC_POC_STAGE_DEADLINE_MS'];
  process.env['USDC_POC_STAGE_DEADLINE_MS'] = String(authority.expiresAt);
  await withCleanup(
    async () => {
      await verifyPayerBudgets(authority, providers);
      const user = await openUser(config, authority);
      // Keep the PoC's committed user state inspectable after any interruption.
      // Storage cadence is host policy, outside the replayed frame state.
      user.env.runtimeConfig.storage = { ...user.env.runtimeConfig.storage, materializePeriodFrames: 1 };
      await withCleanup(
        () => executeAndReport(user, config, authority, runIndex, providers, requireAuthority, observeRestored),
        () => closeUser(user),
      );
    },
    () => {
      if (priorDeadline === undefined) delete process.env['USDC_POC_STAGE_DEADLINE_MS'];
      else process.env['USDC_POC_STAGE_DEADLINE_MS'] = priorDeadline;
      for (const provider of providers) {
        provider.current.destroy();
        provider.historical.destroy();
      }
      release();
    },
  );
};
