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
  const rounds = args.rounds;
  // Credit covers every round: each volley fully fills one MM level per pair.
  const creditUnits = SETUP_CREDIT_MULTIPLIER * BigInt(rounds);
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
        sourceCredit: level.source.amount * creditUnits,
        targetCredit: level.target.amount * creditUnits,
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
              amount: level.target.amount * creditUnits,
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
    type LevelEntry = (typeof levels)[number];
    const pairKeyOf = (level: Pick<LevelEntry, 'source' | 'target'>): string =>
      `${level.source.tokenId}>${level.target.tokenId}`;
    const cohortByPair = new Map(prepared.map(entry => [pairKeyOf(entry.level), entry] as const));
    const buildVolleyRoute = (entry: PreparedCohort, level: LevelEntry, tag: string, now: number) => {
      const { cohort: pairCohort, sourceAccount, targetAccount } = entry;
      return withCanonicalCrossJurisdictionRouteHash({
        orderId: `prod-cross-${hubBefore.height}-${tag}-${level.orderId}`,
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
    // Fresh maker levels for the next volley: after a round fully fills every
    // pair's resting mmx- order, the steady-quote loop must post replacements
    // before routes can be built again.
    const requoteTimeoutMs = Math.max(10_000, Number(process.env['XLN_CROSS_LOAD_REQUOTE_TIMEOUT_MS'] || '60000'));
    let nudgeSeq = 0;
    let nextNudgeAt = 0;
    const readFreshLevels = async (consumedOrderIds: ReadonlySet<string>): Promise<Map<string, LevelEntry>> => {
      const deadline = performance.now() + requoteTimeoutMs;
      const graceDeadline = performance.now() + Math.min(requoteTimeoutMs, 5_000);
      let nextLogAt = 0;
      for (;;) {
        const committed = decodeCommittedCrossRoutes(await readWithRateLimitRetry<unknown>(hub, `entity/${sourceHub.entityId}`));
        if (performance.now() >= nextLogAt) {
          nextLogAt = performance.now() + 10_000;
          const histogram = new Map<string, number>();
          for (const route of committed) {
            if (!route.orderId.startsWith('mmx-')) continue;
            const key = `${route.status}${consumedOrderIds.has(route.orderId) ? ':consumed' : ':fresh'}`;
            histogram.set(key, (histogram.get(key) ?? 0) + 1);
          }
          console.log(`[load] cross requote poll mmx status=${JSON.stringify(Object.fromEntries(histogram))}`);
        }
        let live: LevelEntry[] = [];
        try {
          live = selectMarketMakerCrossRoutes(committed, sourceHub.entityId, targetHub.entityId);
        } catch (error) {
          // Zero live routes is a legitimate requote window, not a failure.
          if (!(error instanceof Error) || !error.message.startsWith('PRODUCTION_SWAP_LOAD_CROSS_MM_ROUTE_MISSING')) throw error;
        }
        const byPair = new Map<string, LevelEntry>();
        for (const level of live) {
          const key = pairKeyOf(level);
          if (!cohortByPair.has(key) || byPair.has(key) || consumedOrderIds.has(level.orderId)) continue;
          byPair.set(key, level);
        }
        // Steady replenishment lands pair by pair (and some replacements go to
        // other hubs' books), so a volley proceeds with whatever fresh levels
        // this hub already shows instead of stalling for the full set.
        if (byPair.size === prepared.length) return byPair;
        if (byPair.size > 0 && performance.now() > graceDeadline) return byPair;
        if (performance.now() > deadline) {
          throw new Error(`PRODUCTION_SWAP_LOAD_CROSS_MM_REQUOTE_TIMEOUT:${byPair.size}:${prepared.length}`);
        }
        // Book-owner progress and clear requests land on the owner's next
        // entity frame; a quiescent hub never produces one. A minimal credit
        // bump keeps the book-owner entities framing while the maker requotes.
        if (process.env['XLN_CROSS_LOAD_REQUOTE_NUDGE'] === '1' && performance.now() >= nextNudgeAt) {
          nextNudgeAt = performance.now() + 1_000;
          nudgeSeq += 1;
          await sendObserved(hub, `prod-cross-requote-nudge-${nudgeSeq}`, {
            runtimeTxs: [],
            entityInputs: [{
              entityId: targetHub.entityId,
              signerId: targetHub.signerId,
              entityTxs: [{
                type: 'extendCredit',
                data: {
                  counterpartyEntityId: prepared[0]!.cohort.target.entityId,
                  tokenId: prepared[0]!.level.target.tokenId,
                  amount: 1n,
                },
              }],
            }],
          });
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    const hubWal = resolveWalPath(join(args.workDir, 'prod-mesh', 'h1'));
    const loadWal = resolveWalPath(join(args.workDir, 'prod-mesh', 'custody', 'daemon-db'));
    const hubWalBytesBefore = directoryBytes(hubWal);
    const loadWalBytesBefore = directoryBytes(loadWal);
    const startedAt = performance.now();
    // Volley mode: each round submits one atomic pair envelope per prepared
    // pair (the cross-j pair cohort admits exactly two legs per envelope),
    // waits until every route reaches committed full fill on both hub
    // entities, then re-reads the maker's fresh steady-quote levels. Economic
    // tps is total settled routes over the whole wall clock — requote latency
    // included, so the number is sustained, not burst.
    let observed = { enqueueAckElapsedMs: 0, commandObservedElapsedMs: 0 };
    let totalSettled = 0;
    let lastSettled: Awaited<ReturnType<typeof waitForSettledCrossRoute>> | undefined;
    let loadOrderId = '';
    let roundLevels = new Map(prepared.map(entry => [pairKeyOf(entry.level), entry.level]));
    for (let round = 0; round < rounds; round += 1) {
      const now = Date.now();
      const volley = prepared.flatMap((entry, index) => {
        const level = roundLevels.get(pairKeyOf(entry.level));
        if (!level) return [];
        return [{ entry, level, route: buildVolleyRoute(entry, level, `r${round}-${index}`, now) }];
      });
      if (volley.length === 0) throw new Error(`PRODUCTION_SWAP_LOAD_CROSS_ROUND_LEVEL_MISSING:${round}`);
      if (round === 0) loadOrderId = volley[0]!.route.orderId;
      for (const { entry, route } of volley) {
        const routeObserved = await sendObserved(load, route.orderId, {
          runtimeTxs: [],
          entityInputs: [
            { entityId: entry.cohort.target.entityId, signerId: entry.cohort.target.signerId, entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }] },
            { entityId: entry.cohort.source.entityId, signerId: entry.cohort.source.signerId, entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }] },
          ],
        });
        observed = {
          enqueueAckElapsedMs: Math.max(observed.enqueueAckElapsedMs, routeObserved.enqueueAckElapsedMs),
          commandObservedElapsedMs: Math.max(observed.commandObservedElapsedMs, routeObserved.commandObservedElapsedMs),
        };
      }
      const settledRound = await Promise.all(volley.map(({ level, route }) => waitForSettledCrossRoute(
        hub, sourceHub.entityId, targetHub.entityId, route.orderId,
        level.target.amount, level.source.amount,
      )));
      totalSettled += settledRound.length;
      lastSettled = settledRound[settledRound.length - 1]!;
      console.log(`[load] cross volley round=${round + 1}/${rounds} settled=${totalSettled} elapsedMs=${Math.ceil(performance.now() - startedAt)}`);
      if (round + 1 < rounds) {
        roundLevels = await readFreshLevels(new Set(volley.map(({ level }) => level.orderId)));
      }
    }
    const settled = lastSettled!;
    const economicCompletionElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    const report = decodeCrossLoadReport({
      schema: 'xln-production-cross-swap-load-v1', mode: 'cross', configuredBurstSize: burstSize,
      configuredRounds: rounds,
      settledRoutes: totalSettled,
      economicTps: totalSettled * 1_000 / Math.max(1, Math.ceil(performance.now() - startedAt)),
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
      environment: collectHltEnvironmentManifest({ engine: 'ts', requireAccountWorkers: true }),
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
