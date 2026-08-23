/** One truthful cross-j economic fill on the production local stack. */
import { collectHltEnvironmentManifest } from '../boundary/environment-manifest';
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
  selectMarketMakerCrossRoutes,
} from './cross-boundary';
import { publishHltDashboardPerfFromWorkDir, publishHltDashboardReport } from '../../../../qa/hlt/hlt-dashboard';
import {
  decodeEntitySummaries,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
} from '../boundary/worker-boundary';
import {
  connectRuntime,
  directoryBytes,
  entryByLabel,
  exportReplayBaseSnapshotIfConfigured,
  persistReport,
  readLoadAccount,
  resolveWalPath,
  sendObserved,
  waitForCredit,
  waitForRuntimeHeight,
  type ConnectedRuntime,
  type WorkerArgs,
  readWithRateLimitRetry,
} from '../worker-runtime';
import { setupCrossLoadCohort, waitForSettledCrossRoute } from './worker-cross-state';

const SOURCE_CHAIN_ID = 31_337;
const TARGET_CHAIN_ID = 31_338;
// Credit covers the whole burst: every route in flight holds its full amount.
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
  const burstSize = args.swaps;
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
    const entities = decodeEntitySummaries(await readWithRateLimitRetry<unknown>(hub, 'entities'));
    const sourceHub = selectLocalHubIdentity(entities, hub.adapter.runtimeId, SOURCE_CHAIN_ID);
    const targetHub = selectLocalHubIdentity(entities, hub.adapter.runtimeId, TARGET_CHAIN_ID);
    const marketMakerLevels = selectMarketMakerCrossRoutes(
      decodeCommittedCrossRoutes(await readWithRateLimitRetry<unknown>(hub, `entity/${sourceHub.entityId}`)),
      sourceHub.entityId,
      targetHub.entityId,
    );
    // The byte-budget selector quotes one level per token pair per directed
    // route, so parallel fills come from parallel pairs: one funded cohort per
    // pair, each burst route matching that pair's single MM level.
    const seenPairs = new Set<string>();
    const pairLevels = marketMakerLevels.filter(level => {
      const key = `${level.source.tokenId}>${level.target.tokenId}`;
      if (seenPairs.has(key)) return false;
      seenPairs.add(key);
      return true;
    });
    if (pairLevels.length < burstSize) {
      throw new Error(`PRODUCTION_SWAP_LOAD_CROSS_MM_DEPTH_INSUFFICIENT:${pairLevels.length}:${burstSize}`);
    }
    const levels = pairLevels.slice(0, burstSize);
    const marketMakerRoute = levels[0]!;
    console.log(`[load] cross pairs available=${pairLevels.length} burst=${burstSize}`);
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
    type PreparedCohort = {
      level: (typeof levels)[number];
      cohort: Awaited<ReturnType<typeof setupCrossLoadCohort>>;
      sourceAccount: NonNullable<Awaited<ReturnType<typeof readLoadAccount>>>;
      targetAccount: NonNullable<Awaited<ReturnType<typeof readLoadAccount>>>;
    };
    const prepared: PreparedCohort[] = [];
    for (const [index, level] of levels.entries()) {
      const cohort = await setupCrossLoadCohort({
        runtime: load,
        relayUrl: `ws://127.0.0.1:${args.portBase + 4}/relay`,
        labelSuffix: `-${index}`,
        sourceHubEntityId: sourceHub.entityId,
        targetHubEntityId: targetHub.entityId,
        sourceJurisdiction,
        targetJurisdiction,
        sourceTokenId: level.source.tokenId,
        targetTokenId: level.target.tokenId,
        sourceCredit: level.source.amount * SETUP_CREDIT_MULTIPLIER,
        targetCredit: level.target.amount * SETUP_CREDIT_MULTIPLIER,
        custodyRuntimeSeed,
      });
      await sendObserved(hub, `prod-cross-credit-${index}-${targetHub.entityId.slice(-8)}`, {
        runtimeTxs: [],
        entityInputs: [{
          entityId: targetHub.entityId,
          signerId: targetHub.signerId,
          entityTxs: [{
            type: 'extendCredit',
            data: {
              counterpartyEntityId: cohort.target.entityId,
              tokenId: level.target.tokenId,
              amount: level.target.amount * SETUP_CREDIT_MULTIPLIER,
            },
          }],
        }],
      });
      await waitForCredit(
        load, cohort.target.entityId, targetHub.entityId,
        level.target.tokenId, level.target.amount,
      );
      const sourceAccount = await readLoadAccount(load, cohort.source.entityId, sourceHub.entityId);
      const targetAccount = await readLoadAccount(load, cohort.target.entityId, targetHub.entityId);
      if (!sourceAccount || !targetAccount) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_ACCOUNT_MISSING');
      prepared.push({ level, cohort, sourceAccount, targetAccount });
    }

    await exportReplayBaseSnapshotIfConfigured(hub);
    const hubBefore = decodeLoadFrame(await readWithRateLimitRetry<unknown>(hub, 'frame/latest'));
    const loadBefore = decodeLoadFrame(await readWithRateLimitRetry<unknown>(load, 'frame/latest'));
    const now = Date.now();
    const buildRoute = (index: number) => {
      const { level, cohort: pairCohort, sourceAccount, targetAccount } = prepared[index]!;
      return withCanonicalCrossJurisdictionRouteHash({
        orderId: `prod-cross-${hubBefore.height}-${index}-${level.orderId}`,
        makerEntityId: pairCohort.target.entityId,
        hubEntityId: targetHub.entityId,
        ...(level.bookOwnerEntityId ? { bookOwnerEntityId: level.bookOwnerEntityId } : {}),
        sourceSignerId: pairCohort.target.signerId,
        sourceHubSignerId: targetHub.signerId,
        targetHubSignerId: sourceHub.signerId,
        targetSignerId: pairCohort.source.signerId,
        ...(level.bookHubSignerId ? { bookHubSignerId: level.bookHubSignerId } : {}),
        source: {
          jurisdiction: level.target.jurisdiction,
          entityId: pairCohort.target.entityId,
          counterpartyEntityId: targetHub.entityId,
          tokenId: level.target.tokenId,
          amount: level.target.amount,
        },
        target: {
          jurisdiction: level.source.jurisdiction,
          entityId: sourceHub.entityId,
          counterpartyEntityId: pairCohort.source.entityId,
          tokenId: level.source.tokenId,
          amount: level.source.amount,
        },
        sourceDisputeConfig: { ...targetAccount.state.disputeConfig },
        targetDisputeConfig: { ...sourceAccount.state.disputeConfig },
        ...(level.priceTicks !== undefined ? { priceTicks: level.priceTicks } : {}),
        riskMode: 'fully_collateralized',
        status: 'intent', createdAt: now, updatedAt: now, expiresAt: now + 10 * 60_000,
      });
    };
    const routes = Array.from({ length: burstSize }, (_, index) => buildRoute(index));
    const loadOrderId = routes[0]!.orderId;
    const hubWal = resolveWalPath(join(args.workDir, 'prod-mesh', 'h1'));
    const loadWal = resolveWalPath(join(args.workDir, 'prod-mesh', 'custody', 'daemon-db'));
    const hubWalBytesBefore = directoryBytes(hubWal);
    const loadWalBytesBefore = directoryBytes(loadWal);
    const startedAt = performance.now();
    // One burst: every route is one atomic pair envelope (the cross-j pair
    // cohort admits exactly two legs per envelope), submitted back to back;
    // then every route must reach committed full fill on both hub entities.
    let observed = { enqueueAckElapsedMs: 0, commandObservedElapsedMs: 0 };
    for (const [index, route] of routes.entries()) {
      const pairCohort = prepared[index]!.cohort;
      const routeObserved = await sendObserved(load, route.orderId, {
        runtimeTxs: [],
        entityInputs: [
          { entityId: pairCohort.target.entityId, signerId: pairCohort.target.signerId, entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }] },
          { entityId: pairCohort.source.entityId, signerId: pairCohort.source.signerId, entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }] },
        ],
      });
      observed = {
        enqueueAckElapsedMs: Math.max(observed.enqueueAckElapsedMs, routeObserved.enqueueAckElapsedMs),
        commandObservedElapsedMs: Math.max(observed.commandObservedElapsedMs, routeObserved.commandObservedElapsedMs),
      };
    }
    const settledRoutes = await Promise.all(routes.map((route, index) => waitForSettledCrossRoute(
      hub, sourceHub.entityId, targetHub.entityId, route.orderId,
      prepared[index]!.level.target.amount, prepared[index]!.level.source.amount,
    )));
    const settled = settledRoutes[0]!;
    const economicCompletionElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    const report = decodeCrossLoadReport({
      schema: 'xln-production-cross-swap-load-v1', mode: 'cross', configuredBurstSize: burstSize,
      settledRoutes: settledRoutes.length,
      economicTps: settledRoutes.length * 1_000 / Math.max(1, Math.ceil(performance.now() - startedAt)),
      completionAuthority: 'committed_cross_route_full_fill',
      marketMakerOrderId: marketMakerRoute.orderId, loadOrderId,
      sourceAmount: settled.filledSourceAmount!.toString(),
      targetAmount: settled.filledTargetAmount!.toString(), routeStatus: 'settled',
      enqueueAckElapsedMs: observed.enqueueAckElapsedMs,
      commandObservedElapsedMs: observed.commandObservedElapsedMs,
      economicCompletionElapsedMs,
      hubWalBytesBefore, hubWalBytesAfter: directoryBytes(hubWal),
      loadWalBytesBefore, loadWalBytesAfter: directoryBytes(loadWal),
      hubDurableBefore: hubBefore, hubDurableAfter: decodeLoadFrame(await readWithRateLimitRetry<unknown>(hub, 'frame/latest')),
      environment: collectHltEnvironmentManifest(),
      loadDurableBefore: loadBefore, loadDurableAfter: decodeLoadFrame(await readWithRateLimitRetry<unknown>(load, 'frame/latest')),
    });
    persistReport(join(args.workDir, 'production-cross-swap-load-report.json'), report, decodeCrossLoadReport);
    publishHltDashboardReport('cross', report);
    publishHltDashboardPerfFromWorkDir(args.workDir);
    console.log(safeStringify(report));
  } finally {
    hub.adapter.disconnect();
    load.adapter.disconnect();
  }
};
