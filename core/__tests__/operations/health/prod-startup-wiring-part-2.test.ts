import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverHubIds } from '../../../orchestrator/bootstrap/custody-bootstrap';
import { createOrchestratorProxyHandlers } from '../../../orchestrator/proxy';
import { MAX_WALLET_SNAPSHOT_BODY_BYTES } from '../../../api/public/external-wallet/http';
import { safeStringify } from '../../../protocol/serialization';
import { E2E_FATAL_LOG_TAIL_LINES, findFirstRuntimeFatalLogHit, tailLog } from '../../../scripts/e2e/harness/e2e-fatal-log-monitor';
import { expandPlaywrightTargets } from '../../../scripts/e2e/runners/run-e2e-parallel-isolated';
import {
  applyHubRuntimeFrameDelay,
  buildHubChildProcessEnv,
  buildHubEngineArgs,
  DEFAULT_HUB_RUNTIME_FRAME_PERIOD_MS,
  readHubSteadyRuntimeFramePeriodMs,
} from '../../../orchestrator/process/hub-runtime-env';
import { buildRuntimeChildGcEnv } from '../../../support/process/runtime-gc-env';

const repoRoot = process.cwd();
const readPlatformDeploy = (): string =>
  readFileSync(join(repoRoot, 'scripts/deployment/deploy-platform.sh'), 'utf8');

const readMarketMakerNodeModule = (file: string): string =>
  readFileSync(join(repoRoot, 'core/orchestrator', file), 'utf8');

const readMarketMakerNodeSource = (): string =>
  [
    'mm-node.ts',
    'market-maker/node/mm-node-core.ts',
    'market-maker/node/mm-node-health.ts',
    'market-maker/node/mm-node-run.ts',
  ].map(readMarketMakerNodeModule).join('\n');

const readOrchestratorSource = (): string =>
  [
    'orchestrator.ts',
    'process/spawn/hub.ts',
    'process/spawn/market-maker.ts',
    'support/runtime-support.ts',
    'replica-import/runtime-import-controller.ts',
    'health/orchestrator-health-support.ts',
    'market-maker/identity-resolver.ts',
  ]
    .map(file => readFileSync(join(repoRoot, 'core/orchestrator', file), 'utf8'))
    .join('\n');

const readRpcAdapterSource = (): string =>
  [
    'rpc-public.ts',
    'rpc/rpc-adapter.ts',
    'rpc/rpc-chain-io.ts',
    'rpc/rpc-lifecycle.ts',
    'rpc/rpc-reads.ts',
    'rpc/wallet/rpc-wallet-writes.ts',
    'rpc/watcher/rpc-watcher-ingress.ts',
    'rpc/watcher/rpc-watcher-poll.ts',
  ]
    .map(file => readFileSync(join(repoRoot, 'core/jurisdiction/adapter', file), 'utf8'))
    .join('\n');

const extractSourceBlock = (source: string, marker: string, nextMarker: string): string => {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(nextMarker, start + marker.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('production startup wiring', () => {
  test('co-located Runtime children use one GC marker unless the operator overrides it', () => {
    expect(buildRuntimeChildGcEnv({})).toEqual({ BUN_JSC_numberOfGCMarkers: '1' });
    expect(buildRuntimeChildGcEnv({ BUN_JSC_numberOfGCMarkers: '3' })).toEqual({
      BUN_JSC_numberOfGCMarkers: '3',
    });
  });

  test('Hub child drains by default and activates an explicit steady start period after bootstrap', () => {
    const orchestrator = readOrchestratorSource();
    const inherited = applyHubRuntimeFrameDelay({
      XLN_RUNTIME_MIN_FRAME_DELAY_MS: '20',
      XLN_UNRELATED_SETTING: 'kept',
    }, undefined);
    expect(inherited['XLN_RUNTIME_MIN_FRAME_DELAY_MS']).toBe('0');
    expect(inherited['XLN_HUB_STEADY_FRAME_PERIOD_MS']).toBe(
      String(DEFAULT_HUB_RUNTIME_FRAME_PERIOD_MS),
    );
    expect(inherited['XLN_UNRELATED_SETTING']).toBe('kept');
    expect(applyHubRuntimeFrameDelay(inherited, '100')).toMatchObject({
      XLN_RUNTIME_MIN_FRAME_DELAY_MS: '0',
      XLN_HUB_STEADY_FRAME_PERIOD_MS: '100',
      XLN_UNRELATED_SETTING: 'kept',
    });
    expect(applyHubRuntimeFrameDelay(inherited, '0')).toMatchObject({
      XLN_RUNTIME_MIN_FRAME_DELAY_MS: '0',
      XLN_HUB_STEADY_FRAME_PERIOD_MS: '0',
      XLN_UNRELATED_SETTING: 'kept',
    });
    expect(readHubSteadyRuntimeFramePeriodMs(inherited)).toBe(0);
    expect(() => readHubSteadyRuntimeFramePeriodMs({
      XLN_HUB_STEADY_FRAME_PERIOD_MS: '-1',
    })).toThrow('HUB_STEADY_FRAME_PERIOD_MS_INVALID:-1');
    expect(orchestrator).toContain('env: sanitizeChildProcessEnv(buildHubChildProcessEnv({');
    expect(buildHubEngineArgs('h1', {
      XLN_HUB_ENGINE_ARGS_H1: ' --cpu-prof   --smol ',
    })).toEqual(['--cpu-prof', '--smol']);
    expect(buildHubChildProcessEnv({
      hubName: 'h1',
      dbPath: '/db/h1',
      brainvaultOwnerPath: '/db/h1/brainvault-owner.json',
      jurisdictionsPath: '/db/jurisdictions.json',
      rpcEnv: { ANVIL_RPC: 'http://rpc' },
      orchestratorPid: 42,
      orchestratorOwnerId: 'owner',
      startupTimeoutMs: 5_000,
      hubDelayMs: '25',
      sourceEnv: {
        XLN_HUB_RSCORE_AUTHORITY_H1: '1',
        XLN_RSCORE_BINARY: '/bin/rscore',
        XLN_RSCORE_AUTHORITY_CUTOVER: '1',
        XLN_RSCORE_AUTHORITY_RECORD: '1',
        XLN_RUNTIME_APPLY_PROFILE: '1',
        XLN_RSCORE_PROFILE_ENTITY: '1',
        XLN_RSCORE_PROFILE_PROJECTION: '1',
        XLN_HLT_ENGINE: 'rust',
        XLN_MESH_PRIMARY_JURISDICTION_ONLY: '1',
      },
    })).toMatchObject({
      XLN_DB_PATH: '/db/h1',
      ANVIL_RPC: 'http://rpc',
      XLN_RSCORE_AUTHORITY: '1',
      XLN_RSCORE_BINARY: '/bin/rscore',
      XLN_RSCORE_AUTHORITY_CUTOVER: '1',
      XLN_RSCORE_AUTHORITY_RECORD: '1',
      XLN_RUNTIME_APPLY_PROFILE: '1',
      XLN_RSCORE_PROFILE_ENTITY: '1',
      XLN_RSCORE_PROFILE_PROJECTION: '1',
      XLN_HLT_ENGINE: 'rust',
      XLN_MESH_PRIMARY_JURISDICTION_ONLY: '1',
      XLN_RUNTIME_MIN_FRAME_DELAY_MS: '0',
      XLN_HUB_STEADY_FRAME_PERIOD_MS: '25',
    });
  });

  test('prod runtime child keeps merge debug output structured and gated', () => {
    const mergeSource = readFileSync(join(repoRoot, 'core/entity/consensus/input/merge.ts'), 'utf8');
    expect(mergeSource).toContain("const entityInputMergeLog = createStructuredLogger('entity.input.merge');");
    expect(mergeSource).toContain("entityInputMergeLog.warn('frame.conflict'");
    expect(mergeSource).not.toContain('console.');
  });

  test('health enrichment cannot erase an active reset failure', () => {
    const orchestrator = readFileSync(
      join(repoRoot, 'core/orchestrator/health/orchestrator-health-support.ts'),
      'utf8',
    );
    const recompute = extractSourceBlock(
      orchestrator,
      'export const createHealthRecomputer = (',
      'export const createBaselineWaitReporter =',
    );
    expect(recompute).toContain('const resetOk = deriveResetHealthOk(health.reset);');
    expect(recompute).toContain('health.coreOk &&\n    resetOk &&');
    expect(recompute).toContain("resetOk ? null : 'reset'");
  });

  test('isolated e2e runner bounds green-path MM teardown and cleans child ports', () => {
    const runner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts'), 'utf8');
    expect(runner).toContain('const assertShardRuntimePortsReleased = (');
    expect(runner).toMatch(
      /stopProcessDependencyChain\(\[\s*\{ label: 'vite', proc: vite \},\s*\{ label: 'api', proc: api, termTimeoutMs: 35_000 \}/,
    );
    expect(runner).toContain('assertShardRuntimePortsReleased(apiPort);');
    expect(runner).toContain(
      'assertLocalTestPortsFree([apiPort, apiPort + 10, apiPort + 11, apiPort + 12, apiPort + 13]);',
    );
    expect(runner).toContain('const E2E_ANVIL_HISTORY_STATES = 8192;');
    expect(runner.match(/'--prune-history'/g)).toHaveLength(2);
    expect(runner.match(/String\(E2E_ANVIL_HISTORY_STATES\)/g)).toHaveLength(2);
    expect(runner).not.toContain("'--max-persisted-states'");
    expect(runner).toContain('TMPDIR: anvilTmpDir');
    expect(runner).toContain('TMPDIR: anvil2TmpDir');
    expect(runner).toContain('rmSync(anvilTmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });');
    expect(runner).toContain('rmSync(anvil2TmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });');
    expect(runner).not.toContain('await stopProcess(api,');
  });

  test('isolated e2e discovers requirements inside multiline Playwright declarations', () => {
    const title = 'market maker prepublishes same-chain and ETH/TRON cross-chain books before user swaps';
    const target = expandPlaywrightTargets(['tests/e2e-cross-j-swap.spec.ts']).find(entry => entry.title === title);

    expect(target).toBeDefined();
    expect(target?.requireMarketMaker).toBe(true);
  });

  test('non-production Anvil harnesses keep bounded history in memory', () => {
    const harnesses = [
      'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts',
      'core/scripts/operations/settlement/rpc-settlement-anvil.ts',
      'core/scripts/operations/development/dev-anvil-stack.ts',
      'core/scripts/e2e/runners/run-system-tests-parallel.ts',
      'core/scenarios/harness/boot.ts',
      'core/__tests__/security/watchtower/watchtower-rpc-last-resort.test.ts',
    ];
    for (const relativePath of harnesses) {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8');
      expect(source, relativePath).toContain("'--prune-history'");
    }
  });

  test('production bootstrap starts stateful Anvil chains sequentially', () => {
    const smoke = readFileSync(join(repoRoot, 'core/scripts/operations/production/local-prod-smoke.ts'), 'utf8');
    const primaryStart = smoke.indexOf("startManaged('anvil',");
    const primaryReady = smoke.indexOf("await waitForRpc(rpcPort, '0x7a69', 'Testnet')");
    const secondaryStart = smoke.indexOf("startManaged('anvil2',");
    const secondaryReady = smoke.indexOf("await waitForRpc(rpc2Port, '0x7a6a', 'Tron')");
    expect(primaryStart).toBeGreaterThan(0);
    expect(primaryReady).toBeGreaterThan(primaryStart);
    expect(secondaryStart).toBeGreaterThan(primaryReady);
    expect(secondaryReady).toBeGreaterThan(secondaryStart);
  });

  test('Rust authority restart proves the exact persisted H1 checkpoint root', () => {
    const smoke = readFileSync(join(repoRoot, 'core/scripts/operations/production/local-prod-smoke.ts'), 'utf8');
    expect(smoke).not.toContain("inheritedProcessEnv['XLN_HUB_RSCORE_AUTHORITY_H1'] = '1';");
    expect(smoke).not.toContain("inheritedProcessEnv['XLN_RSCORE_AUTHORITY_CUTOVER'] = '1';");
    expect(smoke).not.toContain('XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES:');
    expect(smoke).toContain("readH1AuthorityFrame(before.height)");
    expect(smoke).toContain('restored.canonicalStateHash !== before.canonicalStateHash');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_AUTHORITY_CHECKPOINT_DIVERGED');
    expect(smoke).toContain('HLT_RSCORE_RESTART_CHECKPOINT_OK');
  });

  test('isolated e2e outer timeout exceeds every declared Playwright test timeout', () => {
    const runner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts'), 'utf8');
    const configured = runner.match(/const DEFAULT_E2E_TEST_TIMEOUT_MS = ([\d_]+);/);
    expect(configured).not.toBeNull();
    const outerTimeoutMs = Number(String(configured?.[1] || '').replaceAll('_', ''));
    const declaredTimeouts = Array.from(new Bun.Glob('tests/e2e*.spec.ts').scanSync({ cwd: repoRoot })).flatMap(path =>
      Array.from(readFileSync(join(repoRoot, path), 'utf8').matchAll(/test\.setTimeout\(([\d_]+)\)/g), match =>
        Number(String(match[1] || '').replaceAll('_', '')),
      ),
    );
    expect(declaredTimeouts.length).toBeGreaterThan(0);
    expect(outerTimeoutMs).toBeGreaterThan(Math.max(...declaredTimeouts));
  });

  test('fast e2e caps full-stack browser concurrency at the release-tested level', () => {
    const runner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-fast.ts'), 'utf8');
    expect(runner).toContain('const stackConcurrency = isCi ? 1 : 8;');
    expect(runner).toContain('`--shards=${stackConcurrency}`');
    expect(runner).toContain("'--max-mm-concurrency=1'");
    expect(runner).toContain('`--max-reset-concurrency=${isCi ? 1 : 4}`');
  });

  test('isolated e2e keeps the bounded market-maker queue exclusive from plain stacks', () => {
    const runner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts'), 'utf8');
    expect(runner).toContain('const pendingMarketMakerIndex = tasks.findIndex(');
    expect(runner).toContain('!claimed[index] && task.requireMarketMaker');
    expect(runner).toContain('!claimed[index] && !task.requireMarketMaker');
    expect(runner).toContain('activePlainTasks > 0 || activeMarketMakerTasks >= args.maxMmConcurrency');
    expect(runner).toContain('if (activeMarketMakerTasks > 0)');
  });

  test('managed runtime teardown stops J-event producers before draining runtime and network IO', () => {
    const runtimeMain = readFileSync(join(repoRoot, 'core/runtime/composition.ts'), 'utf8');
    const runtimeLoop = readFileSync(join(repoRoot, 'core/runtime/loop/loop.ts'), 'utf8');
    const runtimeWatchers = readFileSync(join(repoRoot, 'core/runtime/loop/loop-watchers.ts'), 'utf8');
    const nodeQuiesce = readFileSync(join(repoRoot, 'core/orchestrator/process/node-runtime-quiesce.ts'), 'utf8');
    const sources = [
      readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8'),
      readMarketMakerNodeSource(),
    ];

    expect(runtimeMain).toContain('stopJurisdictionWatchersAndWait,');
    expect(runtimeWatchers).toContain(
      'export const stopJurisdictionWatchersAndWait = async (env: RuntimeReplica): Promise<void> => {',
    );
    expect(runtimeLoop).toContain('await lifecycle.stopJurisdictionWatchersAndWait(env);');
    expect(nodeQuiesce.indexOf('await stopJurisdictionWatchersAndWait(env)')).toBeLessThan(
      nodeQuiesce.indexOf('runtimeDrained = await waitForRuntimeWorkDrained('),
    );
    expect(nodeQuiesce.indexOf('runtimeDrained = await waitForRuntimeWorkDrained(')).toBeLessThan(
      nodeQuiesce.indexOf('runtimeIdle = await stopRuntimeLoopAndWait('),
    );
    expect(nodeQuiesce.indexOf('runtimeIdle = await stopRuntimeLoopAndWait(')).toBeLessThan(
      nodeQuiesce.indexOf('await stopP2PAndWait('),
    );
    expect(nodeQuiesce.indexOf('const quiesceResult = await quiesceNodeRuntime(env, {')).toBeLessThan(
      nodeQuiesce.indexOf('state.persistencePaused = true;'),
    );
    expect(nodeQuiesce.indexOf('await options.persist();')).toBeLessThan(
      nodeQuiesce.indexOf("transitionRuntimeLifecycle(state, 'stopped');"),
    );
    for (const source of sources) {
      expect(source).toContain('node-runtime-quiesce');
      expect(source).toContain('quiesceNodeRuntime');
      const quiesceBlock = source.includes('const createHubControlRequestHandler = (')
        ? extractSourceBlock(
            source,
            'const createHubControlRequestHandler = (',
            'const handleHubJurisdictionsRequest = (',
          )
        : extractSourceBlock(source, 'const quiesceMarketMakerRuntime = async (', 'const createMarketMakerHttpHandler');
      expect(quiesceBlock).toContain('quiesceNodeRuntime(');
      expect(quiesceBlock).toContain('status: 503');
      expect(quiesceBlock).toContain('safeStringify({ ok: false, error: message })');

      const shutdownBlock = source.includes('const createMarketMakerShutdown = (')
        ? extractSourceBlock(
            source,
            'const createMarketMakerShutdown = (',
            'const installMarketMakerShutdownSignals = (',
          )
        : extractSourceBlock(source, 'const shutdown = async', 'const stopParentWatch = startParentLivenessWatch');
      expect(shutdownBlock).toMatch(
        /await runCleanup\('quiesce', \(\) =>\s*quiesceNodeRuntime\((?:live\.|deps\.)?env, \{/,
      );
      expect(shutdownBlock).toContain("await runCleanup('server'");
      expect(shutdownBlock).toContain("await runCleanup('runtime_db'");
      expect(shutdownBlock).toContain("await runCleanup('infra_db'");
      expect(shutdownBlock).toContain('process.exit(code || 1);');
      expect(shutdownBlock).not.toContain('stopP2P(env)');
    }
  });

  test('market-maker control lifecycle exists before the HTTP server accepts teardown', () => {
    const mmNode = readMarketMakerNodeSource();
    const serverStart = mmNode.indexOf('const server = Bun.serve');
    const lifecycleDeclarations = ['shuttingDown: false,', 'stopRuntimeLoops: () => {'];

    expect(serverStart).toBeGreaterThan(0);
    for (const declaration of lifecycleDeclarations) {
      const declarationIndex = mmNode.indexOf(declaration);
      expect(declarationIndex).toBeGreaterThan(0);
      expect(declarationIndex).toBeLessThan(serverStart);
    }
  });

  test('production nodes start their commit loop before resuming registrations and expose P2P last', () => {
    const hubSource = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    const hubLoopStart = hubSource.indexOf('startRuntimeLoop(env, {');
    const hubResume = hubSource.indexOf('await ensurePendingNumberedRegistrationsResumed(env);', hubLoopStart);
    const hubIngressReady = hubSource.indexOf('live.externalIngressReady = true;', hubResume);
    const hubP2PStart = hubSource.indexOf('live.p2p = startP2P(env, {');
    const hubP2PReady = hubSource.indexOf("if (!live.p2p) throw new Error('P2P_START_FAILED');", hubP2PStart);
    expect(hubLoopStart).toBeGreaterThan(0);
    expect(hubResume).toBeGreaterThan(hubLoopStart);
    expect(hubIngressReady).toBeGreaterThan(hubResume);
    expect(hubP2PStart).toBeGreaterThan(0);
    expect(hubP2PStart).toBeGreaterThan(hubIngressReady);
    expect(hubP2PReady).toBeGreaterThan(hubP2PStart);

    const mmSource = readMarketMakerNodeSource();
    const mmInitialization = mmSource.indexOf('const initializeMarketMakerContexts = async (');
    const mmLoopStart = mmSource.indexOf('startRuntimeLoop(env, {');
    const mmServicesStart = mmSource.indexOf('const startMarketMakerServices = async (');
    const mmServicesCall = mmSource.indexOf('await startMarketMakerServices(context)', mmLoopStart);
    const mmPrimaryContext = mmSource.indexOf(
      'const primaryContext = await createMarketMakerEntityContext(',
      mmInitialization,
    );
    const mmSecondaryContexts = mmSource.indexOf(
      'for (const [index, secondary] of resolveSecondaryJurisdictions(jurisdiction.rpc).entries())',
      mmPrimaryContext,
    );
    const mmInitializationCall = mmSource.indexOf(
      'state.tokenIdsByContext = await initializeMarketMakerContexts({',
      mmServicesStart,
    );
    const mmResume = mmSource.indexOf(
      'await ensurePendingNumberedRegistrationsResumed(env);',
      mmInitializationCall,
    );
    const mmIngressReady = mmSource.indexOf('state.externalIngressReady = true;', mmResume);
    const mmP2PStart = mmSource.indexOf('const p2p = startP2P(env, {', mmInitializationCall);
    const mmP2PReady = mmSource.indexOf("if (!p2p) throw new Error('P2P_START_FAILED');", mmP2PStart);
    expect(mmInitialization).toBeGreaterThan(0);
    expect(mmPrimaryContext).toBeGreaterThan(mmInitialization);
    expect(mmSecondaryContexts).toBeGreaterThan(mmPrimaryContext);
    expect(mmLoopStart).toBeGreaterThan(0);
    expect(mmServicesCall).toBeGreaterThan(mmLoopStart);
    expect(mmInitializationCall).toBeGreaterThan(mmServicesStart);
    expect(mmResume).toBeGreaterThan(mmInitializationCall);
    expect(mmIngressReady).toBeGreaterThan(mmResume);
    expect(mmP2PStart).toBeGreaterThan(mmInitializationCall);
    expect(mmP2PStart).toBeGreaterThan(mmIngressReady);
    expect(mmP2PReady).toBeGreaterThan(mmP2PStart);

    const orchestrator = readOrchestratorSource();
    expect(orchestrator).toContain('const MARKET_MAKER_RESTART_FENCING_GRACE_MS = STORAGE_WRITER_LOCK_TTL_MS + 1_000;');
    const restartLog = orchestrator.indexOf('[MESH] restarting MM during readiness');
    const restartGrace = orchestrator.indexOf(
      'await scheduler.wait(MARKET_MAKER_RESTART_FENCING_GRACE_MS);',
      restartLog,
    );
    const restartSpawn = orchestrator.indexOf('await spawnMarketMaker();', restartGrace);
    expect(restartGrace).toBeGreaterThan(restartLog);
    expect(restartSpawn).toBeGreaterThan(restartGrace);
  });

  test('deploy starts and checks the production Tron chain', () => {
    const deploy = readPlatformDeploy();
    const startServer = readFileSync(join(repoRoot, 'scripts/operations/start-server.sh'), 'utf8');
    const bootstrapMonitor = readFileSync(join(repoRoot, 'scripts/deployment/watch-prod-bootstrap.ts'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(deploy).toContain('start_production_anvil anvil2 scripts/operations/start-anvil2.sh');
    expect(deploy).toContain('wait_for_rpc_chain "http://127.0.0.1:8546" "0x7a6a"');
    expect(deploy).toContain('wait_for_public_rpc_chain "/rpc2" "0x7a6a"');
    expect(bootstrapMonitor).toContain('http://127.0.0.1:8080/api/health');
    expect(startServer).toContain('XLN_RUNTIME_TICK_DELAY_MS=${XLN_RUNTIME_TICK_DELAY_MS:-0}');
    expect(startServer).toContain('MARKET_MAKER_RUNTIME_TICK_DELAY_MS=${MARKET_MAKER_RUNTIME_TICK_DELAY_MS:-0}');
    expect(startServer).toContain('MARKET_MAKER_API_YIELD_MS=${MARKET_MAKER_API_YIELD_MS:-25}');
    expect(deploy).toContain('curl --max-time 10 -fsS "$url"');
    expect(deploy).toContain('curl --max-time 10 -sS -X POST');
    expect(deploy).toContain('location ~ ^/rpc[2-8]$');
    expect(deploy).toContain('public /rpc must proxy through orchestrator safety filter');
    expect(deploy).toContain('fail_deploy_with_debug "anvil2 did not become ready on :8546"');
    expect(deploy).toContain('bun scripts/deployment/watch-prod-bootstrap.ts http://127.0.0.1:8080/api/health 0');
    expect(deploy).toContain('const raw = await Bun.stdin.text();');
    expect(deploy).not.toContain('const raw = process.argv[1] || "";');
    expect(deploy).not.toContain('truncate -s 0');
    expect(deploy).toContain('local expected_version="${XLN_FOUNDRY_VERSION:-v1.7.1}"');
    expect(deploy).toContain('foundryup --install "$expected_version"');
    expect(deploy).toContain('pm2 stop "$service"');
    expect(deploy).toContain('FOUNDRY_UPGRADE_ANVIL_STOP_TIMEOUT');
    expect(deploy).toContain('pm2 set pm2-logrotate:max_size 20M');
    expect(deploy).toContain('pm2 set pm2-logrotate:retain 5');
    expect(deploy).toContain('pm2 set pm2-logrotate:compress true');
    expect(deploy).toContain('pause_production_explorer_backend');
    expect(deploy).not.toContain('resume_production_explorer_backend');
    expect(deploy).toContain('com.docker.compose.service=backend');
    expect(deploy).toContain('docker stop --timeout 30 "$container"');
    expect(deploy).toContain('RESET_PRODUCTION_MESH=0');
    expect(deploy).toContain('--reset-mesh');
    expect(deploy).toContain('--code-only');
    expect(deploy).toContain('if [ "$RESET_PRODUCTION_MESH" = "1" ]; then');
    expect(deploy).toContain('echo "[deploy] restarting production services without resetting anvil/runtime state"');
    expect(deploy).toContain('echo "[deploy] resetting production anvil + runtime + chain-bound watchtower state"');
    expect(deploy).toContain('export XLN_JDB_ROOT="${XLN_JDB_ROOT:-$XLN_STATE_ROOT/jdb}"');
    expect(deploy).toContain('export XLN_RDB_ROOT="${XLN_RDB_ROOT:-$XLN_STATE_ROOT/rdb}"');
    expect(deploy).toContain('if [ "$PRODUCTION" != "1" ]; then');
    expect(deploy).toContain('echo "[deploy] production state remains in the canonical external state root"');
    expect(deploy).not.toContain('migrate_production_path');
    expect(deploy).not.toContain('.checkout-state-migrated');
    expect(deploy).toContain('chmod -R go-rwx "$XLN_STATE_ROOT"');
    expect(deploy).toContain('rm -rf "$XLN_RDB_ROOT/core/prod-main"');
    expect(deploy).toContain('"$XLN_RDB_ROOT/watchtower/prod-main"');
    expect(deploy).toContain('"$XLN_RDB_ROOT/watchtower/push-main"');
    expect(deploy).not.toContain('-- --reset');
    expect(deploy).toContain('--kill-timeout 60000 --restart-delay 2000');
    const startAnvil = deploy.slice(
      deploy.indexOf('start_production_anvil()'),
      deploy.indexOf('ensure_production_anvil_memory_restart_disabled()'),
    );
    expect(startAnvil).not.toContain('--max-memory-restart');
    expect(deploy).toContain('ensure_production_anvil_memory_restart_disabled anvil scripts/operations/start-anvil.sh');
    expect(deploy).toContain('ensure_production_anvil_memory_restart_disabled anvil2 scripts/operations/start-anvil2.sh');
    expect(deploy).toContain(
      'run_or_fail_deploy "unsafe Anvil PM2 supervision" bun scripts/operations/check-anvil-supervision.ts',
    );
    expect(deploy).toContain('wait_for_anvil_state_checkpoint "$XLN_JDB_ROOT/anvil-state.json"');
    expect(deploy).toContain('wait_for_anvil_state_checkpoint "$XLN_JDB_ROOT/anvil2-state.json"');
    expect(deploy).toContain('pm2 delete xln-server >/dev/null 2>&1 || true');
    expect(deploy).toContain(
      'run_or_fail_deploy "failed to start xln-server via pm2" pm2 start scripts/operations/start-server.sh --name xln-server --interpreter bash --max-memory-restart 900M',
    );
    expect(deploy).toContain('export XLN_MESH_PRESERVE_STATE_ON_RESET=1');
    expect(deploy).toContain('install -m 600 /dev/null "$XLN_RDB_ROOT/core/.mesh-reset-once"');
    expect(deploy).not.toContain('export XLN_MESH_PRESERVE_STATE_ON_RESET=0');
    expect(startServer).toContain('export XLN_MESH_PRESERVE_STATE_ON_RESET=0');
    expect(startServer).toContain('MESH_RESET_CLAIMED');
    expect(startServer).toContain('MESH_RESET_RETRY');
    expect(startServer).toContain('MESH_RESET_FINALIZED');
    expect(deploy.match(/git clean -fd/g)).toHaveLength(2);
    expect(deploy).not.toContain('pm2 restart xln-server');
    expect(packageJson.scripts['deploy:prod']).toContain('--reset-mesh');
    expect(packageJson.scripts['deploy:prod']).not.toContain('--code-only');
    expect(packageJson.scripts['deploy:prod:runtime']).toContain('--reset-mesh');
    expect(packageJson.scripts['deploy:prod:runtime']).not.toContain('--code-only');
    expect(packageJson.scripts['deploy:prod:runtime:code']).toBeUndefined();
    expect(packageJson.scripts['deploy:prod:fresh']).toContain('--reset-mesh');
  });

  test('prod remote runtime import e2e cannot reset the shared prod mesh implicitly', () => {
    const baseline = readFileSync(join(repoRoot, 'tests/utils/e2e-baseline.ts'), 'utf8');
    const radapterRemote = ['tests/e2e/runtime/e2e-radapter-remote-part-1.spec.ts', 'tests/e2e/runtime/e2e-radapter-remote-part-2.spec.ts']
      .map(file => readFileSync(join(repoRoot, file), 'utf8'))
      .join('\n');
    const appLayout = readFileSync(join(repoRoot, 'frontend/src/routes/app/+layout.svelte'), 'utf8');
    const importFlow = readFileSync(join(repoRoot, 'frontend/src/lib/utils/onboarding/remoteRuntimeImportFlow.ts'), 'utf8');
    const orchestrator = readOrchestratorSource();
    const runtimeImportHttp = readFileSync(join(repoRoot, 'core/orchestrator/replica-import/runtime-import-http.ts'), 'utf8');
    const bootstrapTimeline = readFileSync(join(repoRoot, 'core/orchestrator/bootstrap/bootstrap-timeline-stages.ts'), 'utf8');
    const isolatedRunner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts'), 'utf8');

    expect(baseline).toContain('allowAutoReset?: boolean;');
    expect(baseline).toContain('if (!resolved.allowAutoReset) {');
    expect(baseline).toContain('E2E baseline was not ready and automatic reset is disabled');
    expect(radapterRemote).toContain('allowAutoReset: false');
    expect(orchestrator).toContain('const publishRuntimeImportManifest = async (): Promise<boolean> => {');
    expect(orchestrator).toContain('const health = await buildAggregatedHealthResponse();');
    expect(orchestrator).toContain('const custodyBootstrapPending = custodySupport === null;');
    expect(orchestrator).toContain('custodyBootstrapPending,');
    expect(orchestrator).toContain('const readiness = resolveRuntimeImportReadiness(health);');
    expect(orchestrator).toContain('if (!readiness.ok) {');
    expect(runtimeImportHttp).toContain("url.searchParams.get('allowPartial') === '1'");
    expect(runtimeImportHttp).toContain('&& operatorAuthorized;');
    expect(runtimeImportHttp).toContain('partial: true,');
    expect(runtimeImportHttp).toContain('ready: false,');
    expect(runtimeImportHttp).toContain('category: readiness.category,');
    expect(runtimeImportHttp).toContain('failure: readiness.failure,');
    expect(runtimeImportHttp).toContain('entries: [],');
    expect(runtimeImportHttp).toContain("'Retry-After': '2'");
    expect(runtimeImportHttp).not.toContain('status: readiness.status, headers');
    expect(orchestrator).toContain('clearRuntimeImportManifestFile();');
    expect(orchestrator).toContain('scheduleRuntimeImportManifestRefresh(null);');
    expect(bootstrapTimeline).toContain(
      'const preflightComplete = resetClear.completedAt !== null && params.storageOk;',
    );
    expect(bootstrapTimeline).toContain(
      'const custodyState = params.custodyOk ? true : custodyStarted ? false : null;',
    );
    expect(orchestrator).toContain('clearRuntimeImportManifestFile();\n  const preserveState');
    expect(orchestrator).not.toContain('await persistHubReadySnapshots();\n    publishRuntimeImportManifest();');
    expect(orchestrator).toContain(
      'resetState.inProgress = false;\n    pendingResetOptions = null;\n  }\n  await publishRuntimeImportManifest();',
    );

    expect(existsSync(join(repoRoot, 'frontend/src/routes/radapter/manage/+page.svelte'))).toBe(false);
    expect(appLayout).toContain('async function importRemoteRuntimesIntoApp');
    expect(appLayout).toContain('fetchRemoteRuntimeImportSource(source)');
    expect(appLayout).toContain('const result = await importRemoteRuntimeEntries(entries)');
    expect(importFlow).toContain('await Promise.allSettled(workers)');
    expect(importFlow).toContain('writeRemoteRuntimeImportSummary(results, entries.length, importedAt)');
    expect(isolatedRunner).toContain("'--wallet-url',\n        `${webUrl}/app`,\n        '--allow-reset'");
    expect(isolatedRunner).not.toContain(
      "'--custody-db-root',\n          join(dbPath, 'custody'),\n          '--wallet-url'",
    );
  });

  test('prod diagnose accepts the market maker terminal startup phase', () => {
    const diagnose = readFileSync(join(repoRoot, 'scripts/operations/prod-diagnose.sh'), 'utf8');
    expect(diagnose).toContain('payload.marketMaker.startupPhase !== "offers-ready"');
    expect(diagnose).not.toContain('payload.marketMaker.startupPhase !== "ready"');
  });

  test('market maker activates executable arguments before deriving runtime keys', () => {
    const core = readMarketMakerNodeModule('market-maker/node/mm-node-core.ts');
    const run = readMarketMakerNodeModule('market-maker/node/mm-node-run.ts');
    const activation = run.indexOf('activateMarketMakerProcessArgs();');
    const runtimeCreation = run.indexOf('const env = await main(resolvedArgs.seed, {');

    expect(core).toContain("if (!seed) throw new Error('Market-maker seed is required");
    expect(core).toContain("if (!directWsUrl) throw new Error('[MESH-MM] Missing required --direct-ws-url')");
    expect(activation).toBeGreaterThan(0);
    expect(runtimeCreation).toBeGreaterThan(activation);
  });

  test('node orchestrators validate J adapters without mutating committed replicas', () => {
    const sources = [
      readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8'),
      readMarketMakerNodeModule('market-maker/node/mm-node-core.ts'),
    ];
    for (const source of sources) {
      expect(source).toContain('assertJStackAddressMatch(');
      expect(source).toContain('attachLiveJAdapter(env, activeName, jadapter);');
      expect(source).not.toMatch(
        /\breplica\.(?:depositoryAddress|entityProviderAddress|contracts|rpcs|chainId)\s*=/,
      );
    }
  });

  test('market maker cross readiness only expects feasible cross specs', () => {
    const mmNode = readMarketMakerNodeSource();
    const buildExpectedStart = mmNode.indexOf('const buildExpectedMarketMakerCrossRouteGroups = (');
    const buildHealthStart = mmNode.indexOf('const buildMarketMakerCrossHealth = (');
    expect(buildExpectedStart).toBeGreaterThan(0);
    expect(buildHealthStart).toBeGreaterThan(buildExpectedStart);
    const buildExpected = mmNode.slice(buildExpectedStart, buildHealthStart);

    expect(buildExpected).toContain('env: RuntimeReplica,');
    expect(buildExpected).toContain('for (const spec of buildMarketMakerCrossOfferSpecs(');
    expect(buildExpected).toContain('group.specs.push(spec);');
    expect(buildExpected).not.toContain('for (const pair of buildMarketMakerCrossTokenPairs');
  });

  test('market maker health route serves cached bootstrap readiness without scanning state', () => {
    const mmNode = readMarketMakerNodeSource();
    const mmProgress = readFileSync(join(repoRoot, 'core/orchestrator/market-maker/node/mm-bootstrap-progress.ts'), 'utf8');
    const healthRouteStart = mmNode.indexOf("if (pathname === '/api/health')");
    const controlRouteStart = mmNode.indexOf("if (pathname === '/api/control/p2p/stop'");
    expect(healthRouteStart).toBeGreaterThan(0);
    expect(controlRouteStart).toBeGreaterThan(healthRouteStart);

    const healthRoute = mmNode.slice(healthRouteStart, controlRouteStart);
    expect(healthRoute).toContain('if (!deps.readCachedHealthResponseJson()) deps.rebuildCachedHealthResponseJson();');
    expect(healthRoute).toContain(
      "return new Response(deps.readCachedHealthResponseJson() ?? '{}', { headers: JSON_HEADERS });",
    );
    expect(healthRoute).not.toContain('safeStringify(');
    expect(healthRoute).not.toContain('readVisibleHubProfiles(');
    expect(healthRoute).not.toContain('getMarketMakerHealth(');
    const healthProjectionStart = mmNode.indexOf('const resolveMarketMakerHealthForResponse = (');
    const marketMakerStart = mmNode.indexOf('export const runMarketMakerNode');
    expect(healthProjectionStart).toBeGreaterThan(0);
    expect(marketMakerStart).toBeGreaterThan(healthProjectionStart);
    const healthProjection = mmNode.slice(healthProjectionStart, marketMakerStart);
    expect(healthProjection).toContain(
      "return input.startupPhase === 'offers-ready' ? health : { ...health, ok: false };",
    );
    expect(healthProjection).toContain('const readiness = deriveMarketMakerChildReadiness({');
    expect(healthProjection).toContain('marketMakerReady: marketMakerHealth.ok === true');
    expect(healthProjection).toContain('ok: readiness.ready');
    expect(healthProjection).toContain('live: readiness.live');
    expect(healthProjection).toContain('ready: readiness.ready');
    expect(healthProjection).toContain('...marketMakerHealth');
    expect(healthProjection).toContain('quiescence: summarizeRuntimeQuiescence(input.env)');
    expect(healthProjection).toContain('expectedRoutes: 0');
    expect(healthProjection).toContain('return safeStringify({');
    const healthControllerStart = mmNode.indexOf('const createMarketMakerHealthController = (');
    const httpDepsStart = mmNode.indexOf('type MarketMakerHttpHandlerDeps = {');
    expect(healthControllerStart).toBeGreaterThan(healthProjectionStart);
    expect(httpDepsStart).toBeGreaterThan(healthControllerStart);
    const healthController = mmNode.slice(healthControllerStart, httpDepsStart);
    expect(healthController).toContain('healthResponseJson = buildMarketMakerHealthResponseJson({');
    expect(healthController).toContain('const publish = (');
    expect(mmNode).toContain(
      "const buildDeferredMarketMakerCrossHealth = (applicable: boolean): MarketMakerHealth['cross'] => ({",
    );
    expect(mmNode).not.toContain("const buildNeutralMarketMakerCrossHealth = (): MarketMakerHealth['cross'] => ({");
    expect(mmNode).toContain(
      'ok: expectedRouteCount === 0 || (routes.length >= expectedRouteCount && routes.every(route => route.depthReady))',
    );
    expect(healthController).toContain('const publishBootstrap = (): MarketMakerHealth | null =>');
    expect(healthController).toContain(
      'const plan = buildMarketMakerCrossPlanSummary([...deps.contexts()], hubs, new Map(deps.tokenIdsByContext()));',
    );
    expect(healthController).toContain(
      'return publish({ includeCross: false, crossOverride: buildPlannedMarketMakerCrossHealth(plan) });',
    );
    expect(mmNode).toContain('const buildCompletionHealth = (): MarketMakerHealth | null => {');
    expect(mmNode).toContain('completionHealth = deps.health.buildSnapshot({ includeCross: true });');
    expect(mmNode).toContain('deps.health.setCurrentHealth(completionHealth);');
    expect(mmNode).toContain('deps.health.rebuildHealthResponse();');
    expect(readMarketMakerNodeModule('market-maker/node/mm-node-health.ts')).toContain('computeCanonicalEntityHashesFromEnv');
    expect(readMarketMakerNodeModule('market-maker/node/mm-node-run.ts')).toContain('computeCanonicalStateHashFromEnv');
    expect(mmNode).toContain('export const buildMarketMakerBootstrapEntityStateHash = (env: RuntimeReplica): string =>');
    expect(mmProgress).toContain("schema: 'market-maker-bootstrap-entity-state-v1'");
    expect(mmNode).toContain('const fingerprint = buildMarketMakerBootstrapFingerprint(');
    expect(mmNode).toContain('const runtimeStateHash = computeCanonicalStateHashFromEnv(deps.env);');
    expect(mmNode).toContain('const entityStateHash = buildMarketMakerBootstrapEntityStateHash(deps.env);');
    expect(mmNode).toContain('state.bootstrapReadyHash = finalization.fingerprint.hash;');
    expect(mmNode).toContain('state.bootstrapRuntimeStateHash = finalization.runtimeStateHash;');
    expect(mmNode).toContain('state.bootstrapEntityStateHash = finalization.entityStateHash;');
    expect(mmNode).toContain('const restoredEntityStateHash = env.state.eReplicas.size > 0');
    expect(mmNode).toContain('restoredEntityStateHash,');
    expect(mmNode).toContain('runtimeStateHash,');
    expect(mmNode).toContain('entityStateHash,');
    expect(mmNode).toContain("readBooleanEnv('XLN_MARKET_MAKER_LOG_READY_HASH_PAYLOAD', false)");
    expect(mmNode).toContain('BOOTSTRAP_READY_HASH_PAYLOAD payload=${safeStringify(fingerprint.payload)}');
    expect(mmNode).toContain('bootstrapCrossPlanJobCount: null,');
    expect(mmNode).not.toContain('let bootstrapCrossExpectedRoutes');
    expect(mmNode).toContain("emit('cross-plan'");
    expect(mmNode).toContain('const plan = buildMarketMakerCrossPlanSummary(');
    expect(mmNode).toContain('const canCheckCompletion = (): boolean =>');
    expect(mmNode).not.toContain('MARKET_MAKER_SKIP_CROSS_BOOTSTRAP');
    expect(mmNode).toContain('if (plan.expectedRoutes > 0 && !bootstrapCross.producerAttempted) return false;');
    expect(mmNode).toContain('return plan.expectedRoutes === 0 || !hasCrossAccountBacklog(visibleHubs);');
    expect(mmNode).not.toContain('const completionBeforeDrive = buildBootstrapCompletionHealth();');
    expect(mmNode).toContain("const enqueued = await deps.driveQuotes('bootstrap');");
    expect(mmNode).toContain('if (!enqueued && deps.canCheckCompletion()) {');
    expect(mmNode.replace(/\s+/g, '')).toContain(
      'if(deps.isDepthComplete(completionHealth)&&deps.canCheckCompletion())returncompletionHealth;',
    );
    expect(mmNode).toContain('const bootstrapHealth = await waitForBootstrapOffers({');
    expect(mmNode).toContain('if (await lifecycle.markOffersReady()) {');
    expect(mmNode).toContain('lifecycle.loops.startQuotes();');
    expect(mmNode).not.toContain(
      'await markOffersReady();\n      publishMarketMakerHealthSnapshot({ includeCross: true });',
    );
    expect(mmNode).toContain("state.phase = 'bootstrap-same-chain';\n    health.publishBootstrap();");
    expect(mmNode).toContain('if (state.bootstrapCrossStarted) {');
    expect(mmNode).toContain('readModel.allSameDepthReady(readVisibleHubProfiles(env, true)) &&');
    expect(mmNode).toContain('isMarketMakerSameDepthComplete(currentHealth)');
    expect(mmNode).not.toContain('bootstrapCrossStarted || isMarketMakerSameReady(health)');
    expect(mmNode).not.toContain("if (startupPhase !== 'offers-ready' && bootstrapCrossStarted) {");
    expect(mmNode).not.toContain(
      'const completionHealth = bootstrapCrossStarted ? buildBootstrapCompletionHealth() : health;',
    );
    expect(mmNode).toContain("const enqueued = await deps.driveQuotes('bootstrap');");
    expect(mmNode).toContain('if (!enqueued && deps.canCheckCompletion()) {');
    expect(mmNode).toContain('await deps.markReady();');
  });

  test('market maker info route keeps cross debug opt-in off the hot path', () => {
    const mmNode = readMarketMakerNodeSource();
    const infoRouteStart = mmNode.indexOf("if (pathname === '/api/info')");
    const fullHealthRouteStart = mmNode.indexOf("if (pathname === '/api/health/full'");
    const healthRouteStart = mmNode.indexOf("if (pathname === '/api/health')", fullHealthRouteStart + 1);
    expect(infoRouteStart).toBeGreaterThan(0);
    expect(fullHealthRouteStart).toBeGreaterThan(infoRouteStart);
    expect(healthRouteStart).toBeGreaterThan(fullHealthRouteStart);

    const infoRoute = mmNode.slice(infoRouteStart, fullHealthRouteStart);
    expect(infoRoute).toContain("url.searchParams.get('crossDebug') === '1'");
    expect(infoRoute).toContain("url.searchParams.get('debug') === 'cross'");
    expect(infoRoute).toContain('return new Response(deps.buildInfoResponseJson(true), { headers: JSON_HEADERS });');
    expect(infoRoute).toContain('if (!deps.readCachedInfoResponseJson()) deps.rebuildCachedInfoResponseJson();');
    expect(infoRoute).toContain(
      "return new Response(deps.readCachedInfoResponseJson() ?? '{}', { headers: JSON_HEADERS });",
    );
    expect(infoRoute).not.toContain('getMarketMakerRuntimeBacklogSnapshot(env');
    expect(infoRoute).not.toContain('buildMarketMakerCrossDebugSummary(');
    expect(mmNode).toContain('const buildInfoResponse = (includeCrossDebug = false): string => {');
    expect(mmNode).toContain('const buildMarketMakerInfoResponseJson = (');
    expect(mmNode).toContain('currentHealth: input.currentHealth');
    expect(mmNode).toContain('runtimeBacklog: getMarketMakerRuntimeBacklogSnapshot(input.env, {');
    expect(mmNode).toContain('includeQueuedEntityInputs: includeCrossDebug');
    expect(mmNode).toContain('crossDebug: buildMarketMakerCrossDebugSummary(');
    expect(mmNode).toContain('infoResponseJson = buildInfoResponse(false);');
    expect(infoRoute).not.toContain('const allVisibleHubs = readVisibleHubProfiles(env, true);');
    expect(infoRoute).not.toContain('buildMarketMakerHealthSnapshot({ includeCross: true })');
  });

  test('local prod smoke records bootstrap benchmark stages and hash assertions', () => {
    const packageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    const smoke = readFileSync(join(repoRoot, 'core/scripts/operations/production/local-prod-smoke.ts'), 'utf8');
    const orchestrator = readOrchestratorSource();
    const mmNode = readMarketMakerNodeSource();
    const benchmark = readFileSync(join(repoRoot, 'core/scripts/operations/bootstrap/bootstrap-benchmark.ts'), 'utf8');
    const soundcheck = readFileSync(join(repoRoot, 'core/scripts/operations/bootstrap/bootstrap-soundcheck.ts'), 'utf8');

    expect(packageJson).toContain(
      '"prod:bootstrap:bench": "bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=bootstrap-bench -- bun core/scripts/operations/bootstrap/bootstrap-benchmark.ts"',
    );
    expect(packageJson).toContain(
      '"prod:bootstrap:fresh": "bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=bootstrap-fresh -- bun core/scripts/operations/bootstrap/bootstrap-soundcheck.ts --mode=fresh"',
    );
    expect(packageJson).toContain(
      '"prod:bootstrap:template": "bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=bootstrap-template -- bun core/scripts/operations/bootstrap/bootstrap-soundcheck.ts --mode=template"',
    );
    expect(packageJson).toContain(
      '"prod:bootstrap:clone": "bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=bootstrap-clone --keep-test-artifacts -- bun core/scripts/operations/bootstrap/bootstrap-soundcheck.ts --mode=clone"',
    );
    expect(packageJson).toContain(
      '"prod:bootstrap:hydrate": "bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=bootstrap-hydrate --keep-test-artifacts -- bun core/scripts/operations/bootstrap/bootstrap-soundcheck.ts --mode=hydrate"',
    );
    expect(packageJson).toContain(
      '"prod:bootstrap:rotation": "XLN_STORAGE_EPOCH_MAX_BYTES=4194304 XLN_LOCAL_PROD_SMOKE_REQUIRE_EPOCH_ROTATION=1',
    );
    expect(smoke).toContain('await commitPostRotationProofFrames();');
    expect(smoke).toContain("recordStage('storage-epoch:post-rotation-wal-committed');");
    expect(smoke).toContain("recordStage('storage-epoch:verified', epochRotations);");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_STORAGE_POST_ROTATION_FRAME_MISSING');
    expect(smoke).toContain('await acquireLocalTestPortLease({');
    expect(smoke).toContain('requiredOffsets: [0, 1, 4, 7, 8, 10, 11, 12, 13]');
    expect(smoke).toContain('buildInheritedLocalTestLeaseEnv(localTestLease, repoRoot)');
    expect(smoke).toContain('assertLocalTestPortsFree(localTestLease.ports);');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_PORT_OVERRIDE_FORBIDDEN');
    expect(soundcheck).not.toContain('XLN_LOCAL_PROD_SMOKE_PORT_BASE');
    expect(benchmark).not.toContain('XLN_LOCAL_PROD_SMOKE_PORT_BASE');
    expect(smoke).toContain("schema: 'xln-local-prod-bootstrap-benchmark-v1'");
    expect(smoke).toContain("schema: 'xln-bootstrap-debug-event-v1'");
    expect(smoke).toContain('findFirstRuntimeFatalLogHit');
    expect(smoke).toContain('const assertNoFatalChildLogs = (stage: string): void => {');
    expect(smoke).toContain("emitDebugEvent('fatal-log-hit'");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_FATAL_LOG');
    expect(smoke).not.toContain("hit.pattern === '/PENDING[-_]FRAME[-_]STALE/'");
    expect(smoke).not.toContain('bootstrapQuiescenceReady(health)');
    expect(smoke).toContain("assertNoFatalChildLogs('post-bootstrap-stability')");
    expect(smoke).toContain("assertNoFatalChildLogs('health-poll');");
    expect(mmNode).toContain("schema: 'xln-market-maker-bootstrap-debug-event-v1'");
    expect(mmNode).toContain("process.env['XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL']");
    expect(orchestrator).toContain('XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL:');
    expect(orchestrator).toContain("join(child.dbPath, 'bootstrap-events.jsonl')");
    expect(mmNode).toContain("deps.emit('same-quote-progress'");
    expect(mmNode).not.toContain("emitBootstrapDebugEvent('cross-progress'");
    expect(mmNode).not.toContain("emitMarketMakerCrossBootstrapWaveEvent('cross-wave-enqueue'");
    expect(mmNode).not.toContain('deferredBootstrapCrossInputs');
    expect(mmNode).not.toContain("direction: 'bootstrap-batch'");
    expect(mmNode).toContain('BOOTSTRAP_DEBUG_EVENT_WRITE_FAILED');
    expect(smoke).toContain('DEBUG_EVENT_WRITE_FAILED');
    expect(smoke).toContain('const marketMakerEventsJsonlPath =');
    expect(smoke).toContain('XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL: marketMakerEventsJsonlPath');
    expect(smoke).toContain('marketMakerEventsJsonl: marketMakerEventsJsonlPath');
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_ENFORCE_STAGE_BUDGETS'] === '1'");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_HUB_MESH_BUDGET_MS'] || '20000'");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_STAGE_BUDGET_EXCEEDED');
    expect(smoke).toContain('spawnH1StartedAt: health.timings?.reset_spawn_h1?.startedAt');
    expect(orchestrator).toContain('spawnHub(h1).finally(() => finishTiming');
    expect(orchestrator).toContain('Promise.all(h23.map(child => spawnHub(child)))');
    expect(orchestrator).toContain('await Promise.all(hubChildren.map(child => waitForHubSelfReady(child)));');
    expect(orchestrator).not.toContain('for (const child of h23) {');
    expect(smoke).not.toContain("const serverStartedAt = stageElapsed('server:started') ?? 0;");
    expect(smoke).toContain("const crossReadyAt = stageElapsed('marketMaker:cross-ready');");
    expect(smoke).toContain(
      "requireStageBudget('marketMaker:cross', crossReadyAt - crossStartedAt, stageBudgetsMs.cross, snapshot);",
    );
    expect(smoke).toContain('const marketMakerFullDepthReady = (health: HealthPayload): boolean => {');
    expect(smoke).toContain('const expectedRoutes = Number(health.marketMaker?.cross?.expectedRoutes || 0);');
    expect(smoke).toContain('hub.depthReady === true');
    expect(smoke).toContain('route.depthReady === true');
    expect(smoke).toContain('const marketMakerDepthReadyForSmoke = (health: HealthPayload): boolean =>');
    expect(smoke).toContain('marketMakerDepthReadyForSmoke(health) &&');
    expect(smoke).not.toContain('XLN_MARKET_MAKER_SKIP_CROSS_BOOTSTRAP');
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_SAME_CHAIN_BUDGET_MS'] || '30000'");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_CROSS_BUDGET_MS'] || '300000'");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_HEALTH_POLL_MAX_MS'] || '2000'");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_MM_HEALTH_POLL_MAX_MS'] || '5000'");
    expect(smoke).toContain("marketMakerHealthPollMaxMs,\n      'MM_HEALTH',");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_HEALTH_POLL_INTERVAL_MS'] || '250'");
    expect(smoke).toContain('await sleep(healthPollIntervalMs);');
    expect(smoke).toContain("emitDebugEvent('health-poll'");
    expect(smoke).toContain("emitDebugEvent('health-snapshot'");
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_TEMPLATE_DIR']");
    expect(smoke).not.toContain('XLN_LOCAL_PROD_SMOKE_PERSIST_MM');
    expect(smoke).toContain('const copySnapshotTemplate = (sourceDir: string, targetDir: string): void => {');
    expect(smoke).toContain("recordStage('snapshot:copied', { templateDir, workDir });");
    expect(smoke).toContain("XLN_MESH_PRESERVE_STATE_ON_RESET: '1'");
    expect(smoke).toContain('...(useSnapshotTemplate ? {');
    expect(smoke).toContain("process.env['XLN_MARKET_MAKER_DISABLE_RESTORE'] || '0'");
    expect(smoke).not.toContain('XLN_MARKET_MAKER_DISABLE_STORAGE');
    expect(smoke).not.toContain('MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK');
    expect(smoke).not.toContain('MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK');
    expect(smoke).not.toContain('MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE');
    expect(mmNode).not.toContain('MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE');
    expect(mmNode).toContain('const orderedSourceHubs = [...sourceHubs].sort');
    expect(mmNode).not.toContain('const sourceHubScans = [...sourceHubs]');
    const bootstrapCrossBranch = mmNode.slice(
      mmNode.indexOf('const planBootstrapCrossQuoteRoutes = ('),
      mmNode.indexOf('const maintainSteadyCrossQuotes = async ('),
    );
    expect(bootstrapCrossBranch.indexOf("emitMarketMakerCrossBootstrapWaveEvent('cross-wave-start'")).toBeLessThan(
      bootstrapCrossBranch.indexOf('const sourceHubSpecs = buildMarketMakerCrossOfferSpecs('),
    );
    expect(bootstrapCrossBranch).toContain('coverageGaps = countCrossPairCoverageGaps(env, sourceHubSpecs)');
    expect(bootstrapCrossBranch).toContain(
      'progress = countCrossSpecBootstrapProgress(env, sourceHubSpecs, getPendingCrossRequestOrderIds)',
    );
    expect(mmNode).not.toContain('deferredBootstrapCrossInputs');
    expect(mmNode).not.toContain("direction: 'bootstrap-batch'");
    expect(mmNode).not.toContain('deferredBootstrapCrossLastIndex');
    expect(mmNode).not.toContain('bootstrapCrossCursor');
    expect(mmNode).not.toContain('launch one per-account settlement wave and wait for');
    const bootstrapCrossStart = mmNode.indexOf('if (!deps.bootstrapCross.isStarted()) {');
    expect(bootstrapCrossStart).toBeGreaterThan(0);
    expect(mmNode.slice(bootstrapCrossStart, bootstrapCrossStart + 180)).toContain(
      'deps.bootstrapCross.markStarted(healthBeforeQuotes);',
    );
    expect(bootstrapCrossStart).toBeLessThan(mmNode.indexOf('const jobs = await buildMarketMakerCrossQuoteJobs('));
    expect(mmNode).toContain(
      'if (deps.readModel.hasCrossAccountBacklog(visibleHubs)) {\n        await yieldMarketMakerApi();\n        return false;\n      }',
    );
    expect(mmNode.indexOf('if (deps.readModel.hasCrossAccountBacklog(visibleHubs)) {')).toBeLessThan(
      mmNode.indexOf('const jobs = await buildMarketMakerCrossQuoteJobs('),
    );
    expect(mmNode).toContain('let completionCheckArmed = false;');
    expect(mmNode).toContain('let lastProgressAt = Date.now();');
    expect(mmNode).toContain("deps.emit('progress'");
    const progressEvent = mmNode.slice(
      mmNode.indexOf("deps.emit('progress'"),
      mmNode.indexOf("deps.emit('progress'") + 300,
    );
    expect(progressEvent).not.toContain('checkpoint:');
    expect(mmNode).toContain('lastProgressCheckpoint,');
    expect(mmNode).toContain('MARKET_MAKER_BOOTSTRAP_STALLED');
    expect(mmNode).not.toContain("markProgress('enqueue');");
    expect(mmNode).toContain("deps.progress.observe('runtime-backlog', deps.health.readCurrentHealth());");
    expect(mmNode).not.toContain("startupPhase = 'bootstrap-degraded'");
    expect(mmNode).toContain("deps.emit('completion-health'");
    expect(mmNode).toContain('completionCheckArmed = true;');
    expect(mmNode).toContain("deps.emit('finalize-step'");
    expect(mmNode).toContain(
      "pathname === '/api/health/full' || (pathname === '/api/health' && url.searchParams.get('full') === '1')",
    );
    expect(mmNode).toContain('buildHealthSnapshot: () => health.buildSnapshot({ includeCross: true })');
    expect(mmNode).toContain("pathname === '/api/account/status'");
    expect(mmNode).toContain('pendingFrameTxs: (account?.pendingFrame?.accountTxs ?? []).map');
    expect(smoke).toContain('const shouldFetchMarketMakerHealth = (health: HealthPayload): boolean =>');
    expect(smoke).toContain("'bootstrap-same-chain'");
    expect(smoke).toContain("'bootstrap-cross'");
    expect(smoke).toContain(
      'const fetchMarketMakerHealth = (health: HealthPayload): MarketMakerDirectHealthPayload | null => {',
    );
    expect(smoke).toContain('if (!shouldFetchMarketMakerHealth(health)) {');
    expect(smoke).toContain('skipped: true');
    expect(smoke).toContain('`http://127.0.0.1:${marketMakerApiPort}/api/health`');
    expect(smoke).toContain("emitDebugEvent('mm-health-poll'");
    expect(smoke).toContain('durationMs: Date.now() - startedAt');
    expect(smoke).toContain('const marketMakerProbe = fetchMarketMakerHealthProbe(health);');
    expect(smoke).toContain('const directMarketMakerHealth = marketMakerProbe.payload;');
    expect(smoke).toContain('const stageHealth = healthWithDirectMarketMaker(health, directMarketMakerHealth);');
    expect(smoke).toContain("process.env['XLN_LOCAL_PROD_SMOKE_NO_PROGRESS_FATAL_MS'] || '60000'");
    expect(smoke).toContain('causalProgress = trackCausalProgress(causalProgress, JSON.stringify(last), nowMs);');
    expect(smoke).toContain('const decision = evaluateMmHealthProbeFailure({');
    expect(smoke).toContain("emitDebugEvent('mm-health-transient'");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_NO_CAUSAL_PROGRESS');
    expect(smoke).toContain("if (message.includes('LOCAL_PROD_SMOKE_NO_CAUSAL_PROGRESS')) throw error;");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_RESET_FAILED');
    expect(smoke).toContain("if (message.includes('LOCAL_PROD_SMOKE_RESET_FAILED')) throw error;");
    expect(smoke).toContain('if (iteration % 10 === 0 || healthReady(stageHealth))');
    expect(smoke).toContain('if (healthReady(stageHealth))');
    expect(smoke).toContain('return stageHealth;');
    expect(smoke).not.toContain('healthReady(health))');
    expect(smoke).toContain('const summarizeBlockers = (blockers: unknown[] | undefined): unknown[] =>');
    expect(smoke).toContain(
      'blockerDetails: health.marketMaker?.cross?.routes?.map(route => summarizeBlockers(route.blockers)) ?? []',
    );
    expect(mmNode).not.toContain('persistRestoredEnvToDB');
    expect(mmNode).not.toContain('MARKET_MAKER_PERSIST_READY_SNAPSHOT');
    const mmReadySource = extractSourceBlock(
      mmNode,
      'const build = (): MarketMakerBootstrapFinalization =>',
      'const markReady = async',
    );
    expect(mmReadySource).toContain('computeCanonicalStateHashFromEnv(deps.env)');
    expect(mmReadySource).toContain('buildMarketMakerBootstrapEntityStateHash(deps.env)');
    expect(mmReadySource).not.toContain('await ');
    expect(mmNode).toContain('const markReady = async (): Promise<boolean> => {');
    expect(mmNode).toContain('const finalization = build();');
    expect(orchestrator).toContain("const preserveState = process.env['XLN_MESH_PRESERVE_STATE_ON_RESET'] === '1';");
    expect(orchestrator).toContain('} else if (existsSync(args.dbRoot)) {');
    expect(orchestrator).toContain('rmSync(args.dbRoot, { recursive: true, force: true });');
    expect(orchestrator).toContain('PRESERVE_STATE_DB_ROOT_MISSING');
    expect(orchestrator).toContain('PRESERVE_STATE_JURISDICTIONS_MISSING');
    expect(orchestrator).not.toContain('postJsonExpectOk');
    expect(orchestrator).not.toContain('persistHubReadySnapshots');
    expect(orchestrator).not.toContain('ready-snapshot');
    expect(smoke).toContain('recordStage(`marketMaker:${marketMakerPhase}`, last);');
    expect(smoke).toContain("recordStageOnce('system:ready', last);");
    expect(smoke).toContain("recordStage('post-bootstrap:observed', { stabilityMs: postBootstrapStabilityMs });");
    expect(smoke).toContain('const rawPostBootstrapHealth = await fetchHealth();');
    expect(smoke).toContain(
      'const postBootstrapDirectMarketMakerHealth = fetchMarketMakerHealth(rawPostBootstrapHealth);',
    );
    expect(smoke).toContain(
      'const postBootstrapHealth = healthWithDirectMarketMaker(rawPostBootstrapHealth, postBootstrapDirectMarketMakerHealth);',
    );
    expect(smoke).not.toContain('const postBootstrapHealth = await fetchHealth();');
    expect(smoke).toContain("recordStage('post-bootstrap:stable', summarizeHealth(postBootstrapHealth));");
    expect(smoke).toContain("MARKET_MAKER_BOOTSTRAP_LOOP_MS: process.env['MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '1'");
    expect(smoke).not.toContain('XLN_HUB_BOOTSTRAP_PAUSE_STORAGE');
    expect(smoke).not.toContain('XLN_HUB_READY_SNAPSHOT_TIMEOUT_MS');
    expect(smoke).not.toContain('XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT');
    expect(smoke).toContain("process.env['XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '0'");
    expect(smoke).toContain("process.env['XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '0'");
    expect(smoke).toContain("process.env['MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '0'");
    expect(smoke).toContain("process.env['MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '0'");
    expect(smoke).toContain("XLN_RUNTIME_PROCESS_SLOW_MS: process.env['XLN_RUNTIME_PROCESS_SLOW_MS'] || '250'");
    expect(smoke).toContain("XLN_ENTITY_FRAME_SLOW_MS: process.env['XLN_ENTITY_FRAME_SLOW_MS'] || '250'");
    expect(smoke).toContain('throw new Error(`LOCAL_PROD_SMOKE_MM_HEALTH_FAILED error=${message}`);');
    expect(smoke).toContain("if (message.includes('LOCAL_PROD_SMOKE_MM_HEALTH_FAILED')) throw error;");
    expect(smoke).not.toContain('MARKET_MAKER_MAX_LEVELS_PER_PAIR:');
    expect(smoke).not.toContain('MARKET_MAKER_CROSS_LEVELS_PER_PAIR:');
    expect(smoke).toContain("process.env['MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE'] || '1000'");
    expect(smoke).not.toContain('MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK');
    expect(smoke).not.toContain('MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_MISSING');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_RUNTIME_HASH_MISSING');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_ENTITY_HASH_MISSING');
    expect(smoke).not.toContain('/BOOTSTRAP_READY_HASH hash=');
    expect(smoke).toContain("emitDebugEvent('bootstrap-hash'");
    expect(smoke).toContain('LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HEALTH_REGRESSED');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HASH_CHANGED');
    expect(smoke).toContain('LOCAL_PROD_SMOKE_POST_BOOTSTRAP_BACKLOG');
    expect(smoke).toContain('writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\\n`);');
    expect(benchmark).toContain("schema: 'xln-bootstrap-benchmark-summary-v1'");
    expect(benchmark).toContain('BOOTSTRAP_BENCH_BOOTSTRAP_HASH_DRIFT');
    expect(benchmark).toContain('BOOTSTRAP_BENCH_ENTITY_HASH_DRIFT');
    expect(benchmark).toContain('runtimeStateHashes: metrics.map(entry => entry.runtimeStateHash)');
    expect(soundcheck).toContain("type Mode = 'fresh' | 'template' | 'clone' | 'hydrate' | 'all';");
    expect(soundcheck).toContain('cpSync(result.workDir, templateDir, { recursive: true });');
    expect(soundcheck).toContain('const installTemplateFromResult = (result: SoundcheckResult): SoundcheckResult => {');
    expect(soundcheck).toContain("if (mode === 'all') {");
    expect(soundcheck).toContain('results.push(installTemplateFromResult(freshResult));');
    expect(soundcheck).not.toContain('XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT');
    expect(soundcheck).not.toContain('XLN_LOCAL_PROD_SMOKE_PERSIST_MM');
    expect(soundcheck).toContain("XLN_LOCAL_PROD_SMOKE_ENFORCE_STAGE_BUDGETS: '1'");
    expect(soundcheck).toContain('marketMakerEventsJsonl: metrics.marketMakerEventsJsonl');
    expect(soundcheck).toContain('BOOTSTRAP_SOUNDCHECK_CLONE_HASH_DRIFT');
    expect(soundcheck).toContain('BOOTSTRAP_SOUNDCHECK_CLONE_RESTORED_ENTITY_HASH_DRIFT');
    expect(soundcheck).toContain('clone.restoredEntityStateHash !== templateHashes.entityStateHash');
    expect(soundcheck).toContain('BOOTSTRAP_SOUNDCHECK_HYDRATE_HASH_DRIFT');
    expect(soundcheck).toContain('BOOTSTRAP_SOUNDCHECK_HYDRATE_RESTORED_ENTITY_HASH_DRIFT');
    expect(soundcheck).toContain('hydrate.restoredEntityStateHash !== templateHashes.entityStateHash');
  });

  test('isolated e2e runner fails fast on fatal shard log markers', () => {
    const runner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts'), 'utf8');
    const isolatedRuntime = readFileSync(join(repoRoot, 'core/scripts/e2e/harness/e2e-isolated-runtime.ts'), 'utf8');
    const fatalHelper = readFileSync(join(repoRoot, 'core/scripts/e2e/harness/e2e-fatal-log-monitor.ts'), 'utf8');
    const runnerLockHelper = readFileSync(join(repoRoot, 'core/scripts/e2e/harness/e2e-runner-lock.ts'), 'utf8');
    const standaloneMonitor = readFileSync(join(repoRoot, 'core/scripts/e2e/harness/e2e-fail-fast-monitor.ts'), 'utf8');
    const releaseGate = readFileSync(join(repoRoot, 'core/scripts/release/run-release-gate.ts'), 'utf8');
    const mainnetGate = readFileSync(join(repoRoot, 'core/scripts/release/run-mainnet-preflight-gate.ts'), 'utf8');
    const allTestsFast = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-all-tests-fast.ts'), 'utf8');
    const unitTestsRunner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-unit-tests.ts'), 'utf8');
    const e2eFastRunner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-fast.ts'), 'utf8');
    const e2eCoreRunner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-core.ts'), 'utf8');
    const systemRunner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-system-tests-parallel.ts'), 'utf8');
    const soakRunner = readFileSync(join(repoRoot, 'core/scripts/release/run-soak-gate.ts'), 'utf8');
    const cleanupHelper = readFileSync(join(repoRoot, 'core/scripts/e2e/harness/test-artifact-cleanup.ts'), 'utf8');
    const bootstrapSoundcheck = readFileSync(join(repoRoot, 'core/scripts/operations/bootstrap/bootstrap-soundcheck.ts'), 'utf8');
    const packageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    expect(fatalHelper).toContain('/MISSING_SIGNER_KEY/');
    expect(fatalHelper).toContain('/JADAPTER_MISSING/');
    expect(fatalHelper).not.toContain('/PENDING[-_]FRAME[-_]STALE/');
    expect(fatalHelper).toContain('/MM_READY_TIMEOUT/');
    expect(fatalHelper).toContain('/\\[ERROR\\].*CROSS_J_[A-Z0-9_:-]*/');
    expect(fatalHelper).toContain('/ROUTE_NO_P2P/');
    expect(fatalHelper).toContain('/child\\.unexpected_exit/');
    expect(fatalHelper).toContain('export const E2E_FATAL_LOG_TAIL_LINES = 80;');
    expect(runner).toContain('const startFailFastLogMonitor = (');
    expect(runner).toContain("import { assertMinDiskFree } from '../../../support/storage-monitor';");
    expect(runner).toContain('const assertRunnerPreflight = async (): Promise<void> => {');
    expect(runner).toContain('assertMinDiskFree();');
    expect(runner).toContain('createIncrementalRuntimeFatalLogScanner,');
    expect(runner).toContain('const fatalScanner = createIncrementalRuntimeFatalLogScanner(logPath);');
    expect(runner).toContain('const hit = fatalScanner.scan();');
    expect(runner).not.toContain("scannedLines = readFileSync(logPath, 'utf8')");
    expect(runner).toContain('E2E_FATAL_RUNTIME_LOG marker=');
    expect(runner).toContain('--- last 80 lines (${logPath}) ---');
    expect(runner).toContain('shardAbortController.abort();');
    expect(runner).toContain("child.kill('SIGTERM')");
    expect(runner).toContain("from '../harness/e2e-runner-lock';");
    expect(runnerLockHelper).toContain('logsDir?: string;');
    expect(runnerLockHelper).toContain("if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;");
    expect(runnerLockHelper).toContain("if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;");
    expect(runner).toContain('const releaseRunnerLock = acquireRunnerLock(logsDir);');
    expect(standaloneMonitor).toContain("const runnerLockPath = join(e2eRoot, '.runner-lock.json');");
    expect(standaloneMonitor).toContain('findFirstRuntimeFatalLogHit(path, fromLine)');
    expect(standaloneMonitor).toContain('await stopRunner();');
    expect(standaloneMonitor).toContain("process.kill(lock.pid, 'SIGTERM')");
    expect(standaloneMonitor).toContain("process.kill(lock.pid, 'SIGKILL')");
    expect(packageJson).toContain('"test:e2e:monitor": "bun core/scripts/e2e/harness/e2e-fail-fast-monitor.ts"');
    expect(packageJson).toContain('"test:cleanup": "bun core/scripts/e2e/harness/test-artifact-cleanup.ts"');
    expect(packageJson).toContain('"test:unit": "bun core/scripts/e2e/runners/run-unit-tests.ts"');
    expect(packageJson).toContain(
      '"test:persistence:cli": "bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=persistence-cli -- bun core/scripts/operations/persistence/persistence-wal-smoke.ts"',
    );
    expect(packageJson).toContain(
      '"test:watchtower:smoke": "bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=watchtower-smoke -- bun core/scripts/operations/production/watchtower-smoke.ts"',
    );
    expect(packageJson).toContain(
      '"test:rpc-settlement": "bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=rpc-settlement -- bun core/scripts/operations/settlement/rpc-settlement-parity.ts"',
    );
    expect(packageJson).toContain(
      '"test:contracts:full": "bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=contracts --child-cwd=jurisdictions -- bunx hardhat test"',
    );
    expect(packageJson).toContain(
      '"test:e2e:release": "bun run prod:bootstrap:soundcheck && bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts --all --exclude-market-maker',
    );
    expect(packageJson).toContain(
      '"test:e2e:mm": "bun run prod:bootstrap:soundcheck && bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts --all --market-maker-only',
    );
    expect(packageJson).toContain(
      '"test:e2e:full": "bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts --all --strict-browser-health --shards=7 --workers-per-shard=1 --max-mm-concurrency=1',
    );
    expect(packageJson).toContain(
      '"test:e2e:release": "bun run prod:bootstrap:soundcheck && bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts --all --exclude-market-maker --strict-browser-health --shards=7',
    );
    expect(packageJson).toContain(
      '"test:e2e:mm": "bun run prod:bootstrap:soundcheck && bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts --all --market-maker-only --strict-browser-health --shards=7 --workers-per-shard=1 --max-mm-concurrency=1',
    );
    expect(packageJson).toContain(
      '"test:e2e:all": "bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts --all --strict-browser-health --shards=7 --workers-per-shard=1 --max-mm-concurrency=1',
    );
    expect(packageJson).toContain(
      '"test:p2p:relay": "bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=p2p-relay -- bun core/scenarios/network/p2p-relay.ts"',
    );
    expect(bootstrapSoundcheck).toContain(
      "XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO: process.env['XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO'] || '1'",
    );
    expect(bootstrapSoundcheck).toContain(
      "XLN_LOCAL_PROD_SMOKE_MM_INFO_MAX_MS: process.env['XLN_LOCAL_PROD_SMOKE_MM_INFO_MAX_MS'] || '5000'",
    );
    expect(runner).toContain('excludeMarketMaker: hasFlag');
    expect(runner).toContain('marketMakerOnly: hasFlag');
    expect(runner).toContain('expandedTargets = expandedTargets.filter(entry => !entry.requireMarketMaker);');
    expect(runner).toContain('expandedTargets = expandedTargets.filter(entry => entry.requireMarketMaker);');
    expect(runner).not.toContain("XLN_MIN_DISK_FREE_BYTES: process.env['XLN_MIN_DISK_FREE_BYTES'] || '1'");
    expect(runner).toContain("...(process.env['XLN_MIN_DISK_FREE_BYTES']");
    expect(releaseGate).toContain(
      "{ name: 'bootstrap soundcheck', command: 'bun run prod:bootstrap:soundcheck', timeoutMs: 1_200_000 }",
    );
    expect(releaseGate).toContain(
      "{ name: 'bootstrap epoch rotation', command: 'bun run prod:bootstrap:rotation', timeoutMs: 1_200_000 }",
    );
    expect(releaseGate).toContain(
      "{ name: 'real WebSocket P2P relay', command: 'bun run test:p2p:relay', timeoutMs: 240_000 }",
    );
    expect(releaseGate).toContain(
      "{ name: 'frontend generated aliases', command: 'cd frontend && bunx svelte-kit sync', timeoutMs: 60_000 }",
    );
    expect(releaseGate.indexOf("'frontend generated aliases'")).toBeLessThan(
      releaseGate.indexOf("'runtime core unit tests'"),
    );
    expect(releaseGate.indexOf("'bootstrap soundcheck'")).toBeLessThan(releaseGate.indexOf("'fast E2E gate'"));
    expect(releaseGate).toContain('cleanupTestArtifactsBeforeRun({ reason: `release-gate:${profile}` })');
    expect(releaseGate).toContain("process.env[TEST_ARTIFACT_CLEANUP_DONE_ENV] = '1'");
    expect(releaseGate).toContain('env: withoutTestArtifactCleanupDoneEnv()');
    expect(mainnetGate).toContain('env: withoutTestArtifactCleanupDoneEnv()');
    expect(cleanupHelper).toContain("import { sanitizeChildProcessEnv } from '../../../api/server/child-process-env';");
    expect(cleanupHelper).toContain('const next = sanitizeChildProcessEnv(env);');
    expect(unitTestsRunner).toContain('cleanupTestArtifactsBeforeRun({');
    expect(unitTestsRunner).toContain("reason: 'unit-tests'");
    expect(unitTestsRunner).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV');
    expect(unitTestsRunner).toContain('env: sanitizeChildProcessEnv({');
    expect(unitTestsRunner).toContain("'--keep-test-artifacts'");
    expect(unitTestsRunner).toContain("'--no-cleanup'");
    expect(unitTestsRunner).toContain('const SUBPROCESS_STDIO_TEST_FILES = [');
    expect(unitTestsRunner).toContain('`--path-ignore-patterns=**/${file}`');
    expect(unitTestsRunner).toContain("resolve(ROOT, 'core')");
    expect(unitTestsRunner).toContain('await ensureContractArtifacts();');
    expect(e2eFastRunner).toContain('cleanupTestArtifactsBeforeRun({');
    expect(e2eFastRunner).toContain("reason: 'e2e-fast'");
    expect(e2eFastRunner).toContain("scope: 'e2e'");
    expect(e2eFastRunner).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV');
    expect(e2eFastRunner).toContain('env: sanitizeChildProcessEnv({');
    expect(e2eCoreRunner).toContain("import { sanitizeChildProcessEnv } from '../../../api/server/child-process-env';");
    expect(e2eCoreRunner).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(runner).toContain("import { sanitizeChildProcessEnv } from '../../../api/server/child-process-env';");
    expect(isolatedRuntime).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(runner).toContain(
      "XLN_AUTO_PROVISION_EXTERNAL_FAUCET: process.env['XLN_AUTO_PROVISION_EXTERNAL_FAUCET'] ?? '1'",
    );
    expect(allTestsFast).toContain('env: sanitizeChildProcessEnv(env)');
    expect(allTestsFast).toContain('const e2eEnv = withoutTestArtifactCleanupDoneEnv(childEnv);');
    expect(allTestsFast).toContain('e2eEnv,');
    expect(systemRunner).toContain('cleanupTestArtifactsBeforeRun,');
    expect(systemRunner).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV,');
    expect(systemRunner).toContain("from '../harness/test-artifact-cleanup';");
    expect(systemRunner).toContain("import { sanitizeChildProcessEnv } from '../../../api/server/child-process-env';");
    expect(systemRunner).toContain("cleanupTestArtifactsBeforeRun({ reason: 'system-tests' })");
    expect(systemRunner).toContain("process.env[TEST_ARTIFACT_CLEANUP_DONE_ENV] = '1'");
    expect(systemRunner).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(systemRunner).toContain('env: sanitizeChildProcessEnv({');
    expect(soakRunner).toContain("import { sanitizeChildProcessEnv } from '../../api/server/child-process-env';");
    expect(soakRunner).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(cleanupHelper).toContain('export const DEFAULT_TEST_WORKSPACE_MAX_BYTES = 50 * 1024 * 1024 * 1024;');
    expect(cleanupHelper).toContain('const estimatedWorkspaceBytes = estimateWorkspaceBytes(cwd);');
    expect(cleanupHelper).toContain('if (estimatedWorkspaceBytes > maxBytes)');
    const e2eCleanupStart = runner.indexOf('cleanupTestArtifactsBeforeRun({');
    expect(e2eCleanupStart).toBeGreaterThan(0);
    const e2eCleanupCall = runner.slice(e2eCleanupStart, e2eCleanupStart + 240);
    expect(e2eCleanupCall).toContain("reason: 'e2e'");
    expect(e2eCleanupCall).toContain("scope: 'e2e'");
    expect(e2eCleanupCall).toContain('skipIfAlreadyDone: false');
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
    const runner = readFileSync(join(repoRoot, 'core/scenarios/run.ts'), 'utf8');
    const p2pNode = readFileSync(join(repoRoot, 'core/scenarios/network/p2p-node.ts'), 'utf8');

    expect(runner).not.toContain('core/network/relay/standalone-server.ts');
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

  test('fatal log monitor ignores a resolved liveness warning but reports a real fatal marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xln-fatal-log-monitor-'));
    const path = join(dir, 'e2e-shard-00.log');
    try {
      const lines = Array.from({ length: 90 }, (_, index) => `line ${index + 1}`);
      lines.push('[MM:err] PENDING-FRAME-STALE: Account with abcd h4 for 31s');
      lines.push('[MM:err] RUNTIME_LOOP_HALTED: committed state failed');
      lines.push('line 93 after fatal');
      writeFileSync(path, `${lines.join('\n')}\n`);

      const hit = findFirstRuntimeFatalLogHit(path, 0);
      expect(hit?.pattern).toBe('/RUNTIME_LOOP_HALTED/');
      expect(hit?.lineNumber).toBe(92);
      expect(hit?.line).toContain('RUNTIME_LOOP_HALTED');
      expect(tailLog(path, E2E_FATAL_LOG_TAIL_LINES)).toContain('line 93 after fatal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('orchestrator health does not enrich cross market snapshots by default', () => {
    const orchestrator = readOrchestratorSource();
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
    expect(buildHealth).toContain('? await enrichMarketMakerFromHubSnapshots(baseHealth)');
    expect(buildHealth).toContain(': baseHealth;');
    expect(orchestrator).toContain("meshLog.warn('market_snapshot.enrichment_unavailable'");
    expect(orchestrator).not.toContain('[MESH] market snapshot enrichment unavailable');

    const fullHealthRouteStart = orchestrator.indexOf('const handleHealthRequest = async (');
    const healthRouteStart = orchestrator.indexOf("if (pathname === '/api/health')", fullHealthRouteStart);
    const metricsRouteStart = orchestrator.indexOf("if (pathname === '/api/metrics')", healthRouteStart);
    expect(fullHealthRouteStart).toBeGreaterThan(0);
    expect(healthRouteStart).toBeGreaterThan(0);
    expect(metricsRouteStart).toBeGreaterThan(healthRouteStart);
    const fullHealthRoute = orchestrator.slice(fullHealthRouteStart, healthRouteStart);
    expect(fullHealthRoute).toContain('const marketMakerHealthOverride = activeResetOptions.enableMarketMaker');
    expect(fullHealthRoute).toContain('? await fetchMarketMakerFullHealthForResponse()');
    expect(fullHealthRoute).toContain('includeMarketSnapshots:');
    expect(fullHealthRoute).toContain("url.searchParams.get('marketSnapshots') === '1',");
    const healthRoute = orchestrator.slice(healthRouteStart, metricsRouteStart);
    expect(healthRoute).toContain('const health = await buildAggregatedHealthResponse();');
    expect(healthRoute).not.toContain('includeMarketSnapshots');
  });

  test('bootstrap timeline stages expose typed failure metadata', () => {
    const bootstrapTimeline = [
      'bootstrap/bootstrap-timeline.ts',
      'bootstrap/bootstrap-timeline-stages.ts',
    ]
      .map(file => readFileSync(join(repoRoot, 'core/orchestrator', file), 'utf8'))
      .join('\n');
    const types = readFileSync(join(repoRoot, 'core/orchestrator/orchestrator-types.ts'), 'utf8');
    const healthRedaction = readFileSync(join(repoRoot, 'core/api/server/health/redaction.ts'), 'utf8');

    expect(types).toContain('failure: RuntimeFailureSignal | null;');
    expect(bootstrapTimeline).toContain('classifyRuntimeBootstrapStageFailure');
    expect(bootstrapTimeline).toContain('const withBootstrapStageFailure = (');
    expect(bootstrapTimeline).toContain(
      'failure: classifyRuntimeBootstrapStageFailure(stage.key, stage.status, stage.reason)',
    );
    expect(bootstrapTimeline).toContain('].map(');
    expect(bootstrapTimeline).toContain('withBootstrapStageFailure,');
    expect(healthRedaction).toContain("failure: publicFailureSignal(valueOf(stage, 'failure'))");
  });

  test('market maker quote hot path is producer-only after runtime loop starts', () => {
    const mmNode = readMarketMakerNodeSource();
    const meshCommon = readFileSync(join(repoRoot, 'core/orchestrator/mesh/mesh-common.ts'), 'utf8');
    const ensureStart = mmNode.indexOf('const ensureMarketMakerHubConnectivity = async (');
    const readyStart = mmNode.indexOf('const isMarketMakerConnectivityReady = (');
    const quotePipelineStart = mmNode.indexOf('type BootstrapSameQuoteDriverDeps = {');
    const driveStart = mmNode.indexOf('const driveMarketMakerQuotes = async (');
    const quotePipelineEnd = mmNode.indexOf('export const runMarketMakerNode = async (');
    expect(ensureStart).toBeGreaterThan(0);
    expect(readyStart).toBeGreaterThan(ensureStart);
    expect(quotePipelineStart).toBeGreaterThan(readyStart);
    expect(driveStart).toBeGreaterThan(quotePipelineStart);
    expect(quotePipelineEnd).toBeGreaterThan(driveStart);
    expect(mmNode).toContain('if (!MARKET_MAKER_STEADY_QUOTES_ENABLED) return;');
    // Regression (2026-08-24): publishReady keeps a frozen cross health
    // section once it ever read complete, so the steady loop must decide from
    // a live snapshot — otherwise a fully filled cross route reads depth-ready
    // forever and the maker never requotes.
    expect(mmNode).toContain('const before = deps.health.publish({ includeCross: true });');
    expect(mmNode).not.toContain('const before = deps.health.publishReady();');

    const ensureConnectivity = mmNode.slice(ensureStart, readyStart);
    const quotePipeline = mmNode.slice(quotePipelineStart, quotePipelineEnd);
    expect(ensureConnectivity).not.toContain('settleRuntimeFor(');
    expect(ensureConnectivity).not.toContain('const accountOpenInputs: EntityInput[] = []');
    expect(ensureConnectivity).toContain('return true;');
    expect(ensureConnectivity).toContain('return false;');
    expect(quotePipeline).not.toContain('settleRuntimeFor(');
    expect(quotePipeline).toContain('await yieldMarketMakerApi();');
    expect(quotePipeline).toMatch(/await ensureMarketMakerHubConnectivity\(/);
    expect(quotePipeline).toContain('const orderedIncompleteJobs: SameQuoteJob[] = [];');
    expect(quotePipeline).toMatch(/const jobsByContext = new Map<\s*string,\s*\{/);
    expect(quotePipeline).toContain('const runnableHubEntityIdsFor =');
    expect(quotePipeline).toContain('const quoteBatch = mergeMarketMakerQuoteEntityInputs(');
    expect(quotePipeline).toContain('enqueueRuntimeInput(deps.env, { runtimeTxs: [], entityInputs: quoteBatch });');
    expect(quotePipeline).not.toContain('const hubEntityIds = [job.hub.entityId];');
    expect(quotePipeline).toContain('await maintainSameContextQuotes({');
    expect(quotePipeline).toContain('const enqueued = await maintainMarketMakerCrossQuotes(');
    expect(quotePipeline).toContain('job.sourceHubs,');
    expect(quotePipeline).toContain('job.targetHubs,');
    expect(quotePipeline).toContain("if (input.mode === 'bootstrap') {");
    expect(quotePipeline).toContain('await submitCrossJurisdictionIntents(input.deps.env, routes);');
    expect(quotePipeline).toContain('input.state.bootstrapCrossBatchSubmitted = true;');
    expect(meshCommon).toContain(
      'const queuedEntityTxsFor = (env: RuntimeReplica, targetEntityId: string): EntityTx[] => {',
    );
    expect(meshCommon).toContain('export const hasQueuedExtendCredit = (');
  });

  test('frontend command submission never starts or directly drives the runtime loop', () => {
    const xlnStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/xlnStore.ts'), 'utf8');
    const drainStart = xlnStore.indexOf('const drainLocalRuntimeInput = async (');
    const drainEnd = xlnStore.indexOf('const normalizeRuntimeIdentifier =', drainStart);
    const submitStart = xlnStore.indexOf('export async function dispatchRuntimeInputToRuntimeEnv');
    const submitEnd = xlnStore.indexOf('\nexport ', submitStart + 1);

    expect(drainStart).toBeGreaterThan(0);
    expect(drainEnd).toBeGreaterThan(drainStart);
    expect(submitStart).toBeGreaterThan(0);
    expect(submitEnd).toBeGreaterThan(submitStart);
    expect(xlnStore.slice(drainStart, drainEnd)).not.toContain('xln.process(');
    expect(xlnStore.slice(submitStart, submitEnd)).not.toContain('xln.startRuntimeLoop(');
  });

  test('isolated E2E failure forensics never opens the live database and records every HTTP failure', () => {
    const runner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts'), 'utf8');
    const forensicsStart = runner.indexOf('const captureShardFailureForensics = async (');
    const runShardStart = runner.indexOf('const runShard = async (');
    const forensics = runner.slice(forensicsStart, runShardStart);

    expect(runner).not.toContain('FAILURE_RECEIPT_DUMP_TIMEOUT_MS');
    expect(runner).not.toContain('receiptDump');
    expect(runner).toContain("path: '/api/debug/activity?limit=500'");
    expect(runner).toContain('Promise.all(forensicEndpoints.map(async endpoint =>');
    expect(runner).toContain('`${endpoint.name}.error.txt`');
    expect(forensics).toContain('await captureE2EHttpForensics({ apiUrl: options.apiUrl, outputDir });');
  });

  test('market maker bootstrap never sends hub-side credit inputs itself', () => {
    const mmNode = readMarketMakerNodeSource();
    const orchestrator = readOrchestratorSource();
    const ensureStart = mmNode.indexOf('const ensureMarketMakerHubConnectivity = async (');
    const readyStart = mmNode.indexOf('const isMarketMakerConnectivityReady = (');
    expect(ensureStart).toBeGreaterThan(0);
    expect(readyStart).toBeGreaterThan(ensureStart);

    const ensureConnectivity = mmNode.slice(ensureStart, readyStart);
    expect(mmNode).toContain("import { deriveAccountWatchSeed } from '../../../protocol/identity/account-watch-seed';");
    expect(ensureConnectivity).toContain(
      'const deriveMarketMakerAccountWatchSeed = (counterpartyId: string): string =>',
    );
    // The seed used to assert a literal `timestamp: 0` here, standing in for
    // "derived deterministically, never from wall-clock". deriveAccountWatchSeed
    // no longer accepts a timestamp at all, so the type enforces it.
    expect(ensureConnectivity).toContain('counterpartyId,');
    expect(ensureConnectivity).toContain(
      'const [openTokenId = 1, ...extraCreditTokenIds] = normalizePositiveTokenIds(tokenIds);',
    );
    expect(ensureConnectivity).toContain("type: 'openAccount'");
    expect(ensureConnectivity).toContain('watchSeed: deriveMarketMakerAccountWatchSeed(hubEntityId)');
    expect(ensureConnectivity).toContain("type: 'extendCredit' as const");
    expect(ensureConnectivity).not.toContain('hubSignerIdsByEntityId');
    expect(ensureConnectivity).not.toContain('remoteCreditInputs');
    expect(ensureConnectivity).not.toContain('sendEntityInput');
    expect(mmNode).not.toContain('RoutedEntityInput');
    expect(orchestrator).toContain("'--support-peer-identities-json', safeStringify(deps.getMarketMakerIdentities())");
    expect(orchestrator).not.toContain('--mesh-hub-identities-json');
  });

  test('hub and market maker require one authenticated direct entity route', () => {
    const apiServer = readFileSync(join(repoRoot, 'core/api/server/index.ts'), 'utf8');
    const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    const hubTransport = readFileSync(join(repoRoot, 'core/orchestrator/hub/hub-runtime-transport.ts'), 'utf8');
    const mmNode = readMarketMakerNodeSource();
    const p2p = readFileSync(join(repoRoot, 'core/network/p2p/p2p.ts'), 'utf8');

    expect(p2p).not.toContain('preferRelayForEntityInput');
    expect(p2p).not.toContain('resolveTransportAttempts');
    expect(hubNode).not.toContain("process.env['XLN_ENABLE_DIRECT_ENTITY_INPUT_DISPATCH'] === '1'");
    expect(hubTransport).not.toContain("process.env['XLN_ENABLE_DIRECT_ENTITY_INPUT_DISPATCH'] === '1'");
    expect(mmNode).not.toContain("process.env['XLN_ENABLE_DIRECT_ENTITY_INPUT_DISPATCH'] === '1'");
    expect(hubTransport).toContain('route.sendEntityInputsDelivery(');
    expect(mmNode).not.toContain('env.infrastructure.directEntityInputsDispatch');
    expect(apiServer).not.toContain('env.infrastructure.directEntityInputsDispatch');
    expect(apiServer).not.toContain('sendEntityInputDirectViaRelaySocketDelivery');
    expect(hubNode).not.toContain('preferRelayForEntityInput');
    expect(mmNode).not.toContain('preferRelayForEntityInput');
    expect(mmNode).not.toContain('allowDirectClients: false');
    expect(hubNode).toContain('if (!directHubPeersReady(input.env, peers)) return false;');
    expect(mmNode).toContain('if (!marketMakerHubDirectRoutesOpen(env, hubEntityIds))');
  });

  test('hub support-peer provisioning uses full jurisdiction token sets', () => {
    const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    expect(hubNode).toContain("import { getTokenIdsForJurisdiction } from '../account/utils';");
    expect(hubNode).toContain('const tokenIdsForHubJurisdiction = (');
    expect(hubNode).toContain('const tokenCatalogForHubJurisdiction = (');

    const planSupportStart = hubNode.indexOf('const planSupportAccountSetupInputs = (');
    const planHubStart = hubNode.indexOf('const planHubAccountSetupInputs = (', planSupportStart);
    expect(planSupportStart).toBeGreaterThan(0);
    expect(planHubStart).toBeGreaterThan(planSupportStart);
    const planSupportAccountSetupInputs = hubNode.slice(planSupportStart, planHubStart);
    expect(planSupportAccountSetupInputs).toContain('const tokenIds = tokenIdsForHubJurisdiction(owner);');
    expect(planSupportAccountSetupInputs).toContain('if (!account || !canWrite) continue;');
    expect(planSupportAccountSetupInputs).toContain('const missingTokenIds = tokenIds.filter(');
    expect(planSupportAccountSetupInputs).toContain('entityTxs: missingTokenIds.map(tokenId => ({');
    expect(planSupportAccountSetupInputs).toContain('return { openInputs: [], creditInputs };');
    expect(planSupportAccountSetupInputs).not.toContain('DEFAULT_ACCOUNT_TOKEN_IDS');

    const reserveStart = hubNode.indexOf('const getReserveHealth = (');
    const supportPeerReserveEnd = hubNode.indexOf('const getEntityJurisdictionName = (');
    expect(reserveStart).toBeGreaterThan(0);
    expect(supportPeerReserveEnd).toBeGreaterThan(reserveStart);
    const reserveBootstrap = hubNode.slice(reserveStart, supportPeerReserveEnd);
    expect(reserveBootstrap).toContain('tokenCatalogForHubJurisdiction(tokenCatalog, {');
    expect(reserveBootstrap).toContain(
      'const bootstrapTokens = tokenCatalogForHubJurisdiction(tokenCatalog, {',
    );
    expect(reserveBootstrap).not.toContain('tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)');
    expect(reserveBootstrap).not.toContain('catalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)');
  });

  test('hub mesh bootstrap uses live entity jurisdiction and provisions the external faucet by default', () => {
    const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    const driveStart = hubNode.indexOf('const advanceHubMeshBootstrap = async (');
    const driveEnd = hubNode.indexOf('const run = async (): Promise<void> => {', driveStart);
    expect(driveStart).toBeGreaterThan(0);
    expect(driveEnd).toBeGreaterThan(driveStart);
    const driveMeshBootstrap = hubNode.slice(driveStart, driveEnd);
    expect(driveMeshBootstrap).toContain('getEntityJurisdiction(input.env, input.bootstrap.entityId)');
    expect(driveMeshBootstrap).toContain('readVisibleHubProfiles(input.env, jurisdiction)');
    expect(driveMeshBootstrap).toContain('if (requiredProfiles.length !== resolvedArgs.meshHubNames.length) return false;');
    expect(driveMeshBootstrap).toContain('const supportReady = supportPeerProvisioningReady(');
    expect(driveMeshBootstrap).toContain('input.milestones.reserveReady = await ensureHubMeshReserves(input);');
    const creditFence = driveMeshBootstrap.indexOf('if (!creditReady) return false;');
    const reserveProvision = driveMeshBootstrap.indexOf('if (!input.milestones.reserveReady) {');
    const faucetProvision = driveMeshBootstrap.indexOf('await input.ensureFaucetReady();');
    const supportFence = driveMeshBootstrap.indexOf('supportPeerProvisioningReady');
    expect(creditFence).toBeGreaterThan(0);
    expect(reserveProvision).toBeGreaterThan(creditFence);
    expect(faucetProvision).toBeGreaterThan(reserveProvision);
    expect(supportFence).toBeGreaterThan(faucetProvision);
    expect(driveMeshBootstrap).not.toContain('assertBootstrapNotStalled');
    expect(driveMeshBootstrap).not.toContain('meshLoopProgress = beginBootstrapProgress(Date.now())');
    expect(driveMeshBootstrap).not.toContain("markMeshBootstrapProgress('idle')");
    expect(hubNode).toContain('step => input.markProgress(`local-reserve:${step}`)');
    expect(hubNode).toContain('const bootstrapClockMs = (): number => getPerfMs();');
    expect(hubNode).toContain('beginBootstrapProgress(bootstrapClockMs())');
    expect(hubNode).toContain('advanceBootstrapProgress(live.meshLoopProgress, step, bootstrapClockMs())');
    expect(hubNode).not.toContain('advanceBootstrapProgress(live.meshLoopProgress, step, Date.now())');
    expect(hubNode).toContain(
      "const AUTO_PROVISION_EXTERNAL_FAUCET = process.env['XLN_AUTO_PROVISION_EXTERNAL_FAUCET'] !== '0';",
    );
    expect(hubNode).toContain('if (!AUTO_PROVISION_EXTERNAL_FAUCET) return;');
    expect(driveMeshBootstrap).toContain('await input.ensureFaucetReady();');
    expect(hubNode).not.toContain(
      'if (resolvedArgs.deployTokens) {\n    void externalWalletApi.provisionFaucetWallet()',
    );
    expect(hubNode).not.toContain('void externalWalletApi.provisionFaucetWallet()');
  });

  test('hub mesh bootstrap releases its interval only after declared support peers are provisioned', () => {
    const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    const readinessStart = hubNode.indexOf('const supportPeerProvisioningReady = (');
    const healthStart = hubNode.indexOf('const buildPairHealth = (', readinessStart);
    const controllerStart = hubNode.indexOf('const createHubMeshBootstrapController = (');
    const shutdownStart = hubNode.indexOf('const installHubShutdownHandlers = (', controllerStart);
    expect(readinessStart).toBeGreaterThan(0);
    expect(healthStart).toBeGreaterThan(readinessStart);
    expect(controllerStart).toBeGreaterThan(healthStart);
    expect(shutdownStart).toBeGreaterThan(controllerStart);

    const readiness = hubNode.slice(readinessStart, healthStart);
    expect(readiness).toContain('if (peers.length !== expected.length) return false;');
    expect(readiness).toContain('if (!account || account.pendingFrame || account.mempool.length > 0) return false;');
    expect(readiness).toContain('getCreditGrantedByEntity(account, owner.entityId, tokenId) >=');

    const controller = hubNode.slice(controllerStart, shutdownStart);
    expect(controller).toContain('const complete = await advanceHubMeshBootstrap({');
    expect(controller).toContain("markProgress('complete');");
    expect(controller).toContain('if (loop) clearInterval(loop);');
    expect(controller).toContain('loop = null;');
  });

  test('secondary hubs wait until every primary contract address has deployed bytecode', () => {
    const orchestrator = readOrchestratorSource();
    const readiness = extractSourceBlock(
      orchestrator,
      'const waitForShardJurisdictions = async (child: HubChild): Promise<void> =>',
      'const runReset = async (options: OrchestratorResetOptions = configuredResetOptions): Promise<void> =>',
    );

    expect(readiness).toContain('await findMissingRpcContractCode(args.rpcUrl, contracts)');
    expect(readiness).toContain('if (hasRpc2 && missingCode.length === 0 && !probeError)');
    expect(readiness).not.toContain('if (hasShardRpc2Jurisdiction(jurisdictionsConfig)) {\n      return;');
  });

  test('hub mesh, market maker, and custody bootstrap behind one parallel readiness barrier', () => {
    const orchestrator = readOrchestratorSource();
    const custodyBootstrapSource = readFileSync(join(repoRoot, 'core/orchestrator/bootstrap/custody-bootstrap.ts'), 'utf8');
    const resetStart = orchestrator.indexOf('const runReset = async (');
    const resetEnd = orchestrator.indexOf('const resetCoordinator =', resetStart);
    const reset = orchestrator.slice(resetStart, resetEnd);
    expect(reset).toContain('await Promise.all(hubChildren.map(child => waitForHubSelfReady(child)));');
    expect(reset).toContain('const startConfiguredMarketMaker = async (): Promise<void> => {');
    expect(reset).toContain('const startConfiguredCustody = async (): Promise<void> => {');
    expect(reset).toContain(
      'await Promise.all([\n      waitForMesh(),\n      driveNativeH1Bootstrap(h1, shouldStartMarketMaker),\n      startConfiguredMarketMaker(),\n      startConfiguredCustody(),',
    );
    expect(orchestrator).not.toContain('continuing market maker startup before failing reset');
    expect(custodyBootstrapSource).toContain('XLN_PREDEPLOYED_JURISDICTION_KEY: options.jurisdictionId');
    expect(custodyBootstrapSource).toContain('discoverHubIds(options.apiBaseUrl, 3, 30_000, jurisdictionTarget)');
  });

  test('custody daemon advertises on relay before opening hub accounts', () => {
    const daemonControl = readFileSync(join(repoRoot, 'core/orchestrator/daemon-control.ts'), 'utf8');
    const setupStart = daemonControl.indexOf('export const setupCustody = async (');
    const setupEnd = daemonControl.indexOf('};', setupStart);
    expect(setupStart).toBeGreaterThan(0);
    expect(setupEnd).toBeGreaterThan(setupStart);
    const setupCustody = daemonControl.slice(setupStart, setupEnd);
    const configureIndex = setupCustody.indexOf('await configureManagedEntityP2P(client, identity, config);');
    const profileWaitIndex = setupCustody.indexOf('await waitForGossipProfiles(client, hubEntityIds);');
    const directWaitIndex = setupCustody.indexOf('await client.waitForDirectEntityRoutes(hubEntityIds);');
    const connectivityIndex = setupCustody.indexOf('const connectivityInput = buildCustodyConnectivityInput');
    expect(configureIndex).toBeGreaterThan(0);
    expect(profileWaitIndex).toBeGreaterThan(configureIndex);
    expect(directWaitIndex).toBeGreaterThan(profileWaitIndex);
    expect(connectivityIndex).toBeGreaterThan(directWaitIndex);
    expect(daemonControl).toContain('CUSTODY_HUB_PROFILES_NOT_VISIBLE');
    expect(daemonControl).toContain('CONTROL_P2P_DIRECT_ROUTES_NOT_OPEN');
    expect(setupCustody).toContain('CUSTODY_CONNECTIVITY_ACCOUNTS_NOT_OPEN');
    expect(setupCustody).not.toContain('await enableRouting(client, config);');
  });

  test('production account openers bind one explicit role authority per party', () => {
    const sources = [
      'core/orchestrator/daemon-control.ts',
      'core/orchestrator/hub-node.ts',
      'core/orchestrator/market-maker/node/mm-node-core.ts',
      'core/runtime/swap-cmd/swap-command-plan.ts',
      'frontend/src/lib/components/Entity/onboarding/onboarding-runtime-input.ts',
      'frontend/src/lib/components/Entity/onboarding/hub-discovery-profile.ts',
      'frontend/src/lib/components/Entity/swap-panel-core.ts',
      'frontend/src/lib/view/panels/ArchitectPanel.svelte',
    ].map(file => readFileSync(join(repoRoot, file), 'utf8'));
    for (const source of sources) {
      expect(source).toContain('defaultAccountDisputeConfigForRoleEvidence');
      expect(source).not.toContain('defaultAccountDisputeConfigForParties');
    }
    expect(sources.join('\n')).toContain("source: 'committed-profile'");
    expect(sources.join('\n')).toContain("source: 'verified-gossip-profile'");
    expect(sources.join('\n')).toContain("source: 'operator-config'");
  });

  test('custody hub discovery filters hubs by jurisdiction stack identity', async () => {
    const originalFetch = globalThis.fetch;
    const debugHub = (
      entityId: string,
      jurisdictionName: string,
      chainId: number,
      depositoryAddress: string,
    ) => ({
      entityId,
      name: `hub-${entityId.slice(-2)}`,
      isHub: true,
      online: true,
      lastUpdated: 1,
      accounts: [],
      publicAccounts: [],
      metadata: { jurisdiction: { name: jurisdictionName, chainId, depositoryAddress } },
    });
    globalThis.fetch = (async () =>
      new Response(
        safeStringify({
          entities: [
            debugHub('0x' + 'a'.repeat(64), 'Tron', 31338, '0x2222222222222222222222222222222222222222'),
            debugHub('0x' + 'b'.repeat(64), 'Tron', 31338, '0x2222222222222222222222222222222222222222'),
            debugHub('0x' + 'c'.repeat(64), 'Tron', 31338, '0x2222222222222222222222222222222222222222'),
            debugHub('0x' + '1'.repeat(64), 'Testnet', 31337, '0x1111111111111111111111111111111111111111'),
            debugHub('0x' + '2'.repeat(64), 'Testnet', 31337, '0x1111111111111111111111111111111111111111'),
            debugHub('0x' + '3'.repeat(64), 'Testnet', 31337, '0x1111111111111111111111111111111111111111'),
          ],
        }),
      )) as typeof fetch;
    try {
      const hubIds = await discoverHubIds('http://127.0.0.1:8082', 3, 100, {
        key: 'arrakis',
        name: 'Testnet',
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
      });
      expect(hubIds).toEqual(['0x' + '1'.repeat(64), '0x' + '2'.repeat(64), '0x' + '3'.repeat(64)]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('offchain faucet exposes all local hub bootstrap entities', () => {
    const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    expect(hubNode).toContain(
      'context.faucetRelayStore.activeHubEntityIds =\n      context.hubBootstraps.map(entry => entry.entityId);',
    );
    expect(hubNode).not.toContain('faucetRelayStore.activeHubEntityIds = [readyBootstrap.entityId];');
  });

  test('orchestrator exposes the gossip profile bundle endpoint used by payments', () => {
    const debugApi = readFileSync(join(repoRoot, 'core/orchestrator/debug-api.ts'), 'utf8');
    const paymentPanel = readFileSync(join(repoRoot, 'frontend/src/lib/components/Entity/payments/PaymentPanel.svelte'), 'utf8');
    const xlnStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/xlnStore.ts'), 'utf8');

    expect(paymentPanel).not.toContain('/api/gossip/profile?entityId=');
    expect(paymentPanel).toContain('refreshPaymentRuntimeGossip');
    expect(xlnStore).toContain('/api/gossip/profile?entityId=');
    expect(xlnStore).toContain('export async function refreshPaymentRuntimeGossip');
    expect(debugApi).toContain("import { handleKnownProfileRequest } from '../api/server/network/gossip-profiles';");
    expect(debugApi).toContain("if (deps.pathname === '/api/gossip/profile')");
    expect(debugApi).toContain('return handleKnownProfileRequest({');
    expect(debugApi).toContain('relayStore: deps.relayStore');
  });

  test('fresh deploy stops runtime processes before deleting runtime state', () => {
    const deploy = readPlatformDeploy();
    const stopIndex = deploy.indexOf('pm2 delete xln-server');
    const deleteIndex = deploy.indexOf('rm -rf "$XLN_RDB_ROOT/core/prod-main"');
    expect(stopIndex).toBeGreaterThan(0);
    expect(deleteIndex).toBeGreaterThan(0);
    expect(stopIndex).toBeLessThan(deleteIndex);
    expect(deploy).toContain("pkill -KILL -f 'core/orchestrator/hub-node.ts'");
    expect(deploy).toContain("pkill -KILL -f 'core/orchestrator/mm-node.ts'");
  });

  test('secondary anvil uses a persistent Tron chain id and state file', () => {
    const anvil = readFileSync(join(repoRoot, 'scripts/operations/start-anvil.sh'), 'utf8');
    const anvil2 = readFileSync(join(repoRoot, 'scripts/operations/start-anvil2.sh'), 'utf8');
    const jurisdictions = JSON.parse(readFileSync(join(repoRoot, 'jurisdictions/jurisdictions.json'), 'utf8')) as {
      jurisdictions: Record<string, { blockTimeMs?: number }>;
    };
    expect(anvil).toContain('ANVIL_CHAIN_ID="${ANVIL_CHAIN_ID:-31337}"');
    expect(anvil).toContain('--chain-id "$ANVIL_CHAIN_ID"');
    expect(anvil).toContain('--prune-history "$ANVIL_PRUNE_HISTORY"');
    expect(anvil).toContain('--state "$ANVIL_STATE"');
    expect(anvil).toContain('--state-interval "$ANVIL_STATE_INTERVAL"');
    expect(anvil).toContain('ANVIL_STATE_INTERVAL="${ANVIL_STATE_INTERVAL:-60}"');
    expect(anvil).toContain('ANVIL_BLOCK_TIME=10');
    expect(anvil).toContain('exec anvil --host 0.0.0.0');
    expect(anvil).toContain('ANVIL_PRODUCTION_RESET_REQUIRES_ONE_SHOT_AUTHORIZATION');
    expect(anvil).toContain('ANVIL_PORT_ALREADY_BOUND');
    expect(anvil).not.toContain('| tee');
    expect(anvil).toContain('--mixed-mining');
    for (const key of ['arrakis', 'tron']) {
      expect(jurisdictions.jurisdictions[key]?.blockTimeMs).toBe(10_000);
    }
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
      return new Response(
        safeStringify({
          success: true,
          serverDurationMs: 0,
          requestId: 'offchain_1',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {
          pollCalls += 1;
          throw new Error('health poll should not run for a cached explicit hub');
        },
        getHubChildByEntityId: (entityId: string) => (entityId === hubEntityId ? ({ apiPort: 19301 } as any) : null),
        getHealthyHub: () => null,
      });
      const body = safeStringify({ hubEntityId, userEntityId: `0x${'cd'.repeat(32)}` });
      const response = await handlers.proxyHubApi(
        new Request('http://xln.local/api/faucet/offchain', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
        '/api/faucet/offchain',
      );

      expect(response.status).toBe(200);
      expect(pollCalls).toBe(0);
      expect(upstreamUrl).toBe('http://127.0.0.1:19301/api/faucet/offchain');
      expect(upstreamBody).toBe(body);
      expect(response.headers.get('x-xln-proxy-health-polled')).toBe('0');
      expect((await response.json()).requestId).toBe('offchain_1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('explicit hub action proxy fails fast when the selected child is absent', async () => {
    const originalFetch = globalThis.fetch;
    const hubEntityId = `0x${'ef'.repeat(32)}`;
    let pollCalls = 0;
    globalThis.fetch = (async () =>
      new Response(safeStringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {
          pollCalls += 1;
        },
        getHubChildByEntityId: () => null,
        getHealthyHub: () => null,
      });
      const response = await handlers.proxyHubApi(
        new Request('http://xln.local/api/faucet/offchain', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: safeStringify({ hubEntityId }),
        }),
        '/api/faucet/offchain',
      );

      expect(response.status).toBe(404);
      expect(pollCalls).toBe(0);
      expect(response.headers.get('x-xln-proxy-health-polled')).toBe('0');
      expect((await response.json()).code).toBe('FAUCET_HUB_NOT_FOUND');
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

    const response = await handlers.proxyEntityHubApi(
      new Request('http://xln.local/api/external-wallet/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: safeStringify({ entityId }),
      }),
      '/api/external-wallet/snapshot',
    );
    const body = (await response.json()) as {
      category?: string;
      code?: string;
      error?: string;
      failure?: { category?: string; code?: string; retryable?: boolean; fatal?: boolean };
      retryable?: boolean;
      fatal?: boolean;
    };

    expect(response.status).toBe(503);
    expect(body.code).toBe('ENTITY_HUB_PROXY_ENTITY_NOT_FOUND');
    expect(body.category).toBe('TransientRace');
    expect(body.retryable).toBe(true);
    expect(body.fatal).toBe(false);
    expect(body.failure).toMatchObject({
      category: 'TransientRace',
      code: 'ENTITY_HUB_PROXY_ENTITY_NOT_FOUND',
      retryable: true,
      fatal: false,
    });
    expect(body.error).toContain(entityId);
    expect(pollCalls).toBe(1);
    expect(healthyHubCalls).toBe(0);
    expect(response.headers.get('x-xln-proxy-health-polled')).toBe('1');
  });

  test('entity-scoped wallet proxy rejects oversized bodies before routing or upstream work', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let lookupCalls = 0;
    let pollCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ success: true });
    }) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {
          pollCalls += 1;
        },
        getHubChildByEntityId: () => {
          lookupCalls += 1;
          return null;
        },
        getHealthyHub: () => null,
      });
      const declared = await handlers.proxyEntityHubApi(
        new Request('http://xln.local/api/external-wallet/snapshot', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(MAX_WALLET_SNAPSHOT_BODY_BYTES + 1),
          },
          body: '{}',
        }),
        '/api/external-wallet/snapshot',
      );
      const streamed = await handlers.proxyEntityHubApi(
        new Request('http://xln.local/api/external-wallet/snapshot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: safeStringify({ padding: 'x'.repeat(MAX_WALLET_SNAPSHOT_BODY_BYTES) }),
        }),
        '/api/external-wallet/snapshot',
      );

      expect(declared.status).toBe(413);
      expect(streamed.status).toBe(413);
      expect(await declared.json()).toMatchObject({
        success: false,
        code: 'EXTERNAL_WALLET_SNAPSHOT_BODY_TOO_LARGE',
      });
      expect(await streamed.json()).toMatchObject({
        success: false,
        code: 'EXTERNAL_WALLET_SNAPSHOT_BODY_TOO_LARGE',
      });
      expect({ fetchCalls, lookupCalls, pollCalls }).toEqual({ fetchCalls: 0, lookupCalls: 0, pollCalls: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('entity-scoped wallet proxy canonicalizes entity id before routing', async () => {
    const originalFetch = globalThis.fetch;
    const suppliedEntityId = `0X${'AB'.repeat(32)}`;
    const canonicalEntityId = suppliedEntityId.toLowerCase();
    let routedEntityId = '';
    globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {
          throw new Error('canonical entity lookup should hit the cached child');
        },
        getHubChildByEntityId: entityId => {
          routedEntityId = entityId;
          return entityId === canonicalEntityId ? ({ apiPort: 19303 } as any) : null;
        },
        getHealthyHub: () => null,
      });
      const response = await handlers.proxyEntityHubApi(
        new Request('http://xln.local/api/external-wallet/snapshot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: safeStringify({ entityId: suppliedEntityId }),
        }),
        '/api/external-wallet/snapshot',
      );

      expect(response.status).toBe(200);
      expect(routedEntityId).toBe(canonicalEntityId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('RPC watcher pauses during persistence quiesce instead of entering j-event ingress', () => {
    const poll = readFileSync(join(repoRoot, 'core/jurisdiction/adapter/rpc/watcher/rpc-watcher-poll.ts'), 'utf8');
    const ingress = readFileSync(join(repoRoot, 'core/jurisdiction/adapter/rpc/watcher/rpc-watcher-ingress.ts'), 'utf8');
    const pauseHelper = poll.indexOf('const isIngressPaused = (env: RuntimeReplica): boolean =>');
    const earlyPause = poll.indexOf("pauseForQuiesce(request, { step: 'before-block-number' });");
    const batchPause = ingress.indexOf("step: 'before-process-event-batch'");
    const processBatch = ingress.indexOf('const observedInputs = decoded.events.length > 0');

    expect(pauseHelper).toBeGreaterThan(0);
    expect(poll).toContain("event: 'j_watch_paused_persistence_quiescing'");
    expect(earlyPause).toBeGreaterThan(pauseHelper);
    expect(batchPause).toBeGreaterThan(0);
    expect(batchPause).toBeLessThan(processBatch);
  });

  test('hub account-status proxy skips health polling when cached child mapping is known', () => {
    const routes = readFileSync(join(repoRoot, 'core/orchestrator/hub/hub-api-routes.ts'), 'utf8');
    const findHubStart = routes.indexOf('const findHub = async (');
    const accountRouteStart = routes.indexOf('const handleHubAccountRequest = async (');
    expect(findHubStart).toBeGreaterThan(0);
    expect(accountRouteStart).toBeGreaterThan(findHubStart);

    const findHub = routes.slice(findHubStart, accountRouteStart);
    expect(findHub).toContain('const cached = dependencies.getHubChildByEntityId(entityId);');
    expect(findHub).toContain('if (cached) return cached;');
    expect(findHub).toContain('await dependencies.pollAllHubHealth();');
    expect(findHub.indexOf('if (cached) return cached;')).toBeLessThan(
      findHub.indexOf('await dependencies.pollAllHubHealth();'),
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
      const response = await handlers.proxyRpc(
        new Request('http://127.0.0.1/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: safeStringify({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }),
        }),
      );
      const body = (await response.json()) as {
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
      // Bun 1.4 correctly aborts the client request, but awaiting stop() can
      // wait forever for the deliberately unresolved test handler itself.
      server.stop(true);
    }
  }, 2_000);
});
