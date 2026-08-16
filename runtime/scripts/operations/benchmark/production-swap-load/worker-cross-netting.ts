/** Full production-stack two-jurisdiction netting experiment. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getJurisdictionStackId } from '../../../../jurisdiction/machine/jurisdiction-runtime';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
} from '../../../../protocol/boundary-validation';
import { safeStringify } from '../../../../protocol/serialization';
import {
  resolveMeshJurisdictionConfig,
  resolveSecondaryJurisdictions,
} from '../../../../orchestrator/mesh/mesh-jurisdictions';
import { readMeshSeedOverrides, resolveMeshRuntimeSeed } from '../../../../orchestrator/mesh/mesh-seeds';
import {
  decodeCommittedCrossRoutes,
  selectMarketMakerCrossRouteLevelByJurisdictions,
} from './cross/cross-boundary';
import { buildCrossNettingReport, decodeCrossNettingReport } from './cross/cross-netting-report';
import { commitCrossNettingManualMode } from './cross/worker-cross-netting-policy';
import { settleCrossNettingExposure } from './cross/worker-cross-netting-settlement';
import { accumulateCrossNettingTrades } from './cross/worker-cross-netting-trades';
import { setupCrossLoadCohort } from './cross/worker-cross-state';
import {
  decodeEntitySummaries,
  decodeHubCoreRecord,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
} from './worker-boundary';
import {
  connectRuntime,
  entryByLabel,
  persistReport,
  sendObserved,
  waitForCredit,
  type ConnectedRuntime,
  type WorkerArgs,
} from './worker-runtime';
import {
  importJurisdiction,
  resolveLoadJurisdictionRpc,
  toEntityJurisdiction,
} from './worker-cross';

const JURISDICTION_A_CHAIN_ID = 31_337;
const JURISDICTION_B_CHAIN_ID = 31_338;
const BRIDGE_TOKEN_ID = 1;
const FEE_TOKEN_ID = 3;
const TOKEN_DECIMALS = 6;
const CREDIT = 500_000n * 10n ** BigInt(TOKEN_DECIMALS);
const MANUAL_LIMIT = 0n;
const MAX_ACCEPTABLE_FEE = 100n * 10n ** BigInt(TOKEN_DECIMALS);
const FORWARD_TRADES = 10;
const REVERSE_TRADES = 8;
const MARKET_MAKER_LEVEL = 1;
const EXPERIMENT_TOTAL_STEPS = 9;

const logExperimentStep = (
  step: number,
  stage: string,
  status: 'start' | 'progress' | 'complete',
  details: Readonly<Record<string, unknown>> = {},
): void => {
  console.log(safeStringify({
    experiment: 'cross-netting',
    step,
    totalSteps: EXPERIMENT_TOTAL_STEPS,
    progress: `${step}/${EXPERIMENT_TOTAL_STEPS}`,
    stage,
    status,
    ...details,
  }));
};

type ExperimentIdentity = Readonly<{ entityId: string; signerId: string }>;

const identityForRouteHub = (
  entities: ReturnType<typeof decodeEntitySummaries>,
  runtimeId: string,
  entityId: string,
  chainId: number,
): ExperimentIdentity => {
  const matches = entities.filter(entity =>
    entity.runtimeId === runtimeId && entity.isHub === true && entity.signerId !== undefined &&
    entity.entityId.toLowerCase() === entityId.toLowerCase() &&
    Number(entity.jurisdiction?.chainId) === chainId
  );
  if (matches.length !== 1 || !matches[0]?.signerId) {
    throw new Error(`CROSS_NETTING_ROUTE_HUB_IDENTITY_NOT_UNIQUE:${entityId}:${chainId}`);
  }
  return { entityId: matches[0].entityId, signerId: matches[0].signerId };
};

const identityForRouteMarketMaker = (
  entities: ReturnType<typeof decodeEntitySummaries>,
  runtimeId: string,
  entityId: string,
  chainId: number,
): ExperimentIdentity => {
  const matches = entities.filter(entity =>
    entity.runtimeId === runtimeId && entity.signerId !== undefined &&
    entity.entityId.toLowerCase() === entityId.toLowerCase() &&
    Number(entity.jurisdiction?.chainId) === chainId
  );
  if (matches.length !== 1 || !matches[0]?.signerId) {
    throw new Error(`CROSS_NETTING_ROUTE_MM_IDENTITY_NOT_UNIQUE:${entityId}:${chainId}`);
  }
  return { entityId: matches[0].entityId, signerId: matches[0].signerId };
};

const requireZeroSwapFee = async (
  runtime: ConnectedRuntime,
  hubs: readonly ExperimentIdentity[],
): Promise<void> => {
  for (const hub of hubs) {
    const core = decodeHubCoreRecord(await runtime.adapter.read<unknown>(`entity/${hub.entityId}`));
    const config = requireBoundaryRecord(
      core['hubRebalanceConfig'],
      `CROSS_NETTING_HUB_CONFIG_MISSING:${hub.entityId}`,
    );
    const fee = requireBoundaryInteger(
      config['swapTakerFeeBps'],
      `CROSS_NETTING_HUB_SWAP_FEE_INVALID:${hub.entityId}`,
    );
    if (fee !== 0) throw new Error(`CROSS_NETTING_HUB_SWAP_FEE_NOT_ZERO:${hub.entityId}:${fee}`);
  }
};

const extendMutualCredit = async (
  hubRuntime: ConnectedRuntime,
  loadRuntime: ConnectedRuntime,
  hubA: ExperimentIdentity,
  hubB: ExperimentIdentity,
  userA: ExperimentIdentity,
  userB: ExperimentIdentity,
  commandId: string,
): Promise<void> => {
  const creditTxs = (counterpartyEntityId: string) => [BRIDGE_TOKEN_ID, FEE_TOKEN_ID].map(tokenId => ({
    type: 'extendCredit' as const,
    data: { counterpartyEntityId, tokenId, amount: CREDIT },
  }));
  await sendObserved(hubRuntime, commandId, {
    runtimeTxs: [],
    entityInputs: [
      { entityId: hubA.entityId, signerId: hubA.signerId, entityTxs: creditTxs(userA.entityId) },
      { entityId: hubB.entityId, signerId: hubB.signerId, entityTxs: creditTxs(userB.entityId) },
    ],
  });
  await Promise.all([
    waitForCredit(loadRuntime, userA.entityId, hubA.entityId, BRIDGE_TOKEN_ID, CREDIT),
    waitForCredit(loadRuntime, userB.entityId, hubB.entityId, BRIDGE_TOKEN_ID, CREDIT),
    waitForCredit(loadRuntime, userA.entityId, hubA.entityId, FEE_TOKEN_ID, MAX_ACCEPTABLE_FEE),
    waitForCredit(loadRuntime, userB.entityId, hubB.entityId, FEE_TOKEN_ID, MAX_ACCEPTABLE_FEE),
    waitForCredit(hubRuntime, hubA.entityId, userA.entityId, BRIDGE_TOKEN_ID, CREDIT),
    waitForCredit(hubRuntime, hubB.entityId, userB.entityId, BRIDGE_TOKEN_ID, CREDIT),
  ]);
};

export const runCrossNettingExperiment = async (args: WorkerArgs): Promise<void> => {
  logExperimentStep(1, 'runtime-connections', 'start');
  if (args.swaps !== 1) throw new Error('CROSS_NETTING_EXPERIMENT_REQUIRES_SINGLE_RUN');
  process.env['XLN_JURISDICTIONS_PATH'] = join(args.workDir, 'prod-main', 'jurisdictions.json');
  const meshRootSeed = readFileSync(join(args.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  if (!meshRootSeed) throw new Error('CROSS_NETTING_MESH_ROOT_SEED_MISSING');
  const custodyRuntimeSeed = resolveMeshRuntimeSeed(
    meshRootSeed,
    readMeshSeedOverrides(process.env['XLN_MESH_RUNTIME_SEEDS_JSON'], 'XLN_MESH_RUNTIME_SEEDS_JSON'),
    'CUSTODY',
  );
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(
    join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json'), 'utf8',
  )) as unknown);
  const hubRuntime = await connectRuntime(entryByLabel(entries, 'H1'));
  const marketMakerRuntime = await connectRuntime(entryByLabel(entries, 'MM'));
  const loadRuntime = await connectRuntime(
    entryByLabel(entries, 'Custody'),
    `ws://127.0.0.1:${args.portBase + 8}/rpc`,
  );
  logExperimentStep(1, 'runtime-connections', 'complete', {
    hubRuntimeId: hubRuntime.adapter.runtimeId,
    marketMakerRuntimeId: marketMakerRuntime.adapter.runtimeId,
    loadRuntimeId: loadRuntime.adapter.runtimeId,
  });
  try {
    logExperimentStep(2, 'topology-and-routes', 'start');
    const entities = decodeEntitySummaries(await hubRuntime.adapter.read<unknown>('entities'));
    const marketMakerEntities = decodeEntitySummaries(
      await marketMakerRuntime.adapter.read<unknown>('entities'),
    );
    const apiBaseUrl = `http://127.0.0.1:${args.portBase + 4}`;
    const jurisdictionAConfig = resolveMeshJurisdictionConfig(`${apiBaseUrl}/rpc`);
    const rawJurisdictionB = resolveSecondaryJurisdictions(jurisdictionAConfig.rpc)
      .find(value => value.chainId === JURISDICTION_B_CHAIN_ID);
    if (!rawJurisdictionB) throw new Error('CROSS_NETTING_JURISDICTION_B_MISSING');
    const jurisdictionBConfig = {
      ...rawJurisdictionB,
      rpc: resolveLoadJurisdictionRpc(rawJurisdictionB.rpc, apiBaseUrl),
    };
    const jurisdictionA = toEntityJurisdiction(jurisdictionAConfig);
    const jurisdictionB = toEntityJurisdiction(jurisdictionBConfig);
    const jurisdictionAId = getJurisdictionStackId(jurisdictionA);
    const jurisdictionBId = getJurisdictionStackId(jurisdictionB);
    const localHubEntities = entities.filter(entity =>
      entity.runtimeId === hubRuntime.adapter.runtimeId && entity.isHub === true
    );
    const routeSets = await Promise.all(localHubEntities.map(entity =>
      hubRuntime.adapter.read<unknown>(
        `entity/${entity.entityId}`,
        { tokenId: BRIDGE_TOKEN_ID },
      ).then(decodeCommittedCrossRoutes)
    ));
    const routes = [...new Map(
      routeSets.flat().map(route => [route.orderId, route] as const),
    ).values()];
    const routeAtoB = selectMarketMakerCrossRouteLevelByJurisdictions(
      routes, jurisdictionAId, jurisdictionBId, BRIDGE_TOKEN_ID, MARKET_MAKER_LEVEL,
    );
    const routeBtoA = selectMarketMakerCrossRouteLevelByJurisdictions(
      routes, jurisdictionBId, jurisdictionAId, BRIDGE_TOKEN_ID, MARKET_MAKER_LEVEL,
    );
    const hubA = identityForRouteHub(
      entities, hubRuntime.adapter.runtimeId,
      routeAtoB.source.counterpartyEntityId, JURISDICTION_A_CHAIN_ID,
    );
    const hubB = identityForRouteHub(
      entities, hubRuntime.adapter.runtimeId,
      routeAtoB.target.entityId, JURISDICTION_B_CHAIN_ID,
    );
    if (
      routeBtoA.source.counterpartyEntityId.toLowerCase() !== hubB.entityId.toLowerCase() ||
      routeBtoA.target.entityId.toLowerCase() !== hubA.entityId.toLowerCase() ||
      routeBtoA.source.entityId.toLowerCase() !== routeAtoB.target.counterpartyEntityId.toLowerCase() ||
      routeBtoA.target.counterpartyEntityId.toLowerCase() !== routeAtoB.source.entityId.toLowerCase()
    ) throw new Error('CROSS_NETTING_MM_ROUTE_PAIR_MISMATCH');
    const marketMakerA = identityForRouteMarketMaker(
      marketMakerEntities, marketMakerRuntime.adapter.runtimeId,
      routeAtoB.source.entityId, JURISDICTION_A_CHAIN_ID,
    );
    const marketMakerB = identityForRouteMarketMaker(
      marketMakerEntities, marketMakerRuntime.adapter.runtimeId,
      routeAtoB.target.counterpartyEntityId, JURISDICTION_B_CHAIN_ID,
    );
    await requireZeroSwapFee(hubRuntime, [hubA, hubB]);
    const bookOwnerEntityId = routeAtoB.bookOwnerEntityId;
    if (!bookOwnerEntityId) {
      throw new Error(`CROSS_NETTING_BOOK_OWNER_MISSING:${routeAtoB.orderId}`);
    }
    if (
      jurisdictionAId !== routeAtoB.source.jurisdiction ||
      jurisdictionBId !== routeAtoB.target.jurisdiction ||
      jurisdictionBId !== routeBtoA.source.jurisdiction ||
      jurisdictionAId !== routeBtoA.target.jurisdiction
    ) throw new Error('CROSS_NETTING_ROUTE_JURISDICTION_MISMATCH');
    logExperimentStep(2, 'topology-and-routes', 'complete', {
      hubA: hubA.entityId,
      hubB: hubB.entityId,
      marketMakerA: marketMakerA.entityId,
      marketMakerB: marketMakerB.entityId,
      routeAtoB: routeAtoB.orderId,
      routeBtoA: routeBtoA.orderId,
    });

    logExperimentStep(3, 'load-cohort', 'start');
    await importJurisdiction(loadRuntime, jurisdictionBConfig);
    const cohort = await setupCrossLoadCohort({
      runtime: loadRuntime,
      relayUrl: `ws://127.0.0.1:${args.portBase + 4}/relay`,
      sourceHubEntityId: hubA.entityId,
      targetHubEntityId: hubB.entityId,
      sourceJurisdiction: jurisdictionA,
      targetJurisdiction: jurisdictionB,
      sourceTokenId: BRIDGE_TOKEN_ID,
      targetTokenId: BRIDGE_TOKEN_ID,
      additionalCreditTokenIds: [FEE_TOKEN_ID],
      sourceCredit: CREDIT,
      targetCredit: CREDIT,
      custodyRuntimeSeed,
    });
    logExperimentStep(3, 'load-cohort', 'complete', {
      userA: cohort.source.entityId,
      userB: cohort.target.entityId,
    });
    const before = decodeLoadFrame(await hubRuntime.adapter.read<unknown>('frame/latest'));
    const prefix = `cross-netting-${before.height}`;
    logExperimentStep(4, 'mutual-credit', 'start');
    await extendMutualCredit(
      hubRuntime, loadRuntime, hubA, hubB, cohort.source, cohort.target,
      `${prefix}-mutual-credit`,
    );
    logExperimentStep(4, 'mutual-credit', 'complete');
    logExperimentStep(5, 'user-manual-mode', 'start');
    await commitCrossNettingManualMode({
      runtime: loadRuntime,
      accounts: [
        { owner: cohort.source, counterparty: hubA },
        { owner: cohort.target, counterparty: hubB },
      ],
      tokenId: BRIDGE_TOKEN_ID,
      manualLimit: MANUAL_LIMIT,
      maxAcceptableFee: MAX_ACCEPTABLE_FEE,
      commandId: `${prefix}-manual-mode`,
    });
    logExperimentStep(5, 'user-manual-mode', 'complete');
    logExperimentStep(6, 'market-maker-manual-mode', 'start');
    await commitCrossNettingManualMode({
      runtime: marketMakerRuntime,
      accounts: [
        { owner: marketMakerA, counterparty: hubA },
        { owner: marketMakerB, counterparty: hubB },
      ],
      tokenId: BRIDGE_TOKEN_ID,
      manualLimit: MANUAL_LIMIT,
      maxAcceptableFee: MAX_ACCEPTABLE_FEE,
      commandId: `${prefix}-mm-manual-mode`,
    });
    logExperimentStep(6, 'market-maker-manual-mode', 'complete');
    console.log(safeStringify({
      stage: 'cross-netting:manual-mode-ready',
      userAccounts: [
        { owner: cohort.source.entityId, counterparty: hubA.entityId },
        { owner: cohort.target.entityId, counterparty: hubB.entityId },
      ],
      marketMakerAccounts: [
        { owner: marketMakerA.entityId, counterparty: hubA.entityId },
        { owner: marketMakerB.entityId, counterparty: hubB.entityId },
      ],
      tokenId: BRIDGE_TOKEN_ID,
      softLimit: MANUAL_LIMIT,
      hardLimit: MANUAL_LIMIT,
    }));
    logExperimentStep(7, 'trade-accumulation', 'start', {
      forwardTrades: FORWARD_TRADES,
      reverseTrades: REVERSE_TRADES,
      totalTrades: FORWARD_TRADES + REVERSE_TRADES,
    });
    const accumulation = await accumulateCrossNettingTrades({
      hubRuntime,
      loadRuntime,
      marketMakerRuntime,
      bookOwnerEntityId,
      hubA,
      hubB,
      userA: cohort.source,
      userB: cohort.target,
      marketMakerA,
      marketMakerB,
      tokenId: BRIDGE_TOKEN_ID,
      marketMakerLevel: MARKET_MAKER_LEVEL,
      forwardTrades: FORWARD_TRADES,
      reverseTrades: REVERSE_TRADES,
      orderIdPrefix: `${prefix}-trade`,
      onProgress: (stage, details) =>
        logExperimentStep(7, stage, 'progress', details),
    });
    logExperimentStep(7, 'trade-accumulation', 'complete', {
      completedTrades: accumulation.trades.length,
    });
    console.log(safeStringify({
      stage: 'cross-netting:accumulation-complete',
      trades: accumulation.trades.length,
      jurisdictionA: {
        reserveBefore: accumulation.baseline.hubA.reserve,
        reserveAfter: accumulation.accumulated.hubA.reserve,
        userOffdelta: accumulation.accumulated.jurisdictionA.user.offdelta,
        marketMakerOffdelta: accumulation.accumulated.marketMakerA.marketMaker.offdelta,
      },
      jurisdictionB: {
        reserveBefore: accumulation.baseline.hubB.reserve,
        reserveAfter: accumulation.accumulated.hubB.reserve,
        userOffdelta: accumulation.accumulated.jurisdictionB.user.offdelta,
        marketMakerOffdelta: accumulation.accumulated.marketMakerB.marketMaker.offdelta,
      },
    }));
    logExperimentStep(8, 'explicit-settlement', 'start');
    const settlement = await settleCrossNettingExposure({
      hubRuntime,
      loadRuntime,
      marketMakerRuntime,
      hubA,
      hubB,
      userA: cohort.source,
      userB: cohort.target,
      marketMakerA,
      marketMakerB,
      tokenId: BRIDGE_TOKEN_ID,
      feeTokenId: FEE_TOKEN_ID,
      accumulated: accumulation.accumulated,
      commandId: `${prefix}-settle-net`,
      onProgress: (stage, details) =>
        logExperimentStep(8, stage, 'progress', details),
    });
    logExperimentStep(8, 'explicit-settlement', 'complete', {
      jurisdiction: settlement.requestedJurisdiction,
      amount: settlement.requestedAmount,
    });
    logExperimentStep(9, 'report', 'start');
    const report = buildCrossNettingReport({
      config: {
        jurisdictionA: getJurisdictionStackId(jurisdictionA),
        jurisdictionB: getJurisdictionStackId(jurisdictionB),
        tokenId: BRIDGE_TOKEN_ID,
        tokenSymbol: 'USDC',
        tokenDecimals: TOKEN_DECIMALS,
        feeTokenId: FEE_TOKEN_ID,
        swapFeeBps: 0,
        forwardTrades: FORWARD_TRADES,
        reverseTrades: REVERSE_TRADES,
        marketMakerLevel: MARKET_MAKER_LEVEL,
        manualSoftLimit: MANUAL_LIMIT.toString(),
        manualHardLimit: MANUAL_LIMIT.toString(),
      },
      ...accumulation,
      rebalanceRequested: settlement.rebalanceRequested,
      finalized: settlement.finalized,
    });
    persistReport(
      join(args.workDir, 'cross-j-netting-experiment-report.json'),
      report,
      decodeCrossNettingReport,
    );
    logExperimentStep(9, 'report', 'complete', {
      reportPath: join(args.workDir, 'cross-j-netting-experiment-report.json'),
    });
    console.log(safeStringify(report));
  } finally {
    hubRuntime.adapter.disconnect();
    marketMakerRuntime.adapter.disconnect();
    loadRuntime.adapter.disconnect();
  }
};
