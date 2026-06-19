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
    expect(orchestrator).toContain('const [health, info] = await Promise.all([');
    expect(orchestrator).toContain("fetchJson<MarketMakerHealthPayload>(`${apiBase}/api/health`, CHILD_HEALTH_TIMEOUT_MS)");
    expect(orchestrator).toContain("fetchJson<MarketMakerInfoPayload>(`${apiBase}/api/info`, MARKET_MAKER_INFO_TIMEOUT_MS)");
    expect(orchestrator).toContain('const mmHealthReady = Boolean(marketMakerChild.lastHealth?.marketMaker);');
    expect(orchestrator).toContain('const mmOk = !args.mmEnabled');
    expect(orchestrator).toContain('marketMakerActive &&');
    const waitForMarketMakerReady = orchestrator.slice(orchestrator.indexOf('const waitForMarketMakerReady = async (): Promise<void> => {'));
    expect(waitForMarketMakerReady.indexOf('if (marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null)')).toBeLessThan(
      waitForMarketMakerReady.indexOf('health.marketMaker.ok'),
    );
    expect(orchestrator.indexOf('if (health) marketMakerChild.lastHealth = health;')).toBeLessThan(
      orchestrator.indexOf('if (info) marketMakerChild.lastInfo = info;'),
    );
    expect(orchestrator).toContain('if (info) marketMakerChild.lastInfo = info;');
    expect(orchestrator).toContain('if (health) marketMakerChild.lastHealth = health;');
    expect(orchestrator).toContain('syncCanonicalJurisdictionsFromShard(jurisdictionsConfig)');
    expect(readFileSync(join(repoRoot, 'runtime/orchestrator/jurisdictions.ts'), 'utf8'))
      .toContain('const seedPath = existsSync(canonicalPath) ? canonicalPath : resolveRepoJurisdictionsJsonPath();');
    expect(orchestrator).toContain('const buildSecondaryRpcArgs = (): string[] => {');
    expect(orchestrator).toContain('const buildRpcChildEnv = (): Record<string, string> => {');
    expect(orchestrator).toContain('const rpcProxyIndex = resolveRpcProxyIndex(pathname);');
    expect(orchestrator).toContain("return await proxyRpc(request, args.rpcUrls[rpcProxyIndex] || '');");
    expect(orchestrator).toContain("XLN_RUNTIME_EXIT_ON_FATAL: process.env['XLN_RUNTIME_EXIT_ON_FATAL'] ?? '1'");
    expect(orchestrator).toContain("XLN_STORAGE_WRITE_TIMEOUT_MS: process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] ?? '60000'");
    expect(runtimeEntityRouting).toContain('const shouldExitOnRuntimeFatal = (runtimeProcess = getRuntimeProcessGlobal()): boolean =>');
    expect(runtimeEntityRouting).toContain("runtimeProcess.exit(1);");
    expect(orchestrator).toContain("XLN_STORAGE_SYNC_WRITES: process.env['XLN_STORAGE_SYNC_WRITES'] ?? '0'");
    expect(orchestrator).toContain("XLN_MARKET_MAKER_DISABLE_STORAGE: process.env['XLN_MARKET_MAKER_DISABLE_STORAGE'] ?? '1'");
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
    expect(orchestrator).toContain('MARKET_MAKER_CREDIT_AMOUNT.toString()');
    expect(orchestrator).not.toContain("creditAmount: '50000000000000000000000000'");
    expect(mmNode).toContain('const readRpcUrls = (): Record<number, string> => {');
    expect(mmNode).toContain("const match = raw.match(/^\\/(?:api\\/)?rpc([2-8])?(?:\\?.*)?$/);");
    expect(mmNode).toContain('buildMarketMakerConsensusConfig(signerId, entityJurisdiction)');
    expect(mmNode).toContain('deriveMarketMakerEntityId(signerId, entityJurisdiction)');
    expect(mmNode).toContain('isCanonicalAccountOpener(mmEntityId, hubEntityId)');
    expect(mmNode).toContain('Runtime storage disabled for rebuildable market-maker state');
    expect(mmNode).toContain('const waitForActiveJAdapter = async (env: Env, jurisdictionName: string, rounds = 1200)');
    expect(mmNode).toContain('ACTIVE_JADAPTER_NOT_READY name=${jurisdictionName}');
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS'] || '1500000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK'] || '60'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK'] || '180'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK'] || '20'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] || '60'");
    expect(mmNode).toContain('const selectMarketMakerBootstrapTokenIds = (tokenIds: readonly number[]): number[] => {');
    expect(mmNode).toContain('return unique;');
    expect(mmNode).not.toContain('return unique.slice(0, HUB_REQUIRED_TOKEN_COUNT);');
    expect(mmNode).toContain('const hasCrossSpecBootstrapProgress = (');
    expect(mmNode).toContain('hasCrossRouteRegistered(env, route.source.entityId, route.orderId)');
    expect(mmNode).toContain('hasCrossRouteRegistered(env, route.source.counterpartyEntityId, route.orderId)');
    expect(mmNode).toContain('countCrossSpecBootstrapProgressByPair(env, specs, getPendingCrossRequestOrderIds)');
    expect(mmNode).toContain('(progressByPair.get(left.pairId) || 0) - (progressByPair.get(right.pairId) || 0)');
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_CROSS_ROUTE_JOBS_PER_TICK'] || '6'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK'] || '60'");
    expect(mmNode).toContain('type MarketMakerCrossOfferBudget = {');
    expect(mmNode).toContain('const reserveCrossOfferBudget = (');
    expect(mmNode).toContain('remainingOffersTotal: MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK');
    expect(mmNode).toContain('route.source.counterpartyEntityId');
    expect(mmNode).toContain('bootstrapCrossCursor');
    expect(mmNode).toContain('const jobCount = Math.min(MARKET_MAKER_BOOTSTRAP_CROSS_ROUTE_JOBS_PER_TICK, crossQuoteJobs.length)');
    expect(mmNode).toContain('const hasSourceAccountCrossOffer = (env: Env, route: CrossJurisdictionSwapRoute): boolean => {');
    expect(mmNode).toContain('if (hasSourceAccountCrossOffer(env, route)) return true;');
    expect(mmNode).not.toContain('Math.max(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK, expectedOffersPerHub)');
    expect(mmNode).toContain('const quoteReadyHubEntityIds = hubEntityIds.filter((hubEntityId) =>');
    expect(mmNode).toContain('const desiredOffers = buildMarketMakerOfferSpecs(quoteReadyHubEntityIds, tokenIds);');
    expect(mmNode).not.toContain('if (!isMarketMakerConnectivityReady(env, mmEntityId, hubEntityIds, tokenIds))');
    expect(mmNode).not.toContain('if (!isMarketMakerConnectivityReady(env, sourceContext.entityId, sourceHubEntityIds, sourceTokenIds)) return;');
    expect(mmNode).not.toContain('if (!isMarketMakerConnectivityReady(env, targetContext.entityId, targetHubEntityIds, targetTokenIds)) return;');
    expect(mmNode).toContain('const targetAccount = getAccountMachine(env, targetContext.entityId, route.target.entityId);');
    expect(hubNode).toContain('isCanonicalAccountOpener(bootstrap.entityId, peer.entityId)');
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
