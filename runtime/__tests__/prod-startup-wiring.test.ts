import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOrchestratorProxyHandlers } from '../orchestrator/proxy';

const repoRoot = process.cwd();

describe('production startup wiring', () => {
  test('start-server exposes the secondary Tron RPC to the orchestrator and children', () => {
    const script = readFileSync(join(repoRoot, 'scripts/start-server.sh'), 'utf8');
    expect(script).toContain('RPC2_PORT="${ANVIL2_PORT:-$(xln_rpc2_port)}"');
    expect(script).toContain('export ANVIL_RPC2="${ANVIL_RPC2:-http://127.0.0.1:${RPC2_PORT}}"');
    expect(script).toContain('export RPC_TRON="${RPC_TRON:-$ANVIL_RPC2}"');
    expect(script).toContain('export RELAY_URL=${RELAY_URL:-$INTERNAL_RELAY_URL}');
    expect(script).toContain('--relay-url "$RELAY_URL"');
    expect(script).toContain('--rpc2-url "$ANVIL_RPC2"');
    expect(script).toContain('export XLN_RUNTIME_EXIT_ON_FATAL=${XLN_RUNTIME_EXIT_ON_FATAL:-1}');
    expect(script).toContain('export XLN_STORAGE_WRITE_TIMEOUT_MS=${XLN_STORAGE_WRITE_TIMEOUT_MS:-60000}');

    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const orchestratorConfig = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator-config.ts'), 'utf8');
    const runtimeEntityRouting = readFileSync(join(repoRoot, 'runtime/runtime-entity-routing.ts'), 'utf8');
    expect(orchestratorConfig).toContain("relayUrl: normalizeWsUrl(getArg('--relay-url', process.env['RELAY_URL'] || '')");
    expect(orchestratorConfig).toContain("const RPC_PROXY_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8] as const;");
    expect(orchestrator).toContain('const relayUrl = args.relayUrl;');
    expect(orchestrator).toContain("process.env['XLN_CHILD_HEALTH_TIMEOUT_MS'] || '30000'");
    expect(orchestrator).toContain("process.env['XLN_MARKET_MAKER_INFO_TIMEOUT_MS'] || '1500'");
    expect(orchestrator).toContain("process.env['XLN_CHILD_SHUTDOWN_QUIESCE_MS'] || '5000'");
    expect(orchestrator).toContain('const CHILD_RESET_QUIESCE_TIMEOUT_MS = 45_000;');
    expect(orchestrator).toContain('await stopAllChildren({');
    expect(orchestrator).toContain('quiesceRounds: 1');
    expect(orchestrator).toContain('quiesceTimeoutMs: CHILD_SHUTDOWN_QUIESCE_TIMEOUT_MS');
    expect(orchestrator).toContain('let hubHealthPollInFlight: Promise<void> | null = null;');
    expect(orchestrator).toContain('if (hubHealthPollInFlight) return hubHealthPollInFlight;');
    expect(orchestrator).toContain('let marketMakerHealthPollInFlight: Promise<void> | null = null;');
    expect(orchestrator).toContain('if (marketMakerHealthPollInFlight) return marketMakerHealthPollInFlight;');
    expect(orchestrator).toContain("fetchJson<MarketMakerHealthPayload>(`${apiBase}/api/health`, CHILD_HEALTH_TIMEOUT_MS)");
    expect(orchestrator).not.toContain('const [health, info] = await Promise.all([');
    expect(orchestrator).toContain('if (!health && !marketMakerChild.lastInfo) {');
    expect(orchestrator).toContain("fetchJson<MarketMakerInfoPayload>(`${apiBase}/api/info`, MARKET_MAKER_INFO_TIMEOUT_MS)");
    expect(orchestrator).toContain('const mmHealthReady = Boolean(marketMakerChild.lastHealth?.marketMaker);');
    expect(orchestrator).toContain('const mmOk = !args.mmEnabled');
    expect(orchestrator).toContain('marketMakerActive &&');
    const waitForMarketMakerReady = orchestrator.slice(orchestrator.indexOf('const waitForMarketMakerReady = async (): Promise<void> => {'));
    expect(waitForMarketMakerReady.indexOf('if (marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null)')).toBeLessThan(
      waitForMarketMakerReady.indexOf('health.marketMaker.ok'),
    );
    expect(orchestrator.indexOf('marketMakerChild.lastHealth = health;')).toBeLessThan(
      orchestrator.indexOf('if (info) marketMakerChild.lastInfo = info;'),
    );
    expect(orchestrator).toContain('if (info) marketMakerChild.lastInfo = info;');
    expect(orchestrator).toContain('if (health) {');
    expect(orchestrator).toContain('marketMakerChild.lastHealth = health;');
    expect(orchestrator).toContain('if (health.startupPhase !== undefined) nextInfo.startupPhase = health.startupPhase;');
    expect(orchestrator).toContain('const mmChildDepthReady = marketMakerChild.lastHealth?.marketMaker?.ok === true;');
    expect(orchestrator).toContain('mmChildDepthReady &&');
    expect(orchestrator).toContain('mmHubs.every((hub) => hub.depthReady) &&');
    expect(orchestrator).toContain('routes.every(route => route.depthReady)');
    expect(orchestrator).toContain('health.marketMaker.hubs.every(hub => hub.depthReady)');
    expect(orchestrator).toContain('syncCanonicalJurisdictionsFromShard(jurisdictionsConfig)');
    expect(readFileSync(join(repoRoot, 'runtime/orchestrator/jurisdictions.ts'), 'utf8'))
      .toContain('const seedPath = existsSync(canonicalPath) ? canonicalPath : resolveRepoJurisdictionsJsonPath();');
    expect(orchestrator).toContain('const buildSecondaryRpcArgs = (): string[] => {');
    expect(orchestrator).toContain('const buildRpcChildEnv = (): Record<string, string> => {');
    expect(orchestrator).toContain('const rpcProxyIndex = resolveRpcProxyIndex(pathname);');
    expect(orchestrator).toContain("return await proxyRpc(request, args.rpcUrls[rpcProxyIndex] || '');");
    expect(orchestrator).toContain("XLN_RUNTIME_EXIT_ON_FATAL: process.env['XLN_RUNTIME_EXIT_ON_FATAL'] ?? '1'");
    expect(orchestrator).toContain("XLN_STORAGE_WRITE_TIMEOUT_MS: process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] ?? '60000'");
    expect(orchestrator).toContain("XLN_LOG_LEVEL: process.env['XLN_HUB_LOG_LEVEL'] ?? process.env['XLN_LOG_LEVEL'] ?? 'warn'");
    expect(runtimeEntityRouting).toContain('const shouldExitOnRuntimeFatal = (runtimeProcess = getRuntimeProcessGlobal()): boolean =>');
    expect(runtimeEntityRouting).toContain("runtimeProcess.exit(1);");
    expect(orchestrator).toContain("XLN_STORAGE_SYNC_WRITES: process.env['XLN_STORAGE_SYNC_WRITES'] ?? '0'");
    expect(orchestrator).toContain("XLN_MARKET_MAKER_DISABLE_STORAGE: process.env['XLN_MARKET_MAKER_DISABLE_STORAGE'] ?? '1'");
    expect(orchestrator).toContain("XLN_DISABLE_RUNTIME_RESTORE: process.env['XLN_MARKET_MAKER_DISABLE_RESTORE'] ?? process.env['XLN_DISABLE_RUNTIME_RESTORE'] ?? '1'");
    expect(orchestrator).toContain("XLN_LOG_LEVEL: process.env['XLN_MARKET_MAKER_LOG_LEVEL'] ?? process.env['XLN_LOG_LEVEL'] ?? 'warn'");
    expect(orchestrator).toContain('const getMarketMakerIdentities = (): MarketMakerSupportPeerIdentity[] => {');
    expect(orchestrator).toContain('deriveMarketMakerEntityId(signerId, toMarketMakerEntityJurisdictionConfig(jurisdiction))');
    expect(orchestrator).toContain('resolveSecondaryJurisdictions<MarketMakerJurisdictionConfig>(primary.rpc)');
    expect(orchestrator).toContain('`${marketMakerChild.signerLabel}:${secondaryName}`');
    expect(orchestrator).toContain('jurisdictionName: jurisdiction.name');
    expect(orchestrator).toContain("'--support-peer-identities-json', JSON.stringify(getMarketMakerIdentities())");
    expect(orchestrator).not.toContain('JSON.stringify([getMarketMakerIdentity()])');
    expect(orchestrator).toContain('const getExitedHubChild = (): HubChild | null =>');
    expect(orchestrator).toContain('HUB_EXITED_DURING_MM_READY name=${exitedHub.name}');
    expect(orchestrator).toContain('hubsOnline &&');

    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const runtimeTxHandlers = readFileSync(join(repoRoot, 'runtime/runtime-tx-handlers.ts'), 'utf8');
    const jadapterTypes = readFileSync(join(repoRoot, 'runtime/jadapter/types.ts'), 'utf8');
    const rpcAdapter = readFileSync(join(repoRoot, 'runtime/jadapter/rpc.ts'), 'utf8');
    expect(hubNode).toContain('const readRpcUrls = (): Record<number, string> => {');
    expect(hubNode).toContain("const match = raw.match(/^\\/(?:api\\/)?rpc([2-8])?(?:\\?.*)?$/);");
    expect(hubNode).toContain('visibleDirectSupportPeers');
    expect(hubNode).toContain('jurisdictionName: normalizeJurisdictionDisplayName(entry?.jurisdictionName || \'\')');
    expect(hubNode).toContain('normalizeJurisdictionKey(identity.jurisdictionName) !== normalizedJurisdiction');
    expect(hubNode).toContain('for (const hubBootstrap of hubBootstraps)');
    expect(hubNode).not.toContain('if (!runtimeId || !openRuntimeIds.has(runtimeId)) return null;');
    expect(hubNode).toContain('entityAdapter = getEntityJAdapter(env, entityId);');
    expect(hubNode).toContain("if (!message.startsWith('ENTITY_JURISDICTION_MISSING')) throw error;");
    expect(hubNode).toContain('const activeAdapter = getActiveJAdapter(env);');
    expect(hubNode).not.toContain("return requireJAdapterForEntity(env, entityId, 'DEBUG_RESERVE');");
    expect(hubNode).toContain('const configureHubRuntimeLogging = (env: Env): void => {');
    expect(hubNode).toContain("if (envFlagEnabled(process.env['XLN_HUB_VERBOSE_RUNTIME_LOGS'])) return;");
    expect(hubNode).toContain('env.quietRuntimeLogs = true;');
    expect(hubNode).toContain('configureHubRuntimeLogging(env);');
    expect(orchestrator).toContain('MARKET_MAKER_CREDIT_AMOUNT.toString()');
    expect(orchestrator).not.toContain("creditAmount: '50000000000000000000000000'");
    expect(mmNode).toContain('const readRpcUrls = (): Record<number, string> => {');
    expect(mmNode).toContain("const match = raw.match(/^\\/(?:api\\/)?rpc([2-8])?(?:\\?.*)?$/);");
    expect(mmNode).toContain('buildMarketMakerConsensusConfig(signerId, entityJurisdiction)');
    expect(mmNode).toContain('deriveMarketMakerEntityId(signerId, entityJurisdiction)');
    expect(mmNode).toContain('isCanonicalAccountOpener(mmEntityId, hubEntityId)');
    expect(mmNode).toContain('Runtime storage disabled for rebuildable market-maker state');
    expect(mmNode).toContain('const configureMarketMakerRuntimeLogging = (env: Env): void => {');
    expect(mmNode).toContain("if (envFlagEnabled(process.env['XLN_MARKET_MAKER_VERBOSE_RUNTIME_LOGS'])) return;");
    expect(mmNode).toContain('env.quietRuntimeLogs = true;');
    const runtimeSource = readFileSync(join(repoRoot, 'runtime/runtime.ts'), 'utf8');
    expect(runtimeSource).toContain('const runtimeLoopTickDelayMs = Math.max(0, Math.floor(Number(config?.tickDelayMs ?? 0)));');
    expect(runtimeSource).toContain('maxEntityInputsPerFrame?: number');
    expect(runtimeSource).toContain('const applyEntityInputFrameCap =');
    expect(runtimeSource).toContain('mempool.entityInputs = [...deferredInputs, ...mempool.entityInputs];');
    expect(runtimeSource).toContain('if (remoteOutputs.length > 0 && env.quietRuntimeLogs !== true)');
    expect(runtimeSource).not.toContain('void config;');
    expect(mmNode).toContain("MARKET_MAKER_RUNTIME_TICK_DELAY_MS'] || '10'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '1000'");
    expect(mmNode).toContain('maxEntityInputsPerFrame: MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME');
    expect(mmNode).toContain('const pushMarketMakerEntityTx = (');
    expect(mmNode).toContain('const entityInputsByEntitySigner = new Map<string, EntityInput>();');
    expect(mmNode).toContain('const waitForActiveJAdapter = async (env: Env, jurisdictionName: string, rounds = 1200)');
    expect(mmNode).toContain('ACTIVE_JADAPTER_NOT_READY name=${jurisdictionName}');
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS'] || '1500000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '25'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_START_DELAY_MS'] || '0'");
    expect(mmNode).toContain("MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_CROSS_LEVELS_PER_PAIR'] || '3'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_LEVELS_PER_PAIR'] || '10'");
    expect(mmNode).not.toContain("MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK'] || '6'");
    expect(mmNode).not.toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] || '6'");
    expect(mmNode).toContain("role: 'source-mm-hub' | 'target-mm-hub';");
    expect(mmNode).toContain('const describeMarketMakerAccountBlocker = (');
    expect(mmNode).toContain("reason: 'missing-account' | 'inactive-account' | 'height-zero' | 'pending-frame' | 'mempool';");
    expect(mmNode).toContain('const publishMarketMakerHealthSnapshot = (options: { includeCross?: boolean } = {}): MarketMakerHealth | null => {');
    expect(mmNode).toContain('if (health) cachedMarketMakerHealth = health;');
    expect(mmNode).toContain('const shouldStartJWatcherAtCurrentBlock = (): boolean =>');
    expect(mmNode).toContain("!envFlagEnabled(process.env['XLN_MARKET_MAKER_REPLAY_HISTORICAL_J_EVENTS'])");
    expect(mmNode).toContain('startAtCurrentBlock: shouldStartJWatcherAtCurrentBlock()');
    expect(runtimeTxHandlers).toContain('const initialBlockNumber = await resolveInitialJBlockNumber(jadapter, runtimeTx);');
    expect(runtimeTxHandlers).toContain('IMPORT_J_CURRENT_BLOCK_UNAVAILABLE');
    expect(runtimeTxHandlers).toContain('IMPORT_J_CURRENT_BLOCK_INVALID');
    expect(runtimeTxHandlers).toContain('blockNumber: initialBlockNumber');
    expect(jadapterTypes).toContain('getCurrentBlockNumber?(): Promise<number>;');
    expect(rpcAdapter).toContain('async getCurrentBlockNumber(): Promise<number> {');
    expect(rpcAdapter).toContain('return await provider.getBlockNumber();');
    expect(mmNode).toContain('const selectMarketMakerBootstrapTokenIds = (tokenIds: readonly number[]): number[] => {');
    expect(mmNode).toContain('return unique;');
    expect(mmNode).not.toContain('return unique.slice(0, HUB_REQUIRED_TOKEN_COUNT);');
    expect(mmNode).toContain('const hasCrossSpecBootstrapProgress = (');
    expect(mmNode).toContain('const computeCrossOrderbookPriceTicks = (');
    expect(mmNode).toContain('priceTicks: amounts.priceTicks');
    expect(mmNode).toContain('hasCrossRouteRegistered(env, route.source.entityId, route.orderId)');
    expect(mmNode).toContain('hasCrossRouteRegistered(env, route.source.counterpartyEntityId, route.orderId)');
    expect(mmNode).toContain('countCrossSpecBootstrapProgressByPair(env, specs, getPendingCrossRequestOrderIds)');
    expect(mmNode).toContain('const visibleByPair = countCrossSpecVisibleOffersByPair(env, specs);');
    expect(mmNode).toContain('countCrossPairCoverageGaps(env, right[1]) -');
    expect(mmNode).toContain('(visibleByPair.get(left.pairId) || 0) - (visibleByPair.get(right.pairId) || 0)');
    expect(mmNode).toContain("MARKET_MAKER_RUNTIME_TICK_DELAY_MS'] || '10'");
    expect(mmNode).toContain("MARKET_MAKER_API_YIELD_MS'] || '1'");
    expect(mmNode).toContain('const yieldMarketMakerApi = async (): Promise<void> => {');
    expect(mmNode).toContain('await new Promise<void>(resolve => setTimeout(resolve, MARKET_MAKER_API_YIELD_MS));');
    expect(mmNode).not.toContain('setImmediate(resolve)');
    expect(mmNode).not.toContain('await sleep(0);');
    expect(mmNode).toContain("MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK'] || '1000'");
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_OFFERS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_CROSS_DEPTH_REQUESTS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('MARKET_MAKER_BOOTSTRAP_CROSS_ROUTE_JOBS_PER_TICK');
    expect(mmNode).toContain("MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK'] || '1000'");
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_CONNECTIVITY_TXS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('type MarketMakerCrossOfferBudget = {');
    expect(mmNode).toContain('const hasMarketMakerAccountBacklog = (');
    expect(mmNode).toContain('const hasMarketMakerRuntimeBacklog = (env: Env): boolean => {');
    expect(mmNode).toContain('Boolean(env.runtimeState?.processingPromise)');
    expect(mmNode).toContain('if (hasMarketMakerRuntimeBacklog(env)) return;');
    expect(mmNode).toContain('const quoteableHubsFor = (context: MarketMakerEntityContext): HubProfile[] =>');
    expect(mmNode).toContain('.filter(profile => !hasMarketMakerAccountBacklog(env, context.entityId, profile.entityId));');
    expect(mmNode).toContain('): Promise<boolean> => {\n  const localCreditInputsByEntity = new Map<string, EntityInput>();');
    expect(mmNode).toContain('const pushLocalConnectivityTx = (');
    expect(mmNode).toContain('const maintainSameContextQuotes = async (context: MarketMakerEntityContext): Promise<boolean> => {');
    expect(mmNode).toContain('if (await maintainSameContextQuotes(context)) return;');
    expect(mmNode).toContain('const entityInputsByEntitySigner = new Map<string, EntityInput>();');
    expect(mmNode).toContain('pushMarketMakerEntityTx(');
    expect(mmNode).not.toContain('const missingByPair = new Map<string, MarketMakerOfferSpec[]>();');
    expect(mmNode).not.toContain('const missingByEntityAndPair = new Map<string, MarketMakerOfferSpec[]>();');
    expect(mmNode).toContain('entityInputs,');
    expect(mmNode).not.toContain('const hasMarketMakerQuoteBacklog = (');
    expect(mmNode).not.toContain('if (hasPendingRuntimeWork(env)) return true;');
    expect(mmNode).not.toContain('!hasMarketMakerQuoteBacklog(env, mmContexts, visibleHubs)');
    expect(mmNode).not.toContain('const primarySameReady =');
    expect(mmNode).toContain('const primarySameDepthReady = isMarketMakerSameDepthComplete(healthBeforeQuotes);');
    expect(mmNode).toContain("if (mode !== 'bootstrap' || !primarySameDepthReady) {");
    expect(mmNode).not.toContain('const reserveCrossOfferBudget = (');
    expect(mmNode).not.toContain('remainingOffersTotal: MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK');
    expect(mmNode).toContain('route.source.counterpartyEntityId');
    expect(mmNode).not.toContain('coverageOnly');
    expect(mmNode).toContain('bootstrapCrossCursor');
    expect(mmNode).toContain('steadyCrossCursor');
    expect(mmNode).toContain('const selectedCrossQuoteJobs: Array<{ index: number; job: CrossQuoteJob }>');
    expect(mmNode).toContain('advanceCrossCursorAfterEnqueue(entry.index)');
    expect(mmNode).toContain("advanceCrossCursorAfterEnqueue(entry.index);\n          await yieldMarketMakerApi();\n          return;");
    expect(mmNode).not.toContain("if (mode !== 'bootstrap') return;");
    expect(mmNode).not.toContain("const sameQuoteContexts = mode === 'bootstrap' ? mmContexts.slice(0, 1) : mmContexts;");
    expect(mmNode).toContain("const jobCount = mode === 'bootstrap'");
    expect(mmNode).toContain('? crossQuoteJobs.length');
    expect(mmNode).toContain('MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK');
    expect(mmNode).toContain('if (!health?.hubs.every((hub) => hub.depthReady)) return;');
    expect(mmNode).toContain('if (isMarketMakerDepthComplete(health)) return;');
    expect(mmNode).toContain('const hubsDepthReady = hubs.length > 0 && hubs.every((entry) => entry.depthReady);');
    expect(mmNode).toContain('const crossDepthReady = !cross.applicable || (');
    expect(mmNode).toContain('cross.routes.every((route) => route.depthReady)');
    expect(mmNode).toContain('ok: hubsDepthReady && crossDepthReady');
    expect(mmNode).toContain('countCommittedMarketMakerOffersForHub(env, mmEntityId, hubEntityId)');
    expect(mmNode).toContain('countCommittedMarketMakerOffersForHubPair(env, mmEntityId, hubEntityId, pair)');
    expect(mmNode).toContain('blockers: blocker ? [blocker] : []');
    expect(mmNode).toContain('accountReady && expectedHubOffers > 0');
    expect(mmNode).toContain('MARKET_MAKER_BOOTSTRAP_INCOMPLETE');
    expect(mmNode).toContain('BOOTSTRAP_READY_HASH');
    expect(mmNode).toContain('const health = assertMarketMakerBootstrapFinalized(');
    expect(mmNode).not.toContain('const hubsReady = hubs.length > 0 && hubs.every((entry) => entry.ready);');
    expect(mmNode).not.toContain('ok: hubsReady && crossReady');
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_OFFERS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_CONNECTIVITY_TXS_PER_ENTITY_INPUT');
    expect(mmNode).toContain('collectQueuedSwapOfferIds(env, mmEntityId, hubEntityId)');
    expect(mmNode).toContain('hasQueuedExtendCredit(env, mmEntityId, hubEntityId, tokenId, MARKET_MAKER_CREDIT_AMOUNT)');
    expect(mmNode).toContain('const hasSourceAccountCrossOffer = (env: Env, route: CrossJurisdictionSwapRoute): boolean => {');
    expect(mmNode).toContain('if (hasSourceAccountCrossOffer(env, route)) return true;');
    expect(mmNode).not.toContain('const isMarketMakerBootstrapReady = (health: MarketMakerHealth | null): boolean => {');
    expect(mmNode).toContain('const isMarketMakerDepthComplete = (health: MarketMakerHealth | null): boolean => {');
    expect(mmNode).toContain("if (startupPhase === 'offers-ready') {\n      publishMarketMakerHealthSnapshot({ includeCross: true });\n      return;\n    }");
    expect(mmNode).not.toContain('Math.max(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK, expectedOffersPerHub)');
    expect(mmNode).toContain('const quoteReadyHubEntityIds = hubEntityIds.filter((hubEntityId) =>');
    expect(mmNode).toContain('const desiredOffers = buildMarketMakerOfferSpecs(quoteReadyHubEntityIds, tokenIds);');
    const sameChainQuotes = mmNode.slice(
      mmNode.indexOf('const maintainMarketMakerQuotes = async ('),
      mmNode.indexOf('const hasCrossRouteRegistered = ('),
    );
    expect(sameChainQuotes).toContain('countMarketMakerOffersForHub(env, mmEntityId, left[0])');
    expect(sameChainQuotes).toContain('countMarketMakerOffersForHub(env, mmEntityId, right[0])');
    expect(sameChainQuotes.indexOf('const groupedEntries = Array.from(grouped.entries())')).toBeLessThan(
      sameChainQuotes.indexOf('for (const [hubEntityId, specs] of groupedEntries)'),
    );
    expect(mmNode).not.toContain('if (!isMarketMakerConnectivityReady(env, mmEntityId, hubEntityIds, tokenIds))');
    expect(mmNode).not.toContain('if (!isMarketMakerConnectivityReady(env, sourceContext.entityId, sourceHubEntityIds, sourceTokenIds)) return;');
    expect(mmNode).not.toContain('if (!isMarketMakerConnectivityReady(env, targetContext.entityId, targetHubEntityIds, targetTokenIds)) return;');
    expect(mmNode).toContain('const targetAccount = getAccountMachine(env, targetContext.entityId, route.target.entityId);');
    expect(hubNode).toContain('isCanonicalAccountOpener(bootstrap.entityId, peer.entityId)');
  });

  test('prod runtime child logs keep merge debug output behind explicit heavy logging', () => {
    const mergeSource = readFileSync(join(repoRoot, 'runtime/entity-input-merge.ts'), 'utf8');
    expect(mergeSource).toContain('if (HEAVY_LOGS) {\n          console.log(\n            `🔍 MERGE-PRECOMMITS:');
    expect(mergeSource).toContain('if (HEAVY_LOGS) {\n        console.log(\n          `    🔄 Merging inputs for');
  });

  test('isolated e2e runner bounds green-path MM teardown and cleans child ports', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
    expect(runner).toContain('const stopShardRuntimePorts = async (');
    expect(runner).toContain('await stopProcess(api, 35_000);');
    expect(runner).toContain('await stopShardRuntimePorts(apiPort, log);');
    expect(runner).toContain('await freePort(apiPort + 13, log);');
    expect(runner).not.toContain('await stopProcess(api, 120_000);');
  });

  test('deploy starts and checks the production Tron chain', () => {
    const deploy = readFileSync(join(repoRoot, 'deploy.sh'), 'utf8');
    expect(deploy).toContain('pm2 start scripts/start-anvil2.sh --name anvil2');
    expect(deploy).toContain('wait_for_rpc_chain "http://127.0.0.1:8546" "0x7a6a"');
    expect(deploy).toContain('wait_for_public_rpc_chain "/rpc2" "0x7a6a"');
    expect(deploy).toContain('location ~ ^/rpc[2-8]$');
    expect(deploy).toContain('public /rpc must proxy through orchestrator safety filter');
    expect(deploy).toContain('fail_deploy_with_debug "anvil2 did not become ready on :8546"');
    expect(deploy).toContain('local deadline=$((SECONDS + 1800))');
    expect(deploy).toContain('echo "[deploy] resetting production anvil + runtime state"');
    expect(deploy).toContain('rm -rf db/runtime/prod-main db/runtime/prod-mesh db/custody/prod db-tmp/prod-custody');
    expect(deploy).toContain('pm2 start scripts/start-anvil.sh --name anvil --interpreter bash --max-memory-restart 512M -- --reset');
    expect(deploy).toContain('pm2 start scripts/start-anvil2.sh --name anvil2 --interpreter bash --max-memory-restart 512M -- --reset');
    expect(deploy).not.toContain('preserving production anvil + runtime state');
  });

  test('prod diagnose accepts the market maker terminal startup phase', () => {
    const diagnose = readFileSync(join(repoRoot, 'scripts/prod-diagnose.sh'), 'utf8');
    expect(diagnose).toContain('payload.marketMaker.startupPhase !== "offers-ready"');
    expect(diagnose).not.toContain('payload.marketMaker.startupPhase !== "ready"');
  });

  test('market maker cross readiness only expects feasible cross specs', () => {
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const buildExpectedStart = mmNode.indexOf('const buildExpectedMarketMakerCrossRouteGroups = (');
    const buildHealthStart = mmNode.indexOf('const buildMarketMakerCrossHealth = (');
    expect(buildExpectedStart).toBeGreaterThan(0);
    expect(buildHealthStart).toBeGreaterThan(buildExpectedStart);
    const buildExpected = mmNode.slice(buildExpectedStart, buildHealthStart);

    expect(buildExpected).toContain('env: Env,');
    expect(buildExpected).toContain('for (const spec of buildMarketMakerCrossOfferSpecs(');
    expect(buildExpected).toContain('group.specs.push(spec);');
    expect(buildExpected).not.toContain('for (const pair of buildMarketMakerCrossTokenPairs');
  });

  test('market maker health route serves cached bootstrap readiness without scanning state', () => {
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const healthRouteStart = mmNode.indexOf("if (pathname === '/api/health')");
    const controlRouteStart = mmNode.indexOf("if (pathname === '/api/control/p2p/stop'");
    expect(healthRouteStart).toBeGreaterThan(0);
    expect(controlRouteStart).toBeGreaterThan(healthRouteStart);

    const healthRoute = mmNode.slice(healthRouteStart, controlRouteStart);
    expect(healthRoute).toContain('const cachedHealth = cachedMarketMakerHealth;');
    expect(healthRoute).toContain("const marketMakerHealth = startupPhase === 'offers-ready'");
    expect(healthRoute).toContain(': { ...rawMarketMakerHealth, ok: false };');
    expect(healthRoute).toContain('marketMaker: marketMakerHealth');
    expect(healthRoute).toContain('expectedRoutes: 0');
    expect(healthRoute).not.toContain('getMarketMakerHealth(');
    expect(mmNode).toContain('const buildDeferredMarketMakerCrossHealth = (applicable: boolean): MarketMakerHealth[\'cross\'] => ({');
    expect(mmNode).toContain('const publishBootstrapHealthSnapshot = (): MarketMakerHealth | null => {');
    expect(mmNode).toContain('const sameHealth = publishMarketMakerHealthSnapshot({ includeCross: false });');
    expect(mmNode).toContain('if (!isMarketMakerSameDepthComplete(sameHealth)) return sameHealth;');
    expect(mmNode).toContain('return publishMarketMakerHealthSnapshot({ includeCross: true });');
    expect(mmNode).toContain("import { computeCanonicalEntityHashesFromEnv, computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';");
    expect(mmNode).toContain('export const buildMarketMakerBootstrapEntityStateHash = (env: Env): string => {');
    expect(mmNode).toContain("schema: 'market-maker-bootstrap-entity-state-v1'");
    expect(mmNode).toContain('const fingerprint = buildMarketMakerBootstrapFingerprint(');
    expect(mmNode).toContain('const runtimeStateHash = computeCanonicalStateHashFromEnv(env);');
    expect(mmNode).toContain('const entityStateHash = buildMarketMakerBootstrapEntityStateHash(env);');
    expect(mmNode).toContain('bootstrapReadyHash = fingerprint.hash;');
    expect(mmNode).toContain('bootstrapRuntimeStateHash = runtimeStateHash;');
    expect(mmNode).toContain('bootstrapEntityStateHash = entityStateHash;');
    expect(mmNode).toContain('runtimeStateHash=${runtimeStateHash} entityStateHash=${entityStateHash}');
    expect(mmNode).toContain('payload=${safeStringify(fingerprint.payload)}');
    expect(mmNode).toContain("const beforeDrive = publishBootstrapHealthSnapshot();\n      refreshBootstrapPhase(beforeDrive);\n      if (isMarketMakerDepthComplete(beforeDrive) && !hasMarketMakerRuntimeBacklog(env)) return true;");
    expect(mmNode).toContain("await driveQuotes('bootstrap');");
    expect(mmNode).toContain('if (!hasMarketMakerRuntimeBacklog(env)) return true;');
    expect(mmNode).toContain("startupPhase = 'bootstrap-same-chain';\n    publishBootstrapHealthSnapshot();");
    expect(mmNode).toContain("startupPhase = isMarketMakerSameDepthComplete(health)\n        ? 'bootstrap-cross'\n        : 'bootstrap-same-chain';");
    expect(mmNode).toContain("const before = startupPhase === 'offers-ready'\n      ? publishMarketMakerHealthSnapshot({ includeCross: true })\n      : publishBootstrapHealthSnapshot();");
    expect(mmNode).toContain("if (startupPhase === 'offers-ready' && isMarketMakerDepthComplete(before)) return;");
    expect(mmNode).toContain("if (startupPhase !== 'offers-ready' && isMarketMakerDepthComplete(before) && !hasMarketMakerRuntimeBacklog(env))");
    expect(mmNode).toContain("if (startupPhase !== 'offers-ready' && isMarketMakerDepthComplete(health) && !hasMarketMakerRuntimeBacklog(env))");
  });

  test('market maker info route keeps cross debug opt-in off the hot path', () => {
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const infoRouteStart = mmNode.indexOf("if (pathname === '/api/info')");
    const healthRouteStart = mmNode.indexOf("if (pathname === '/api/health')");
    expect(infoRouteStart).toBeGreaterThan(0);
    expect(healthRouteStart).toBeGreaterThan(infoRouteStart);

    const infoRoute = mmNode.slice(infoRouteStart, healthRouteStart);
    expect(infoRoute).toContain("url.searchParams.get('crossDebug') === '1'");
    expect(infoRoute).toContain("url.searchParams.get('debug') === 'cross'");
    expect(infoRoute).toContain('const currentHealth = cachedMarketMakerHealth;');
    expect(infoRoute).toContain('bootstrap: {');
    expect(infoRoute).toContain('readyHash: bootstrapReadyHash');
    expect(infoRoute).toContain('runtimeStateHash: bootstrapRuntimeStateHash');
    expect(infoRoute).toContain('entityStateHash: bootstrapEntityStateHash');
    expect(infoRoute).toContain('runtimeBacklog: getMarketMakerRuntimeBacklogSnapshot(env, {');
    expect(infoRoute).toContain('includeQueuedEntityInputs: includeCrossDebug');
    expect(infoRoute).toContain('crossDebug: buildMarketMakerCrossDebugSummary(');
    expect(infoRoute).toContain('readVisibleHubProfiles(env, true)');
    expect(infoRoute).not.toContain('const allVisibleHubs = readVisibleHubProfiles(env, true);');
    expect(infoRoute).not.toContain('buildMarketMakerHealthSnapshot({ includeCross: true })');
  });

  test('local prod smoke records bootstrap benchmark stages and hash assertions', () => {
    const packageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    const smoke = readFileSync(join(repoRoot, 'runtime/scripts/local-prod-smoke.ts'), 'utf8');
    const benchmark = readFileSync(join(repoRoot, 'runtime/scripts/bootstrap-benchmark.ts'), 'utf8');

    expect(packageJson).toContain('"prod:bootstrap:bench": "bun runtime/scripts/bootstrap-benchmark.ts"');
    expect(smoke).toContain("schema: 'xln-local-prod-bootstrap-benchmark-v1'");
    expect(smoke).toContain("recordStage(`marketMaker:${marketMakerPhase}`, last);");
    expect(smoke).toContain("recordStageOnce('system:ready', last);");
    expect(smoke).toContain("recordStage('post-bootstrap:observed', { stabilityMs: postBootstrapStabilityMs });");
    expect(smoke).toContain("recordStage('post-bootstrap:stable', summarizeHealth(postBootstrapHealth));");
    expect(smoke).toContain("MARKET_MAKER_BOOTSTRAP_LOOP_MS: process.env['MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '25'");
    expect(smoke).toContain("process.env['MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '1000'");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_BOOTSTRAP_RUNTIME_HASH_MISMATCH');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_BOOTSTRAP_ENTITY_HASH_MISMATCH');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HEALTH_REGRESSED');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HASH_CHANGED');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_POST_BOOTSTRAP_BACKLOG');
    expect(smoke).toContain("writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\\n`);");
    expect(benchmark).toContain("schema: 'xln-bootstrap-benchmark-summary-v1'");
    expect(benchmark).toContain('BOOTSTRAP_BENCH_BOOTSTRAP_HASH_DRIFT');
    expect(benchmark).toContain('BOOTSTRAP_BENCH_ENTITY_HASH_DRIFT');
    expect(benchmark).toContain("runtimeStateHashes: metrics.map(entry => entry.runtimeStateHash)");
  });

  test('orchestrator health does not enrich cross market snapshots by default', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const buildHealthStart = orchestrator.indexOf('const buildAggregatedHealthResponse = async (');
    const waitBaselineStart = orchestrator.indexOf('const waitForHubBaseline = async (): Promise<void> => {');
    expect(buildHealthStart).toBeGreaterThan(0);
    expect(waitBaselineStart).toBeGreaterThan(buildHealthStart);

    const buildHealth = orchestrator.slice(buildHealthStart, waitBaselineStart);
    expect(buildHealth).toContain('options: { includeMarketSnapshots?: boolean } = {},');
    expect(buildHealth).toContain('const baseHealth = computeAggregatedHealth();');
    expect(buildHealth).toContain('const health = options.includeMarketSnapshots');
    expect(buildHealth).toContain('? await enrichMarketMakerCrossFromHubSnapshots(baseHealth)');
    expect(buildHealth).toContain(': baseHealth;');

    const healthRouteStart = orchestrator.indexOf("if (pathname === '/api/health')");
    const metricsRouteStart = orchestrator.indexOf("if (pathname === '/api/metrics')");
    expect(healthRouteStart).toBeGreaterThan(0);
    expect(metricsRouteStart).toBeGreaterThan(healthRouteStart);
    const healthRoute = orchestrator.slice(healthRouteStart, metricsRouteStart);
    expect(healthRoute).toContain('const health = await buildAggregatedHealthResponse();');
    expect(healthRoute).not.toContain('includeMarketSnapshots');
  });

  test('market maker quote hot path is producer-only after runtime loop starts', () => {
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const meshCommon = readFileSync(join(repoRoot, 'runtime/orchestrator/mesh-common.ts'), 'utf8');
    const ensureStart = mmNode.indexOf('const ensureMarketMakerHubConnectivity = async (');
    const readyStart = mmNode.indexOf('const isMarketMakerConnectivityReady = (');
    const driveStart = mmNode.indexOf("const driveQuotes = async (mode: 'bootstrap' | 'steady' = 'steady')");
    const markReadyStart = mmNode.indexOf('const markOffersReady = (): void => {');
    expect(ensureStart).toBeGreaterThan(0);
    expect(readyStart).toBeGreaterThan(ensureStart);
    expect(driveStart).toBeGreaterThan(readyStart);
    expect(markReadyStart).toBeGreaterThan(driveStart);

    const ensureConnectivity = mmNode.slice(ensureStart, readyStart);
    const driveQuotes = mmNode.slice(driveStart, markReadyStart);
    expect(ensureConnectivity).not.toContain('settleRuntimeFor(');
    expect(ensureConnectivity).not.toContain('const accountOpenInputs: EntityInput[] = []');
    expect(ensureConnectivity).toContain('return true;');
    expect(ensureConnectivity).toContain('return false;');
    expect(driveQuotes).not.toContain('settleRuntimeFor(');
    expect(driveQuotes).toContain('await yieldMarketMakerApi();');
    expect(driveQuotes).toContain('if (await ensureMarketMakerHubConnectivity(');
    expect(driveQuotes).toContain('if (await maintainSameContextQuotes(context)) return;');
    expect(driveQuotes).toContain('if (await maintainMarketMakerCrossQuotes(');
    expect(meshCommon).toContain('const queuedEntityTxsFor = (env: Env, targetEntityId: string): EntityTx[] => {');
    expect(meshCommon).toContain('export const hasQueuedExtendCredit = (');
  });

  test('market maker bootstrap never sends hub-side credit inputs itself', () => {
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const ensureStart = mmNode.indexOf('const ensureMarketMakerHubConnectivity = async (');
    const readyStart = mmNode.indexOf('const isMarketMakerConnectivityReady = (');
    expect(ensureStart).toBeGreaterThan(0);
    expect(readyStart).toBeGreaterThan(ensureStart);

    const ensureConnectivity = mmNode.slice(ensureStart, readyStart);
    expect(ensureConnectivity).toContain('const [openTokenId = 1, ...extraCreditTokenIds] = normalizePositiveTokenIds(tokenIds);');
    expect(ensureConnectivity).toContain("type: 'openAccount'");
    expect(ensureConnectivity).toContain("type: 'extendCredit' as const");
    expect(ensureConnectivity).not.toContain('hubSignerIdsByEntityId');
    expect(ensureConnectivity).not.toContain('remoteCreditInputs');
    expect(ensureConnectivity).not.toContain('sendEntityInput');
    expect(mmNode).not.toContain('RoutedEntityInput');
    expect(orchestrator).toContain("'--support-peer-identities-json', JSON.stringify(getMarketMakerIdentities())");
    expect(orchestrator).not.toContain('--mesh-hub-identities-json');
  });

  test('hub support-peer provisioning uses full jurisdiction token sets', () => {
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    expect(hubNode).toContain("import { getTokenIdsForJurisdiction } from '../account-utils';");
    expect(hubNode).toContain('const tokenIdsForHubJurisdiction = (');
    expect(hubNode).toContain('const tokenCatalogForHubJurisdiction = (');

    const collectSupportStart = hubNode.indexOf('const collectSupportPeerInputs = (');
    const hubPeerStart = hubNode.indexOf('for (const peer of peers)', collectSupportStart);
    expect(collectSupportStart).toBeGreaterThan(0);
    expect(hubPeerStart).toBeGreaterThan(collectSupportStart);
    const collectSupportPeerInputs = hubNode.slice(collectSupportStart, hubPeerStart);
    expect(collectSupportPeerInputs).toContain('const supportPeerTokenIds = tokenIdsForHubJurisdiction(owner);');
    expect(collectSupportPeerInputs).toContain('const [openTokenId = HUB_MESH_TOKEN_ID, ...extraCreditTokenIds] = supportPeerTokenIds;');
    expect(collectSupportPeerInputs).toContain('...extraCreditTokenIds.map((tokenId) => ({');
    expect(collectSupportPeerInputs).toContain('const missingTokenIds = supportPeerTokenIds.filter((tokenId) =>');
    expect(collectSupportPeerInputs).not.toContain('DEFAULT_ACCOUNT_TOKEN_IDS');

    const reserveStart = hubNode.indexOf('const getReserveHealth = (');
    const supportPeerReserveEnd = hubNode.indexOf('const getEntityJurisdictionName = (');
    expect(reserveStart).toBeGreaterThan(0);
    expect(supportPeerReserveEnd).toBeGreaterThan(reserveStart);
    const reserveBootstrap = hubNode.slice(reserveStart, supportPeerReserveEnd);
    expect(reserveBootstrap).toContain('tokenCatalogForHubJurisdiction(tokenCatalog, {');
    expect(reserveBootstrap).toContain('const bootstrapTokens = tokenCatalogForHubJurisdiction(catalog, { jurisdictionName });');
    expect(reserveBootstrap).not.toContain('tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)');
    expect(reserveBootstrap).not.toContain('catalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)');
  });

  test('orchestrator exposes the gossip profile bundle endpoint used by payments', () => {
    const debugApi = readFileSync(join(repoRoot, 'runtime/orchestrator/debug-api.ts'), 'utf8');
    const paymentPanel = readFileSync(join(repoRoot, 'frontend/src/lib/components/Entity/PaymentPanel.svelte'), 'utf8');

    expect(paymentPanel).toContain('/api/gossip/profile?entityId=');
    expect(debugApi).toContain("import { buildKnownProfileBundle } from '../server/gossip-profiles';");
    expect(debugApi).toContain("if (deps.pathname === '/api/gossip/profile')");
    expect(debugApi).toContain('const bundle = buildKnownProfileBundle({');
    expect(debugApi).toContain('relayStore: deps.relayStore');
    expect(debugApi).toContain('found: !!bundle.profile');
    expect(debugApi).toContain("safeStringify({ ok: false, error: 'entityId is required' })");
  });

  test('fresh deploy stops runtime processes before deleting runtime state', () => {
    const deploy = readFileSync(join(repoRoot, 'deploy.sh'), 'utf8');
    const stopIndex = deploy.indexOf('pm2 delete xln-server');
    const deleteIndex = deploy.indexOf('rm -rf db/runtime/prod-main db/runtime/prod-mesh');
    expect(stopIndex).toBeGreaterThan(0);
    expect(deleteIndex).toBeGreaterThan(0);
    expect(stopIndex).toBeLessThan(deleteIndex);
    expect(deploy).toContain("pkill -KILL -f 'runtime/orchestrator/hub-node.ts'");
    expect(deploy).toContain("pkill -KILL -f 'runtime/orchestrator/mm-node.ts'");
  });

  test('secondary anvil uses a persistent Tron chain id and state file', () => {
    const anvil = readFileSync(join(repoRoot, 'scripts/start-anvil.sh'), 'utf8');
    const anvil2 = readFileSync(join(repoRoot, 'scripts/start-anvil2.sh'), 'utf8');
    expect(anvil).toContain('ANVIL_CHAIN_ID="${ANVIL_CHAIN_ID:-31337}"');
    expect(anvil).toContain('--chain-id "$ANVIL_CHAIN_ID"');
    expect(anvil2).toContain('ANVIL_CHAIN_ID="${ANVIL2_CHAIN_ID:-31338}"');
    expect(anvil2).toContain('ANVIL_STATE="${ANVIL2_STATE:-$REPO_ROOT/data/anvil2-state.json}"');
  });

  test('explicit hub action proxy uses cached hub child without synchronous health polling', async () => {
    const originalFetch = globalThis.fetch;
    const hubEntityId = `0x${'ab'.repeat(32)}`;
    let pollCalls = 0;
    let upstreamUrl = '';
    let upstreamBody = '';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      upstreamUrl = url instanceof Request ? url.url : String(url);
      upstreamBody = String(init?.body || '');
      return new Response(JSON.stringify({ success: true, serverDurationMs: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {
          pollCalls += 1;
          throw new Error('health poll should not run for a cached explicit hub');
        },
        getHubChildByEntityId: (entityId: string) =>
          entityId === hubEntityId ? ({ apiPort: 19301 } as any) : null,
        getHealthyHub: () => null,
      });
      const body = JSON.stringify({ hubEntityId, userEntityId: `0x${'cd'.repeat(32)}` });
      const response = await handlers.proxyHubApi(new Request('http://xln.local/api/faucet/offchain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }), '/api/faucet/offchain');

      expect(response.status).toBe(200);
      expect(pollCalls).toBe(0);
      expect(upstreamUrl).toBe('http://127.0.0.1:19301/api/faucet/offchain');
      expect(upstreamBody).toBe(body);
      expect(response.headers.get('x-xln-proxy-health-polled')).toBe('0');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('explicit hub action proxy polls health only as a lookup fallback', async () => {
    const originalFetch = globalThis.fetch;
    const hubEntityId = `0x${'ef'.repeat(32)}`;
    let pollCalls = 0;
    let hubVisible = false;
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {
          pollCalls += 1;
          hubVisible = true;
        },
        getHubChildByEntityId: (entityId: string) =>
          hubVisible && entityId === hubEntityId ? ({ apiPort: 19302 } as any) : null,
        getHealthyHub: () => null,
      });
      const response = await handlers.proxyHubApi(new Request('http://xln.local/api/faucet/offchain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hubEntityId }),
      }), '/api/faucet/offchain');

      expect(response.status).toBe(200);
      expect(pollCalls).toBe(1);
      expect(response.headers.get('x-xln-proxy-health-polled')).toBe('1');
      expect(Number(response.headers.get('x-xln-proxy-health-poll-ms'))).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('hub account-status proxy skips health polling when cached child mapping is known', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const routeStart = orchestrator.indexOf("if (pathname === '/api/hub/account-status' && request.method === 'GET')");
    const nextRouteStart = orchestrator.indexOf("if (pathname === '/api/lending/state'", routeStart);
    expect(routeStart).toBeGreaterThan(0);
    expect(nextRouteStart).toBeGreaterThan(routeStart);

    const route = orchestrator.slice(routeStart, nextRouteStart);
    expect(route).toContain('let child = getHubChildByEntityId(hubEntityId);');
    expect(route).toContain('if (!child) {\n        await pollAllHubHealth();\n        child = getHubChildByEntityId(hubEntityId);\n      }');
    expect(route.indexOf('let child = getHubChildByEntityId(hubEntityId);')).toBeLessThan(
      route.indexOf('await pollAllHubHealth();'),
    );
  });

  test('orchestrator rpc proxy fails fast when upstream hangs', async () => {
    const previousTimeout = process.env['XLN_RPC_PROXY_TIMEOUT_MS'];
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    process.env['XLN_RPC_PROXY_TIMEOUT_MS'] = '25';
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: `http://127.0.0.1:${server.port}`,
        pollAllHubHealth: async () => {},
        getHubChildByEntityId: () => null,
        getHealthyHub: () => null,
      });
      const startedAt = performance.now();
      const response = await handlers.proxyRpc(new Request('http://127.0.0.1/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }),
      }));
      const body = await response.json() as { error?: string };

      expect(response.status).toBe(502);
      expect(body.error).toContain('PROXY_UPSTREAM_TIMEOUT:25');
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env['XLN_RPC_PROXY_TIMEOUT_MS'];
      } else {
        process.env['XLN_RPC_PROXY_TIMEOUT_MS'] = previousTimeout;
      }
      await server.stop(true);
    }
  }, 2_000);
});
