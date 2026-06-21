import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    expect(mmNode).toContain("MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '1'");
    expect(mmNode).toContain('maxEntityInputsPerFrame: MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME');
    expect(mmNode).toContain('const waitForActiveJAdapter = async (env: Env, jurisdictionName: string, rounds = 1200)');
    expect(mmNode).toContain('ACTIVE_JADAPTER_NOT_READY name=${jurisdictionName}');
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS'] || '1500000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '250'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK'] || '60'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK'] || '180'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK'] || '60'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] || '180'");
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
    expect(mmNode).toContain('hasCrossRouteRegistered(env, route.source.entityId, route.orderId)');
    expect(mmNode).toContain('hasCrossRouteRegistered(env, route.source.counterpartyEntityId, route.orderId)');
    expect(mmNode).toContain('countCrossSpecBootstrapProgressByPair(env, specs, getPendingCrossRequestOrderIds)');
    expect(mmNode).toContain('const visibleByPair = countCrossSpecVisibleOffersByPair(env, specs);');
    expect(mmNode).toContain('countCrossPairCoverageGaps(env, right[1]) -');
    expect(mmNode).toContain('(visibleByPair.get(left.pairId) || 0) - (visibleByPair.get(right.pairId) || 0)');
    expect(mmNode).toContain("MARKET_MAKER_RUNTIME_TICK_DELAY_MS'] || '10'");
    expect(mmNode).toContain("MARKET_MAKER_API_YIELD_MS'] || '1'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '1'");
    expect(mmNode).toContain('const yieldMarketMakerApi = async (): Promise<void> => {');
    expect(mmNode).toContain('await new Promise<void>(resolve => setTimeout(resolve, MARKET_MAKER_API_YIELD_MS));');
    expect(mmNode).not.toContain('setImmediate(resolve)');
    expect(mmNode).not.toContain('await sleep(0);');
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_CROSS_ROUTE_JOBS_PER_TICK'] || '2'");
    expect(mmNode).toContain("MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK'] || '2'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_NEW_OFFERS_PER_ENTITY_INPUT'] || '4'");
    expect(mmNode).not.toContain("MARKET_MAKER_MAX_NEW_OFFERS_PER_ENTITY_INPUT'] || '30'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT']");
    expect(mmNode).not.toContain("MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT'] ||\n    '30'");
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_OFFERS_PER_ENTITY_INPUT * 5');
    expect(mmNode).toContain("MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT'] ||\n    '4'");
    expect(mmNode).not.toContain("MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT'] ||\n    '2'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_NEW_CROSS_DEPTH_REQUESTS_PER_ENTITY_INPUT'] || '4'");
    expect(mmNode).not.toContain("MARKET_MAKER_MAX_NEW_CROSS_DEPTH_REQUESTS_PER_ENTITY_INPUT'] || '2'");
    expect(mmNode).not.toContain("MARKET_MAKER_MAX_NEW_CROSS_DEPTH_REQUESTS_PER_ENTITY_INPUT'] || '30'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK'] || '64'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_CONNECTIVITY_TXS_PER_ENTITY_INPUT'] || '1'");
    expect(mmNode).toContain('type MarketMakerCrossOfferBudget = {');
    expect(mmNode).toContain('const hasMarketMakerAccountBacklog = (');
    expect(mmNode).toContain('const hasMarketMakerRuntimeBacklog = (env: Env): boolean => {');
    expect(mmNode).toContain('Boolean(env.runtimeState?.processingPromise)');
    expect(mmNode).toContain('if (hasMarketMakerRuntimeBacklog(env)) return;');
    expect(mmNode).toContain('const quoteableHubsFor = (context: MarketMakerEntityContext): HubProfile[] =>');
    expect(mmNode).toContain('.filter(profile => !hasMarketMakerAccountBacklog(env, context.entityId, profile.entityId));');
    expect(mmNode).toContain('): Promise<boolean> => {\n  const localCreditInputsByEntity = new Map<string, EntityInput>();');
    expect(mmNode).toContain('const maintainSameContextQuotes = async (context: MarketMakerEntityContext): Promise<boolean> => {');
    expect(mmNode).toContain('if (await maintainSameContextQuotes(context)) return;');
    expect(mmNode).toContain('entityInputs: [entityInputs[0]!],');
    expect(mmNode).not.toContain('const hasMarketMakerQuoteBacklog = (');
    expect(mmNode).not.toContain('if (hasPendingRuntimeWork(env)) return true;');
    expect(mmNode).not.toContain('!hasMarketMakerQuoteBacklog(env, mmContexts, visibleHubs)');
    expect(mmNode).not.toContain('const primarySameReady =');
    expect(mmNode).toContain('const primarySameDepthReady = isMarketMakerSameDepthComplete(healthBeforeQuotes);');
    expect(mmNode).toContain("if (mode !== 'bootstrap' || !primarySameDepthReady) {");
    expect(mmNode).toContain('const reserveCrossOfferBudget = (');
    expect(mmNode).toContain('remainingOffersTotal: MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK');
    expect(mmNode).toContain('route.source.counterpartyEntityId');
    expect(mmNode).toContain('MARKET_MAKER_MAX_NEW_CROSS_DEPTH_REQUESTS_PER_ENTITY_INPUT');
    expect(mmNode).toContain('if (coverageOnly && coverageGapCount === 0) continue;');
    expect(mmNode).toContain('bootstrapCrossCursor');
    expect(mmNode).toContain('steadyCrossCursor');
    expect(mmNode).toContain('const selectedCrossQuoteJobs: Array<{ index: number; job: CrossQuoteJob }>');
    expect(mmNode).toContain('advanceCrossCursorAfterEnqueue(entry.index)');
    expect(mmNode).not.toContain("const sameQuoteContexts = mode === 'bootstrap' ? mmContexts.slice(0, 1) : mmContexts;");
    expect(mmNode).toContain('const routeJobsPerTick = mode === \'bootstrap\'');
    expect(mmNode).toContain('MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK');
    expect(mmNode).toContain('if (!health?.hubs.every((hub) => hub.depthReady)) return;');
    expect(mmNode).toContain('if (isMarketMakerDepthComplete(health)) return;');
    expect(mmNode).toContain('const hubsDepthReady = hubs.length > 0 && hubs.every((entry) => entry.depthReady);');
    expect(mmNode).toContain('cross.routes.every((route) => route.depthReady)');
    expect(mmNode).toContain('ok: hubsDepthReady && crossDepthReady');
    expect(mmNode).toContain('MARKET_MAKER_MAX_NEW_OFFERS_PER_ENTITY_INPUT');
    expect(mmNode).toContain('MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT');
    expect(mmNode).toContain('Math.floor(maxNewOffersTotal),\n      MARKET_MAKER_MAX_NEW_OFFERS_PER_ENTITY_INPUT');
    expect(mmNode).toContain('Math.floor(maxNewOffersTotal),\n      MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT');
    expect(mmNode).toContain('].slice(0, MARKET_MAKER_MAX_CONNECTIVITY_TXS_PER_ENTITY_INPUT)');
    expect(mmNode).toContain('if (entityTxs.length >= MARKET_MAKER_MAX_CONNECTIVITY_TXS_PER_ENTITY_INPUT) break collectCreditInputs;');
    expect(mmNode).toContain('collectQueuedSwapOfferIds(env, mmEntityId, hubEntityId)');
    expect(mmNode).toContain('hasQueuedExtendCredit(env, mmEntityId, hubEntityId, tokenId, MARKET_MAKER_CREDIT_AMOUNT)');
    expect(mmNode).toContain('const hasSourceAccountCrossOffer = (env: Env, route: CrossJurisdictionSwapRoute): boolean => {');
    expect(mmNode).toContain('if (hasSourceAccountCrossOffer(env, route)) return true;');
    expect(mmNode).toContain('const isMarketMakerDepthComplete = (health: MarketMakerHealth | null): boolean => {');
    expect(mmNode).toContain("if (startupPhase === 'offers-ready' && isMarketMakerDepthComplete(before)) return;");
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
    expect(healthRoute).toContain('expectedRoutes: 0');
    expect(healthRoute).not.toContain('getMarketMakerHealth(');
    expect(mmNode).toContain('const buildDeferredMarketMakerCrossHealth = (applicable: boolean): MarketMakerHealth[\'cross\'] => ({');
    expect(mmNode).toContain('const publishBootstrapHealthSnapshot = (): MarketMakerHealth | null => {');
    expect(mmNode).toContain('const sameHealth = publishMarketMakerHealthSnapshot({ includeCross: false });');
    expect(mmNode).toContain('if (!isMarketMakerSameDepthComplete(sameHealth)) return sameHealth;');
    expect(mmNode).toContain('return publishMarketMakerHealthSnapshot({ includeCross: true });');
    expect(mmNode).toContain("publishBootstrapHealthSnapshot();\n      await yieldMarketMakerApi();\n      await driveQuotes('bootstrap');");
    expect(mmNode).toContain("startupPhase = 'bootstrap-offers';\n    publishBootstrapHealthSnapshot();");
    expect(mmNode).toContain("const before = startupPhase === 'offers-ready'\n      ? publishMarketMakerHealthSnapshot({ includeCross: true })\n      : publishBootstrapHealthSnapshot();");
    expect(mmNode).toContain("if (startupPhase === 'offers-ready' && isMarketMakerDepthComplete(before)) return;");
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
});
