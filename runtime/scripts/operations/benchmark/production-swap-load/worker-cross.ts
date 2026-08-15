/** One truthful cross-j economic fill on the production local stack. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withCanonicalCrossJurisdictionRouteHash } from '../../../../extensions/cross-j';
import { getJurisdictionStackId } from '../../../../jurisdiction/machine/jurisdiction-runtime';
import type { JurisdictionConfig } from '../../../../protocol/config/jurisdiction-config';
import { safeStringify } from '../../../../protocol/serialization';
import {
  resolveMeshJurisdictionConfig,
  resolveSecondaryJurisdictions,
  requireJurisdictionBlockTimeMs,
  type ResolvedMeshJurisdictionConfig,
} from '../../../../orchestrator/mesh/mesh-jurisdictions';
import {
  readMeshSeedOverrides,
  resolveMeshRuntimeSeed,
} from '../../../../orchestrator/mesh/mesh-seeds';
import {
  decodeCrossLoadReport,
  decodeCommittedCrossRoutes,
  selectMarketMakerCrossRoute,
} from './cross/cross-boundary';
import {
  decodeEntitySummaries,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
} from './worker-boundary';
import {
  connectRuntime,
  directoryBytes,
  entryByLabel,
  persistReport,
  readLoadAccount,
  resolveWalPath,
  sendObserved,
  waitForCredit,
  waitForRuntimeHeight,
  type ConnectedRuntime,
  type WorkerArgs,
} from './worker-runtime';
import { setupCrossLoadCohort, waitForSettledCrossRoute } from './cross/worker-cross-state';

const SOURCE_CHAIN_ID = 31_337;
const TARGET_CHAIN_ID = 31_338;
const SETUP_CREDIT_MULTIPLIER = 4n;

export const resolveLoadJurisdictionRpc = (rpc: string, apiBaseUrl: string): string => {
  const resolved = new URL(rpc, apiBaseUrl);
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error(`PRODUCTION_SWAP_LOAD_JURISDICTION_RPC_INVALID:${rpc}`);
  }
  return resolved.toString();
};

export const toEntityJurisdiction = (value: ResolvedMeshJurisdictionConfig): JurisdictionConfig => ({
  // Entity authority binds the deployed stack, never a catalog alias. Runtime
  // imports may key the same stack as "arrakis", "Testnet", or another display
  // name; the chain-qualified Depository identity survives those local names.
  name: getJurisdictionStackId({
    chainId: value.chainId,
    depositoryAddress: value.contracts.depository,
  }),
  address: value.rpc,
  chainId: value.chainId,
  depositoryAddress: value.contracts.depository,
  entityProviderAddress: value.contracts.entityProvider,
  blockTimeMs: requireJurisdictionBlockTimeMs(value),
});

export const httpBaseForRuntimeWsUrl = (wsUrl: string): string => {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.origin;
};

const importJurisdiction = async (
  runtime: ConnectedRuntime,
  jurisdiction: ResolvedMeshJurisdictionConfig,
): Promise<void> => {
  const observed = await sendObserved(runtime, `prod-cross-import-j-${jurisdiction.chainId}`, {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        ticker: 'XLN',
        rpcs: [jurisdiction.rpc],
        entityProviderDeploymentBlock: jurisdiction.entityProviderDeploymentBlock,
        contracts: { ...jurisdiction.contracts },
      },
    }],
    entityInputs: [],
  });
  await waitForRuntimeHeight(runtime, observed.result.height + 1);
};

export const runCrossProductionSwapLoad = async (args: WorkerArgs): Promise<void> => {
  if (args.swaps !== 1) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_ONLY_N1_IMPLEMENTED');
  process.env['XLN_JURISDICTIONS_PATH'] = join(args.workDir, 'prod-main', 'jurisdictions.json');
  const meshRootSeed = readFileSync(join(args.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  if (!meshRootSeed) throw new Error('PRODUCTION_SWAP_LOAD_MESH_ROOT_SEED_MISSING');
  const runtimeSeedOverrides = readMeshSeedOverrides(
    process.env['XLN_MESH_RUNTIME_SEEDS_JSON'],
    'XLN_MESH_RUNTIME_SEEDS_JSON',
  );
  const custodyRuntimeSeed = resolveMeshRuntimeSeed(meshRootSeed, runtimeSeedOverrides, 'CUSTODY');
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(
    join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json'), 'utf8',
  )) as unknown);
  const hub = await connectRuntime(entryByLabel(entries, 'H1'));
  const load = await connectRuntime(entryByLabel(entries, 'Custody'), `ws://127.0.0.1:${args.portBase + 8}/rpc`);
  try {
    const entities = decodeEntitySummaries(await hub.adapter.read<unknown>('entities'));
    const sourceHub = selectLocalHubIdentity(entities, hub.adapter.runtimeId, SOURCE_CHAIN_ID);
    const targetHub = selectLocalHubIdentity(entities, hub.adapter.runtimeId, TARGET_CHAIN_ID);
    const marketMakerRoute = selectMarketMakerCrossRoute(
      decodeCommittedCrossRoutes(await hub.adapter.read<unknown>(`entity/${sourceHub.entityId}`)),
      sourceHub.entityId,
      targetHub.entityId,
    );
    const apiBaseUrl = `http://127.0.0.1:${args.portBase + 4}`;
    const sourceJ = resolveMeshJurisdictionConfig(`${apiBaseUrl}/rpc`);
    const targetJConfig = resolveSecondaryJurisdictions(sourceJ.rpc).find(value => value.chainId === TARGET_CHAIN_ID);
    if (!targetJConfig) throw new Error('PRODUCTION_SWAP_LOAD_TARGET_JURISDICTION_MISSING');
    const targetJ = {
      ...targetJConfig,
      rpc: resolveLoadJurisdictionRpc(targetJConfig.rpc, apiBaseUrl),
    };
    const sourceJurisdiction = toEntityJurisdiction(sourceJ);
    const targetJurisdiction = toEntityJurisdiction(targetJ);
    if (
      getJurisdictionStackId(sourceJurisdiction) !== marketMakerRoute.source.jurisdiction ||
      getJurisdictionStackId(targetJurisdiction) !== marketMakerRoute.target.jurisdiction
    ) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_JURISDICTION_ROUTE_MISMATCH');
    await importJurisdiction(load, targetJ);
    const cohort = await setupCrossLoadCohort({
      runtime: load,
      relayUrl: `ws://127.0.0.1:${args.portBase + 4}/relay`,
      sourceHubEntityId: sourceHub.entityId,
      targetHubEntityId: targetHub.entityId,
      sourceJurisdiction,
      targetJurisdiction,
      sourceTokenId: marketMakerRoute.source.tokenId,
      targetTokenId: marketMakerRoute.target.tokenId,
      sourceCredit: marketMakerRoute.source.amount * SETUP_CREDIT_MULTIPLIER,
      targetCredit: marketMakerRoute.target.amount * SETUP_CREDIT_MULTIPLIER,
      custodyRuntimeSeed,
    });
    await sendObserved(hub, `prod-cross-credit-${targetHub.entityId.slice(-8)}`, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: targetHub.entityId,
        signerId: targetHub.signerId,
        entityTxs: [{
          type: 'extendCredit',
          data: {
            counterpartyEntityId: cohort.target.entityId,
            tokenId: marketMakerRoute.target.tokenId,
            amount: marketMakerRoute.target.amount * SETUP_CREDIT_MULTIPLIER,
          },
        }],
      }],
    });
    await waitForCredit(
      load, cohort.target.entityId, targetHub.entityId,
      marketMakerRoute.target.tokenId, marketMakerRoute.target.amount,
    );
    const sourceAccount = await readLoadAccount(load, cohort.source.entityId, sourceHub.entityId);
    const targetAccount = await readLoadAccount(load, cohort.target.entityId, targetHub.entityId);
    if (!sourceAccount || !targetAccount) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_ACCOUNT_MISSING');
    const hubBefore = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const loadBefore = decodeLoadFrame(await load.adapter.read<unknown>('frame/latest'));
    const loadOrderId = `prod-cross-${hubBefore.height}-${marketMakerRoute.orderId}`;
    const now = Date.now();
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: loadOrderId,
      makerEntityId: cohort.target.entityId,
      hubEntityId: targetHub.entityId,
      ...(marketMakerRoute.bookOwnerEntityId ? { bookOwnerEntityId: marketMakerRoute.bookOwnerEntityId } : {}),
      sourceSignerId: cohort.target.signerId,
      sourceHubSignerId: targetHub.signerId,
      targetHubSignerId: sourceHub.signerId,
      targetSignerId: cohort.source.signerId,
      ...(marketMakerRoute.bookHubSignerId ? { bookHubSignerId: marketMakerRoute.bookHubSignerId } : {}),
      source: {
        jurisdiction: marketMakerRoute.target.jurisdiction,
        entityId: cohort.target.entityId,
        counterpartyEntityId: targetHub.entityId,
        tokenId: marketMakerRoute.target.tokenId,
        amount: marketMakerRoute.target.amount,
      },
      target: {
        jurisdiction: marketMakerRoute.source.jurisdiction,
        entityId: sourceHub.entityId,
        counterpartyEntityId: cohort.source.entityId,
        tokenId: marketMakerRoute.source.tokenId,
        amount: marketMakerRoute.source.amount,
      },
      sourceDisputeConfig: { ...targetAccount.state.disputeConfig },
      targetDisputeConfig: { ...sourceAccount.state.disputeConfig },
      ...(marketMakerRoute.priceTicks !== undefined ? { priceTicks: marketMakerRoute.priceTicks } : {}),
      riskMode: 'fully_collateralized',
      status: 'intent', createdAt: now, updatedAt: now, expiresAt: now + 10 * 60_000,
    });
    const hubWal = resolveWalPath(join(args.workDir, 'prod-mesh', 'h1'));
    const loadWal = resolveWalPath(join(args.workDir, 'prod-mesh', 'custody', 'daemon-db'));
    const hubWalBytesBefore = directoryBytes(hubWal);
    const loadWalBytesBefore = directoryBytes(loadWal);
    const startedAt = performance.now();
    const observed = await sendObserved(load, loadOrderId, {
      runtimeTxs: [],
      entityInputs: [
        { entityId: cohort.target.entityId, signerId: cohort.target.signerId, entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }] },
        { entityId: cohort.source.entityId, signerId: cohort.source.signerId, entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }] },
      ],
    });
    const settled = await waitForSettledCrossRoute(
      hub, sourceHub.entityId, targetHub.entityId, loadOrderId,
      marketMakerRoute.target.amount, marketMakerRoute.source.amount,
    );
    const economicCompletionElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    const report = decodeCrossLoadReport({
      schema: 'xln-production-cross-swap-load-v1', mode: 'cross', configuredBurstSize: 1,
      completionAuthority: 'committed_cross_route_full_fill',
      marketMakerOrderId: marketMakerRoute.orderId, loadOrderId,
      sourceAmount: settled.filledSourceAmount!.toString(),
      targetAmount: settled.filledTargetAmount!.toString(), routeStatus: 'settled',
      enqueueAckElapsedMs: observed.enqueueAckElapsedMs,
      commandObservedElapsedMs: observed.commandObservedElapsedMs,
      economicCompletionElapsedMs,
      hubWalBytesBefore, hubWalBytesAfter: directoryBytes(hubWal),
      loadWalBytesBefore, loadWalBytesAfter: directoryBytes(loadWal),
      hubDurableBefore: hubBefore, hubDurableAfter: decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest')),
      loadDurableBefore: loadBefore, loadDurableAfter: decodeLoadFrame(await load.adapter.read<unknown>('frame/latest')),
    });
    persistReport(join(args.workDir, 'production-cross-swap-load-report.json'), report, decodeCrossLoadReport);
    console.log(safeStringify(report));
  } finally {
    hub.adapter.disconnect();
    load.adapter.disconnect();
  }
};
