import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contract, JsonRpcProvider } from 'ethers';
import * as runtime from '../../../../../core/runtime';
import {
  bootUser,
  closeUser,
  openPocAccount,
  userReplica,
  waitFor,
  type PocUser,
} from '../../../../../core/scenarios/usdc-poc/user';
import { runOrderId, targetUser } from '../../../../../core/scenarios/usdc-poc/journey/context';
import { ensureSourceCollateral } from '../../../../../core/scenarios/usdc-poc/journey/ingress';
import { executeCrossSwap, resumeCrossSwap } from '../../../../../core/scenarios/usdc-poc/cross-swap';
import { executeExternalPayout } from '../../../../../core/scenarios/usdc-poc/external-payout';
import { resumePayout } from '../../../../../core/scenarios/usdc-poc/recovery/payout';
import { runtimeProof } from '../../../../../core/scenarios/usdc-poc/recovery/evidence';
import { drainJWatcherBacklog } from '../../../../../core/jurisdiction/adapter/operations/backlog-drain';
import { deriveRuntimeAdapterCapabilityToken } from '../../../../../core/api/runtime-adapter/security/auth';
import { safeStringify } from '../../../../../core/protocol/serialization';
import { readExistingIdentities, readVaultSeed } from '../../identities';
import { acquireStoreOwnership } from '../../operators/session/stores';
import { assertRestoredSession } from '../../operators/session/inspect';
import {
  authorityDigest,
  readAuthority,
  requireCurrentAuthority,
  payerSlots,
  type ExecutionAuthority,
} from '../authority';
import { verifyExecutionChain, verifyConsumedPayerSlots } from '../submission';
import { readNonceReceipt } from '../nonce-receipt';
import { ensureSourceApproval } from './approval';
import { reportCompletedRun } from './receipt-report';
import type { ExecutionConfig } from '../config';
import { connectExecutionProviders, historicalRpc, type ExecutionProviders } from '../providers';

const verifyBindings = (config: ExecutionConfig, authority: ExecutionAuthority): void => {
  const identities = readExistingIdentities(config.directory);
  if (authority.apiBase !== config.apiBase) throw new Error('USDC_EXECUTION_API_BINDING_MISMATCH');
  for (const chain of authority.chains)
    for (const role of ['user', 'hub'] as const) {
      const own = identities.find(value => value.role === role)!.chains.find(value => value.chainId === chain.chainId)!;
      const entity = role === 'user' ? chain.userEntity : chain.hubEntity;
      const signer = role === 'user' ? chain.userSigner : chain.hubSigner;
      if (own.entityId !== entity || own.signerId !== signer)
        throw new Error('USDC_EXECUTION_IDENTITY_BINDING_MISMATCH');
    }
};

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
      return deriveRuntimeAdapterCapabilityToken(seed, 'inspect', Math.min(authority.expiresAt, Date.now() + 600_000), {
        audience: 'poc-usdc',
      });
    },
  };
  return bootUser(config.apiBase, join(config.directory, 'user'), true, config.runId, connection);
};

const activateUser = async (user: PocUser, config: ExecutionConfig): Promise<void> => {
  await assertRestoredSession(user.env, config.directory, 'user');
  runtime.setRuntimeDeliveryReady(user.env, false);
  runtime.startJurisdictionWatchers(user.env);
  await drainJWatcherBacklog(user.env, env => runtime.processRuntime(env));
  runtime.startP2P(user.env, { relayUrls: [config.apiBase.replace('http', 'ws') + '/relay'], gossipSet: 'hubs' });
  runtime.startRuntimeLoop(user.env, {
    onFatal: ({ message }) => {
      console.error(message);
      process.exit(1);
    },
  });
  runtime.setRuntimeDeliveryReady(user.env, true);
  await waitFor('execution-user-relay-connected', () => runtime.getP2P(user.env)?.isConnected() === true);
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
): Promise<void> => {
  const source = authority.chains[0]!,
    targetChain = authority.chains[1]!;
  const exit = targetChain.payers.find(payer => payer.role === 'target-user')!;
  if (await readNonceReceipt(providers[1]!, targetChain, exit, exit.firstNonce + runIndex)) return;
  await openPocAccount(user, authority.apiBase, source.hubEntity);
  let route = userReplica(user).state.crossJurisdictionSwaps?.get(user.orderId);
  if (!route) {
    await ensureSourceApproval(user, authority, providers[0]!, source, runIndex);
    await ensureSourceCollateral(user, source.hubEntity, source.token);
    await executeCrossSwap(user, source.hubEntity, authority.apiBase, '');
    route = userReplica(user).state.crossJurisdictionSwaps?.get(user.orderId);
  } else if (route.status !== 'settled') {
    if (route.status === 'cancelled' || route.status === 'expired')
      throw new Error('USDC_EXECUTION_PARTIAL_OR_CANCELLED_RUN');
    await resumeCrossSwap(user, source.hubEntity, authority.apiBase, '');
  }
  if (!route) throw new Error('USDC_EXECUTION_ROUTE_MISSING');
  await finishPayout(user, authority, runIndex, providers[1]!);
};

const finishPayout = async (
  user: PocUser,
  authority: ExecutionAuthority,
  runIndex: number,
  provider: ExecutionProviders,
): Promise<void> => {
  const chain = authority.chains[1]!;
  const target = targetUser(user, authority.apiBase);
  const account = userReplica(target).state.accounts.get(chain.hubEntity);
  if (!account) throw new Error('USDC_EXECUTION_TARGET_ACCOUNT_MISSING');
  const coverStarted =
    account.state.requestedRebalanceFeeState.size > 0 ||
    account.state.requestedRebalance.size > 0 ||
    account.state.deltas.get(1)!.collateral > 0n ||
    Boolean(account.state.settlementWorkspace) ||
    (userReplica(target).state.settlementContinuations?.size ?? 0) > 0 ||
    Boolean(userReplica(target).state.jBatchState?.sentBatch);
  if (!coverStarted) {
    const swap = await resumeCrossSwap(user, authority.chains[0]!.hubEntity, authority.apiBase, '');
    await executeExternalPayout(user, authority.chains[0]!.hubEntity, swap, authority.apiBase, '');
    return;
  }
  const hub = chain.payers.find(payer => payer.role === 'target-hub')!;
  const cover = await readNonceReceipt(provider, chain, hub, hub.firstNonce + runIndex);
  const { targetContracts } = await import('../../../../../core/scenarios/usdc-poc/target-evidence');
  const contracts = await targetContracts(target, historicalRpc(authority.apiBase, chain.chainId));
  try {
    const baseline = cover
      ? await contracts.token.balanceOf(target.signerId, { blockTag: cover.receipt.blockNumber - 1 })
      : await contracts.token.balanceOf(target.signerId);
    await resumePayout(user, authority.apiBase, '', baseline);
  } finally {
    contracts.provider.destroy();
  }
};

/** The owning host may attach ordinary commit observers before live delivery.
 * Observers are ephemeral; Runtime WAL and chain evidence still decide recovery. */
export const executeRun = async (config: ExecutionConfig, observeRestored?: (user: PocUser) => void): Promise<void> => {
  const authority = readAuthority(config.authorityPath);
  requireCurrentAuthority(authority, join(config.directory, 'jurisdictions.json'));
  const runIndex = authority.runIds.indexOf(config.runId);
  if (runIndex < 0) throw new Error('USDC_EXECUTION_RUN_NOT_AUTHORIZED');
  verifyBindings(config, authority);
  const release = acquireStoreOwnership([['user', config.store]]);
  const providers = authority.chains.map(chain => connectExecutionProviders(config.apiBase, chain.chainId));
  try {
    await verifyPayerBudgets(authority, providers);
    const user = await openUser(config, authority);
    try {
      const restored = runtimeProof(user);
      await requirePreviousRun(user, authority, runIndex, providers[1]!);
      await requireRunIdentity(user, authority, runIndex, providers[0]!);
      await requireSourcePrincipal(user, authority, providers[0]!.current);
      if (observeRestored) observeRestored(user);
      await activateUser(user, config);
      await finishFinancialFlow(user, authority, runIndex, providers);
      const result = await reportCompletedRun(user, authority, runIndex, providers[0]!, providers[1]!);
      writeFileSync(
        config.output,
        safeStringify(
          { ...result, restored, authorityDigest: authorityDigest(authority), runtime: runtimeProof(user) },
          2,
        ),
        { mode: 0o600, flag: 'wx' },
      );
      console.log(`USDC_EXECUTION_RUN_COMPLETE:${config.runId}:paid=${result.paid}`);
    } finally {
      await closeUser(user);
    }
  } finally {
    for (const provider of providers) {
      provider.current.destroy();
      provider.historical.destroy();
    }
    release();
  }
};
