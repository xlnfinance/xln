import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverHubIds } from '../orchestrator/custody-bootstrap';
import { createOrchestratorProxyHandlers } from '../orchestrator/proxy';
import {
  E2E_FATAL_LOG_TAIL_LINES,
  findFirstRuntimeFatalLogHit,
  tailLog,
} from '../scripts/e2e-fatal-log-monitor';

const repoRoot = process.cwd();

const extractSourceBlock = (source: string, marker: string, nextMarker: string): string => {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(nextMarker, start + marker.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('production startup wiring', () => {
  test('quick and smoke gates rebuild after their own artifact cleanup', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['test:all:quick']).not.toContain('--skip-build');
    expect(packageJson.scripts['test:all:smoke']).not.toContain('--skip-build');
  });
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
    expect(script).toContain('export XLN_HUB_BOOTSTRAP_PAUSE_STORAGE=${XLN_HUB_BOOTSTRAP_PAUSE_STORAGE:-1}');
    expect(script).toContain('export XLN_HUB_READY_SNAPSHOT_TIMEOUT_MS=${XLN_HUB_READY_SNAPSHOT_TIMEOUT_MS:-60000}');
    expect(script).toContain('export XLN_MESH_BOOTSTRAP_TICK_TIMEOUT_MS=${XLN_MESH_BOOTSTRAP_TICK_TIMEOUT_MS:-120000}');
    expect(script).toContain('export XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS=${XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS:-600000}');
    expect(script).toContain('export XLN_HUB_BASELINE_TIMEOUT_MS=${XLN_HUB_BASELINE_TIMEOUT_MS:-600000}');
    expect(script).toContain('export XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT=${XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT:-1}');
    expect(script).toContain('export XLN_CUSTODY_PUBLIC_RPC_URL=${XLN_CUSTODY_PUBLIC_RPC_URL:-wss://custody.xln.finance/rpc}');
    expect(script).toContain('export MARKET_MAKER_MAX_LEVELS_PER_PAIR=${MARKET_MAKER_MAX_LEVELS_PER_PAIR:-10}');
    expect(script).toContain('export MARKET_MAKER_CROSS_LEVELS_PER_PAIR=${MARKET_MAKER_CROSS_LEVELS_PER_PAIR:-3}');
    expect(script).toContain(
      'export MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE=${MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE:-1000}',
    );
    expect(script).toContain(
      'export MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE=${MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE:-3}',
    );
    expect(script).toContain(
      'export MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK=${MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK:-45}',
    );
    expect(script).toContain(
      'export MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK=${MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK:-45}',
    );

    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const marketMakerPoller = readFileSync(join(repoRoot, 'runtime/orchestrator/market-maker-child-poll.ts'), 'utf8');
    const marketMakerAggregation = readFileSync(join(repoRoot, 'runtime/orchestrator/market-maker-aggregated-health.ts'), 'utf8');
    const orchestratorConfig = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator-config.ts'), 'utf8');
    const runtimeEntityRouting = readFileSync(join(repoRoot, 'runtime/runtime-entity-routing.ts'), 'utf8');
    const runtimeMainSource = readFileSync(join(repoRoot, 'runtime/runtime.ts'), 'utf8');
    const standaloneServer = readFileSync(join(repoRoot, 'runtime/server.ts'), 'utf8');
    const startCustodyDev = readFileSync(join(repoRoot, 'runtime/scripts/start-custody-dev.ts'), 'utf8');
    const cli = readFileSync(join(repoRoot, 'runtime/cli.ts'), 'utf8');
    expect(orchestratorConfig).toContain("relayUrl: normalizeWsUrl(getArg('--relay-url', process.env['RELAY_URL'] || '')");
    expect(orchestratorConfig).toContain("const RPC_PROXY_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8] as const;");
    expect(orchestratorConfig).toContain("readPositiveIntEnv('XLN_CHILD_HEALTH_TIMEOUT_MS', 30_000)");
    expect(orchestrator).toContain('const relayUrl = args.relayUrl;');
    expect(orchestrator).toContain("process.env['XLN_MARKET_MAKER_INFO_TIMEOUT_MS'] || '1500'");
    expect(orchestrator).toContain("process.env['XLN_CHILD_SHUTDOWN_QUIESCE_MS'] || '5000'");
    expect(orchestrator).toContain('const CHILD_RESET_QUIESCE_TIMEOUT_MS = 45_000;');
    expect(orchestrator).toContain("meshLog.warn('child.stop_timeout_sigkill'");
    expect(orchestrator).toContain("meshLog.error('child.unexpected_exit'");
    expect(orchestrator).toContain("meshLog.error('child.unexpected_exit.stop_failed'");
    expect(orchestrator).toContain("meshLog.error('custody.bootstrap_failed'");
    expect(orchestrator).toContain("meshLog.warn('reset.sigterm_during_reset'");
    expect(orchestrator).toContain("meshLog.error('reset.initial_failed'");
    expect(orchestrator).not.toContain('[MESH] child pid=');
    expect(orchestrator).not.toContain('failed while stopping children after fatal exit');
    expect(orchestrator).not.toContain('shutting down instead of restarting');
    expect(orchestrator).not.toContain('[MESH] custody bootstrap failed:');
    expect(orchestrator).not.toContain('[MESH] received SIGTERM from parent during reset');
    expect(orchestrator).not.toContain('[MESH] initial reset failed:');
    expect(orchestrator).toContain('await stopAllChildren({');
    expect(orchestrator).toContain('quiesceRounds: 1');
    expect(orchestrator).toContain('quiesceTimeoutMs: CHILD_SHUTDOWN_QUIESCE_TIMEOUT_MS');
    expect(orchestrator).toContain('let hubHealthPollInFlight: Promise<void> | null = null;');
    expect(orchestrator).toContain('if (hubHealthPollInFlight) return hubHealthPollInFlight;');
    expect(orchestrator).toContain('const marketMakerPoller = createMarketMakerChildPoller({');
    expect(orchestrator).toContain('const pollMarketMakerInfo = marketMakerPoller.pollInfo;');
    expect(orchestrator).toContain('const pollMarketMakerHealth = marketMakerPoller.pollHealth;');
    expect(marketMakerPoller).toContain('let healthPollInFlight: Promise<void> | null = null;');
    expect(marketMakerPoller).toContain('let infoPollInFlight: Promise<void> | null = null;');
    expect(marketMakerPoller).toContain('if (healthPollInFlight) return healthPollInFlight;');
    expect(marketMakerPoller).toContain('if (infoPollInFlight) return infoPollInFlight;');
    expect(marketMakerPoller).toContain("fetchJson<MarketMakerHealthPayload>(`${apiBase()}/api/health`, healthTimeoutMs)");
    expect(orchestrator).not.toContain('const [health, info] = await Promise.all([');
    expect(marketMakerPoller).toContain("fetchJson<MarketMakerInfoPayload>(`${apiBase()}/api/info`, infoTimeoutMs)");
    expect(orchestrator).not.toContain('if (!marketMakerChild.lastInfo) {');
    expect(marketMakerPoller).toContain('const applyInfo = (info: MarketMakerInfoPayload, proc: ChildProcess): void => {');
    expect(marketMakerPoller).toContain('child.lastInfo = { ...(child.lastInfo || {}), ...info };');
    expect(marketMakerPoller).toContain('if (!isCurrentProc(proc)) return;');
    expect(orchestrator).toContain('normalizeMarketMakerHealthPayload');
    expect(marketMakerPoller).toContain('type RawMarketMakerHealthPayload');
    expect(marketMakerPoller).toContain('const health = await fetchJson<MarketMakerHealthPayload | RawMarketMakerHealthPayload>');
    expect(marketMakerPoller).toContain('return normalizeMarketMakerHealthPayload(health);');
    expect(orchestrator).toContain('const marketMakerHealth = normalizeMarketMakerHealthPayload(options.marketMakerHealthOverride ?? marketMakerChild.lastHealth);');
    expect(orchestrator).toContain('const aggregatedMarketMakerHealth = buildAggregatedMarketMakerHealth({');
    expect(marketMakerAggregation).toContain('const childReady = marketMakerHealth?.marketMaker?.ok === true;');
    expect(marketMakerAggregation).toContain('if (!marketMakerActive) {');
    expect(marketMakerAggregation).toContain('const ok = !mmEnabled || failure === null;');
    expect(standaloneServer).toContain('const selectPredeployedJurisdiction = (');
    expect(standaloneServer).toContain("const predeployedJurisdictionKey = String(process.env['XLN_PREDEPLOYED_JURISDICTION_KEY'] || '').trim();");
    expect(standaloneServer).toContain('selectPredeployedJurisdiction(jurisdictions, anvilRpc, predeployedJurisdictionKey)');
    expect(standaloneServer).toContain('updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc, detectedChainId, predeployedJurisdictionKey)');
    expect(standaloneServer).toContain('entries.find(entry => samePredeployedRpc(entry.rpc, rpcUrl))');
    expect(standaloneServer).not.toContain('arrakisConfig');
    const waitForMarketMakerReady = orchestrator.slice(orchestrator.indexOf('const waitForMarketMakerReady = async (): Promise<void> => {'));
    const waitForMarketMakerReadyEnd = waitForMarketMakerReady.indexOf('const waitForHubSelfReady = async (child: HubChild): Promise<void> => {');
    expect(waitForMarketMakerReadyEnd).toBeGreaterThan(0);
    const waitForMarketMakerReadyBody = waitForMarketMakerReady.slice(0, waitForMarketMakerReadyEnd);
    expect(waitForMarketMakerReadyBody).toContain('const health = computeAggregatedHealth();');
    expect(waitForMarketMakerReadyBody).not.toContain('buildAggregatedHealthResponse()');
    expect(waitForMarketMakerReady.indexOf('if (marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null)')).toBeLessThan(
      waitForMarketMakerReady.indexOf('health.marketMaker.ok'),
    );
    expect(marketMakerPoller.indexOf("fetchJson<MarketMakerInfoPayload>(`${apiBase()}/api/info`, infoTimeoutMs)")).toBeLessThan(
      marketMakerPoller.indexOf("fetchJson<MarketMakerHealthPayload>(`${apiBase()}/api/health`, healthTimeoutMs)"),
    );
    expect(marketMakerPoller).toContain('const applyHealth = (');
    expect(marketMakerPoller).toContain('child.lastHealth = health;');
    expect(marketMakerPoller).toContain('options: { trustStartupPhase: boolean },');
    expect(marketMakerPoller).toContain('if (health.startupPhase !== undefined && (options.trustStartupPhase || !nextInfo.startupPhase)) {');
    expect(marketMakerPoller).toContain('if (health) applyHealth(health, proc, { trustStartupPhase: !infoFresh });');
    const lastStartupPhaseUpdate = marketMakerPoller.slice(marketMakerPoller.indexOf('child.lastStartupPhase = String('));
    expect(lastStartupPhaseUpdate.indexOf('child.lastInfo?.startupPhase ||')).toBeLessThan(
      lastStartupPhaseUpdate.indexOf('child.lastHealth?.startupPhase ||'),
    );
    expect(marketMakerAggregation).toContain('MARKET_MAKER_HUB_DEPTH_NOT_READY');
    expect(marketMakerAggregation).toContain('depthReady: route.depthReady === true');
    expect(marketMakerAggregation).toContain('expectedOffers: Number(pair.expectedOffers || 0)');
    expect(orchestrator).toContain('health.marketMaker.hubs.every(hub => hub.depthReady)');
    expect(orchestrator).toContain('syncCanonicalJurisdictionsFromShard(jurisdictionsConfig)');
    expect(orchestrator).toContain('const primaryJurisdiction = resolvePrimaryHubJurisdictionFallback(jurisdictionsConfig);');
    expect(orchestrator).toContain('jurisdictionId: primaryJurisdiction.key');
    expect(orchestrator).not.toContain("jurisdictionId: 'arrakis'");
    expect(startCustodyDev).toContain('const custodyJurisdictionId = await resolveCustodyJurisdictionId();');
    expect(startCustodyDev).toContain('jurisdictionId: custodyJurisdictionId');
    expect(startCustodyDev).toContain('CUSTODY_JURISDICTION_ID: custodyJurisdictionId');
    expect(startCustodyDev).not.toContain("jurisdictionId: 'arrakis'");
    expect(startCustodyDev).not.toContain("CUSTODY_JURISDICTION_ID: 'arrakis'");
    expect(cli).toContain("const REMOTE_RPC = process.env['XLN_CLI_REMOTE_RPC'] || 'https://xln.finance/rpc';");
    expect(cli).not.toContain('/rpc/arrakis');
    expect(readFileSync(join(repoRoot, 'runtime/orchestrator/jurisdictions.ts'), 'utf8'))
      .toContain('const seedPath = existsSync(canonicalPath) ? canonicalPath : resolveRepoJurisdictionsJsonPath();');
    expect(orchestrator).toContain('const buildSecondaryRpcArgs = (): string[] => {');
    expect(orchestrator).toContain('const buildRpcChildEnv = (): Record<string, string> => {');
    expect(orchestrator).toContain('const rpcProxyIndex = resolveRpcProxyIndex(pathname);');
    expect(orchestrator).toContain("return await proxyRpc(request, args.rpcUrls[rpcProxyIndex] || '');");
    expect(orchestrator).toContain("XLN_RUNTIME_EXIT_ON_FATAL: process.env['XLN_RUNTIME_EXIT_ON_FATAL'] ?? '1'");
    expect(orchestrator).toContain("XLN_STORAGE_WRITE_TIMEOUT_MS: process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] ?? '60000'");
    expect(orchestrator).toContain("const HUB_BOOTSTRAP_PAUSE_STORAGE = process.env['XLN_HUB_BOOTSTRAP_PAUSE_STORAGE'] ?? '1';");
    expect(orchestrator).toContain("process.env['XLN_HUB_READY_SNAPSHOT_TIMEOUT_MS'] || '60000'");
    expect(orchestrator).toContain('XLN_HUB_BOOTSTRAP_PAUSE_STORAGE: HUB_BOOTSTRAP_PAUSE_STORAGE');
    expect(orchestrator).toContain("XLN_LOG_LEVEL: process.env['XLN_HUB_LOG_LEVEL'] ?? process.env['XLN_LOG_LEVEL'] ?? 'warn'");
    expect(runtimeEntityRouting).not.toContain('deps.startRuntimeLoop(env);');
    expect(runtimeEntityRouting).not.toContain('processRuntime(env)');
    expect(runtimeEntityRouting).not.toContain('queueMicrotask(() =>');
    expect(runtimeMainSource).toContain('const shouldExitOnRuntimeFatal = (runtimeProcess = getRuntimeProcessGlobal()): boolean =>');
    expect(runtimeMainSource).toContain("runtimeProcess.exit(1);");
    expect(orchestrator).toContain("XLN_STORAGE_SYNC_WRITES: process.env['XLN_STORAGE_SYNC_WRITES'] ?? '0'");
    expect(orchestrator).toContain("XLN_MARKET_MAKER_DISABLE_STORAGE: process.env['XLN_MARKET_MAKER_DISABLE_STORAGE'] ?? '1'");
    expect(orchestrator).toContain("XLN_DISABLE_RUNTIME_RESTORE: process.env['XLN_MARKET_MAKER_DISABLE_RESTORE'] ?? process.env['XLN_DISABLE_RUNTIME_RESTORE'] ?? '1'");
    expect(orchestrator).toContain("XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT: process.env['XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT'] ?? '1'");
    expect(orchestrator).toContain("XLN_LOG_LEVEL: process.env['XLN_MARKET_MAKER_LOG_LEVEL'] ?? process.env['XLN_LOG_LEVEL'] ?? 'warn'");
    expect(orchestrator).toContain('const getMarketMakerIdentities = (): MarketMakerSupportPeerIdentity[] => {');
    expect(orchestrator).toContain('deriveMarketMakerEntityId(signerId, toMarketMakerEntityJurisdictionConfig(jurisdiction))');
    expect(orchestrator).toContain('resolveSecondaryJurisdictions<MarketMakerJurisdictionConfig>(primary.rpc)');
    expect(orchestrator).toContain('`${marketMakerChild.signerLabel}:${secondaryName}`');
    expect(orchestrator).toContain('jurisdictionName: jurisdiction.name');
    expect(orchestrator).toContain('chainId: Number(jurisdiction.chainId || 0)');
    expect(orchestrator).toContain('depositoryAddress: jurisdiction.contracts.depository');
    expect(orchestrator).toContain("'--support-peer-identities-json', JSON.stringify(getMarketMakerIdentities())");
    expect(orchestrator).not.toContain('JSON.stringify([getMarketMakerIdentity()])');
    expect(orchestrator).toContain('const getExitedHubChild = (): HubChild | null =>');
    expect(orchestrator).toContain('HUB_EXITED_DURING_MM_READY name=${exitedHub.name}');
    expect(orchestrator).toContain('hubsOnline &&');

    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const serverJurisdictions = readFileSync(join(repoRoot, 'runtime/server/jurisdictions.ts'), 'utf8');
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const runtimeTxHandlers = readFileSync(join(repoRoot, 'runtime/runtime-tx-handlers.ts'), 'utf8');
    const jadapterTypes = readFileSync(join(repoRoot, 'runtime/jadapter/types.ts'), 'utf8');
    const rpcAdapter = readFileSync(join(repoRoot, 'runtime/jadapter/rpc.ts'), 'utf8');
    expect(hubNode).toContain("nodeLog.info('jurisdiction_contracts.stale_dropped'");
    expect(hubNode).not.toContain('`[${resolvedArgs.name}] RPC contracts have no code');
    expect(hubNode).toContain("nodeLog.debug('sibling_jurisdiction.importing'");
    expect(hubNode).toContain("nodeLog.debug('sibling_jurisdiction.ready'");
    expect(hubNode).not.toContain('console.log(`Importing sibling hub jurisdiction');
    expect(hubNode).not.toContain('console.log(`Sibling hub ready');
    expect(hubNode).not.toContain('`[${resolvedArgs.name}] Importing sibling hub jurisdiction');
    expect(hubNode).not.toContain('`[${resolvedArgs.name}] Sibling hub ready');
    expect(hubNode).not.toContain('`[${resolvedArgs.name}] deploying fresh RPC contract stack');
    expect(hubNode).not.toContain('`[${resolvedArgs.name}] token registered');
    expect(hubNode).not.toContain("pathname === '/api/lending/offer'");
    expect(hubNode).not.toContain("pathname === '/api/lending/borrow'");
    expect(hubNode).not.toContain("pathname === '/api/lending/repay'");
    expect(hubNode).toContain("pathname === '/api/lending/state'");
    expect(hubNode).toContain('const readRpcUrls = (): Record<number, string> => {');
    expect(hubNode).toContain("const match = raw.match(/^\\/(?:api\\/)?rpc([2-8])?(?:\\?.*)?$/);");
    expect(hubNode).toContain('visibleDirectSupportPeers');
    expect(hubNode).toContain('jurisdictionName: normalizeJurisdictionDisplayName(entry?.jurisdictionName || \'\')');
    expect(hubNode).not.toContain("normalized === 'arrakis'");
    expect(hubNode).not.toContain("normalized === 'wakanda'");
    expect(hubNode).not.toContain('PRIMARY_TESTNET_JURISDICTION_NAME');
    const meshJurisdictions = readFileSync(join(repoRoot, 'runtime/orchestrator/mesh-jurisdictions.ts'), 'utf8');
    expect(meshJurisdictions).toContain('const exactMatch = entries.find((entry) => sameMeshRpc(entry.rpc, requestedRpc));');
    expect(meshJurisdictions).toContain('entries.find(isPrimaryJurisdiction)');
    expect(meshJurisdictions).not.toContain("map['arrakis']");
    expect(serverJurisdictions).toContain("const normalizeJurisdictionDisplayName = (value: unknown): string =>");
    expect(serverJurisdictions).not.toContain("normalized === 'arrakis'");
    expect(serverJurisdictions).not.toContain("normalized === 'wakanda'");
    expect(serverJurisdictions).not.toContain("name: 'Testnet'");
    expect(serverJurisdictions).not.toContain('PRIMARY_TESTNET_JURISDICTION_NAME');
    expect(serverJurisdictions).toContain('selectWritableJurisdictionKey(jurisdictions, undefined, [rpcUrl, publicRpc])');
    expect(serverJurisdictions).not.toContain("jurisdictions['arrakis']");
    expect(serverJurisdictions).not.toContain('arrakisDisplayName');
    expect(serverJurisdictions).not.toContain('existingArrakis');
    expect(serverJurisdictions).toContain('name: displayName');
    expect(standaloneServer).toContain("const jName = updatedRuntimeJurisdiction?.key || 'primary';");
    expect(standaloneServer).not.toContain("const jName = 'arrakis';");
    expect(hubNode).toContain('selectWritableJurisdictionKey(jurisdictions, undefined, [rpcUrl, publicRpcUrl])');
    expect(hubNode).not.toContain("targetKey = 'arrakis'");
    expect(hubNode).toContain('const jurisdictionRef = getJurisdictionIdentityRef({ chainId, depositoryAddress });');
    expect(hubNode).toContain('entry.jurisdictionRef,');
    expect(mmNode).toContain('.filter(profile => profile.jurisdictionRef.length > 0)');
    expect(hubNode).toContain('return getJurisdictionIdentityRef(profile.metadata?.jurisdiction) === targetRef;');
    expect(hubNode).toContain('const peerJurisdiction = profile.metadata?.jurisdiction || identity;');
    expect(hubNode).toContain('if (!sameJurisdictionRef(peerJurisdiction, jurisdiction)) return null;');
    expect(hubNode).not.toContain('sameJurisdictionIdentityOrNameOnlyFallback');
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
    expect(hubNode).toContain("const LOG_HUB_INSPECT_URL = envFlagEnabled(process.env['XLN_HUB_INSPECT_URL_LOG']);");
    const inspectUrlLog = hubNode.slice(hubNode.indexOf('if (LOG_HUB_INSPECT_URL) {'));
    expect(inspectUrlLog).toContain("nodeLog.info('inspect_url.ready'");
    expect(inspectUrlLog).toContain("nodeLog.warn('inspect_url.unavailable'");
    expect(inspectUrlLog).not.toContain('[MESH-HUB] INSPECT_URL');
    expect(hubNode.indexOf('if (LOG_HUB_INSPECT_URL) {')).toBeLessThan(
      hubNode.indexOf("nodeLog.info('inspect_url.ready'"),
    );
    expect(hubNode).toContain('persistRestoredEnvToDB');
    expect(hubNode).toContain('const configureHubBootstrapStorage = (env: Env): void => {');
    expect(hubNode).toContain("if (!envFlagEnabled(process.env['XLN_HUB_BOOTSTRAP_PAUSE_STORAGE'])) return;");
    expect(hubNode).toContain('env.runtimeState.persistencePaused = true;');
    expect(hubNode).toContain('configureHubBootstrapStorage(env);');
    expect(hubNode).toContain("pathname === '/api/control/runtime/persist-ready-snapshot'");
    expect(hubNode).toContain('await stopRuntimeLoopAndWait(env, 30_000);');
    expect(hubNode).toContain('await persistRestoredEnvToDB(env);');
    expect(hubNode).toContain('startRuntimeLoop(env, {');
    expect(hubNode).toContain("nodeLog.info('bootstrap_ready_snapshot.persisted'");
    expect(hubNode).toContain("import { prewarmSignerLabels } from '../account-crypto';");
    expect(hubNode).toContain('const buildLocalHubSignerLabels = (): string[] => {');
    expect(hubNode).toContain('const prewarmLocalHubSignerKeys = (): void => {');
    expect(hubNode).toContain('prewarmLocalHubSignerKeys();');
    expect(hubNode.indexOf('prewarmLocalHubSignerKeys();')).toBeLessThan(hubNode.indexOf('startRuntimeLoop(env, {'));
    expect(hubNode).toContain('const hasLiveJAdapterForJurisdiction = (env: Env, jurisdictionName: string): boolean =>');
    expect(hubNode).toContain('if (!hasLiveJAdapterForJurisdiction(env, secondaryName)) {');
    expect(orchestrator).not.toContain('creditAmount: MARKET_MAKER_CREDIT_AMOUNT.toString()');
    expect(mmNode).toContain('const readRpcUrls = (): Record<number, string> => {');
    expect(mmNode).toContain("const match = raw.match(/^\\/(?:api\\/)?rpc([2-8])?(?:\\?.*)?$/);");
    expect(mmNode).toContain('buildMarketMakerConsensusConfig(signerId, entityJurisdiction)');
    expect(mmNode).toContain('deriveMarketMakerEntityId(signerId, entityJurisdiction)');
    expect(mmNode).toContain('isCanonicalAccountOpener(mmEntityId, hubEntityId)');
    expect(mmNode).toContain("nodeLog.info('dev_bootstrap.storage_disabled'");
    expect(mmNode).not.toContain('Runtime storage disabled for rebuildable market-maker state');
    expect(mmNode).toContain('const configureMarketMakerRuntimeLogging = (env: Env): void => {');
    expect(mmNode).toContain("if (envFlagEnabled(process.env['XLN_MARKET_MAKER_VERBOSE_RUNTIME_LOGS'])) return;");
    expect(mmNode).toContain('env.quietRuntimeLogs = true;');
    expect(mmNode).toContain('prewarmSignerLabels');
    expect(mmNode).toContain('const buildLocalMarketMakerSignerLabels = (): string[] => {');
    expect(mmNode).toContain('const prewarmLocalMarketMakerSignerKeys = (): void => {');
    expect(mmNode).toContain('prewarmLocalMarketMakerSignerKeys();');
    expect(mmNode.indexOf('prewarmLocalMarketMakerSignerKeys();')).toBeLessThan(mmNode.indexOf('startRuntimeLoop(env, {'));
    expect(mmNode).toContain('const hasLiveJurisdictionAdapter = (env: Env, jurisdiction: JurisdictionConfig): boolean => {');
    expect(mmNode).toContain('const targetRef = getJurisdictionIdentityRef(target);');
    expect(mmNode).toContain('const replicaRef = getJurisdictionIdentityRef(replica);');
    expect(mmNode).not.toContain('sameJurisdictionIdentityOrNameOnlyFallback');
    expect(mmNode).toContain('if (hasJurisdictionReplica(env, jurisdiction) && hasLiveJurisdictionAdapter(env, jurisdiction)) return;');
    const runtimeSource = readFileSync(join(repoRoot, 'runtime/runtime.ts'), 'utf8');
    expect(runtimeSource).toContain('const runtimeLoopTickDelayMs = Math.max(0, Math.floor(Number(config?.tickDelayMs ?? 0)));');
    expect(runtimeSource).toContain('maxEntityInputsPerFrame?: number');
    expect(runtimeSource).toContain('maxEntityTxsPerFrame?: number');
    expect(runtimeSource).toContain('const applyEntityInputFrameCap =');
    expect(runtimeSource).toContain('const applyEntityTxFrameCap =');
    expect(runtimeSource).toContain('mempool.entityInputs = [...deferredInputs, ...mempool.entityInputs];');
    expect(runtimeSource).toContain('if (remoteOutputs.length > 0 && env.quietRuntimeLogs !== true)');
    expect(runtimeSource).not.toContain('void config;');
    expect(mmNode).toContain("MARKET_MAKER_RUNTIME_TICK_DELAY_MS'] || '1'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '1000'");
    expect(mmNode).toContain('maxEntityInputsPerFrame: MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME');
    expect(mmNode).toContain('maxEntityTxsPerFrame: MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME');
    expect(hubNode).toContain("process.env['XLN_RUNTIME_TICK_DELAY_MS'] || '1'");
    expect(hubNode).toContain("process.env['XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '1000'");
    expect(hubNode).toContain('maxEntityTxsPerFrame: HUB_MAX_ENTITY_TXS_PER_RUNTIME_FRAME');
    expect(mmNode).toContain('const pushMarketMakerEntityTx = (');
    expect(mmNode).toContain('const entityInputsByEntitySigner = new Map<string, EntityInput>();');
    expect(mmNode).toContain('const waitForActiveJAdapter = async (env: Env, jurisdictionName: string, rounds = 1200)');
    expect(mmNode).toContain('ACTIVE_JADAPTER_NOT_READY name=${jurisdictionName}');
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS'] || '1500000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '1'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_START_DELAY_MS'] || '0'");
    expect(mmNode).toContain("MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK'] || '1000'");
    expect(mmNode).toContain('const MARKET_MAKER_BOOTSTRAP_DEFAULT_OFFERS_PER_ACCOUNT_PER_TICK = 1000;');
    expect(mmNode).toContain('const MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_OFFERS_PER_TICK = 1000;');
    expect(mmNode).toContain('String(MARKET_MAKER_BOOTSTRAP_DEFAULT_OFFERS_PER_ACCOUNT_PER_TICK)');
    expect(mmNode).toContain('String(MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_OFFERS_PER_TICK)');
    expect(mmNode).toContain('const MARKET_MAKER_BOOTSTRAP_DEFAULT_CROSS_OFFERS_PER_ACCOUNT_PER_TICK = 45;');
    expect(mmNode).toContain('const MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_CROSS_OFFERS_PER_TICK = 45;');
    expect(mmNode).toContain('String(MARKET_MAKER_BOOTSTRAP_DEFAULT_CROSS_OFFERS_PER_ACCOUNT_PER_TICK)');
    expect(mmNode).toContain('String(MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_CROSS_OFFERS_PER_TICK)');
    expect(mmNode).toContain("MARKET_MAKER_CROSS_LEVELS_PER_PAIR'] || '3'");
    expect(mmNode).toContain("MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE'] || '1000'");
    expect(mmNode).toContain('pairs.slice(0, MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE)');
    expect(mmNode).toContain("MARKET_MAKER_MAX_LEVELS_PER_PAIR'] || '10'");
    expect(mmNode).not.toContain("MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK'] || '6'");
    expect(mmNode).not.toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] || '6'");
    expect(mmNode).not.toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] || '36'");
    expect(mmNode).toContain("role: 'source-mm-hub' | 'target-mm-hub';");
    expect(mmNode).toContain('const describeMarketMakerAccountBlocker = (');
    expect(mmNode).toContain("reason: 'missing-account' | 'inactive-account' | 'height-zero' | 'pending-frame' | 'mempool';");
    expect(mmNode).toContain('crossOverride?: MarketMakerHealth[\'cross\'];');
    expect(mmNode).toContain('const publishMarketMakerHealthSnapshot = (options: {');
    expect(mmNode).toContain('if (health) cachedMarketMakerHealth = health;');
    expect(mmNode).toContain('const shouldStartJWatcherAtCurrentBlock = (): boolean =>');
    expect(mmNode).toContain("!envFlagEnabled(process.env['XLN_MARKET_MAKER_REPLAY_HISTORICAL_J_EVENTS'])");
    expect(mmNode).toContain('startAtCurrentBlock: shouldStartJWatcherAtCurrentBlock()');
    expect(runtimeTxHandlers).toContain('const initialBlockNumber = await resolveInitialJBlockNumber(jadapter, runtimeTx);');
    expect(runtimeTxHandlers).toContain('IMPORT_J_CURRENT_BLOCK_UNAVAILABLE');
    expect(runtimeTxHandlers).toContain('IMPORT_J_CURRENT_BLOCK_INVALID');
    expect(runtimeTxHandlers).toContain('blockNumber: initialBlockNumber');
    expect(jadapterTypes).toContain('getCurrentBlockNumber?(): Promise<number>;');
    expect(jadapterTypes).toContain('getFinalityDepth?(): number;');
    expect(rpcAdapter).toContain('async getCurrentBlockNumber(): Promise<number> {');
    expect(rpcAdapter).toContain('return await provider.getBlockNumber();');
    expect(rpcAdapter).toContain('getFinalityDepth(): number {');
    expect(rpcAdapter).toContain('return resolveFinalityDepth(false);');
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
    expect(mmNode).toContain("MARKET_MAKER_RUNTIME_TICK_DELAY_MS'] || '1'");
    expect(mmNode).toContain("MARKET_MAKER_API_YIELD_MS'] || '5'");
    expect(mmNode).toContain('const yieldMarketMakerApi = async (): Promise<void> => {');
    expect(mmNode).toContain('await new Promise<void>(resolve => setTimeout(resolve, MARKET_MAKER_API_YIELD_MS));');
    expect(mmNode).not.toContain('const emitCrossProgress =');
    expect(mmNode).not.toContain('const describeCrossQuoteJobProgress =');
    expect(mmNode).not.toContain('const isCrossQuoteJobDepthComplete =');
    const sameProgressBody = extractSourceBlock(mmNode, 'const emitSameQuoteProgress =', 'const isBootstrapDepthComplete =');
    expect(sameProgressBody.indexOf('if (now - lastSameQuoteProgressLogAt < 2_000) return;')).toBeLessThan(
      sameProgressBody.indexOf('const incomplete = jobs.filter(job => !isSameQuoteJobDepthReady(env, job));'),
    );
    expect(mmNode).not.toContain('setImmediate(resolve)');
    expect(mmNode).not.toContain('await sleep(0);');
    expect(mmNode).toContain("MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK'] || '1000'");
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_OFFERS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_CROSS_DEPTH_REQUESTS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('MARKET_MAKER_BOOTSTRAP_CROSS_ROUTE_JOBS_PER_TICK');
    expect(mmNode).toContain("MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE'] || '1'");
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_CONNECTIVITY_TXS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('type MarketMakerCrossOfferBudget = {');
    expect(mmNode).toContain('const hasMarketMakerAccountBacklog = (');
    expect(mmNode).toContain('const hasMarketMakerRuntimeBacklog = (env: Env): boolean => {');
    expect(mmNode).toContain('Boolean(env.runtimeState?.processingPromise)');
    expect(mmNode).toContain('if (hasMarketMakerRuntimeBacklog(env)) return false;');
    expect(mmNode).toContain('type SameQuoteJob = {');
    expect(mmNode).toContain('const isSameQuoteJobDepthReady = (env: Env, job: SameQuoteJob): boolean => {');
    expect(mmNode).toContain('buildMarketMakerOfferSpecs([job.hub.entityId], job.tokenIds)');
    expect(mmNode).not.toContain('const isSameQuoteJobCovered = (env: Env, job: SameQuoteJob): boolean => {');
    expect(mmNode).not.toContain('const isSameQuoteJobReady = (env: Env, job: SameQuoteJob): boolean => {');
    expect(mmNode).toContain('const buildSameQuoteJobs = (visibleHubs: HubProfile[]): SameQuoteJob[] => {');
    expect(mmNode).toContain('let bootstrapSameCursor = 0;');
    expect(mmNode).toContain('const isAllSameQuoteDepthReady = (visibleHubs: HubProfile[]): boolean => {');
    expect(mmNode).toContain('compareStableText(left.context.jurisdictionRef, right.context.jurisdictionRef)');
    expect(mmNode).toContain("jurisdictionRef: String(context.jurisdictionRef || '').trim().toLowerCase()");
    expect(mmNode).not.toContain('compareStableText(left.context.jurisdictionName, right.context.jurisdictionName)');
    expect(mmNode).not.toContain("jurisdictionName: String(context.jurisdictionName || '').trim().toLowerCase()");
    expect(mmNode).not.toContain('const isAllSameQuoteReady = (visibleHubs: HubProfile[]): boolean => {');
    expect(mmNode).not.toContain('const isAllSameQuoteCovered = (visibleHubs: HubProfile[]): boolean => {');
    expect(mmNode).toContain('const isBootstrapDepthComplete = (health: MarketMakerHealth | null): boolean =>');
    expect(mmNode).toContain('const quoteableHubsFor = (context: MarketMakerEntityContext): HubProfile[] =>');
    expect(mmNode).toContain('hubsForContext(visibleHubs, context)');
    expect(mmNode).toContain('.filter(profile => !hasMarketMakerAccountBacklog(env, context.entityId, profile.entityId));');
    expect(mmNode).toContain('): Promise<boolean> => {\n  const localCreditInputsByEntity = new Map<string, EntityInput>();');
    expect(mmNode).toContain('const pushLocalConnectivityTx = (');
    expect(mmNode).toContain('const maintainSameContextQuotes = async (context: MarketMakerEntityContext): Promise<boolean> => {');
    expect(mmNode).toContain('const orderedIncompleteJobs: SameQuoteJob[] = [];');
    expect(mmNode).toContain('const jobsByContext = new Map<string, {');
    expect(mmNode).toContain('const runnableHubEntityIdsFor = (entry: { context: MarketMakerEntityContext; jobs: SameQuoteJob[] }): string[] =>');
    expect(mmNode).toContain('.filter(hubEntityId => !hasMarketMakerAccountBacklog(env, entry.context.entityId, hubEntityId))');
    expect(mmNode).toContain('.slice(0, MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE)');
    expect(mmNode).not.toContain('if (hasMarketMakerAccountBacklog(env, job.context.entityId, job.hub.entityId)) return;');
    expect(mmNode).not.toContain('const hubEntityIds = [job.hub.entityId];');
    expect(mmNode).toContain('if (await maintainMarketMakerQuotes(');
    expect(mmNode).toContain("if (mode !== 'bootstrap') {");
    expect(mmNode).toContain('const entityInputsByEntitySigner = new Map<string, EntityInput>();');
    expect(mmNode).toContain('pushMarketMakerEntityTx(');
    expect(mmNode).not.toContain('const missingByPair = new Map<string, MarketMakerOfferSpec[]>();');
    expect(mmNode).not.toContain('const missingByEntityAndPair = new Map<string, MarketMakerOfferSpec[]>();');
    expect(mmNode).toContain('entityInputs,');
    expect(mmNode).not.toContain('const hasMarketMakerQuoteBacklog = (');
    expect(mmNode).not.toContain('if (hasPendingRuntimeWork(env)) return true;');
    expect(mmNode).not.toContain('!hasMarketMakerQuoteBacklog(env, mmContexts, visibleHubs)');
    expect(mmNode).toContain('const primarySameDepthReady = isMarketMakerSameDepthComplete(healthBeforeQuotes);');
    expect(mmNode).not.toContain('const primarySameReady = isMarketMakerSameReady(healthBeforeQuotes);');
    expect(mmNode).not.toContain("if (mode !== 'bootstrap' || !primarySameDepthReady) {");
    expect(mmNode).toContain('const sameDepthReady = isAllSameQuoteDepthReady(visibleHubs);');
    expect(mmNode).toContain('const sameSettledDepthReady = primarySameDepthReady && sameDepthReady;');
    expect(mmNode).toContain('if (!sameSettledDepthReady) return false;');
    expect(mmNode).not.toContain('const sameCoverageReady = isAllSameQuoteCovered(visibleHubs);');
    expect(mmNode).not.toContain('const sameSettledReady = primarySameReady && isAllSameQuoteReady(visibleHubs);');
    expect(mmNode).not.toContain('if (bootstrapCrossStarted ? !sameCoverageReady : !sameSettledReady) return false;');
    expect(mmNode).not.toContain('const reserveCrossOfferBudget = (');
    expect(mmNode).not.toContain('remainingOffersTotal: MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK');
    expect(mmNode).toContain('route.source.counterpartyEntityId');
    expect(mmNode).not.toContain('coverageOnly');
    expect(mmNode).toContain('bootstrapCrossCursor');
    expect(mmNode).toContain('steadyCrossCursor');
    expect(mmNode).toContain('const selectedCrossQuoteJobs: Array<{ index: number; job: CrossQuoteJob }>');
    expect(mmNode).toContain('advanceCrossCursorAfterEnqueue(entry.index)');
    expect(mmNode).toContain('const deferredBootstrapCrossInputs = mode === \'bootstrap\'');
    expect(mmNode).toContain("direction: 'bootstrap-batch'");
    expect(mmNode).toContain('if (mode === \'bootstrap\' && deferredBootstrapCrossInputs && deferredBootstrapCrossInputs.size > 0) break;');
    const crossJobPlanningStart = mmNode.indexOf('const crossQuoteJobs: CrossQuoteJob[] = [];');
    const crossSelectionStart = mmNode.indexOf('const selectedCrossQuoteJobs: Array<{ index: number; job: CrossQuoteJob }>');
    expect(crossJobPlanningStart).toBeGreaterThan(0);
    expect(crossSelectionStart).toBeGreaterThan(crossJobPlanningStart);
    const crossJobPlanning = mmNode.slice(crossJobPlanningStart, crossSelectionStart);
    expect(crossJobPlanning).not.toContain('buildMarketMakerCrossOfferSpecs(');
    expect(crossJobPlanning).toContain('crossQuoteJobs.push({');
    expect(mmNode).toContain("emitMarketMakerCrossBootstrapWaveEvent('cross-wave-connectivity'");
    expect(mmNode).not.toContain('launch one per-account settlement wave and wait for');
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK");
    expect(mmNode).toContain('let bootstrapCrossStarted = false;');
    expect(mmNode).toContain('if (sameReady) {');
    expect(mmNode).not.toContain('\n      bootstrapCrossStarted = false;');
    expect(mmNode).toContain('const previousPhase = startupPhase;');
    expect(mmNode).toContain('if (startupPhase !== previousPhase) rebuildCachedHealthResponseJson();');
    expect(mmNode).toContain("startupPhase = 'bootstrap-cross';");
    expect(mmNode).toContain("if (mode === 'steady') return true;");
    expect(mmNode).toContain('bootstrapCrossCursor = nextCursor;');
    expect(mmNode).toContain("if (mode === 'steady') steadyCrossCursor = nextCursor;");
    expect(mmNode).toContain('if (mode === \'bootstrap\' && deferredBootstrapCrossInputs && deferredBootstrapCrossInputs.size > 0) break;');
    expect(mmNode).toContain('sourceHubs,');
    expect(mmNode).toContain('targetHubs,');
    expect(mmNode).toContain("if (mode === 'steady') return true;");
    expect(mmNode).toContain('isAllSameQuoteDepthReady(readVisibleHubProfiles(env, true)) && isMarketMakerDepthComplete(health)');
    expect(mmNode).toContain("scope: 'same-chain-all-contexts-depth'");
    expect(mmNode).not.toContain("if (mode !== 'bootstrap') return;");
    expect(mmNode).not.toContain("const sameQuoteContexts = mode === 'bootstrap' ? mmContexts.slice(0, 1) : mmContexts;");
    expect(mmNode).not.toContain("const jobCount = mode === 'bootstrap'");
    expect(mmNode).not.toContain('? crossQuoteJobs.length');
    expect(mmNode).toContain('MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK');
    expect(mmNode).toContain('if (isBootstrapDepthComplete(health)) return;');
    expect(mmNode).toContain('if (isBootstrapDepthComplete(beforeDrive) && canCheckBootstrapCompletion()) return beforeDrive;');
    expect(mmNode).toContain('const hubsDepthReady = hubs.length > 0 && hubs.every((entry) => entry.depthReady);');
    expect(mmNode).toContain('const crossDepthReady = !cross.applicable || (');
    expect(mmNode).toContain('ready: pairs.length > 0 && pairs.every(pair => pair.ready) && blockers.length === 0');
    expect(mmNode).not.toContain('const finalizedByPair = countFinalizedCrossOffersByPair(env, targetSpecs);');
    expect(mmNode).not.toContain('(finalizedByPair.get(spec.pairId) || 0) === 0');
    expect(mmNode).toContain('const selectedPairs = new Set<string>();');
    expect(mmNode).toContain('if (selectedPairs.has(spec.pairId)) continue;');
    expect(mmNode).toContain('cross.routes.every((route) => route.depthReady)');
    expect(mmNode).toContain('ok: hubsDepthReady && crossDepthReady');
    expect(mmNode).toContain('countCommittedMarketMakerOffersForHub(env, mmEntityId, hubEntityId)');
    expect(mmNode).toContain('countCommittedMarketMakerOffersForHubPair(env, mmEntityId, hubEntityId, pair)');
    expect(mmNode).toContain('blockers: blocker ? [blocker] : []');
    expect(mmNode).toContain('accountReady && expectedHubOffers > 0');
    expect(mmNode).toContain('MARKET_MAKER_BOOTSTRAP_INCOMPLETE');
    expect(mmNode).toContain("nodeLog.info('bootstrap.ready_hash'");
    expect(mmNode).toContain('const health = assertMarketMakerBootstrapFinalized(');
    expect(mmNode).toContain('const isMarketMakerFullDepthComplete = (health: MarketMakerHealth | null): boolean => {');
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_OFFERS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT');
    expect(mmNode).not.toContain('MARKET_MAKER_MAX_CONNECTIVITY_TXS_PER_ENTITY_INPUT');
    expect(mmNode).toContain('collectQueuedSwapOfferIds(env, mmEntityId, hubEntityId)');
    expect(mmNode).toContain('hasQueuedExtendCredit(env, mmEntityId, hubEntityId, tokenId, creditAmount)');
    expect(mmNode).toContain('const hasSourceAccountCrossOffer = (env: Env, route: CrossJurisdictionSwapRoute): boolean => {');
    expect(mmNode).toContain('if (hasSourceAccountCrossOffer(env, route)) return true;');
    expect(mmNode).not.toContain('const isMarketMakerBootstrapReady = (health: MarketMakerHealth | null): boolean => {');
    expect(mmNode).toContain('const isMarketMakerDepthComplete = (health: MarketMakerHealth | null): boolean => {');
    expect(mmNode).toContain('const isMarketMakerFullDepthComplete = (health: MarketMakerHealth | null): boolean => {');
    expect(mmNode).toContain('const isMarketMakerCrossDepthComplete = (health: MarketMakerHealth | null): boolean => {');
    expect(mmNode).toContain('const publishReadyHealthSnapshot = (): MarketMakerHealth | null => {');
    expect(mmNode).toContain('const currentHealth = cachedMarketMakerHealth;');
    expect(mmNode).toContain('if (!currentHealth || !isMarketMakerCrossDepthComplete(currentHealth)) {');
    expect(mmNode).toContain('crossOverride: currentHealth.cross');
    expect(mmNode).toContain("if (startupPhase === 'offers-ready') {");
    expect(mmNode).toContain("const before = publishReadyHealthSnapshot();");
    expect(mmNode).toContain('if (isMarketMakerFullDepthComplete(before)) return;');
    expect(mmNode).toContain("await driveQuotes('steady');");
    expect(mmNode).toContain('const after = publishReadyHealthSnapshot();');
    const refreshCachedHealthBlock = extractSourceBlock(
      mmNode,
      'const refreshCachedHealth = (): void => {',
      'const runQuoteMaintenance = async (): Promise<void> => {',
    );
    expect(refreshCachedHealthBlock).toContain('publishReadyHealthSnapshot();');
    expect(refreshCachedHealthBlock).not.toContain('includeCross: true');
    expect(mmNode).not.toContain("bootstrapCrossExpectedRoutes === false");
    expect(mmNode).not.toContain("crossOverride: buildNeutralMarketMakerCrossHealth()");
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

  test('prod runtime child keeps merge debug output structured and gated', () => {
    const mergeSource = readFileSync(join(repoRoot, 'runtime/entity-input-merge.ts'), 'utf8');
    expect(mergeSource).toContain("const entityInputMergeLog = createStructuredLogger('entity.input.merge');");
    expect(mergeSource).toContain("entityInputMergeLog.debug('precommits.merge'");
    expect(mergeSource).toContain("entityInputMergeLog.debug('input.merged'");
    expect(mergeSource).not.toContain('console.');
  });

  test('health enrichment cannot erase an active reset failure', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const recompute = extractSourceBlock(
      orchestrator,
      'const recomputeHealthWithMarketMaker = (',
      'const enrichMarketMakerCrossFromHubSnapshots = async',
    );
    expect(recompute).toContain('const resetOk = deriveResetHealthOk(health.reset);');
    expect(recompute).toContain('health.coreOk &&\n    resetOk &&');
    expect(recompute).toContain("resetOk ? null : 'reset'");
  });

  test('isolated e2e runner bounds green-path MM teardown and cleans child ports', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
    expect(runner).toContain('const stopShardRuntimePorts = async (');
    expect(runner).toContain('await stopProcess(api, 35_000);');
    expect(runner).toContain('await stopShardRuntimePorts(apiPort, log);');
    expect(runner).toContain('await freePort(apiPort + 13, log);');
    expect(runner).toContain('const E2E_ANVIL_HISTORY_STATES = 256;');
    expect(runner.match(/'--prune-history'/g)).toHaveLength(2);
    expect(runner.match(/String\(E2E_ANVIL_HISTORY_STATES\)/g)).toHaveLength(2);
    expect(runner).not.toContain("'--max-persisted-states'");
    expect(runner).toContain("TMPDIR: anvilTmpDir");
    expect(runner).toContain("TMPDIR: anvil2TmpDir");
    expect(runner).toContain('rmSync(anvilTmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });');
    expect(runner).toContain('rmSync(anvil2TmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });');
    expect(runner).not.toContain('await stopProcess(api, 120_000);');
  });

  test('non-production Anvil harnesses keep bounded history in memory', () => {
    const harnesses = [
      'runtime/scripts/run-e2e-parallel-isolated.ts',
      'runtime/scripts/rpc-settlement-parity.ts',
      'runtime/scripts/dev-anvil-stack.ts',
      'runtime/scripts/run-system-tests-parallel.ts',
      'runtime/scenarios/boot.ts',
      'runtime/__tests__/watchtower-rpc-last-resort.test.ts',
    ];
    for (const relativePath of harnesses) {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8');
      expect(source, relativePath).toContain("'--prune-history'");
    }
  });

  test('isolated e2e outer timeout exceeds every declared Playwright test timeout', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
    const configured = runner.match(/const DEFAULT_E2E_TEST_TIMEOUT_MS = ([\d_]+);/);
    expect(configured).not.toBeNull();
    const outerTimeoutMs = Number(String(configured?.[1] || '').replaceAll('_', ''));
    const declaredTimeouts = Array.from(new Bun.Glob('tests/e2e*.spec.ts').scanSync({ cwd: repoRoot }))
      .flatMap((path) => Array.from(
        readFileSync(join(repoRoot, path), 'utf8').matchAll(/test\.setTimeout\(([\d_]+)\)/g),
        (match) => Number(String(match[1] || '').replaceAll('_', '')),
      ));
    expect(declaredTimeouts.length).toBeGreaterThan(0);
    expect(outerTimeoutMs).toBeGreaterThan(Math.max(...declaredTimeouts));
  });

  test('fast e2e caps full-stack browser concurrency at the release-tested level', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-fast.ts'), 'utf8');
    const configured = runner.match(/'--shards=(\d+)'/);
    expect(configured).not.toBeNull();
    expect(Number(configured?.[1] || 0)).toBeLessThanOrEqual(8);
  });

  test('isolated e2e overlaps the bounded market-maker queue with plain stacks', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
    expect(runner).toContain('const prioritizedMarketMakerIndex = activeMarketMakerTasks < args.maxMmConcurrency');
    expect(runner).toContain('!claimed[index] && task.requireMarketMaker');
    expect(runner).toContain('!claimed[index] && !task.requireMarketMaker');
  });

  test('managed runtime teardown stops J-event producers before draining runtime and network IO', () => {
    const runtimeMain = readFileSync(join(repoRoot, 'runtime/runtime.ts'), 'utf8');
    const sources = [
      readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8'),
      readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8'),
    ];

    expect(runtimeMain).toContain('export const stopJurisdictionWatchers = (env: Env): void => {');
    for (const source of sources) {
      expect(source).toContain('stopJurisdictionWatchers,');
      const quiesceBlock = extractSourceBlock(
        source,
        "if (pathname === '/api/control/runtime/quiesce' && request.method === 'POST') {",
        'return new Response(safeStringify({ ok: true, runtimeDrained: drained',
      );
      expect(quiesceBlock.indexOf('stopJurisdictionWatchers(env);')).toBeLessThan(
        quiesceBlock.indexOf('waitForRuntimeWorkDrained(env, 20_000, 750)'),
      );
      expect(quiesceBlock.indexOf('waitForRuntimeWorkDrained(env, 20_000, 750)')).toBeLessThan(
        quiesceBlock.indexOf('stopRuntimeLoopAndWait(env, 5_000)'),
      );
      expect(quiesceBlock.indexOf('stopRuntimeLoopAndWait(env, 5_000)')).toBeLessThan(
        quiesceBlock.indexOf('stopP2P(env);'),
      );

      const shutdownBlock = extractSourceBlock(
        source,
        'const shutdown = async',
        'const stopParentWatch = startParentLivenessWatch',
      );
      expect(shutdownBlock.indexOf('stopJurisdictionWatchers(env);')).toBeLessThan(
        shutdownBlock.indexOf('stopRuntimeLoopAndWait(env, 10_000)'),
      );
      expect(shutdownBlock.indexOf('stopRuntimeLoopAndWait(env, 10_000)')).toBeLessThan(
        shutdownBlock.indexOf('stopP2P(env);'),
      );
    }
  });

  test('restored hub and market-maker runtimes attach P2P before starting their loops', () => {
    for (const sourcePath of ['runtime/orchestrator/hub-node.ts', 'runtime/orchestrator/mm-node.ts']) {
      const source = readFileSync(join(repoRoot, sourcePath), 'utf8');
      const p2pStart = source.indexOf('const p2p = startP2P(env, {');
      const p2pReady = source.indexOf("if (!p2p) throw new Error('P2P_START_FAILED');", p2pStart);
      const runtimeLoopStart = source.indexOf('startRuntimeLoop(env, {', p2pReady);
      expect(p2pStart).toBeGreaterThan(0);
      expect(p2pReady).toBeGreaterThan(p2pStart);
      expect(runtimeLoopStart).toBeGreaterThan(p2pReady);
    }
  });

  test('deploy starts and checks the production Tron chain', () => {
    const deploy = readFileSync(join(repoRoot, 'deploy.sh'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(deploy).toContain('pm2 start scripts/start-anvil2.sh --name anvil2');
    expect(deploy).toContain('wait_for_rpc_chain "http://127.0.0.1:8546" "0x7a6a"');
    expect(deploy).toContain('wait_for_public_rpc_chain "/rpc2" "0x7a6a"');
    expect(deploy).toContain('curl --max-time 10 -fsS http://127.0.0.1:8080/api/health');
    expect(deploy).toContain('curl --max-time 10 -fsS "$url"');
    expect(deploy).toContain('curl --max-time 10 -sS -X POST');
    expect(deploy).toContain('location ~ ^/rpc[2-8]$');
    expect(deploy).toContain('public /rpc must proxy through orchestrator safety filter');
    expect(deploy).toContain('fail_deploy_with_debug "anvil2 did not become ready on :8546"');
    expect(deploy).toContain('local deadline=$((SECONDS + 1800))');
    expect(deploy).toContain('RESET_PRODUCTION_MESH=0');
    expect(deploy).toContain('--reset-mesh');
    expect(deploy).toContain('--code-only');
    expect(deploy).toContain('if [ "$RESET_PRODUCTION_MESH" = "1" ]; then');
    expect(deploy).toContain('echo "[deploy] restarting production services without resetting anvil/runtime state"');
    expect(deploy).toContain('echo "[deploy] resetting production anvil + runtime state"');
    expect(deploy).toContain('export XLN_JDB_ROOT="${XLN_JDB_ROOT:-$XLN_STATE_ROOT/jdb}"');
    expect(deploy).toContain('export XLN_RDB_ROOT="${XLN_RDB_ROOT:-$XLN_STATE_ROOT/rdb}"');
    expect(deploy).toContain('PRODUCTION_STATE_MIGRATION_COLLISION');
    expect(deploy).toContain('rmdir data db db-tmp 2>/dev/null || true');
    expect(deploy).toContain('chmod -R go-rwx "$XLN_STATE_ROOT"');
    expect(deploy).toContain('rm -rf "$XLN_RDB_ROOT/runtime/prod-main"');
    expect(deploy).toContain('pm2 start scripts/start-anvil.sh --name anvil --interpreter bash --max-memory-restart 512M -- --reset');
    expect(deploy).toContain('pm2 start scripts/start-anvil2.sh --name anvil2 --interpreter bash --max-memory-restart 512M -- --reset');
    expect(deploy).toContain('pm2 start scripts/start-anvil.sh --name anvil --interpreter bash --max-memory-restart 512M');
    expect(deploy).toContain('pm2 start scripts/start-anvil2.sh --name anvil2 --interpreter bash --max-memory-restart 512M');
    expect(deploy).toContain('pm2 delete xln-server >/dev/null 2>&1 || true');
    expect(deploy).toContain('run_or_fail_deploy "failed to start xln-server via pm2" pm2 start scripts/start-server.sh --name xln-server --interpreter bash --max-memory-restart 900M');
    expect(deploy).toContain('export XLN_MESH_PRESERVE_STATE_ON_RESET=0');
    expect(deploy).toContain('export XLN_MESH_PRESERVE_STATE_ON_RESET=1');
    expect(deploy.match(/git clean -fd -e data\/ -e db\/ -e db-tmp\//g)).toHaveLength(2);
    expect(deploy.match(/if \[ -f \/var\/lib\/xln\/\.checkout-state-migrated \]; then git clean -fd; else/g)).toHaveLength(2);
    expect(deploy).not.toContain('pm2 restart xln-server');
    expect(packageJson.scripts['deploy:prod:runtime']).toContain('--code-only');
    expect(packageJson.scripts['deploy:prod:runtime:code']).toContain('--code-only');
    expect(packageJson.scripts['deploy:prod:runtime:reset']).toContain('--reset-mesh');
    expect(packageJson.scripts['deploy:prod:fresh']).toContain('--reset-mesh');
  });

  test('prod remote runtime import e2e cannot reset the shared prod mesh implicitly', () => {
    const baseline = readFileSync(join(repoRoot, 'tests/utils/e2e-baseline.ts'), 'utf8');
    const radapterRemote = readFileSync(join(repoRoot, 'tests/e2e-radapter-remote.spec.ts'), 'utf8');
    const appLayout = readFileSync(join(repoRoot, 'frontend/src/routes/app/+layout.svelte'), 'utf8');
    const importFlow = readFileSync(join(repoRoot, 'frontend/src/lib/utils/remoteRuntimeImportFlow.ts'), 'utf8');
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const isolatedRunner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');

    expect(baseline).toContain('allowAutoReset?: boolean;');
    expect(baseline).toContain('if (!resolved.allowAutoReset) {');
    expect(baseline).toContain('E2E baseline was not ready and automatic reset is disabled');
    expect(radapterRemote).toContain('allowAutoReset: false');
    expect(orchestrator).toContain('const publishRuntimeImportManifest = async (): Promise<boolean> => {');
    expect(orchestrator).toContain('const health = await buildAggregatedHealthResponse();');
    expect(orchestrator).toContain('const readiness = resolveRuntimeImportReadiness(health);');
    expect(orchestrator).toContain('if (!readiness.ok) {');
    expect(orchestrator).toContain("const allowPartial = url.searchParams.get('allowPartial') === '1' && isLocalOperatorRequest(request);");
    expect(orchestrator).toContain('partial: true,');
    expect(orchestrator).toContain('ready: false,');
    expect(orchestrator).toContain('category: readiness.category,');
    expect(orchestrator).toContain('failure: readiness.failure,');
    expect(orchestrator).toContain('entries: [],');
    expect(orchestrator).toContain("'Retry-After': '2'");
    expect(orchestrator).not.toContain('status: readiness.status, headers');
    expect(orchestrator).toContain('clearRuntimeImportManifestFile();');
    expect(orchestrator).toContain('scheduleRuntimeImportManifestRefresh(null);');
    expect(orchestrator).toContain('clearRuntimeImportManifestFile();\n  const preserveState');
    expect(orchestrator).not.toContain('await persistHubReadySnapshots();\n    publishRuntimeImportManifest();');
    expect(orchestrator).toContain('resetState.inProgress = false;\n  }\n  await publishRuntimeImportManifest();');

    expect(existsSync(join(repoRoot, 'frontend/src/routes/radapter/manage/+page.svelte'))).toBe(false);
    expect(appLayout).toContain('async function importRemoteRuntimesIntoApp');
    expect(appLayout).toContain('fetchRemoteRuntimeImportSource(source)');
    expect(appLayout).toContain('const result = await importRemoteRuntimeEntries(entries)');
    expect(importFlow).toContain('await Promise.allSettled(workers)');
    expect(importFlow).toContain('writeRemoteRuntimeImportSummary(results, entries.length, importedAt)');
    expect(isolatedRunner).toContain("'--wallet-url',\n        `${webUrl}/app`,\n        '--allow-reset'");
    expect(isolatedRunner).not.toContain("'--custody-db-root',\n          join(dbPath, 'custody'),\n          '--wallet-url'");
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
    expect(healthRoute).toContain('if (!cachedHealthResponseJson) rebuildCachedHealthResponseJson();');
    expect(healthRoute).toContain("return new Response(cachedHealthResponseJson ?? '{}', { headers: JSON_HEADERS });");
    expect(healthRoute).not.toContain('safeStringify(');
    expect(healthRoute).not.toContain('readVisibleHubProfiles(');
    expect(healthRoute).not.toContain('getMarketMakerHealth(');
    const healthBuilderStart = mmNode.indexOf('const rebuildCachedHealthResponseJson = (): void => {');
    const publishHealthStart = mmNode.indexOf('const publishMarketMakerHealthSnapshot');
    expect(healthBuilderStart).toBeGreaterThan(0);
    expect(publishHealthStart).toBeGreaterThan(healthBuilderStart);
    const healthBuilder = mmNode.slice(healthBuilderStart, publishHealthStart);
    expect(healthBuilder).toContain("const marketMakerHealth = startupPhase === 'offers-ready'");
    expect(healthBuilder).toContain(': { ...rawMarketMakerHealth, ok: false };');
    expect(healthBuilder).toContain('marketMaker: marketMakerHealth');
    expect(healthBuilder).toContain('expectedRoutes: 0');
    expect(healthBuilder).toContain('cachedHealthResponseJson = safeStringify({');
    expect(mmNode).toContain('const buildDeferredMarketMakerCrossHealth = (applicable: boolean): MarketMakerHealth[\'cross\'] => ({');
    expect(mmNode).not.toContain('const buildNeutralMarketMakerCrossHealth = (): MarketMakerHealth[\'cross\'] => ({');
    expect(mmNode).toContain('ok: expectedRouteCount === 0 || (routes.length >= expectedRouteCount && routes.every(route => route.depthReady))');
    expect(mmNode).toContain('const publishBootstrapHealthSnapshot = (): MarketMakerHealth | null =>');
    expect(mmNode).toContain('const buildBootstrapCrossHealthOverride = (): MarketMakerHealth[\'cross\'] => {');
    expect(mmNode).toContain('return buildPlannedMarketMakerCrossHealth(plan);');
    expect(mmNode).toContain('? { includeCross: false, crossOverride: buildBootstrapCrossHealthOverride() }');
    expect(mmNode).toContain(': { includeCross: false },');
    expect(mmNode).toContain('const buildBootstrapCompletionHealth = (): MarketMakerHealth | null => {');
    expect(mmNode).toContain('bootstrapCompletionHealth = buildMarketMakerHealthSnapshot({ includeCross: true });');
    expect(mmNode).toContain('cachedMarketMakerHealth = bootstrapCompletionHealth;');
    expect(mmNode).toContain('rebuildCachedHealthResponseJson();');
    expect(mmNode).toContain("import { computeCanonicalEntityHashesFromEnv, computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';");
    expect(mmNode).toContain('export const buildMarketMakerBootstrapEntityStateHash = (env: Env): string => {');
    expect(mmNode).toContain("schema: 'market-maker-bootstrap-entity-state-v1'");
    expect(mmNode).toContain('const fingerprint = buildMarketMakerBootstrapFingerprint(');
    expect(mmNode).toContain('const runtimeStateHash = computeCanonicalStateHashFromEnv(env);');
    expect(mmNode).toContain('const entityStateHash = buildMarketMakerBootstrapEntityStateHash(env);');
    expect(mmNode).toContain('bootstrapReadyHash = fingerprint.hash;');
    expect(mmNode).toContain('bootstrapRuntimeStateHash = runtimeStateHash;');
    expect(mmNode).toContain('bootstrapEntityStateHash = entityStateHash;');
    expect(mmNode).toContain('runtimeStateHash,');
    expect(mmNode).toContain('entityStateHash,');
    expect(mmNode).toContain("process.env['XLN_MARKET_MAKER_LOG_READY_HASH_PAYLOAD']");
    expect(mmNode).toContain('BOOTSTRAP_READY_HASH_PAYLOAD payload=${safeStringify(fingerprint.payload)}');
    expect(mmNode).toContain('let bootstrapCrossPlanJobCount: number | null = null;');
    expect(mmNode).not.toContain('let bootstrapCrossExpectedRoutes');
    expect(mmNode).toContain("emitBootstrapDebugEvent('cross-plan'");
    expect(mmNode).toContain('const hasExpectedBootstrapCrossRoutes = (visibleHubs: HubProfile[]): boolean =>');
    expect(mmNode).toContain('const canCheckBootstrapCompletion = (): boolean =>');
    expect(mmNode).toContain('if (hasCrossPlan && !bootstrapCrossProducerAttempted) return false;');
    expect(mmNode).toContain('return !hasCrossPlan || !hasBootstrapCrossAccountBacklog(visibleHubs);');
    expect(mmNode).not.toContain('const completionBeforeDrive = buildBootstrapCompletionHealth();');
    expect(mmNode).toContain("const enqueued = await driveQuotes('bootstrap');");
    expect(mmNode).toContain('if (!enqueued && canCheckBootstrapCompletion()) {');
    expect(mmNode).toContain('if (isBootstrapDepthComplete(completionHealth)) return completionHealth;');
    expect(mmNode).toContain('const bootstrapHealth = await waitForBootstrapOffers();');
    expect(mmNode).toContain('await markOffersReady(bootstrapHealth);');
    expect(mmNode).toContain('startQuoteLoop();');
    expect(mmNode).not.toContain("await markOffersReady();\n      publishMarketMakerHealthSnapshot({ includeCross: true });");
    expect(mmNode).toContain("startupPhase = 'bootstrap-same-chain';\n    publishBootstrapHealthSnapshot();");
    expect(mmNode).toContain('if (bootstrapCrossStarted) {');
    expect(mmNode).toContain('isAllSameQuoteDepthReady(visibleHubs) &&');
    expect(mmNode).toContain('isMarketMakerSameDepthComplete(health)');
    expect(mmNode).not.toContain('bootstrapCrossStarted || isMarketMakerSameReady(health)');
    expect(mmNode).not.toContain("if (startupPhase !== 'offers-ready' && bootstrapCrossStarted) {");
    expect(mmNode).not.toContain('const completionHealth = bootstrapCrossStarted ? buildBootstrapCompletionHealth() : health;');
    expect(mmNode).toContain("const enqueued = await driveQuotes('bootstrap');");
    expect(mmNode).toContain('if (startupPhase !== \'offers-ready\' && !enqueued && canCheckBootstrapCompletion()) {');
    expect(mmNode).toContain('await markOffersReady(completionHealth);');
  });

  test('market maker info route keeps cross debug opt-in off the hot path', () => {
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const infoRouteStart = mmNode.indexOf("if (pathname === '/api/info')");
    const fullHealthRouteStart = mmNode.indexOf("if (pathname === '/api/health/full'");
    const healthRouteStart = mmNode.indexOf("if (pathname === '/api/health')", fullHealthRouteStart + 1);
    expect(infoRouteStart).toBeGreaterThan(0);
    expect(fullHealthRouteStart).toBeGreaterThan(infoRouteStart);
    expect(healthRouteStart).toBeGreaterThan(fullHealthRouteStart);

    const infoRoute = mmNode.slice(infoRouteStart, fullHealthRouteStart);
    expect(infoRoute).toContain("url.searchParams.get('crossDebug') === '1'");
    expect(infoRoute).toContain("url.searchParams.get('debug') === 'cross'");
    expect(infoRoute).toContain('return new Response(buildInfoResponseJson(true), { headers: JSON_HEADERS });');
    expect(infoRoute).toContain('if (!cachedInfoResponseJson) rebuildCachedInfoResponseJson();');
    expect(infoRoute).toContain("return new Response(cachedInfoResponseJson ?? '{}', { headers: JSON_HEADERS });");
    expect(infoRoute).not.toContain('getMarketMakerRuntimeBacklogSnapshot(env');
    expect(infoRoute).not.toContain('buildMarketMakerCrossDebugSummary(');
    expect(mmNode).toContain('const buildInfoResponseJson = (includeCrossDebug = false): string => {');
    expect(mmNode).toContain('const currentHealth = cachedMarketMakerHealth;');
    expect(mmNode).toContain('runtimeBacklog: getMarketMakerRuntimeBacklogSnapshot(env, {');
    expect(mmNode).toContain('includeQueuedEntityInputs: includeCrossDebug');
    expect(mmNode).toContain('crossDebug: buildMarketMakerCrossDebugSummary(');
    expect(mmNode).toContain('cachedInfoResponseJson = buildInfoResponseJson(false);');
    expect(infoRoute).not.toContain('const allVisibleHubs = readVisibleHubProfiles(env, true);');
    expect(infoRoute).not.toContain('buildMarketMakerHealthSnapshot({ includeCross: true })');
  });

  test('local prod smoke records bootstrap benchmark stages and hash assertions', () => {
    const packageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    const smoke = readFileSync(join(repoRoot, 'runtime/scripts/local-prod-smoke.ts'), 'utf8');
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const benchmark = readFileSync(join(repoRoot, 'runtime/scripts/bootstrap-benchmark.ts'), 'utf8');
    const soundcheck = readFileSync(join(repoRoot, 'runtime/scripts/bootstrap-soundcheck.ts'), 'utf8');

    expect(packageJson).toContain('"prod:bootstrap:bench": "bun runtime/scripts/test-artifact-cleanup.ts --reason=bootstrap-bench && bun runtime/scripts/bootstrap-benchmark.ts"');
    expect(packageJson).toContain('"prod:bootstrap:fresh": "bun runtime/scripts/test-artifact-cleanup.ts --reason=bootstrap-fresh && bun runtime/scripts/bootstrap-soundcheck.ts --mode=fresh"');
    expect(packageJson).toContain('"prod:bootstrap:template": "bun runtime/scripts/test-artifact-cleanup.ts --reason=bootstrap-template && bun runtime/scripts/bootstrap-soundcheck.ts --mode=template"');
    expect(packageJson).toContain('"prod:bootstrap:clone": "bun runtime/scripts/test-artifact-cleanup.ts --reason=bootstrap-clone && bun runtime/scripts/bootstrap-soundcheck.ts --mode=clone"');
    expect(packageJson).toContain('"prod:bootstrap:hydrate": "bun runtime/scripts/test-artifact-cleanup.ts --reason=bootstrap-hydrate && bun runtime/scripts/bootstrap-soundcheck.ts --mode=hydrate"');
    expect(soundcheck).toContain("import { createConnection } from 'node:net';");
    expect(soundcheck).toContain('const localProdSmokePortOffsets = [0, 1, 4, 7, 8, 10, 11, 12, 13];');
    expect(soundcheck).toContain('const findPortBaseForIndex = async (index: number): Promise<number>');
    expect(soundcheck).toContain('if (explicitPortBase) throw new Error(`BOOTSTRAP_SOUNDCHECK_PORT_BLOCK_BUSY:${requested}`);');
    expect(soundcheck).toContain('throw new Error(`BOOTSTRAP_SOUNDCHECK_NO_FREE_PORT_BLOCK:${requested}`);');
    expect(soundcheck).toContain('const runPortBase = await findPortBaseForIndex(index);');
    expect(smoke).toContain("schema: 'xln-local-prod-bootstrap-benchmark-v1'");
    expect(smoke).toContain("schema: 'xln-bootstrap-debug-event-v1'");
    expect(smoke).toContain("findFirstRuntimeFatalLogHit");
    expect(smoke).toContain("const assertNoFatalChildLogs = (stage: string): void => {");
    expect(smoke).toContain("emitDebugEvent('fatal-log-hit'");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_FATAL_LOG');
    expect(smoke).toContain("assertNoFatalChildLogs('health-poll');");
    expect(mmNode).toContain("schema: 'xln-market-maker-bootstrap-debug-event-v1'");
    expect(mmNode).toContain("process.env['XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL']");
    expect(orchestrator).toContain('XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL:');
    expect(orchestrator).toContain("join(marketMakerChild.dbPath, 'bootstrap-events.jsonl')");
    expect(mmNode).toContain("emitBootstrapDebugEvent('same-quote-progress'");
    expect(mmNode).not.toContain("emitBootstrapDebugEvent('cross-progress'");
    expect(mmNode).toContain("emitMarketMakerCrossBootstrapWaveEvent('cross-wave-enqueue'");
    expect(mmNode).toContain('deferredBootstrapCrossInputs ?? undefined');
    expect(mmNode).toContain("direction: 'bootstrap-batch'");
    expect(mmNode).toContain('BOOTSTRAP_DEBUG_EVENT_WRITE_FAILED');
    expect(smoke).toContain('DEBUG_EVENT_WRITE_FAILED');
    expect(smoke).toContain("const marketMakerEventsJsonlPath =");
    expect(smoke).toContain('XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL: marketMakerEventsJsonlPath');
    expect(smoke).toContain('marketMakerEventsJsonl: marketMakerEventsJsonlPath');
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_ENFORCE_STAGE_BUDGETS'] === '1'");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_HUB_MESH_BUDGET_MS'] || '8000'");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_STAGE_BUDGET_EXCEEDED');
    expect(smoke).toContain("const crossReadyAt = stageElapsed('marketMaker:cross-ready');");
    expect(smoke).toContain("requireStageBudget('marketMaker:cross', crossReadyAt - crossStartedAt, stageBudgetsMs.cross, snapshot);");
    expect(smoke).toContain('const marketMakerFullDepthReady = (health: HealthPayload): boolean => {');
    expect(smoke).toContain('const expectedRoutes = Number(health.marketMaker?.cross?.expectedRoutes || 0);');
    expect(smoke).toContain('hub.depthReady === true');
    expect(smoke).toContain('route.depthReady === true');
    expect(smoke).toContain('marketMakerFullDepthReady(health) &&');
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_SAME_CHAIN_BUDGET_MS'] || '20000'");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_CROSS_BUDGET_MS'] || '60000'");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_HEALTH_POLL_MAX_MS'] || '2000'");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_HEALTH_POLL_INTERVAL_MS'] || '250'");
    expect(smoke).toContain('await sleep(healthPollIntervalMs);');
    expect(smoke).toContain("emitDebugEvent('health-poll'");
    expect(smoke).toContain("emitDebugEvent('health-snapshot'");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_TEMPLATE_DIR']");
    expect(smoke).toContain("const persistMarketMakerStorage = process.env['XLN_LOCAL_PROD_SMOKE_PERSIST_MM'] === '1';");
    expect(smoke).toContain('const copySnapshotTemplate = (sourceDir: string, targetDir: string): void => {');
    expect(smoke).toContain("recordStage('snapshot:copied', { templateDir, workDir });");
    expect(smoke).toContain("XLN_MESH_PRESERVE_STATE_ON_RESET: '1'");
    expect(smoke).toContain("...(useSnapshotTemplate ? {");
    expect(smoke).toContain("XLN_MARKET_MAKER_DISABLE_STORAGE: '0'");
    expect(smoke).toContain("XLN_MARKET_MAKER_DISABLE_RESTORE: '0'");
    expect(smoke).toContain("...(persistMarketMakerStorage ? {");
    expect(smoke).toContain("XLN_MARKET_MAKER_DISABLE_STORAGE: '0'");
    expect(smoke).toContain("XLN_MARKET_MAKER_DISABLE_RESTORE: '0'");
    expect(smoke).toContain("MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK:");
    expect(smoke).toContain("process.env['MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK'] || '45'");
    expect(smoke).toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK:");
    expect(smoke).toContain("process.env['MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] || '45'");
    expect(smoke).toContain("process.env['MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE'] || '3'");
    expect(mmNode).toContain("process.env['MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE'] || '3'");
    expect(mmNode).toContain('remainingSourceHubGroups -= 1;');
    expect(mmNode).toContain('const orderedSourceHubs = [...sourceHubs].sort');
    expect(mmNode).not.toContain('const sourceHubScans = [...sourceHubs]');
    const bootstrapCrossBranch = mmNode.slice(
      mmNode.indexOf('if (emitBootstrapWaveEvents) {'),
      mmNode.indexOf('const desiredOffers = buildMarketMakerCrossOfferSpecs('),
    );
    expect(bootstrapCrossBranch.indexOf("emitMarketMakerCrossBootstrapWaveEvent('cross-wave-start'")).toBeLessThan(
      bootstrapCrossBranch.indexOf('const sourceHubSpecs = buildMarketMakerCrossOfferSpecs('),
    );
    expect(bootstrapCrossBranch).toContain('coverageGaps = countCrossPairCoverageGaps(env, sourceHubSpecs)');
    expect(bootstrapCrossBranch).toContain('progress = countCrossSpecBootstrapProgress(env, sourceHubSpecs, getPendingCrossRequestOrderIds)');
    expect(mmNode).toContain('const deferredBootstrapCrossInputs = mode === \'bootstrap\'');
    expect(mmNode).toContain("direction: 'bootstrap-batch'");
    expect(mmNode).toContain('deferredBootstrapCrossLastIndex = entry.index;\n            break;');
    expect(mmNode).toContain('bootstrapCrossCursor = nextCursor;');
    expect(mmNode).not.toContain('launch one per-account settlement wave and wait for');
    const bootstrapCrossStart = mmNode.indexOf('if (!bootstrapCrossStarted) {');
    expect(bootstrapCrossStart).toBeGreaterThan(0);
    expect(mmNode.slice(bootstrapCrossStart, bootstrapCrossStart + 180)).toContain('bootstrapCrossStarted = true;');
    expect(mmNode.slice(bootstrapCrossStart, bootstrapCrossStart + 180)).toContain("startupPhase = 'bootstrap-cross';");
    expect(bootstrapCrossStart).toBeLessThan(mmNode.indexOf('const crossQuoteJobs: CrossQuoteJob[] = [];'));
    expect(mmNode).toContain('if (hasBootstrapCrossAccountBacklog(visibleHubs)) {\n          await yieldMarketMakerApi();\n          return false;\n        }');
    expect(mmNode.indexOf('if (hasBootstrapCrossAccountBacklog(visibleHubs)) {')).toBeLessThan(
      mmNode.indexOf('const crossQuoteJobs: CrossQuoteJob[] = [];'),
    );
    expect(mmNode).toContain('let bootstrapCompletionCheckArmed = false;');
    expect(mmNode).toContain('let lastProgressAt = Date.now();');
    expect(mmNode).toContain("emitBootstrapDebugEvent('progress'");
    expect(mmNode).toContain('MARKET_MAKER_BOOTSTRAP_STALLED');
    expect(mmNode).toContain("markProgress('enqueue');");
    expect(mmNode).not.toContain("startupPhase = 'bootstrap-degraded'");
    expect(mmNode).toContain("emitBootstrapDebugEvent('completion-health'");
    expect(mmNode).toContain('bootstrapCompletionCheckArmed = true;');
    expect(mmNode).toContain("emitBootstrapDebugEvent('finalize-step'");
    expect(mmNode).toContain("pathname === '/api/health/full' || (pathname === '/api/health' && url.searchParams.get('full') === '1')");
    expect(mmNode).toContain('const health = buildMarketMakerHealthSnapshot({ includeCross: true });');
    expect(mmNode).toContain("pathname === '/api/account/status'");
    expect(mmNode).toContain('pendingFrameTxs: (account?.pendingFrame?.accountTxs || []).map');
    expect(smoke).toContain("const shouldFetchMarketMakerHealth = (health: HealthPayload): boolean =>");
    expect(smoke).toContain("'bootstrap-same-chain'");
    expect(smoke).toContain("'bootstrap-cross'");
    expect(smoke).toContain("const fetchMarketMakerHealth = (health: HealthPayload): MarketMakerDirectHealthPayload | null => {");
    expect(smoke).toContain('if (!shouldFetchMarketMakerHealth(health)) {');
    expect(smoke).toContain('skipped: true');
    expect(smoke).toContain("`http://127.0.0.1:${marketMakerApiPort}/api/health`");
    expect(smoke).toContain("emitDebugEvent('mm-health-poll'");
    expect(smoke).toContain('durationMs: Date.now() - startedAt');
    expect(smoke).toContain('const directMarketMakerHealth = fetchMarketMakerHealth(health);');
    expect(smoke).toContain('const stageHealth = healthWithDirectMarketMaker(health, directMarketMakerHealth);');
    expect(smoke).toContain('if (iteration % 10 === 0 || healthReady(stageHealth))');
    expect(smoke).toContain('if (healthReady(stageHealth))');
    expect(smoke).toContain('return stageHealth;');
    expect(smoke).not.toContain('healthReady(health))');
    expect(smoke).toContain('const summarizeBlockers = (blockers: unknown[] | undefined): unknown[] =>');
    expect(smoke).toContain('blockerDetails: health.marketMaker?.cross?.routes?.map(route => summarizeBlockers(route.blockers)) ?? []');
    expect(mmNode).toContain("persistRestoredEnvToDB");
    expect(mmNode).toContain("process.env['XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT']");
    expect(mmNode).toContain("nodeLog.info('bootstrap.ready_snapshot.persisted'");
    expect(mmNode).toContain('const markOffersReady = async (finalizedHealth?: MarketMakerHealth | null): Promise<void> => {');
    expect(mmNode).toContain('await persistBootstrapReadySnapshotIfRequested();');
    expect(orchestrator).toContain("const preserveState = process.env['XLN_MESH_PRESERVE_STATE_ON_RESET'] === '1';");
    expect(orchestrator).toContain('} else if (existsSync(args.dbRoot)) {');
    expect(orchestrator).toContain('rmSync(args.dbRoot, { recursive: true, force: true });');
    expect(orchestrator).toContain('PRESERVE_STATE_DB_ROOT_MISSING');
    expect(orchestrator).toContain('PRESERVE_STATE_JURISDICTIONS_MISSING');
    expect(orchestrator).toContain('const postJsonExpectOk = async <T extends ControlOkResponse>');
    expect(orchestrator).toContain("payload?.ok !== true");
    expect(orchestrator).toContain('const persistHubReadySnapshots = async (): Promise<void> => {');
    expect(orchestrator).toContain('reset_persist_ready_snapshots');
    expect(orchestrator).toContain('/api/control/runtime/persist-ready-snapshot');
    expect(orchestrator).toContain('await persistHubReadySnapshots();');
    expect(orchestrator.indexOf('await persistHubReadySnapshots();')).toBeLessThan(orchestrator.indexOf("finishTiming('reset_total', resetTotalStartedAt);"));
    expect(smoke).toContain("recordStage(`marketMaker:${marketMakerPhase}`, last);");
    expect(smoke).toContain("recordStageOnce('system:ready', last);");
    expect(smoke).toContain("recordStage('post-bootstrap:observed', { stabilityMs: postBootstrapStabilityMs });");
    expect(smoke).toContain('const rawPostBootstrapHealth = await fetchHealth();');
    expect(smoke).toContain('const postBootstrapDirectMarketMakerHealth = fetchMarketMakerHealth(rawPostBootstrapHealth);');
    expect(smoke).toContain('const postBootstrapHealth = healthWithDirectMarketMaker(rawPostBootstrapHealth, postBootstrapDirectMarketMakerHealth);');
    expect(smoke).not.toContain('const postBootstrapHealth = await fetchHealth();');
    expect(smoke).toContain("recordStage('post-bootstrap:stable', summarizeHealth(postBootstrapHealth));");
    expect(smoke).toContain("MARKET_MAKER_BOOTSTRAP_LOOP_MS: process.env['MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '1'");
    expect(smoke).toContain("XLN_HUB_BOOTSTRAP_PAUSE_STORAGE: process.env['XLN_HUB_BOOTSTRAP_PAUSE_STORAGE'] || '1'");
    expect(smoke).toContain("XLN_HUB_READY_SNAPSHOT_TIMEOUT_MS: process.env['XLN_HUB_READY_SNAPSHOT_TIMEOUT_MS'] || '60000'");
    expect(smoke).toContain("XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT: process.env['XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT'] || '1'");
    expect(smoke).toContain("process.env['XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '1000'");
    expect(smoke).toContain("process.env['MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '1000'");
    expect(smoke).toContain("process.env['MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '1000'");
    expect(smoke).toContain("XLN_RUNTIME_PROCESS_SLOW_MS: process.env['XLN_RUNTIME_PROCESS_SLOW_MS'] || '250'");
    expect(smoke).toContain("XLN_ENTITY_FRAME_SLOW_MS: process.env['XLN_ENTITY_FRAME_SLOW_MS'] || '250'");
    expect(smoke).toContain('throw new Error(`LOCAL_PROD_SMOKE_MM_HEALTH_FAILED error=${message}`);');
    expect(smoke).toContain("if (message.includes('LOCAL_PROD_SMOKE_MM_HEALTH_FAILED')) throw error;");
    expect(smoke).toContain("MARKET_MAKER_MAX_LEVELS_PER_PAIR: process.env['MARKET_MAKER_MAX_LEVELS_PER_PAIR'] || '10'");
    expect(smoke).toContain("MARKET_MAKER_CROSS_LEVELS_PER_PAIR: process.env['MARKET_MAKER_CROSS_LEVELS_PER_PAIR'] || '3'");
    expect(smoke).toContain("process.env['MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE'] || '1000'");
    expect(smoke).toContain("process.env['MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK'] || '1000'");
    expect(smoke).toContain("process.env['MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK'] || '1000'");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_MISSING');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_RUNTIME_HASH_MISSING');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_ENTITY_HASH_MISSING');
    expect(smoke).not.toContain('/BOOTSTRAP_READY_HASH hash=');
    expect(smoke).toContain("emitDebugEvent('bootstrap-hash'");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HEALTH_REGRESSED');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HASH_CHANGED');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_POST_BOOTSTRAP_BACKLOG');
    expect(smoke).toContain("writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\\n`);");
    expect(benchmark).toContain("schema: 'xln-bootstrap-benchmark-summary-v1'");
    expect(benchmark).toContain('BOOTSTRAP_BENCH_BOOTSTRAP_HASH_DRIFT');
    expect(benchmark).toContain('BOOTSTRAP_BENCH_ENTITY_HASH_DRIFT');
    expect(benchmark).toContain("runtimeStateHashes: metrics.map(entry => entry.runtimeStateHash)");
    expect(soundcheck).toContain("type Mode = 'fresh' | 'template' | 'clone' | 'hydrate' | 'all';");
    expect(soundcheck).toContain('cpSync(result.workDir, templateDir, { recursive: true });');
    expect(soundcheck).toContain('const installTemplateFromResult = (result: SoundcheckResult): SoundcheckResult => {');
    expect(soundcheck).toContain("if (mode === 'all') {");
    expect(soundcheck).toContain('results.push(installTemplateFromResult(freshResult));');
    expect(soundcheck).toContain("XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT: '1'");
    expect(soundcheck).not.toContain('XLN_LOCAL_PROD_SMOKE_PERSIST_MM');
    expect(soundcheck).toContain("XLN_LOCAL_PROD_SMOKE_ENFORCE_STAGE_BUDGETS: '1'");
    expect(soundcheck).toContain('marketMakerEventsJsonl: metrics.marketMakerEventsJsonl');
    expect(soundcheck).toContain('BOOTSTRAP_SOUNDCHECK_CLONE_HASH_DRIFT');
    expect(soundcheck).toContain('BOOTSTRAP_SOUNDCHECK_CLONE_ENTITY_HASH_DRIFT');
    expect(soundcheck).toContain('BOOTSTRAP_SOUNDCHECK_HYDRATE_HASH_DRIFT');
    expect(soundcheck).toContain('BOOTSTRAP_SOUNDCHECK_HYDRATE_ENTITY_HASH_DRIFT');
  });

  test('isolated e2e runner fails fast on fatal shard log markers', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
    const fatalHelper = readFileSync(join(repoRoot, 'runtime/scripts/e2e-fatal-log-monitor.ts'), 'utf8');
    const standaloneMonitor = readFileSync(join(repoRoot, 'runtime/scripts/e2e-fail-fast-monitor.ts'), 'utf8');
    const releaseGate = readFileSync(join(repoRoot, 'runtime/scripts/run-release-gate.ts'), 'utf8');
    const mainnetGate = readFileSync(join(repoRoot, 'runtime/scripts/run-mainnet-preflight-gate.ts'), 'utf8');
    const allTestsFast = readFileSync(join(repoRoot, 'runtime/scripts/run-all-tests-fast.ts'), 'utf8');
    const unitTestsRunner = readFileSync(join(repoRoot, 'runtime/scripts/run-unit-tests.ts'), 'utf8');
    const e2eFastRunner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-fast.ts'), 'utf8');
    const e2eCoreRunner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-core.ts'), 'utf8');
    const systemRunner = readFileSync(join(repoRoot, 'runtime/scripts/run-system-tests-parallel.ts'), 'utf8');
    const soakRunner = readFileSync(join(repoRoot, 'runtime/scripts/run-soak-gate.ts'), 'utf8');
    const cleanupHelper = readFileSync(join(repoRoot, 'runtime/scripts/test-artifact-cleanup.ts'), 'utf8');
    const bootstrapSoundcheck = readFileSync(join(repoRoot, 'runtime/scripts/bootstrap-soundcheck.ts'), 'utf8');
    const packageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    expect(fatalHelper).toContain('/MISSING_SIGNER_KEY/');
    expect(fatalHelper).toContain('/JADAPTER_MISSING/');
    expect(fatalHelper).toContain('/PENDING[-_]FRAME[-_]STALE/');
    expect(fatalHelper).toContain('/MM_READY_TIMEOUT/');
    expect(fatalHelper).toContain('/CROSS_J_[A-Z0-9_:-]*/');
    expect(fatalHelper).toContain('/ROUTE_NO_P2P/');
    expect(fatalHelper).toContain('/child\\.unexpected_exit/');
    expect(fatalHelper).toContain('export const E2E_FATAL_LOG_TAIL_LINES = 80;');
    expect(runner).toContain('const startFailFastLogMonitor = (');
    expect(runner).toContain("import { assertMinDiskFree } from '../orchestrator/storage-monitor';");
    expect(runner).toContain('const assertRunnerPreflight = async (): Promise<void> => {');
    expect(runner).toContain('assertMinDiskFree();');
    expect(runner).toContain("import { findFirstRuntimeFatalLogHit, findRuntimeFatalLogLines, tailLog } from './e2e-fatal-log-monitor';");
    expect(runner).toContain('E2E_FATAL_RUNTIME_LOG marker=');
    expect(runner).toContain('--- last 80 lines (${logPath}) ---');
    expect(runner).toContain('shardAbortController.abort();');
    expect(runner).toContain("child.kill('SIGTERM')");
    expect(runner).toContain('logsDir?: string;');
    expect(runner).toContain('const releaseRunnerLock = acquireRunnerLock(logsDir);');
    expect(standaloneMonitor).toContain("const runnerLockPath = join(e2eRoot, '.runner-lock.json');");
    expect(standaloneMonitor).toContain('findFirstRuntimeFatalLogHit(path, fromLine)');
    expect(standaloneMonitor).toContain('await stopRunner();');
    expect(standaloneMonitor).toContain("process.kill(lock.pid, 'SIGTERM')");
    expect(standaloneMonitor).toContain("process.kill(lock.pid, 'SIGKILL')");
    expect(packageJson).toContain('"test:e2e:monitor": "bun runtime/scripts/e2e-fail-fast-monitor.ts"');
    expect(packageJson).toContain('"test:cleanup": "bun runtime/scripts/test-artifact-cleanup.ts"');
    expect(packageJson).toContain('"test:unit": "bun runtime/scripts/run-unit-tests.ts"');
    expect(packageJson).toContain('"test:persistence:cli": "bun runtime/scripts/test-artifact-cleanup.ts --reason=persistence-cli && bun runtime/scripts/persistence-wal-smoke.ts"');
    expect(packageJson).toContain('"test:watchtower:smoke": "bun runtime/scripts/test-artifact-cleanup.ts --reason=watchtower-smoke && bun runtime/scripts/watchtower-smoke.ts"');
    expect(packageJson).toContain('"test:rpc-settlement": "bun runtime/scripts/test-artifact-cleanup.ts --reason=rpc-settlement && bun runtime/scripts/rpc-settlement-parity.ts"');
    expect(packageJson).toContain('"test:contracts:full": "bun runtime/scripts/run-with-test-cleanup.ts --reason=contracts --child-cwd=jurisdictions -- sh -c \\"bunx hardhat test test/*.ts test/*.cjs\\""');
    expect(packageJson).toContain('"test:e2e:release": "bun run prod:bootstrap:soundcheck && bun runtime/scripts/run-e2e-parallel-isolated.ts --all --exclude-market-maker');
    expect(packageJson).toContain('"test:e2e:mm": "bun run prod:bootstrap:soundcheck && bun runtime/scripts/run-e2e-parallel-isolated.ts --all --market-maker-only');
    expect(packageJson).toContain('"test:e2e:full": "bun runtime/scripts/run-e2e-parallel-isolated.ts --all --shards=8 --workers-per-shard=1 --max-mm-concurrency=2');
    expect(packageJson).toContain('"test:e2e:mm": "bun run prod:bootstrap:soundcheck && bun runtime/scripts/run-e2e-parallel-isolated.ts --all --market-maker-only --shards=8 --workers-per-shard=1 --max-mm-concurrency=2');
    expect(packageJson).toContain('"test:e2e:all": "bun runtime/scripts/run-e2e-parallel-isolated.ts --all --shards=8 --workers-per-shard=1 --max-mm-concurrency=2');
    expect(packageJson).toContain('"test:p2p:relay": "bun runtime/scripts/test-artifact-cleanup.ts --reason=p2p-relay && bun runtime/scenarios/p2p-relay.ts"');
    expect(bootstrapSoundcheck).toContain("XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO: process.env['XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO'] || '1'");
    expect(bootstrapSoundcheck).toContain("XLN_LOCAL_PROD_SMOKE_MM_INFO_MAX_MS: process.env['XLN_LOCAL_PROD_SMOKE_MM_INFO_MAX_MS'] || '1500'");
    expect(runner).toContain('excludeMarketMaker: hasFlag');
    expect(runner).toContain('marketMakerOnly: hasFlag');
    expect(runner).toContain('expandedTargets = expandedTargets.filter(entry => !entry.requireMarketMaker);');
    expect(runner).toContain('expandedTargets = expandedTargets.filter(entry => entry.requireMarketMaker);');
    expect(runner).not.toContain("XLN_MIN_DISK_FREE_BYTES: process.env['XLN_MIN_DISK_FREE_BYTES'] || '1'");
    expect(runner).toContain("...(process.env['XLN_MIN_DISK_FREE_BYTES']");
    expect(releaseGate).toContain("{ name: 'bootstrap soundcheck', command: 'bun run prod:bootstrap:soundcheck', timeoutMs: 240_000 }");
    expect(releaseGate).toContain("{ name: 'real WebSocket P2P relay', command: 'bun run test:p2p:relay', timeoutMs: 240_000 }");
    expect(releaseGate).toContain("{ name: 'frontend generated aliases', command: 'cd frontend && bunx svelte-kit sync', timeoutMs: 60_000 }");
    expect(releaseGate.indexOf("'frontend generated aliases'")).toBeLessThan(releaseGate.indexOf("'runtime core unit tests'"));
    expect(releaseGate.indexOf("'bootstrap soundcheck'")).toBeLessThan(releaseGate.indexOf("'fast E2E gate'"));
    expect(releaseGate).toContain("cleanupTestArtifactsBeforeRun({ reason: `release-gate:${profile}` })");
    expect(releaseGate).toContain("process.env[TEST_ARTIFACT_CLEANUP_DONE_ENV] = '1'");
    expect(releaseGate).toContain('env: withoutTestArtifactCleanupDoneEnv()');
    expect(mainnetGate).toContain('env: withoutTestArtifactCleanupDoneEnv()');
    expect(cleanupHelper).toContain("import { sanitizeChildProcessEnv } from '../child-process-env';");
    expect(cleanupHelper).toContain('const next = sanitizeChildProcessEnv(env);');
    expect(unitTestsRunner).toContain('cleanupTestArtifactsBeforeRun({');
    expect(unitTestsRunner).toContain("reason: 'unit-tests'");
    expect(unitTestsRunner).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV');
    expect(unitTestsRunner).toContain('env: sanitizeChildProcessEnv({');
    expect(unitTestsRunner).toContain("'--keep-test-artifacts'");
    expect(unitTestsRunner).toContain("'--no-cleanup'");
    expect(unitTestsRunner).toContain('const SUBPROCESS_STDIO_TEST_FILES = [');
    expect(unitTestsRunner).toContain('`--path-ignore-patterns=**/${file}`');
    expect(unitTestsRunner).toContain("resolve(process.cwd(), 'runtime')");
    expect(e2eFastRunner).toContain('cleanupTestArtifactsBeforeRun({');
    expect(e2eFastRunner).toContain("reason: 'e2e-fast'");
    expect(e2eFastRunner).toContain("scope: 'e2e'");
    expect(e2eFastRunner).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV');
    expect(e2eFastRunner).toContain('env: sanitizeChildProcessEnv({');
    expect(e2eCoreRunner).toContain("import { sanitizeChildProcessEnv } from '../child-process-env';");
    expect(e2eCoreRunner).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(runner).toContain("import { sanitizeChildProcessEnv } from '../child-process-env';");
    expect(runner).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(runner).toContain("XLN_AUTO_PROVISION_EXTERNAL_FAUCET: process.env['XLN_AUTO_PROVISION_EXTERNAL_FAUCET'] ?? '1'");
    expect(allTestsFast).toContain('env: sanitizeChildProcessEnv(env)');
    expect(allTestsFast).toContain('const e2eEnv = withoutTestArtifactCleanupDoneEnv(childEnv);');
    expect(allTestsFast).toContain('e2eEnv,');
    expect(systemRunner).toContain("import { cleanupTestArtifactsBeforeRun } from './test-artifact-cleanup';");
    expect(systemRunner).toContain("import { sanitizeChildProcessEnv } from '../child-process-env';");
    expect(systemRunner).toContain("cleanupTestArtifactsBeforeRun({ reason: 'system-tests' })");
    expect(systemRunner).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(systemRunner).toContain('env: sanitizeChildProcessEnv({');
    expect(soakRunner).toContain("import { sanitizeChildProcessEnv } from '../child-process-env';");
    expect(soakRunner).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(cleanupHelper).toContain('export const DEFAULT_TEST_WORKSPACE_MAX_BYTES = 50 * 1024 * 1024 * 1024;');
    expect(cleanupHelper).toContain('const estimatedWorkspaceBytes = estimateWorkspaceBytes(cwd);');
    expect(cleanupHelper).toContain('if (estimatedWorkspaceBytes > maxBytes)');
    expect(runner).toContain("cleanupTestArtifactsBeforeRun({ reason: 'e2e', scope: 'e2e', skipIfAlreadyDone: false })");
    expect(runner).toContain("XLN_TEST_ARTIFACT_CLEANUP_DONE: '1'");
    expect(readFileSync(join(repoRoot, 'playwright.config.ts'), 'utf8')).toContain(
      "globalSetup: './tests/playwright-global-setup.ts'",
    );
    expect(readFileSync(join(repoRoot, 'frontend/playwright.config.ts'), 'utf8')).toContain(
      "globalSetup: '../tests/playwright-global-setup.ts'",
    );
    const playwrightGlobalSetup = readFileSync(join(repoRoot, 'tests/playwright-global-setup.ts'), 'utf8');
    expect(playwrightGlobalSetup).toContain("spawnSync('bun'");
    expect(playwrightGlobalSetup).toContain('PLAYWRIGHT_ARTIFACT_CLEANUP_SCRIPT');
    expect(playwrightGlobalSetup).toContain('PLAYWRIGHT_ARTIFACT_CLEANUP_CWD');
    expect(playwrightGlobalSetup).toContain("'playwright'");
    expect(playwrightGlobalSetup).toContain("'e2e'");
    expect(playwrightGlobalSetup).toContain('PLAYWRIGHT_ARTIFACT_CLEANUP_FAILED');
  });

  test('scenario workers only start transports their scenario actually uses', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scenarios/run.ts'), 'utf8');
    const p2pNode = readFileSync(join(repoRoot, 'runtime/scenarios/p2p-node.ts'), 'utf8');

    expect(runner).not.toContain('runtime/relay/standalone-server.ts');
    expect(runner).not.toContain('RELAY_URL:');
    expect(runner).not.toContain('INTERNAL_RELAY_URL:');
    expect(runner).not.toContain('PUBLIC_RELAY_URL:');
    expect(runner).not.toContain('P2P_RELAY_PORT:');
    expect(runner).toContain('Parallel Scenario Runner (isolated RPC per worker; in-memory gossip)');

    expect(p2pNode).toContain('console.log(`P2P_JADAPTER_READY role=${role} mode=browservm`)');
    expect(p2pNode).toContain('rpcs: []');
    expect(p2pNode).toContain('profileName: role');
    expect(p2pNode).toContain('createLocalDeliveryHandler(env, store, getEntityReplicaById)');
    expect(p2pNode).not.toContain('env.networkInbox.push(routedInput)');
  });

  test('fatal log monitor reports the concrete marker line and last 80 log lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xln-fatal-log-monitor-'));
    const path = join(dir, 'e2e-shard-00.log');
    try {
      const lines = Array.from({ length: 90 }, (_, index) => `line ${index + 1}`);
      lines.push('[MM:err] PENDING-FRAME-STALE: Account with abcd h4 for 31s');
      lines.push('line 92 after fatal');
      writeFileSync(path, `${lines.join('\n')}\n`);

      const hit = findFirstRuntimeFatalLogHit(path, 0);
      expect(hit?.pattern).toBe('/PENDING[-_]FRAME[-_]STALE/');
      expect(hit?.lineNumber).toBe(91);
      expect(hit?.line).toContain('PENDING-FRAME-STALE');
      expect(tailLog(path, E2E_FATAL_LOG_TAIL_LINES)).toContain('line 92 after fatal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('orchestrator health does not enrich cross market snapshots by default', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const buildHealthStart = orchestrator.indexOf('const buildAggregatedHealthResponse = async (');
    const waitBaselineStart = orchestrator.indexOf('const waitForHubBaseline = async (): Promise<void> => {');
    expect(buildHealthStart).toBeGreaterThan(0);
    expect(waitBaselineStart).toBeGreaterThan(buildHealthStart);

    const buildHealth = orchestrator.slice(buildHealthStart, waitBaselineStart);
    expect(buildHealth).toContain('includeMarketSnapshots?: boolean;');
    expect(buildHealth).toContain('marketMakerHealthOverride?: MarketMakerHealthPayload | null | undefined;');
    expect(buildHealth).toContain('const baseHealth = computeAggregatedHealth({');
    expect(buildHealth).toContain('marketMakerHealthOverride: options.marketMakerHealthOverride,');
    expect(buildHealth).toContain('const health = options.includeMarketSnapshots');
    expect(buildHealth).toContain('? await enrichMarketMakerCrossFromHubSnapshots(baseHealth)');
    expect(buildHealth).toContain(': baseHealth;');
    expect(orchestrator).toContain("meshLog.warn('market_snapshot.enrichment_unavailable'");
    expect(orchestrator).not.toContain('[MESH] market snapshot enrichment unavailable');

    const fullHealthRouteStart = orchestrator.indexOf("if (pathname === '/api/health/full' || (pathname === '/api/health' && url.searchParams.get('full') === '1'))");
    const healthRouteStart = orchestrator.indexOf("if (pathname === '/api/health')", fullHealthRouteStart + 1);
    const metricsRouteStart = orchestrator.indexOf("if (pathname === '/api/metrics')");
    expect(fullHealthRouteStart).toBeGreaterThan(0);
    expect(healthRouteStart).toBeGreaterThan(0);
    expect(metricsRouteStart).toBeGreaterThan(healthRouteStart);
    const fullHealthRoute = orchestrator.slice(fullHealthRouteStart, healthRouteStart);
    expect(fullHealthRoute).toContain('const marketMakerHealthOverride = args.mmEnabled ? await fetchMarketMakerFullHealthForResponse() : null;');
    expect(fullHealthRoute).toContain('includeMarketSnapshots: url.searchParams.get(\'marketSnapshots\') === \'1\',');
    const healthRoute = orchestrator.slice(healthRouteStart, metricsRouteStart);
    expect(healthRoute).toContain('const health = await buildAggregatedHealthResponse();');
    expect(healthRoute).not.toContain('includeMarketSnapshots');
  });

  test('bootstrap timeline stages expose typed failure metadata', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const types = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator-types.ts'), 'utf8');
    const healthRedaction = readFileSync(join(repoRoot, 'runtime/health-redaction.ts'), 'utf8');

    expect(types).toContain('failure: RuntimeFailureSignal | null;');
    expect(orchestrator).toContain('classifyRuntimeBootstrapStageFailure');
    expect(orchestrator).toContain('const withBootstrapStageFailure = (');
    expect(orchestrator).toContain('failure: classifyRuntimeBootstrapStageFailure(stage.key, stage.status, stage.reason)');
    expect(orchestrator).toContain('].map(withBootstrapStageFailure),');
    expect(healthRedaction).toContain("failure: publicFailureSignal(valueOf(stage, 'failure'))");
  });

  test('market maker quote hot path is producer-only after runtime loop starts', () => {
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const meshCommon = readFileSync(join(repoRoot, 'runtime/orchestrator/mesh-common.ts'), 'utf8');
    const ensureStart = mmNode.indexOf('const ensureMarketMakerHubConnectivity = async (');
    const readyStart = mmNode.indexOf('const isMarketMakerConnectivityReady = (');
    const driveStart = mmNode.indexOf("const driveQuotes = async (mode: 'bootstrap' | 'steady' = 'steady')");
    const markReadyStart = mmNode.indexOf('const markOffersReady = async (finalizedHealth?: MarketMakerHealth | null): Promise<void> => {');
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
    expect(driveQuotes).toContain('const orderedIncompleteJobs: SameQuoteJob[] = [];');
    expect(driveQuotes).toContain('const jobsByContext = new Map<string, {');
    expect(driveQuotes).toContain('const runnableHubEntityIdsFor = (entry: { context: MarketMakerEntityContext; jobs: SameQuoteJob[] }): string[] =>');
    expect(driveQuotes).toContain('.slice(0, MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE)');
    expect(driveQuotes).not.toContain('const hubEntityIds = [job.hub.entityId];');
    expect(driveQuotes).toContain("if (mode !== 'bootstrap') {");
    expect(driveQuotes).toContain('if (await maintainSameContextQuotes(context)) return true;');
    expect(driveQuotes).toContain('if (await maintainMarketMakerCrossQuotes(');
    expect(driveQuotes).toContain('sourceHubs,');
    expect(driveQuotes).toContain('targetHubs,');
    expect(driveQuotes).toContain("if (mode === 'steady') return true;");
    expect(meshCommon).toContain('const queuedEntityTxsFor = (env: Env, targetEntityId: string): EntityTx[] => {');
    expect(meshCommon).toContain('export const hasQueuedExtendCredit = (');
  });

  test('isolated E2E failure receipts cannot block shard teardown on a live database lock', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
    const forensicsStart = runner.indexOf('const captureShardFailureForensics = async (');
    const runShardStart = runner.indexOf('const runShard = async (');
    const forensics = runner.slice(forensicsStart, runShardStart);

    expect(forensics).toContain('timeout: FAILURE_RECEIPT_DUMP_TIMEOUT_MS');
    expect(forensics).toContain("killSignal: 'SIGKILL'");
    expect(forensics).toContain('receiptDump.error?.message');
  });

  test('market maker bootstrap never sends hub-side credit inputs itself', () => {
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const ensureStart = mmNode.indexOf('const ensureMarketMakerHubConnectivity = async (');
    const readyStart = mmNode.indexOf('const isMarketMakerConnectivityReady = (');
    expect(ensureStart).toBeGreaterThan(0);
    expect(readyStart).toBeGreaterThan(ensureStart);

    const ensureConnectivity = mmNode.slice(ensureStart, readyStart);
    expect(mmNode).toContain("import { deriveAccountWatchSeed } from '../account-watch-seed';");
    expect(ensureConnectivity).toContain('const deriveMarketMakerAccountWatchSeed = (counterpartyId: string): string =>');
    expect(ensureConnectivity).toContain('timestamp: 0,');
    expect(ensureConnectivity).toContain('const [openTokenId = 1, ...extraCreditTokenIds] = normalizePositiveTokenIds(tokenIds);');
    expect(ensureConnectivity).toContain("type: 'openAccount'");
    expect(ensureConnectivity).toContain('watchSeed: deriveMarketMakerAccountWatchSeed(hubEntityId)');
    expect(ensureConnectivity).toContain("type: 'extendCredit' as const");
    expect(ensureConnectivity).not.toContain('hubSignerIdsByEntityId');
    expect(ensureConnectivity).not.toContain('remoteCreditInputs');
    expect(ensureConnectivity).not.toContain('sendEntityInput');
    expect(mmNode).not.toContain('RoutedEntityInput');
    expect(orchestrator).toContain("'--support-peer-identities-json', JSON.stringify(getMarketMakerIdentities())");
    expect(orchestrator).not.toContain('--mesh-hub-identities-json');
  });

  test('hub and market maker route consensus entity inputs through relay, not direct ws best-effort', () => {
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    const p2p = readFileSync(join(repoRoot, 'runtime/networking/p2p.ts'), 'utf8');

    expect(p2p).toContain('preferRelayForEntityInput?: boolean;');
    expect(p2p).toContain('if (this.preferRelayForEntityInput) {');
    expect(p2p).toContain("transport: 'relay'");
    expect(hubNode).toContain("process.env['XLN_ENABLE_DIRECT_ENTITY_INPUT_DISPATCH'] === '1'");
    expect(mmNode).toContain("process.env['XLN_ENABLE_DIRECT_ENTITY_INPUT_DISPATCH'] === '1'");
    expect(hubNode).toContain('preferRelayForEntityInput: true');
    expect(mmNode).toContain('preferRelayForEntityInput: true');
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
    expect(reserveBootstrap).toContain("const jurisdictionKey = String(profile.jurisdictionRef || '').trim();");
    expect(reserveBootstrap).toContain('resolveJReplicaForJurisdictionIdentity(env, jurisdiction.jurisdictionRef)');
    expect(reserveBootstrap).toContain('sameJurisdictionRef(jurisdiction, activeJurisdiction)');
    expect(reserveBootstrap).not.toContain('profile.jurisdictionRef || jurisdictionName');
    expect(reserveBootstrap).not.toContain('jurisdiction.jurisdictionRef || jurisdiction');
    expect(reserveBootstrap).not.toContain('sameJurisdictionRefOrNameFallback');
    expect(reserveBootstrap).not.toContain('profilesByJurisdiction.has(jurisdictionName)');
    expect(reserveBootstrap).not.toContain('tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)');
    expect(reserveBootstrap).not.toContain('catalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)');
  });

  test('hub mesh bootstrap uses live entity jurisdiction and does not auto-provision faucet by default', () => {
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const driveStart = hubNode.indexOf('const driveMeshBootstrap = async (): Promise<void> => {');
    const driveEnd = hubNode.indexOf('let meshLoopFatal = false;', driveStart);
    expect(driveStart).toBeGreaterThan(0);
    expect(driveEnd).toBeGreaterThan(driveStart);
    const driveMeshBootstrap = hubNode.slice(driveStart, driveEnd);
    expect(driveMeshBootstrap).toContain('const bootstrapJurisdiction =');
    expect(driveMeshBootstrap).toContain('getEntityJurisdiction(env, bootstrap.entityId)');
    expect(driveMeshBootstrap).toContain('readVisibleHubProfiles(env, bootstrapJurisdiction)');
    expect(driveMeshBootstrap).not.toContain('readVisibleHubProfiles(env, jurisdiction)');
    expect(driveMeshBootstrap).toContain('const expectedPeerProfiles = Math.max(0, resolvedArgs.meshHubNames.length - 1) * hubBootstraps.length;');
    expect(driveMeshBootstrap).toContain('peerReservesReady = allPeerProfiles.length >= expectedPeerProfiles;');
    expect(driveMeshBootstrap).toContain('reserveReadyMarked = reserveHealth.targetMet === true && peerReservesReady;');
    expect(driveMeshBootstrap).toContain('MESH_BOOTSTRAP_TICK_TIMEOUT');
    expect(hubNode).toContain("const AUTO_PROVISION_EXTERNAL_FAUCET = process.env['XLN_AUTO_PROVISION_EXTERNAL_FAUCET'] === '1';");
    expect(hubNode).toContain('if (!resolvedArgs.deployTokens || !AUTO_PROVISION_EXTERNAL_FAUCET) return;');
    expect(hubNode).toContain('await ensureExternalFaucetProvisionReady();');
    expect(hubNode).not.toContain('if (resolvedArgs.deployTokens) {\n    void externalWalletApi.provisionFaucetWallet()');
    expect(hubNode).not.toContain('void externalWalletApi.provisionFaucetWallet()');
  });

  test('custody bootstrap waits until market maker readiness completes', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const custodyBootstrapSource = readFileSync(join(repoRoot, 'runtime/orchestrator/custody-bootstrap.ts'), 'utf8');
    const marketMakerAwait = orchestrator.indexOf('if (marketMakerReady) await marketMakerReady;');
    const custodyBootstrap = orchestrator.indexOf('custodySupport = await startCustodySupport({');
    expect(marketMakerAwait).toBeGreaterThan(0);
    expect(custodyBootstrap).toBeGreaterThan(marketMakerAwait);
    expect(orchestrator).not.toContain('continuing market maker startup before failing reset');
    expect(custodyBootstrapSource).toContain('XLN_PREDEPLOYED_JURISDICTION_KEY: options.jurisdictionId');
    expect(custodyBootstrapSource).toContain('discoverHubIds(options.apiBaseUrl, 3, 30_000, jurisdictionTarget)');
  });

  test('custody daemon advertises on relay before opening hub accounts', () => {
    const daemonControl = readFileSync(join(repoRoot, 'runtime/orchestrator/daemon-control.ts'), 'utf8');
    const setupStart = daemonControl.indexOf('export const setupCustody = async (');
    const setupEnd = daemonControl.indexOf('};', setupStart);
    expect(setupStart).toBeGreaterThan(0);
    expect(setupEnd).toBeGreaterThan(setupStart);
    const setupCustody = daemonControl.slice(setupStart, setupEnd);
    const configureIndex = setupCustody.indexOf('await configureManagedEntityP2P(client, identity, config);');
    const profileWaitIndex = setupCustody.indexOf('await waitForGossipProfiles(client, hubEntityIds);');
    const connectivityIndex = setupCustody.indexOf('const connectivityInput = buildCustodyConnectivityInput');
    expect(configureIndex).toBeGreaterThan(0);
    expect(profileWaitIndex).toBeGreaterThan(configureIndex);
    expect(connectivityIndex).toBeGreaterThan(profileWaitIndex);
    expect(daemonControl).toContain('CUSTODY_HUB_PROFILES_NOT_VISIBLE');
    expect(setupCustody).toContain('CUSTODY_CONNECTIVITY_ACCOUNTS_NOT_OPEN');
    expect(setupCustody).not.toContain('await enableRouting(client, config);');
  });

  test('custody hub discovery filters hubs by jurisdiction stack identity', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      entities: [
        {
          entityId: '0x' + 'a'.repeat(64),
          isHub: true,
          metadata: { jurisdiction: { name: 'Tron', chainId: 31338, depositoryAddress: '0x2222222222222222222222222222222222222222' } },
        },
        {
          entityId: '0x' + 'b'.repeat(64),
          isHub: true,
          metadata: { jurisdiction: { name: 'Tron', chainId: 31338, depositoryAddress: '0x2222222222222222222222222222222222222222' } },
        },
        {
          entityId: '0x' + 'c'.repeat(64),
          isHub: true,
          metadata: { jurisdiction: { name: 'Tron', chainId: 31338, depositoryAddress: '0x2222222222222222222222222222222222222222' } },
        },
        {
          entityId: '0x' + '1'.repeat(64),
          isHub: true,
          metadata: { jurisdiction: { name: 'Testnet', chainId: 31337, depositoryAddress: '0x1111111111111111111111111111111111111111' } },
        },
        {
          entityId: '0x' + '2'.repeat(64),
          isHub: true,
          metadata: { jurisdiction: { name: 'Testnet', chainId: 31337, depositoryAddress: '0x1111111111111111111111111111111111111111' } },
        },
        {
          entityId: '0x' + '3'.repeat(64),
          isHub: true,
          metadata: { jurisdiction: { name: 'Testnet', chainId: 31337, depositoryAddress: '0x1111111111111111111111111111111111111111' } },
        },
      ],
    }))) as typeof fetch;
    try {
      const hubIds = await discoverHubIds('http://127.0.0.1:8082', 3, 100, {
        key: 'arrakis',
        name: 'Testnet',
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
      });
      expect(hubIds).toEqual([
        '0x' + '1'.repeat(64),
        '0x' + '2'.repeat(64),
        '0x' + '3'.repeat(64),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('offchain faucet exposes all local hub bootstrap entities', () => {
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    expect(hubNode).toContain('faucetRelayStore.activeHubEntityIds = hubBootstraps.map(entry => entry.entityId);');
    expect(hubNode).not.toContain('faucetRelayStore.activeHubEntityIds = [readyBootstrap.entityId];');
  });

  test('orchestrator exposes the gossip profile bundle endpoint used by payments', () => {
    const debugApi = readFileSync(join(repoRoot, 'runtime/orchestrator/debug-api.ts'), 'utf8');
    const paymentPanel = readFileSync(join(repoRoot, 'frontend/src/lib/components/Entity/PaymentPanel.svelte'), 'utf8');
    const xlnStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/xlnStore.ts'), 'utf8');

    expect(paymentPanel).not.toContain('/api/gossip/profile?entityId=');
    expect(paymentPanel).toContain('refreshPaymentRuntimeGossip');
    expect(xlnStore).toContain('/api/gossip/profile?entityId=');
    expect(xlnStore).toContain('export async function refreshPaymentRuntimeGossip');
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
    const deleteIndex = deploy.indexOf('rm -rf "$XLN_RDB_ROOT/runtime/prod-main"');
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
    expect(anvil).toContain('--prune-history "$ANVIL_PRUNE_HISTORY"');
    expect(anvil).toContain('--state "$ANVIL_STATE"');
    expect(anvil).toContain('--state-interval "$ANVIL_STATE_INTERVAL"');
    expect(anvil).not.toContain('--mixed-mining');
    expect(anvil).toContain('JDB_ROOT="${XLN_JDB_ROOT:-$REPO_ROOT/data}"');
    expect(anvil2).toContain('ANVIL_CHAIN_ID="${ANVIL2_CHAIN_ID:-31338}"');
    expect(anvil2).toContain('ANVIL_STATE="${ANVIL2_STATE:-${XLN_JDB_ROOT:-$REPO_ROOT/data}/anvil2-state.json}"');
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
      return new Response(JSON.stringify({
        success: true,
        serverDurationMs: 0,
        requestId: 'offchain_1',
        statusUrl: '/api/control/runtime-input/offchain_1/status',
      }), {
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
      expect((await response.json()).statusUrl)
        .toBe(`/api/hub/runtime-input/offchain_1/status?hubEntityId=${encodeURIComponent(hubEntityId)}`);
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

  test('entity-scoped hub proxy never falls back to an arbitrary healthy hub', async () => {
    const entityId = `0x${'12'.repeat(32)}`;
    let pollCalls = 0;
    let healthyHubCalls = 0;
    const handlers = createOrchestratorProxyHandlers({
      host: '127.0.0.1',
      defaultRpcUrl: '',
      pollAllHubHealth: async () => {
        pollCalls += 1;
      },
      getHubChildByEntityId: () => null,
      getHealthyHub: () => {
        healthyHubCalls += 1;
        return { apiPort: 19399 } as any;
      },
    });

    const response = await handlers.proxyEntityHubApi(new Request('http://xln.local/api/external-wallet/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entityId }),
    }), '/api/external-wallet/snapshot');
    const body = await response.json() as {
      category?: string;
      code?: string;
      error?: string;
      failure?: { category?: string; code?: string; retryable?: boolean; fatal?: boolean };
      retryable?: boolean;
      fatal?: boolean;
    };

    expect(response.status).toBe(404);
    expect(body.code).toBe('ENTITY_HUB_PROXY_ENTITY_NOT_FOUND');
    expect(body.category).toBe('ExpectedEmpty');
    expect(body.retryable).toBe(false);
    expect(body.fatal).toBe(false);
    expect(body.failure).toMatchObject({
      category: 'ExpectedEmpty',
      code: 'ENTITY_HUB_PROXY_ENTITY_NOT_FOUND',
      retryable: false,
      fatal: false,
    });
    expect(body.error).toContain(entityId);
    expect(pollCalls).toBe(1);
    expect(healthyHubCalls).toBe(0);
    expect(response.headers.get('x-xln-proxy-health-polled')).toBe('1');
  });

  test('RPC watcher pauses during persistence quiesce instead of entering j-event ingress', () => {
    const rpc = readFileSync(join(repoRoot, 'runtime/jadapter/rpc.ts'), 'utf8');
    const pauseHelper = rpc.indexOf('const isJEventIngressPaused = (activeEnv: Env): boolean =>');
    const earlyPause = rpc.indexOf("pauseJEventWatcherForQuiesce({ step: 'before-block-number' });");
    const batchPause = rpc.indexOf("step: 'before-process-event-batch'");
    const processBatch = rpc.indexOf("processEventBatch(events, activeEnv, blockNum, blockHash, txCounter, 'rpc');");

    expect(pauseHelper).toBeGreaterThan(0);
    expect(rpc).toContain("event: 'j_watch_paused_persistence_quiescing'");
    expect(earlyPause).toBeGreaterThan(pauseHelper);
    expect(batchPause).toBeGreaterThan(pauseHelper);
    expect(batchPause).toBeLessThan(processBatch);
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
      const body = await response.json() as {
        category?: string;
        code?: string;
        error?: string;
        failure?: { category?: string; code?: string; retryable?: boolean; fatal?: boolean };
        retryable?: boolean;
        fatal?: boolean;
      };

      expect(response.status).toBe(502);
      expect(body.code).toBe('RPC_PROXY_UPSTREAM_FAILED');
      expect(body.category).toBe('TransientRace');
      expect(body.retryable).toBe(true);
      expect(body.fatal).toBe(false);
      expect(body.failure).toMatchObject({
        category: 'TransientRace',
        code: 'RPC_PROXY_UPSTREAM_FAILED',
        retryable: true,
        fatal: false,
      });
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

  test('generic hub API proxy exposes typed no-healthy-hub failure', async () => {
    let pollCalls = 0;
    const handlers = createOrchestratorProxyHandlers({
      host: '127.0.0.1',
      defaultRpcUrl: '',
      pollAllHubHealth: async () => {
        pollCalls += 1;
      },
      getHubChildByEntityId: () => null,
      getHealthyHub: () => null,
    });

    const response = await handlers.proxyAnyHubRequest(new Request('http://xln.local/api/faucet/gas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entityId: `0x${'34'.repeat(32)}` }),
    }), '/api/faucet/gas');
    const body = await response.json() as {
      category?: string;
      code?: string;
      error?: string;
      failure?: { category?: string; code?: string; retryable?: boolean; fatal?: boolean };
      retryable?: boolean;
      fatal?: boolean;
    };

    expect(response.status).toBe(503);
    expect(body.error).toBe('No healthy hub API available');
    expect(body.code).toBe('NO_HEALTHY_HUB_API_AVAILABLE');
    expect(body.category).toBe('TransientRace');
    expect(body.retryable).toBe(true);
    expect(body.fatal).toBe(false);
    expect(body.failure).toMatchObject({
      category: 'TransientRace',
      code: 'NO_HEALTHY_HUB_API_AVAILABLE',
      retryable: true,
      fatal: false,
    });
    expect(pollCalls).toBe(1);
  });
});
