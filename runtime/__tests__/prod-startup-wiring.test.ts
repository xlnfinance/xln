import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverHubIds } from '../orchestrator/custody-bootstrap';
import { createOrchestratorProxyHandlers } from '../orchestrator/proxy';
import { MAX_WALLET_SNAPSHOT_BODY_BYTES } from '../api/public/external-wallet/http';
import { E2E_FATAL_LOG_TAIL_LINES, findFirstRuntimeFatalLogHit, tailLog } from '../scripts/e2e-fatal-log-monitor';
import { expandPlaywrightTargets } from '../scripts/run-e2e-parallel-isolated';

const repoRoot = process.cwd();
const readPlatformDeploy = (): string =>
  readFileSync(join(repoRoot, 'scripts/deployment/deploy-platform.sh'), 'utf8');

const readMarketMakerNodeModule = (file: string): string =>
  readFileSync(join(repoRoot, 'runtime/orchestrator', file), 'utf8');

const readMarketMakerNodeSource = (): string =>
  ['mm-node.ts', 'mm-node-core.ts', 'mm-node-health.ts', 'mm-node-run.ts'].map(readMarketMakerNodeModule).join('\n');

const readRpcAdapterSource = (): string =>
  [
    'rpc-public.ts',
    'rpc-adapter.ts',
    'rpc-chain-io.ts',
    'rpc-lifecycle.ts',
    'rpc-reads.ts',
    'rpc-wallet-writes.ts',
    'rpc-watcher-ingress.ts',
    'rpc-watcher-poll.ts',
  ]
    .map(file => readFileSync(join(repoRoot, 'runtime/jurisdiction/adapter', file), 'utf8'))
    .join('\n');

const extractSourceBlock = (source: string, marker: string, nextMarker: string): string => {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(nextMarker, start + marker.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('production startup wiring', () => {
  test('managed hub BrainVault prewarms before WAL replay and opens custody only after restore', () => {
    const hub = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const transport = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-runtime-transport.ts'), 'utf8');
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const prewarm = hub.indexOf('await brainVaultOwner.prewarm(resolvedArgs.seed);');
    const runtimeMain = hub.indexOf('const env = await main(resolvedArgs.seed', prewarm);
    const runtimeLoop = hub.indexOf('startRuntimeLoop(env, {', runtimeMain);
    const restore = hub.indexOf('await restoreHubBrainVaultOwner(live, brainVaultOwner);', runtimeLoop);
    const helperRestore = hub.indexOf('const restored = await brainVaultOwner.restore(live.env);');
    const helperReady = hub.indexOf('live.brainVaultReady = true;', helperRestore);

    expect(prewarm).toBeGreaterThanOrEqual(0);
    expect(prewarm).toBeLessThan(runtimeMain);
    expect(runtimeMain).toBeLessThan(runtimeLoop);
    expect(runtimeLoop).toBeLessThan(restore);
    expect(helperRestore).toBeGreaterThanOrEqual(0);
    expect(helperRestore).toBeLessThan(helperReady);
    expect(transport).toContain("throw new Error('BRAINVAULT_OWNER_STARTUP_PENDING')");
    expect(orchestrator).toContain("XLN_BRAINVAULT_OWNER_PATH: join(child.dbPath, 'brainvault-owner.json')");
  });

  test('public direct runtime ports expose only websocket transport routes', () => {
    const sources = [readPlatformDeploy()];

    for (const source of sources) {
      expect(source).toContain('location = /rpc {');
      expect(source).toContain('location = /ws {');
      expect(source).toContain('return 404;');
      expect(source).not.toMatch(/listen 809[0-3][^}]+location \/ \{\s+proxy_pass/s);
    }
    for (const source of [
      readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8'),
      readMarketMakerNodeSource(),
    ]) {
      const upgrade = source.indexOf('const directUpgrade = directRuntimeWs.maybeUpgrade(request, serverRef);');
      const extractedHandler = source.indexOf('const handleHubHttpRequest = async');
      const dispatch = extractedHandler >= 0 ? source.indexOf('handleHubHttpRequest(', upgrade) : upgrade;
      const handler = extractedHandler >= 0 ? extractedHandler : upgrade;
      const guard = source.indexOf('if (requiresLocalNodeOperator(url) && !operatorAuthorized)', handler);
      const statusRoute =
        extractedHandler >= 0
          ? source.indexOf('const statusResponse = context.handleStatus(', guard)
          : source.indexOf("if (pathname === '/api/info')", guard);
      expect(dispatch).toBeGreaterThanOrEqual(upgrade);
      expect(guard).toBeGreaterThan(handler);
      expect(statusRoute).toBeGreaterThan(guard);
    }
  });

  test('runtime import rejects public callers before minting admin capabilities', () => {
    const runtimeImportHttp = readFileSync(join(repoRoot, 'runtime/orchestrator/runtime-import-http.ts'), 'utf8');
    const handler = runtimeImportHttp.indexOf('export const handleRuntimeImportHttpRequest');
    const operatorGate = runtimeImportHttp.indexOf(
      'if (requiresLocalNodeOperator(url) && !operatorAuthorized)',
      handler,
    );
    const manifestMint = runtimeImportHttp.indexOf('deps.buildRuntimeImportManifest()', handler);

    expect(handler).toBeGreaterThanOrEqual(0);
    expect(operatorGate).toBeGreaterThan(handler);
    expect(manifestMint).toBeGreaterThan(operatorGate);
  });

  test('orchestrator rejects public debug dumps before generic hub proxying', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const operatorGate = orchestrator.indexOf(
      'operatorPreflightResponse(request, url, operatorAuthorized)',
    );
    const faucetPolicy = orchestrator.indexOf('enforceFaucetPolicy(', operatorGate);
    const genericApiProxy = orchestrator.indexOf("if (pathname.startsWith('/api/'))", operatorGate);
    expect(operatorGate).toBeGreaterThanOrEqual(0);
    expect(faucetPolicy).toBeGreaterThan(operatorGate);
    expect(genericApiProxy).toBeGreaterThan(faucetPolicy);
    expect(orchestrator).not.toContain("if (pathname === '/api/debug/dumps' && !operatorAuthorized)");
  });

  test('deterministic replay oracle is release-only and has its own timeout', () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const releaseGate = readFileSync(join(repoRoot, 'runtime/scripts/run-release-gate.ts'), 'utf8');

    expect(packageJson.scripts['check:src'].split('&&').map(command => command.trim()))
      .not.toContain('bun run check:determinism');
    expect(releaseGate).toContain(
      "{ name: 'deterministic replay oracle', command: 'bun run check:determinism', timeoutMs: 600_000 }",
    );
  });

  test('release gate proves replacement idempotency at both external I/O boundaries', () => {
    const releaseGate = readFileSync(join(repoRoot, 'runtime/scripts/run-release-gate.ts'), 'utf8');
    const coreE2e = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-core.ts'), 'utf8');
    for (const crashTest of [
      'runtime/__tests__/reliable-delivery-receipts.test.ts',
      'runtime/__tests__/reliable-local-catchup-real-crash.test.ts',
      'runtime/__tests__/reliable-frontier-real-crash.test.ts',
      'runtime/__tests__/j-submit-crash-recovery.test.ts',
      'runtime/__tests__/j-submit-real-rpc-crash-recovery.test.ts',
    ]) {
      expect(releaseGate).toContain(crashTest);
    }
    expect(coreE2e).toContain('H2 process replacement restores authoritative health and exact configured public books');
  });

  test('bounded soak stays separate from the release gate', () => {
    const releaseGate = readFileSync(join(repoRoot, 'runtime/scripts/run-release-gate.ts'), 'utf8');

    expect(releaseGate).not.toContain("command: 'bun run soak:quick'");
  });

  test('production topology health runs after deployment, not against an unrelated release candidate', () => {
    const releaseGate = readFileSync(join(repoRoot, 'runtime/scripts/run-release-gate.ts'), 'utf8');
    const mainnetGate = readFileSync(join(repoRoot, 'runtime/scripts/run-mainnet-preflight-gate.ts'), 'utf8');

    expect(releaseGate).not.toContain("command: 'bun run prod:health'");
    expect(mainnetGate).toContain("command: 'bun run prod:health:capped-testnet'");
  });

  test('release RPC scenarios include the lock hostage terminal-evidence flow', () => {
    const releaseGate = readFileSync(join(repoRoot, 'runtime/scripts/run-release-gate.ts'), 'utf8');
    const systemRunner = readFileSync(join(repoRoot, 'runtime/scripts/run-system-tests-parallel.ts'), 'utf8');

    expect(releaseGate).toContain(
      "{ name: 'RPC system scenarios', command: 'bun run test:system:parallel', timeoutMs: 1_200_000 }",
    );
    expect(systemRunner).toMatch(
      /const DEFAULT_SCENARIOS = \[[\s\S]*?'processbatch'[\s\S]*?'rebalance'[\s\S]*?'settle-rebalance'[\s\S]*?'lock-ahb'[\s\S]*?\];/,
    );
  });

  test('market-maker revalidates bootstrap completion after yielding to ingress', () => {
    const mmNode = readMarketMakerNodeSource();
    const armedBranchStart = mmNode.indexOf('if (completionCheckArmed && deps.canCheckCompletion()) {');
    const armedBranchEnd = mmNode.indexOf('completionCheckArmed = false;', armedBranchStart);
    const armedBranch = mmNode.slice(armedBranchStart, armedBranchEnd);
    const compactBranch = armedBranch.replace(/\s+/g, '');
    const yieldIndex = compactBranch.indexOf('awaityieldMarketMakerApi();');
    const stableReturnIndex = compactBranch.indexOf(
      'if(deps.isDepthComplete(completionHealth)&&deps.canCheckCompletion())returncompletionHealth;',
    );

    expect(armedBranchStart).toBeGreaterThanOrEqual(0);
    expect(armedBranchEnd).toBeGreaterThan(armedBranchStart);
    expect(yieldIndex).toBeGreaterThanOrEqual(0);
    expect(stableReturnIndex).toBeGreaterThan(yieldIndex);
  });

  test('market-maker READY is derived synchronously from the already committed live RuntimeReplica', () => {
    const mmNode = readMarketMakerNodeSource();
    const finalize = extractSourceBlock(
      mmNode,
      'const build = (): MarketMakerBootstrapFinalization =>',
      'const markReady = async',
    );
    expect(finalize).toContain('computeCanonicalStateHashFromEnv(deps.env)');
    expect(finalize).toContain('buildMarketMakerBootstrapEntityStateHash(deps.env)');
    expect(finalize).not.toContain('await ');
    expect(finalize).not.toContain('checkpointNodeRuntime');
  });

  test('market-maker rechecks completion immediately before publishing READY', () => {
    const mmNode = readMarketMakerNodeSource();
    const mark = extractSourceBlock(mmNode, 'const markReady = async', 'return { markReady };');
    const firstCheck = mark.indexOf('if (!deps.canCheckCompletion()) return false;');
    const yieldIndex = mark.indexOf('await yieldMarketMakerApi();', firstCheck);
    const secondCheck = mark.indexOf('if (!deps.canCheckCompletion()) return false;', yieldIndex);
    const finalize = mark.indexOf('const finalization = build();', secondCheck);
    expect(firstCheck).toBeGreaterThanOrEqual(0);
    expect(yieldIndex).toBeGreaterThan(firstCheck);
    expect(secondCheck).toBeGreaterThan(yieldIndex);
    expect(finalize).toBeGreaterThan(secondCheck);
  });

  test('canonical runtime commit persists the durable outbox before backup and dispatch', () => {
    const process = readFileSync(join(repoRoot, 'runtime/runtime/frame/process.ts'), 'utf8');
    const recoveryOutput = readFileSync(join(repoRoot, 'runtime/runtime/recovery-output.ts'), 'utf8');
    const postCommit = readFileSync(join(repoRoot, 'runtime/runtime/frame/post-commit.ts'), 'utf8');
    const durableOutbox = recoveryOutput.indexOf('env.pendingNetworkOutputs = buildPendingNetworkOutputs([');
    const save = process.indexOf('const outcome = await deps.storage.saveEnvToDB(');
    const plan = process.indexOf('const outputPlan = planRuntimeFrameOutputs(');
    const commit = process.indexOf('const commit = await commitRuntimeFrame(', plan);
    const effects = process.indexOf('await runCommittedRuntimeEffects(', commit);
    const backup = postCommit.indexOf('await runCommittedRecoveryBarrier(');
    const dispatch = postCommit.indexOf('await dispatchCommittedEntityOutputs(', backup);
    expect(durableOutbox).toBeGreaterThanOrEqual(0);
    expect(save).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(plan);
    expect(effects).toBeGreaterThan(commit);
    expect(backup).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThan(backup);
  });

  test('market-maker never disables WAL during bootstrap', () => {
    const mmNode = readMarketMakerNodeSource();
    expect(mmNode).not.toContain('MARKET_MAKER_DISABLE_STORAGE');
    expect(mmNode).not.toContain('MARKET_MAKER_PERSIST_READY_SNAPSHOT');
    expect(mmNode).not.toContain('bootstrapReadySnapshotPersisted');
    expect(mmNode).not.toContain('persist-ready-snapshot');
  });

  test('hubs never pause WAL for a final bootstrap snapshot', () => {
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    expect(hubNode).not.toContain('HUB_BOOTSTRAP_PAUSE_STORAGE');
    expect(hubNode).not.toContain('readySnapshotInFlight');
    expect(hubNode).not.toContain('persist-ready-snapshot');
    expect(hubNode).not.toContain('prepare-ready-snapshot');
  });

  test('orchestrator has no bootstrap-specific snapshot coordinator', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    expect(orchestrator).not.toContain('persistHubReadySnapshots');
    expect(orchestrator).not.toContain('HUB_READY_SNAPSHOT');
    expect(orchestrator).not.toContain('prepare-ready-snapshot');
    expect(orchestrator).not.toContain('resume-ready-snapshot');
  });

  test('orchestrator restores the durable incident journal outside resettable runtime state', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    expect(orchestrator).toContain(
      "process.env['XLN_DEBUG_INCIDENT_JOURNAL_PATH'] || `${args.dbRoot}.debug-incidents.jsonl`",
    );
    expect(orchestrator).toContain('initialDebugId: debugIncidentJournal.debugId');
    expect(orchestrator).toContain('initialIncidents: debugIncidentJournal.incidents');
    expect(orchestrator).toContain('incidentSink: incident => debugIncidentJournal.record(incident)');
    expect(orchestrator).not.toContain('relayStore.debugId = 0');
  });

  test('standalone runtime fsyncs fatal incidents before exiting', () => {
    const server = readFileSync(join(repoRoot, 'runtime/api/server/index.ts'), 'utf8');
    expect(server).toContain(
      "process.env['XLN_SERVER_DEBUG_INCIDENT_JOURNAL_PATH'] || `${dbRootPath}.debug-incidents.jsonl`",
    );
    expect(server).toContain('initialDebugId: incidentJournal.debugId');
    expect(server).toContain('initialIncidents: incidentJournal.incidents');
    expect(server).toContain('incidentSink: incident => incidentJournal.record(incident)');

    const startLoop = server.indexOf('startRuntimeLoop(env, {');
    const fatalSink = server.indexOf("serverLog.error('runtime.loop_fatal'", startLoop);
    expect(startLoop).toBeGreaterThan(0);
    expect(fatalSink).toBeGreaterThan(startLoop);
    expect(server.match(/finally \{\n\s+process\.exit\(1\);\n\s+\}/g)).toHaveLength(2);
  });

  test('standalone runtime requires an explicit production RPC or local-simulation mode', () => {
    const server = readFileSync(join(repoRoot, 'runtime/api/server/index.ts'), 'utf8');
    const packagedDaemon = readFileSync(join(repoRoot, 'packages/npm/xlnfinance/lib/process.js'), 'utf8');
    const formationPanel = readFileSync(
      join(repoRoot, 'frontend/src/lib/components/Entity/FormationPanel.svelte'),
      'utf8',
    );
    expect(server).toContain("process.env['XLN_LOCAL_SIMULATION'] === 'true'");
    expect(server).toContain('JADAPTER_MODE_REQUIRED:set_USE_ANVIL_or_XLN_LOCAL_SIMULATION');
    expect(server).toContain('JADAPTER_MODE_CONFLICT:USE_ANVIL_and_XLN_LOCAL_SIMULATION');
    expect(packagedDaemon).toContain("XLN_LOCAL_SIMULATION: 'true'");
    expect(formationPanel).toContain(
      'jurisdictions.filter(jurisdiction => !isTronChainId(Number(jurisdiction.chainId)))',
    );
    expect(existsSync(join(repoRoot, 'scripts/start-prod-hub.sh'))).toBe(false);
  });

  test('managed runtime fatal exits only after parent incident fsync acknowledgement', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const mmNode = readMarketMakerNodeSource();
    const runtimeLoop = readFileSync(join(repoRoot, 'runtime/runtime/loop-failure.ts'), 'utf8');

    expect(orchestrator.match(/stdio: \['pipe', 'pipe', 'pipe', 'ipc'\]/g)).toHaveLength(2);
    expect(orchestrator.match(/attachManagedChildFatalIpc\(/g)).toHaveLength(2);
    expect(orchestrator).toContain('persistManagedChildFatalReport(child, report)');
    expect(orchestrator).toContain('persistManagedChildFatalReport(marketMakerChild, report)');
    expect(hubNode).toContain('await reportManagedChildFatal({');
    expect(mmNode).toContain('await reportManagedChildFatal({');
    const report = runtimeLoop.indexOf('await config.onFatal({');
    const exit = runtimeLoop.indexOf('getRuntimeProcessGlobal()?.exit?.(1);', report);
    expect(report).toBeGreaterThan(0);
    expect(exit).toBeGreaterThan(report);
  });

  test('production frontend deploy builds off-host and uploads a complete artifact', () => {
    const deploy = readPlatformDeploy();
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(deploy).toContain('build_remote_frontend_archive');
    expect(deploy).toContain('ensure_committed_contract_artifacts');
    expect(deploy).toContain('CONTRACT_ARTIFACTS_NOT_COMMITTED');
    expect(deploy).toContain(
      'COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C frontend -czf "$PREBUILT_FRONTEND_ARCHIVE" build',
    );
    expect(deploy).toContain('scp "$PREBUILT_FRONTEND_ARCHIVE" "$REMOTE_HOST:$remote_frontend_archive"');
    expect(deploy).toContain("tar -xzf '$remote_frontend_archive' -C frontend");
    expect(deploy).toContain(
      'remote_cmd="$remote_cmd XLN_DEPLOY_USE_COMMITTED_CONTRACTS=1 ./scripts/deployment/deploy-platform.sh --runtime-only"',
    );
    expect(deploy).toContain('if [ "${XLN_DEPLOY_USE_COMMITTED_CONTRACTS:-0}" = "1" ]');
    expect(deploy).toContain('PRODUCTION_FRONTEND_BUILD_FORBIDDEN');
    expect(deploy).toContain('if [ "$BUILD_FRONTEND" = "1" ]; then');
    expect(deploy).not.toContain('|| [ ! -d frontend/build ]');
    expect(deploy).toContain('PRODUCTION_FRONTEND_ARTIFACT_MISSING');
    expect(deploy).toContain('DEPLOY_PUSH_REQUIRES_REMOTE');
    expect(deploy).not.toContain('remote_cmd="$remote_cmd --frontend"');
    expect(deploy).toContain('frontend artifact installed without runtime restart');
    expect(packageJson.scripts['deploy:prod:frontend']).toContain('--frontend-only');
  });

  test('production public discovery, recovery, and faucet routes are operational by default', () => {
    const runtimeCreation = readFileSync(
      join(repoRoot, 'frontend/src/lib/components/Views/RuntimeCreation.svelte'),
      'utf8',
    );
    const xlnStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/xlnStore.ts'), 'utf8');
    const deploy = readPlatformDeploy();
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const vaultStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/vaultStore.ts'), 'utf8');

    expect(runtimeCreation).toContain("url.searchParams.set('access', 'admin')");
    expect(runtimeCreation).not.toContain("url.searchParams.set('allowPartial', '1')");
    expect(xlnStore).toContain("importSource.searchParams.set('access', 'admin')");
    expect(xlnStore).not.toContain("importSource.searchParams.set('allowPartial', '1')");
    expect(deploy).toContain('location /api/recovery/');
    expect(deploy).toContain('proxy_pass http://127.0.0.1:9100;');
    expect(hubNode).toContain(
      "const AUTO_PROVISION_EXTERNAL_FAUCET = process.env['XLN_AUTO_PROVISION_EXTERNAL_FAUCET'] !== '0';",
    );
    expect(vaultStore).toContain('await fundSignerWalletViaFaucet(signerAddress);');
    expect(vaultStore).not.toContain('void fundSignerWalletViaFaucet(signerAddress);');
    expect(vaultStore).not.toContain('fundSignerWalletViaFaucet(secondaryAddress)');
  });

  test('hub drains relocated gossip before starting any network route', () => {
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const relocationStart = hubNode.indexOf('if (restoredRuntimeRouteRelocated(');
    const awaitedClear = hubNode.indexOf(
      "await clearGossip(env, { runtimeId: String(env.runtimeId || '') });",
      relocationStart,
    );
    const directRouteStart = hubNode.indexOf('const httpSurface = startHubHttpSurface(', relocationStart);
    const p2pStart = hubNode.indexOf('live.p2p = startP2P(env, {', relocationStart);

    expect(relocationStart).toBeGreaterThanOrEqual(0);
    expect(awaitedClear).toBeGreaterThan(relocationStart);
    expect(directRouteStart).toBeGreaterThan(awaitedClear);
    expect(p2pStart).toBeGreaterThan(awaitedClear);
  });

  test('production payment smoke only reads persisted receipts from a real debug runtime env', () => {
    const paymentSmoke = readFileSync(join(repoRoot, 'tests/e2e-payment-smoke.spec.ts'), 'utf8');
    const receiptHelper = readFileSync(join(repoRoot, 'tests/utils/e2e-runtime-receipts.ts'), 'utf8');

    expect(paymentSmoke).toContain("Boolean(env && typeof env === 'object' && String(env.runtimeId || '').trim())");
    expect(paymentSmoke).toContain('if (await hasActivityDebugQuery(page))');
    expect(paymentSmoke).toContain("page.getByTestId('entity-history-event').count()");
    expect(receiptHelper).toContain("throw new Error('PERSISTED_RUNTIME_ENV_UNAVAILABLE')");
    expect(receiptHelper).toContain("throw new Error('PERSISTED_RUNTIME_API_UNAVAILABLE')");
    expect(receiptHelper).not.toContain('catch {\n      return { cursor: { nextHeight }');
  });

  test('fresh browser runtimes replay EntityProvider authority from deployment', () => {
    const vaultStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/vaultStore.ts'), 'utf8');
    const freshRuntimeBootstrap = extractSourceBlock(
      vaultStore,
      '// Import the same primary jurisdiction name that hub profiles advertise.',
      "markPerf('import_j_testnet');",
    );
    const secondaryJurisdictionBootstrap = extractSourceBlock(
      vaultStore,
      'for (const secondary of secondaryJurisdictionImports)',
      '// === MVP: Create entity ===',
    );

    expect(freshRuntimeBootstrap).toContain('startAtCurrentBlock: false');
    expect(secondaryJurisdictionBootstrap).toContain('startAtCurrentBlock: false');
  });

  test('wallet entity configs commit the imported jurisdiction block time', () => {
    const vaultStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/vaultStore.ts'), 'utf8');
    const vaultRecovery = readFileSync(join(repoRoot, 'frontend/src/lib/stores/vault-recovery.ts'), 'utf8');
    const signerConfig = extractSourceBlock(
      vaultRecovery,
      'export const buildSignerEntityConfig = (',
      'export function getSignerDerivationIndex',
    );
    const primaryEntityCreation = extractSourceBlock(
      vaultStore,
      '// === MVP: Create entity ===',
      '// CRITICAL: Register the canonical signer key',
    );

    expect(signerConfig).toContain('const blockTimeMs = Number(jReplica.blockTimeMs);');
    expect(signerConfig).toContain('blockTimeMs,');
    expect(primaryEntityCreation).toContain('const entityConfig = buildSignerEntityConfig(');
    expect(primaryEntityCreation).not.toContain('const entityConfig = {');
  });

  test('quick and smoke gates rebuild after their own artifact cleanup', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['test:all:quick']).not.toContain('--skip-build');
    expect(packageJson.scripts['test:all:smoke']).not.toContain('--skip-build');
  });

  test('isolated frontend builds generate llms context in their requested static directory', () => {
    const generator = readFileSync(join(repoRoot, 'scripts/debug/gpt.cjs'), 'utf8');
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');

    expect(generator).toContain("const outputDir = path.resolve(frontendDir, process.env.XLN_STATIC_DIR || 'static');");
    expect(generator).not.toContain("const outputDir = path.join(__dirname, '../../frontend/static/');");
    expect(runner).toContain('cpSync(canonicalSvelteKitOutDir, artifacts.svelteKitOutDir, { recursive: true });');
    const isolatedBuild = extractSourceBlock(
      runner,
      'const prepareIsolatedE2EBuild = async',
      'const forensicEndpoints = [',
    );
    expect(isolatedBuild).not.toContain('XLN_SVELTE_KIT_OUT_DIR: relative(frontendRoot, artifacts.svelteKitOutDir)');
  });

  test('start-server exposes the secondary Tron RPC to the orchestrator and children', () => {
    const script = readFileSync(join(repoRoot, 'scripts/start-server.sh'), 'utf8');
    expect(script).toContain('RPC2_PORT="${ANVIL2_PORT:-$(xln_rpc2_port)}"');
    expect(script).toContain('export ANVIL_RPC2="${ANVIL_RPC2:-http://127.0.0.1:${RPC2_PORT}}"');
    expect(script).toContain('export RPC_TRON="${RPC_TRON:-$ANVIL_RPC2}"');
    expect(script).toContain('export RELAY_URL=${RELAY_URL:-$INTERNAL_RELAY_URL}');
    expect(script).toContain('export XLN_PUBLIC_FAUCET=${XLN_PUBLIC_FAUCET:-1}');
    expect(script).toContain('export XLN_FAUCET_MAX_AMOUNT=${XLN_FAUCET_MAX_AMOUNT:-100}');
    expect(script).toContain('export XLN_FAUCET_MAX_GAS_AMOUNT=${XLN_FAUCET_MAX_GAS_AMOUNT:-0.1}');
    expect(script).toContain('--relay-url "$RELAY_URL"');
    expect(script).toContain('--rpc2-url "$ANVIL_RPC2"');
    expect(script).not.toContain('XLN_RUNTIME_EXIT_ON_FATAL');
    expect(script).toContain('export XLN_STORAGE_WRITE_TIMEOUT_MS=${XLN_STORAGE_WRITE_TIMEOUT_MS:-60000}');
    expect(script).toContain('export XLN_SNAPSHOT_INTERVAL_FRAMES=${XLN_SNAPSHOT_INTERVAL_FRAMES:-1024}');
    expect(script).not.toContain('HUB_BOOTSTRAP_PAUSE_STORAGE');
    expect(script).not.toContain('HUB_READY_SNAPSHOT');
    expect(script).toContain(
      'export XLN_MESH_BOOTSTRAP_STALL_TIMEOUT_MS=${XLN_MESH_BOOTSTRAP_STALL_TIMEOUT_MS:-60000}',
    );
    expect(script).toContain(
      'export XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS=${XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS:-600000}',
    );
    expect(script).toContain('export XLN_HUB_BASELINE_TIMEOUT_MS=${XLN_HUB_BASELINE_TIMEOUT_MS:-600000}');
    expect(script).toContain('export MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS=${MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS:-600000}');
    expect(script).toContain(
      'export MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS=${MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS:-60000}',
    );
    expect(script).toContain('export XLN_MARKET_MAKER_READY_TIMEOUT_MS=${XLN_MARKET_MAKER_READY_TIMEOUT_MS:-600000}');
    expect(script).not.toContain('MARKET_MAKER_PERSIST_READY_SNAPSHOT');
    expect(script).toContain(
      'export XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME=${XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME:-0}',
    );
    expect(script).toContain('export XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME=${XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME:-0}');
    expect(script).toContain(
      'export MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME=${MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME:-0}',
    );
    expect(script).toContain(
      'export MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME=${MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME:-0}',
    );
    expect(script).toContain(
      'export XLN_CUSTODY_PUBLIC_RPC_URL=${XLN_CUSTODY_PUBLIC_RPC_URL:-wss://custody.xln.finance/rpc}',
    );
    expect(script).not.toContain('MARKET_MAKER_MAX_LEVELS_PER_PAIR');
    expect(script).not.toContain('MARKET_MAKER_CROSS_LEVELS_PER_PAIR');
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
      'export MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK=${MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK:-135}',
    );

    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const marketMakerPoller = readFileSync(join(repoRoot, 'runtime/orchestrator/market-maker-child-poll.ts'), 'utf8');
    const marketMakerAggregation = readFileSync(
      join(repoRoot, 'runtime/orchestrator/market-maker-aggregated-health.ts'),
      'utf8',
    );
    const orchestratorConfig = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator-config.ts'), 'utf8');
    const runtimeEntityRouting = readFileSync(join(repoRoot, 'runtime/runtime/entity-routing.ts'), 'utf8');
    const runtimeLoopSource = readFileSync(join(repoRoot, 'runtime/runtime/loop.ts'), 'utf8');
    const standaloneServer = readFileSync(join(repoRoot, 'runtime/api/server/index.ts'), 'utf8');
    const custodyBootstrap = readFileSync(join(repoRoot, 'runtime/orchestrator/custody-bootstrap.ts'), 'utf8');
    const startCustodyDev = readFileSync(join(repoRoot, 'runtime/scripts/start-custody-dev.ts'), 'utf8');
    const cli = readFileSync(join(repoRoot, 'runtime/api/server/cli.ts'), 'utf8');
    expect(orchestratorConfig).toContain(
      "relayUrl: normalizeWsUrl(getArg('--relay-url', process.env['RELAY_URL'] || '')",
    );
    expect(orchestratorConfig).toContain('const RPC_PROXY_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8] as const;');
    expect(orchestratorConfig).toContain("readPositiveIntegerEnv('XLN_CHILD_HEALTH_TIMEOUT_MS', 30_000)");
    expect(orchestrator).toContain('const relayUrl = args.relayUrl;');
    expect(orchestrator).not.toContain('XLN_MARKET_MAKER_INFO_TIMEOUT_MS');
    expect(orchestrator).toContain("process.env['XLN_CHILD_SHUTDOWN_QUIESCE_MS'] || '5000'");
    expect(orchestrator).toContain('const CHILD_RESET_QUIESCE_TIMEOUT_MS = 45_000;');
    expect(orchestrator).toContain("meshLog.warn('child.stop_timeout_sigkill'");
    expect(orchestrator).toContain("meshLog.error('child.unexpected_exit'");
    expect(orchestrator).toContain("meshLog.error('child.unexpected_exit.stop_failed'");
    expect(orchestrator).toContain("meshLog.error('custody.bootstrap_failed'");
    expect(orchestrator).toContain("meshLog.warn('reset.signal_during_reset'");
    expect(orchestrator).toContain("meshLog.error('reset.initial_failed'");
    expect(orchestrator).toContain('persistOrchestratorFailure(error)');
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
    expect(orchestrator).toContain('const pollMarketMakerHealth = async (): Promise<void> => {');
    expect(orchestrator).toContain('observeManagedRuntimeHalt(marketMakerChild, marketMakerChild.lastHealth);');
    expect(marketMakerPoller).toContain('let healthPollInFlight: Promise<void> | null = null;');
    expect(marketMakerPoller).toContain('if (healthPollInFlight) return healthPollInFlight;');
    expect(marketMakerPoller).toContain(
      'fetchJson<MarketMakerHealthPayload>(`${apiBase()}/api/health`, healthTimeoutMs)',
    );
    expect(orchestrator).not.toContain('const [health, info] = await Promise.all([');
    expect(marketMakerPoller).not.toContain('/api/info');
    expect(orchestrator).not.toContain('pollMarketMakerInfo');
    expect(marketMakerPoller).toContain('child.lastInfo = nextInfo;');
    expect(marketMakerPoller).toContain('if (!isCurrentProc(proc)) return;');
    expect(orchestrator).toContain('normalizeMarketMakerHealthPayload');
    expect(marketMakerPoller).toContain('type RawMarketMakerHealthPayload');
    expect(marketMakerPoller).toContain(
      'const health = await fetchJson<MarketMakerHealthPayload | RawMarketMakerHealthPayload>',
    );
    expect(marketMakerPoller).toContain('return normalizeMarketMakerHealthPayload(health);');
    expect(orchestrator).toContain(
      'const marketMakerHealth = normalizeMarketMakerHealthPayload(options.marketMakerHealthOverride ?? marketMakerChild.lastHealth);',
    );
    expect(orchestrator).toContain('const aggregatedMarketMakerHealth = buildAggregatedMarketMakerHealth({');
    expect(marketMakerAggregation).toContain('const childReady = marketMakerHealth?.marketMaker?.ok === true;');
    expect(marketMakerAggregation).toContain('if (!marketMakerActive) {');
    expect(marketMakerAggregation).toContain('const ok = !mmEnabled || failure === null;');
    expect(standaloneServer).toContain("import { selectPredeployedJurisdiction } from './predeployed-jurisdiction';");
    expect(standaloneServer).toContain(
      "const predeployedJurisdictionKey = String(process.env['XLN_PREDEPLOYED_JURISDICTION_KEY'] || '').trim();",
    );
    expect(standaloneServer).toContain('trustedJurisdictionRpcBindings: resolveTrustedServerRestoreRpcBindings(),');
    expect(standaloneServer).toContain('const jurisdictionRef = getJurisdictionIdentityRef(selected);');
    expect(standaloneServer).toContain('selectPredeployedJurisdiction(jurisdictions, anvilRpc, jurisdictionKey)');
    expect(standaloneServer).toContain(
      'entityProviderDeploymentBlock: Number(predeployedConfig.entityProviderDeploymentBlock)',
    );
    expect(standaloneServer).toContain('watcherConfirmationDepth: requireWatcherConfirmationDepth(adapter)');
    expect(standaloneServer).toContain("serverLog.error('anvil.predeployed.load_failed'");
    expect(standaloneServer).toContain('throw error;');
    expect(standaloneServer).toContain("throw new Error('PREDEPLOYED_JURISDICTION_CONFIG_MISSING')");
    expect(standaloneServer).toContain('throw new Error(`PREDEPLOYED_CONTRACT_CODE_MISSING:');
    expect(standaloneServer).toContain('throw new Error(`PREDEPLOYED_STACK_DEPLOY_FORBIDDEN:${reason}`)');
    expect(standaloneServer).toContain('await globalJAdapter?.close();');
    expect(custodyBootstrap).toContain('startupSignerSeed: options.seed');
    expect(custodyBootstrap).toContain('startupSignerLabel: options.signerLabel');
    expect(standaloneServer).toContain('const STARTUP_SIGNER = (() => {');
    expect(standaloneServer).toContain('localSigners: [');
    expect(standaloneServer).toContain('...(STARTUP_SIGNER ? [STARTUP_SIGNER] : [])');
    expect(standaloneServer).toContain('...(LOCAL_RUNTIME_OWNER ? [{ label: LOCAL_RUNTIME_OWNER.label }] : [])');
    expect(standaloneServer).not.toContain('registerSignerKey(');
    expect(standaloneServer).not.toContain('globalJAdapter?.close().catch(() => undefined)');
    expect(standaloneServer).toContain('updateJurisdictionsJson(');
    expect(standaloneServer).toContain('globalJAdapter.entityProviderDeploymentBlock,');
    expect(standaloneServer).not.toContain('entries.find(entry => samePredeployedRpc(entry.rpc, rpcUrl))');
    expect(standaloneServer).not.toContain('arrakisConfig');
    const waitForMarketMakerReady = orchestrator.slice(
      orchestrator.indexOf('const waitForMarketMakerReady = async (): Promise<void> => {'),
    );
    const waitForMarketMakerReadyEnd = waitForMarketMakerReady.indexOf(
      'const waitForHubSelfReady = async (child: HubChild): Promise<void> => {',
    );
    expect(waitForMarketMakerReadyEnd).toBeGreaterThan(0);
    const waitForMarketMakerReadyBody = waitForMarketMakerReady.slice(0, waitForMarketMakerReadyEnd);
    expect(waitForMarketMakerReadyBody).toContain('const internalHealth = computeAggregatedHealth();');
    expect(waitForMarketMakerReadyBody).toContain('await enrichMarketMakerFromHubSnapshots(internalHealth)');
    expect(waitForMarketMakerReadyBody).not.toContain('buildAggregatedHealthResponse()');
    expect(waitForMarketMakerReadyBody).toContain('while (true)');
    expect(waitForMarketMakerReadyBody).not.toContain('const deadline =');
    const waitForHubSelfReady = orchestrator.slice(
      orchestrator.indexOf('const waitForHubSelfReady = async (child: HubChild): Promise<void> => {'),
      orchestrator.indexOf('const waitForShardJurisdictions = async (child: HubChild): Promise<void> => {'),
    );
    expect(waitForHubSelfReady).toContain('idleMs >= HUB_BASELINE_TIMEOUT_MS');
    expect(waitForHubSelfReady).not.toContain('idleMs >= HUB_BASELINE_STALL_TIMEOUT_MS');
    expect(
      waitForMarketMakerReady.indexOf(
        'if (marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null)',
      ),
    ).toBeLessThan(waitForMarketMakerReady.indexOf('health.marketMaker.ok'));
    expect(marketMakerPoller).not.toContain('/api/info');
    expect(marketMakerPoller).toContain('const applyHealth = (');
    expect(marketMakerPoller).toContain('child.lastHealth = sanitizedHealth;');
    expect(marketMakerPoller).toContain('if (sanitizedHealth.startupPhase !== undefined) {');
    expect(marketMakerPoller).toContain('if (health) applyHealth(health, proc);');
    const lastStartupPhaseUpdate = marketMakerPoller.slice(
      marketMakerPoller.indexOf('child.lastStartupPhase = String('),
    );
    expect(lastStartupPhaseUpdate.indexOf('child.lastInfo?.startupPhase ||')).toBeLessThan(
      lastStartupPhaseUpdate.indexOf('child.lastHealth?.startupPhase ||'),
    );
    expect(marketMakerAggregation).toContain('MARKET_MAKER_HUB_DEPTH_NOT_READY');
    expect(marketMakerAggregation).toContain('depthReady: route.depthReady === true');
    expect(marketMakerAggregation).toContain('expectedOffers: Number(pair.expectedOffers || 0)');
    const snapshotEnrichment = readFileSync(
      join(repoRoot, 'runtime/orchestrator/market-maker-public-health.ts'),
      'utf8',
    );
    expect(snapshotEnrichment).toContain('const snapshotDepthExact = isExactMarketSnapshotOrderDepth');
    expect(snapshotEnrichment).toContain('const crossExpectedDepth = buildCrossExpectedDepth');
    expect(snapshotEnrichment).toContain('expectedBidOffers + expectedAskOffers === expectedOffers');
    expect(orchestrator).toContain('syncCanonicalJurisdictionsFromShard(jurisdictionsConfig)');
    expect(orchestrator).toContain(
      'const primaryJurisdiction = resolvePrimaryHubJurisdictionFallback(jurisdictionsConfig);',
    );
    expect(orchestrator).toContain('jurisdictionId: primaryJurisdiction.key');
    expect(orchestrator).not.toContain("jurisdictionId: 'arrakis'");
    expect(startCustodyDev).toContain('const custodyJurisdictionId = await resolveCustodyJurisdictionId();');
    expect(startCustodyDev).toContain('jurisdictionId: custodyJurisdictionId');
    expect(startCustodyDev).toContain('CUSTODY_JURISDICTION_ID: custodyJurisdictionId');
    expect(startCustodyDev).not.toContain("jurisdictionId: 'arrakis'");
    expect(startCustodyDev).not.toContain("CUSTODY_JURISDICTION_ID: 'arrakis'");
    expect(cli).toContain("const REMOTE_RPC = process.env['XLN_CLI_REMOTE_RPC'] || 'https://xln.finance/rpc';");
    expect(cli).not.toContain('/rpc/arrakis');
    expect(readFileSync(join(repoRoot, 'runtime/orchestrator/jurisdictions.ts'), 'utf8')).toContain(
      'const seedPath = existsSync(canonicalPath) ? canonicalPath : resolveRepoJurisdictionsJsonPath();',
    );
    expect(orchestrator).toContain('const buildSecondaryRpcArgs = (): string[] => {');
    expect(orchestrator).toContain('const buildRpcChildEnv = (): Record<string, string> => {');
    expect(orchestrator).toContain('const rpcProxyIndex = resolveRpcProxyIndex(pathname);');
    expect(orchestrator).toContain(
      "return await proxyRpc(request, args.rpcUrls[rpcProxyIndex] || '', operatorAuthorized);",
    );
    expect(orchestrator).not.toContain('XLN_RUNTIME_EXIT_ON_FATAL');
    expect(orchestrator).toContain(
      "XLN_STORAGE_WRITE_TIMEOUT_MS: process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] ?? '60000'",
    );
    expect(orchestrator).not.toContain('HUB_BOOTSTRAP_PAUSE_STORAGE');
    expect(orchestrator).not.toContain('HUB_READY_SNAPSHOT');
    expect(orchestrator).toContain(
      "XLN_LOG_LEVEL: process.env['XLN_HUB_LOG_LEVEL'] ?? process.env['XLN_LOG_LEVEL'] ?? 'warn'",
    );
    expect(runtimeEntityRouting).not.toContain('deps.startRuntimeLoop(env);');
    expect(runtimeEntityRouting).not.toContain('processRuntime(env)');
    expect(runtimeEntityRouting).not.toContain('queueMicrotask(() =>');
    const runtimeLifecycleSource = readFileSync(join(repoRoot, 'runtime/runtime/loop-failure.ts'), 'utf8');
    expect(runtimeLifecycleSource).toContain('getRuntimeProcessGlobal()?.exit?.(1);');
    expect(runtimeLoopSource).not.toContain('shouldExitOnRuntimeFatal');
    expect(orchestrator).toContain("XLN_STORAGE_SYNC_WRITES: process.env['XLN_STORAGE_SYNC_WRITES'] ?? '1'");
    expect(orchestrator).not.toContain('XLN_MARKET_MAKER_DISABLE_STORAGE');
    expect(orchestrator).toContain(
      "XLN_DISABLE_RUNTIME_RESTORE: process.env['XLN_MARKET_MAKER_DISABLE_RESTORE'] ?? process.env['XLN_DISABLE_RUNTIME_RESTORE'] ?? '0'",
    );
    expect(orchestrator).not.toContain('XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT');
    expect(orchestrator).toContain(
      "XLN_LOG_LEVEL: process.env['XLN_MARKET_MAKER_LOG_LEVEL'] ?? process.env['XLN_LOG_LEVEL'] ?? 'warn'",
    );
    expect(orchestrator).toContain('const getMarketMakerIdentities = (): MarketMakerSupportPeerIdentity[] => {');
    expect(orchestrator).toContain(
      'deriveMarketMakerEntityId(signerId, toMarketMakerEntityJurisdictionConfig(jurisdiction))',
    );
    expect(orchestrator).toContain('blockTimeMs: requireJurisdictionBlockTimeMs(jurisdiction)');
    expect(orchestrator).toContain('resolveSecondaryJurisdictions(primary.rpc)');
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
    const hubVisibleProfiles = readFileSync(
      join(repoRoot, 'runtime/orchestrator/hub-visible-profiles.ts'),
      'utf8',
    );
    const bootstrapHub = readFileSync(join(repoRoot, 'scripts/bootstrap-hub.ts'), 'utf8');
    const serverJurisdictions = readFileSync(join(repoRoot, 'runtime/api/server/jurisdictions.ts'), 'utf8');
    const mmNode = readMarketMakerNodeSource();
    const runtimeTxHandlers = readFileSync(join(repoRoot, 'runtime/runtime/tx-handlers.ts'), 'utf8');
    const jurisdictionImport = readFileSync(join(repoRoot, 'runtime/runtime/jurisdiction-import.ts'), 'utf8');
    const jadapterTypes = readFileSync(join(repoRoot, 'runtime/jurisdiction/adapter/types.ts'), 'utf8');
    const rpcAdapter = readRpcAdapterSource();
    expect(hubNode).toContain("nodeLog.error('jurisdiction_contracts.code_missing'");
    expect(bootstrapHub).toContain(
      'const blockTimeMs = requireJurisdictionBlockTimeMs({ name, blockTimeMs: jr.blockTimeMs });',
    );
    expect(bootstrapHub).toContain('blockTimeMs,');
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
    expect(hubNode).toContain('const match = raw.match(/^\\/(?:api\\/)?rpc([2-8])?(?:\\?.*)?$/);');
    expect(hubNode).toContain('visibleDirectSupportPeers');
    expect(hubNode).toContain("jurisdictionName: normalizeJurisdictionDisplayName(entry['jurisdictionName'] || '')");
    expect(hubNode).toContain('SUPPORT_PEER_IDENTITIES_JSON_INVALID:malformed JSON');
    expect(hubNode).not.toContain('} catch {\n    return [];\n  }\n};\n\nconst resolvedArgs');
    expect(hubNode).not.toContain("normalized === 'arrakis'");
    expect(hubNode).not.toContain("normalized === 'wakanda'");
    expect(hubNode).not.toContain('PRIMARY_TESTNET_JURISDICTION_NAME');
    const meshJurisdictions = readFileSync(join(repoRoot, 'runtime/orchestrator/mesh-jurisdictions.ts'), 'utf8');
    expect(meshJurisdictions).toContain(
      'const exactMatch = entries.find((entry) => sameMeshRpc(entry.rpc, requestedRpc));',
    );
    expect(meshJurisdictions).toContain('entries.find(isPrimaryJurisdiction)');
    expect(meshJurisdictions).toContain('export const resolveMeshJurisdictionRpcBindings = (');
    expect(meshJurisdictions).not.toContain("map['arrakis']");
    for (const nodeSource of [hubNode, mmNode]) {
      expect(nodeSource).toContain('trustedJurisdictionRpcBindings: resolveMeshJurisdictionRpcBindings(');
      expect(nodeSource).toContain('resolvedArgs.rpcUrl,');
      expect(nodeSource).toContain('resolveLocalApiUrl,');
    }
    expect(serverJurisdictions).toContain('const normalizeJurisdictionDisplayName = (value: unknown): string =>');
    expect(serverJurisdictions).not.toContain("normalized === 'arrakis'");
    expect(serverJurisdictions).not.toContain("normalized === 'wakanda'");
    expect(serverJurisdictions).not.toContain("name: 'Testnet'");
    expect(serverJurisdictions).not.toContain('PRIMARY_TESTNET_JURISDICTION_NAME');
    expect(serverJurisdictions).toContain(
      'selectWritableJurisdictionKey(jurisdictions, undefined, [rpcUrl, publicRpc])',
    );
    expect(serverJurisdictions).not.toContain("jurisdictions['arrakis']");
    expect(serverJurisdictions).not.toContain('arrakisDisplayName');
    expect(serverJurisdictions).not.toContain('existingArrakis');
    expect(serverJurisdictions).toContain('name: displayName');
    expect(standaloneServer).toContain("const jurisdictionName = updatedRuntimeJurisdiction?.key || 'primary';");
    expect(standaloneServer).toContain('env.state.jReplicas.set(registration.name, {');
    expect(standaloneServer).toContain('name: registration.name,');
    expect(standaloneServer).not.toContain('name: jDisplayName,');
    expect(standaloneServer).not.toContain("const jName = 'arrakis';");
    expect(hubNode).toContain('selectWritableJurisdictionKey(jurisdictions, undefined, [rpcUrl, publicRpcUrl])');
    expect(hubNode).not.toContain("targetKey = 'arrakis'");
    expect(hubNode).toContain('const jurisdictionRef = getJurisdictionIdentityRef({ chainId, depositoryAddress });');
    expect(hubNode).toContain('!identity.jurisdictionRef');
    expect(mmNode).toContain('.filter(profile => profile.jurisdictionRef.length > 0)');
    expect(hubVisibleProfiles).toContain(
      'getJurisdictionIdentityRef(profile.metadata?.jurisdiction) === targetRef',
    );
    expect(hubNode).toContain('const peerJurisdiction = profile.metadata?.jurisdiction || identity;');
    expect(hubNode).toContain('if (!sameJurisdictionRef(peerJurisdiction, jurisdiction)) return null;');
    expect(hubNode).not.toContain('sameJurisdictionIdentityOrNameOnlyFallback');
    expect(hubNode).toContain('...hubBootstraps.map(owner =>\n      planSupportPeerInputs(');
    expect(hubNode).not.toContain('if (!runtimeId || !openRuntimeIds.has(runtimeId)) return null;');
    expect(hubNode).toContain('entityAdapter = getEntityJAdapter(env, entityId);');
    expect(hubNode).toContain("if (!message.startsWith('ENTITY_JURISDICTION_MISSING')) throw error;");
    expect(hubNode).toContain('const activeAdapter = getActiveJAdapter(env);');
    expect(hubNode).not.toContain("return requireJAdapterForEntity(env, entityId, 'DEBUG_RESERVE');");
    expect(hubNode).toContain('const configureHubRuntimeLogging = (env: RuntimeReplica): void => {');
    expect(hubNode).toContain("if (readBooleanEnv('XLN_HUB_VERBOSE_RUNTIME_LOGS', false)) return;");
    expect(hubNode).toContain('env.quietRuntimeLogs = true;');
    expect(hubNode).toContain('configureHubRuntimeLogging(env);');
    expect(hubNode).toContain("const LOG_HUB_ADMIN_URL = readBooleanEnv('XLN_HUB_ADMIN_URL_LOG', false);");
    const adminUrlLog = hubNode.slice(hubNode.indexOf('if (LOG_HUB_ADMIN_URL) {'));
    expect(adminUrlLog).toContain("nodeLog.info('admin_url.ready'");
    expect(adminUrlLog).toContain("nodeLog.warn('admin_url.unavailable'");
    expect(adminUrlLog).not.toContain('[MESH-HUB] INSPECT_URL');
    expect(hubNode.indexOf('if (LOG_HUB_ADMIN_URL) {')).toBeLessThan(hubNode.indexOf("nodeLog.info('admin_url.ready'"));
    expect(hubNode).not.toContain('persistRestoredEnvToDB');
    expect(hubNode).not.toContain('configureHubBootstrapStorage');
    expect(hubNode).not.toContain('persistencePaused = true');
    expect(hubNode).not.toContain('ready-snapshot');
    expect(hubNode).toContain('startRuntimeLoop(env, {');
    expect(hubNode).toContain('const buildLocalHubSignerLabels = (): string[] => {');
    expect(hubNode).toContain('localSigners: localSignerLabels.map(label => ({ label }))');
    expect(hubNode).not.toContain('prewarmSignerLabels');
    expect(hubNode).toContain(
      'const hasLiveJAdapterForJurisdiction = (env: RuntimeReplica, jurisdictionName: string): boolean =>',
    );
    expect(hubNode).toContain('if (!hasLiveJAdapterForJurisdiction(env, name)) {');
    expect(orchestrator).not.toContain('creditAmount: MARKET_MAKER_CREDIT_AMOUNT.toString()');
    expect(mmNode).toContain('const readRpcUrls = (): Record<number, string> => {');
    expect(mmNode).toContain('const match = raw.match(/^\\/(?:api\\/)?rpc([2-8])?(?:\\?.*)?$/);');
    expect(mmNode).toContain('buildMarketMakerConsensusConfig(signerId, entityJurisdiction)');
    expect(mmNode).toContain('deriveMarketMakerEntityId(signerId, entityJurisdiction)');
    expect(mmNode).toContain('blockTimeMs: requireJurisdictionBlockTimeMs(jurisdiction)');
    expect(mmNode).toContain('isCanonicalAccountOpener(mmEntityId, hubEntityId)');
    expect(mmNode).not.toContain('dev_bootstrap.storage_disabled');
    expect(mmNode).toContain('const configureMarketMakerRuntimeLogging = (env: RuntimeReplica): void => {');
    expect(mmNode).toContain("if (readBooleanEnv('XLN_MARKET_MAKER_VERBOSE_RUNTIME_LOGS', false)) return;");
    expect(mmNode).toContain('env.quietRuntimeLogs = true;');
    expect(mmNode).toContain('const buildLocalMarketMakerSignerLabels = (): string[] => {');
    expect(mmNode).toContain('localSigners: localSignerLabels.map(label => ({ label }))');
    expect(mmNode).not.toContain('prewarmSignerLabels');
    expect(mmNode).toContain(
      'const hasLiveJurisdictionAdapter = (env: RuntimeReplica, jurisdiction: JurisdictionConfig): boolean => {',
    );
    expect(mmNode).toContain('const targetRef = getJurisdictionIdentityRef(target);');
    expect(mmNode).toContain('const replicaRef = getJurisdictionIdentityRef(replica);');
    expect(mmNode).not.toContain('sameJurisdictionIdentityOrNameOnlyFallback');
    expect(mmNode).toContain(
      'if (hasJurisdictionReplica(env, jurisdiction) && hasLiveJurisdictionAdapter(env, jurisdiction)) return;',
    );
    const runtimeSource = readFileSync(join(repoRoot, 'runtime/runtime/composition.ts'), 'utf8');
    const frameDispatchSource = readFileSync(join(repoRoot, 'runtime/runtime/frame/dispatch.ts'), 'utf8');
    const framePreparationSource = readFileSync(join(repoRoot, 'runtime/runtime/frame/prepare.ts'), 'utf8');
    const runtimeLoopWorkSource = readFileSync(join(repoRoot, 'runtime/runtime/loop-work.ts'), 'utf8');
    const runtimeLoopLifecycleSource = readFileSync(join(repoRoot, 'runtime/runtime/loop-lifecycle.ts'), 'utf8');
    expect(runtimeLoopLifecycleSource).toContain(
      'const tickDelayMs = Math.max(0, Math.floor(Number(config?.tickDelayMs ?? 0)));',
    );
    expect(runtimeLoopLifecycleSource).toContain('maxEntityInputsPerFrame?: number');
    expect(runtimeLoopLifecycleSource).toContain('maxEntityTxsPerFrame?: number');
    expect(runtimeLoopWorkSource).toContain('export const applyEntityInputFrameCap =');
    expect(runtimeLoopWorkSource).toContain('export const applyEntityTxFrameCap =');
    expect(runtimeLoopWorkSource).toContain('mempool.entityInputs = [...deferredInputs, ...mempool.entityInputs];');
    expect(runtimeSource).not.toContain('prepareCrossJurisdictionEntityInputs');
    const entityAdmissionSource = readFileSync(join(repoRoot, 'runtime/entity/consensus/input-admission.ts'), 'utf8');
    expect(entityAdmissionSource).toContain('appendDefaultProposerCrossJMaterializations');
    expect(
      framePreparationSource.indexOf('input.entityInputs = await prepareHtlcPaymentEntityInputs('),
    ).toBeGreaterThan(framePreparationSource.lastIndexOf('deps.applyEntityInputFrameCap('));
    expect(frameDispatchSource).toContain('if (plan.remoteOutputs.length > 0 && env.quietRuntimeLogs !== true)');
    expect(runtimeSource).not.toContain('void config;');
    expect(runtimeLoopLifecycleSource).toContain('else if (tickDelayMs > 0)');
    expect(mmNode).toContain("MARKET_MAKER_RUNTIME_TICK_DELAY_MS'] || '0'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '0'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '0'");
    expect(mmNode).toContain('maxEntityInputsPerFrame: MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME');
    expect(mmNode).toContain('maxEntityTxsPerFrame: MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME');
    expect(hubNode).toContain("process.env['XLN_RUNTIME_TICK_DELAY_MS'] || '0'");
    expect(hubNode).toContain("process.env['XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '0'");
    expect(hubNode).toContain("process.env['XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '0'");
    expect(hubNode).toContain('maxEntityInputsPerFrame: HUB_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME');
    expect(hubNode).toContain('maxEntityTxsPerFrame: HUB_MAX_ENTITY_TXS_PER_RUNTIME_FRAME');
    expect(mmNode).toContain('const pushMarketMakerEntityTx = (');
    expect(mmNode).toContain('const entityInputsByEntitySigner = new Map<string, EntityInput>();');
    expect(mmNode).toContain('export const waitForJurisdictionAdapter = async (');
    expect(mmNode).toContain('JURISDICTION_ADAPTER_AMBIGUOUS');
    expect(mmNode).toContain('JURISDICTION_ADAPTER_NOT_READY name=${jurisdiction.name}');
    expect(orchestratorConfig).toContain("readPositiveIntegerEnv('MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS', 1_500_000)");
    expect(orchestratorConfig).toContain('Math.max(MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS, STARTUP_TIMEOUT_MS)');
    expect(mmNode).toContain("import { MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS } from './orchestrator-config';");
    expect(orchestratorConfig).toContain("readPositiveIntegerEnv('MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS', 60_000)");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '1'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_START_DELAY_MS'] || '0'");
    expect(mmNode).toContain("MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK'] || '1000'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK'] || '1000'");
    expect(mmNode).toContain('const MARKET_MAKER_BOOTSTRAP_DEFAULT_OFFERS_PER_ACCOUNT_PER_TICK = 1000;');
    expect(mmNode).toContain('const MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_OFFERS_PER_TICK = 1000;');
    expect(mmNode).toContain('String(MARKET_MAKER_BOOTSTRAP_DEFAULT_OFFERS_PER_ACCOUNT_PER_TICK)');
    expect(mmNode).toContain('String(MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_OFFERS_PER_TICK)');
    expect(mmNode).toContain('const MARKET_MAKER_BOOTSTRAP_DEFAULT_CROSS_OFFERS_PER_ACCOUNT_PER_TICK = 45;');
    expect(mmNode).toContain('const MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_CROSS_OFFERS_PER_TICK = 135;');
    expect(mmNode).not.toContain('const selectedPairs = new Set<string>();');
    expect(mmNode).toContain('for (const spec of candidates.slice(0, allowedNewOffers)) {');
    expect(mmNode).toContain('String(MARKET_MAKER_BOOTSTRAP_DEFAULT_CROSS_OFFERS_PER_ACCOUNT_PER_TICK)');
    expect(mmNode).toContain('String(MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_CROSS_OFFERS_PER_TICK)');
    expect(mmNode).toContain('const MARKET_MAKER_LEVELS_PER_SIDE = 10;');
    expect(mmNode).toContain("MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE'] || '1000'");
    expect(mmNode).toContain('pairs.slice(0, MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE)');
    expect(mmNode).not.toContain("MARKET_MAKER_MAX_LEVELS_PER_PAIR']");
    expect(mmNode).not.toContain("MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK'] || '6'");
    expect(mmNode).not.toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] || '6'");
    expect(mmNode).not.toContain("MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] || '36'");
    expect(mmNode).toContain("role: 'source-mm-hub' | 'target-mm-hub';");
    expect(mmNode).toContain('const describeMarketMakerAccountBlocker = (');
    expect(mmNode).toContain(
      "reason: 'missing-account' | 'inactive-account' | 'height-zero' | 'pending-frame' | 'mempool';",
    );
    expect(mmNode).toContain("crossOverride?: MarketMakerHealth['cross'];");
    expect(mmNode).toContain('const createMarketMakerHealthController = (deps: MarketMakerHealthControllerDeps) => {');
    expect(mmNode).toContain('if (health) currentHealth = health;');
    expect(mmNode.match(/startAtCurrentBlock: false/g)).toHaveLength(2);
    expect(runtimeTxHandlers).toContain('applyImportJurisdictionIntent(env, runtimeTx);');
    expect(jurisdictionImport).toContain('const resolveInitialBlockNumber = async (');
    expect(jurisdictionImport).toContain('IMPORT_J_CURRENT_BLOCK_UNAVAILABLE');
    expect(jurisdictionImport).toContain('IMPORT_J_CURRENT_BLOCK_INVALID');
    expect(jurisdictionImport).toContain('blockNumber: (await resolveInitialBlockNumber(adapter, request)).toString()');
    expect(jadapterTypes).toContain('getCurrentBlockNumber?(): Promise<number>;');
    expect(jadapterTypes).toContain('getFinalityDepth?(): number;');
    expect(rpcAdapter).toContain('const readCurrentBlockNumber = async (): Promise<number> =>');
    expect(rpcAdapter).toContain("send('eth_blockNumber', [])");
    expect(rpcAdapter).toContain('J_WATCHER_BLOCK_NUMBER_INVALID');
    expect(rpcAdapter).toContain('getCurrentBlockNumber: chainIo.readSafeBlockNumber');
    expect(rpcAdapter).toContain('getFinalityDepth: () => chainIo.resolveFinalityDepth(false)');
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
    expect(mmNode).toContain("MARKET_MAKER_RUNTIME_TICK_DELAY_MS'] || '0'");
    expect(mmNode).toContain("MARKET_MAKER_API_YIELD_MS'] || '5'");
    expect(mmNode).toContain('const yieldMarketMakerApi = async (): Promise<void> => {');
    expect(mmNode).toContain('await new Promise<void>(resolve => setTimeout(resolve, MARKET_MAKER_API_YIELD_MS));');
    expect(mmNode).not.toContain('const emitCrossProgress =');
    expect(mmNode).not.toContain('const describeCrossQuoteJobProgress =');
    expect(mmNode).not.toContain('const isCrossQuoteJobDepthComplete =');
    const sameProgressBody = extractSourceBlock(mmNode, 'const emitSameProgress =', 'const isBootstrapDepthComplete =');
    expect(sameProgressBody.indexOf('if (now - lastProgressLogAt < 2_000) return;')).toBeLessThan(
      sameProgressBody.indexOf('const incomplete = jobs.filter(job => !isSameQuoteJobDepthReady(deps.env, job));'),
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
    expect(mmNode).toContain('const hasMarketMakerRuntimeBacklog = (env: RuntimeReplica): boolean => {');
    expect(mmNode).toContain('Boolean(env.infrastructure?.processingPromise)');
    expect(mmNode).toContain('if (hasMarketMakerRuntimeBacklog(deps.env)) return false;');
    expect(mmNode).toContain('type SameQuoteJob = {');
    expect(mmNode).toContain('const isSameQuoteJobDepthReady = (env: RuntimeReplica, job: SameQuoteJob): boolean => {');
    expect(mmNode).toContain('buildMarketMakerOfferSpecs([job.hub.entityId], job.tokenIds)');
    expect(mmNode).not.toContain('const isSameQuoteJobCovered = (env: RuntimeReplica, job: SameQuoteJob): boolean => {');
    expect(mmNode).not.toContain('const isSameQuoteJobReady = (env: RuntimeReplica, job: SameQuoteJob): boolean => {');
    expect(mmNode).toContain('const buildMarketMakerSameQuoteJobs = (');
    expect(mmNode).toContain('const buildSameJobs = (visibleHubs: HubProfile[]): SameQuoteJob[] =>');
    expect(mmNode).toContain('let bootstrapSameCursor = 0;');
    expect(mmNode).toContain('const allSameDepthReady = (visibleHubs: HubProfile[]): boolean => {');
    expect(mmNode).toContain('compareStableText(left.context.jurisdictionRef, right.context.jurisdictionRef)');
    expect(mmNode).toContain("jurisdictionRef: String(context.jurisdictionRef || '').trim().toLowerCase()");
    expect(mmNode).not.toContain('compareStableText(left.context.jurisdictionName, right.context.jurisdictionName)');
    expect(mmNode).not.toContain("jurisdictionName: String(context.jurisdictionName || '').trim().toLowerCase()");
    expect(mmNode).not.toContain('const isAllSameQuoteReady = (visibleHubs: HubProfile[]): boolean => {');
    expect(mmNode).not.toContain('const isAllSameQuoteCovered = (visibleHubs: HubProfile[]): boolean => {');
    expect(mmNode).toContain('const isBootstrapDepthComplete = (health: MarketMakerHealth | null): boolean =>');
    expect(mmNode).toContain('selectMarketMakerHubsForContext(input.visibleHubs, input.context)');
    expect(mmNode).toMatch(
      /\.filter\(profile => !hasMarketMakerAccountBacklog\(input\.deps\.env, input\.context\.entityId, profile\.entityId\)\)/,
    );
    expect(mmNode).toMatch(
      /\): Promise<boolean> => \{\s*const localCreditInputsByEntity = new Map<string, EntityInput>\(\);/,
    );
    expect(mmNode).toContain('const pushLocalConnectivityTx = (');
    expect(mmNode).toContain('const maintainSameContextQuotes = async (');
    expect(mmNode).toContain('const orderedIncompleteJobs: SameQuoteJob[] = [];');
    expect(mmNode).toMatch(/const jobsByContext = new Map<\s*string,\s*\{/);
    expect(mmNode).toContain('const runnableHubEntityIdsFor =');
    expect(mmNode).toContain(
      '.filter(hubEntityId => !hasMarketMakerAccountBacklog(deps.env, entry.context.entityId, hubEntityId))',
    );
    expect(mmNode).toMatch(/\.slice\(\s*0,\s*MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE,\s*\)/);
    expect(mmNode).not.toContain(
      'if (hasMarketMakerAccountBacklog(env, job.context.entityId, job.hub.entityId)) return;',
    );
    expect(mmNode).not.toContain('const hubEntityIds = [job.hub.entityId];');
    expect(mmNode).toContain('const enqueued = await maintainMarketMakerQuotes(');
    expect(mmNode).toContain('await maintainSameContextQuotes({');
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
    expect(mmNode).toContain(
      'if (!(primarySameDepthReady && deps.readModel.allSameDepthReady(visibleHubs))) return false;',
    );
    expect(mmNode).not.toContain('const sameCoverageReady = isAllSameQuoteCovered(visibleHubs);');
    expect(mmNode).not.toContain('const sameSettledReady = primarySameReady && isAllSameQuoteReady(visibleHubs);');
    expect(mmNode).not.toContain('if (bootstrapCrossStarted ? !sameCoverageReady : !sameSettledReady) return false;');
    expect(mmNode).not.toContain('const reserveCrossOfferBudget = (');
    expect(mmNode).not.toContain('remainingOffersTotal: MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK');
    expect(mmNode).toContain('route.source.counterpartyEntityId');
    expect(mmNode).not.toContain('coverageOnly');
    expect(mmNode).toContain('bootstrapCrossCursor');
    expect(mmNode).toContain('steadyCrossCursor');
    expect(mmNode).toContain('const selected = selectQuoteEngineCrossJobs(state, mode, jobs);');
    expect(mmNode).toContain('const nextCursor = (index + 1) % input.jobs.length;');
    expect(mmNode).not.toContain('deferredBootstrapCrossInputs');
    expect(mmNode).not.toContain("direction: 'bootstrap-batch'");
    const crossJobPlanningStart = mmNode.indexOf('const buildMarketMakerCrossQuoteJobs = async (');
    const crossSelectionStart = mmNode.indexOf('type SelectedCrossQuoteJobs = {');
    expect(crossJobPlanningStart).toBeGreaterThan(0);
    expect(crossSelectionStart).toBeGreaterThan(crossJobPlanningStart);
    const crossJobPlanning = mmNode.slice(crossJobPlanningStart, crossSelectionStart);
    expect(crossJobPlanning).not.toContain('buildMarketMakerCrossOfferSpecs(');
    expect(crossJobPlanning).toContain('jobs.push({');
    expect(mmNode).toContain("emitMarketMakerCrossBootstrapWaveEvent('cross-wave-connectivity'");
    expect(mmNode).not.toContain('launch one per-account settlement wave and wait for');
    expect(mmNode).toContain('MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK');
    expect(mmNode).toContain('bootstrapCrossStarted: false,');
    expect(mmNode).toContain('readModel.allSameDepthReady(readVisibleHubProfiles(env, true))');
    expect(mmNode).not.toContain('\n      state.bootstrapCrossStarted = false;');
    expect(mmNode).toContain('const previousPhase = state.phase;');
    expect(mmNode).toContain('if (state.phase === previousPhase) return;');
    expect(mmNode).toContain('rebuildCachedHealthResponseJson();');
    expect(mmNode).toContain("state.phase = 'bootstrap-cross';");
    expect(mmNode).toContain("if (input.mode === 'steady') return true;");
    expect(mmNode).toContain('input.state.bootstrapCrossCursor = nextCursor;');
    expect(mmNode).toContain("if (mode === 'steady') state.steadyCrossCursor = selection.nextCursor;");
    expect(mmNode).not.toContain('deferredBootstrapCrossInputs');
    expect(mmNode).toContain('sourceHubs,');
    expect(mmNode).toContain('targetHubs,');
    expect(mmNode).toContain("if (input.mode === 'steady') return true;");
    expect(mmNode).toContain(
      'allSameDepthReady(readVisibleHubProfiles(deps.env, true)) && isMarketMakerDepthComplete(health)',
    );
    expect(mmNode).toContain("scope: 'same-chain-all-contexts-depth'");
    expect(mmNode).not.toContain("if (mode !== 'bootstrap') return;");
    expect(mmNode).not.toContain(
      "const sameQuoteContexts = mode === 'bootstrap' ? mmContexts.slice(0, 1) : mmContexts;",
    );
    expect(mmNode).not.toContain("const jobCount = mode === 'bootstrap'");
    expect(mmNode).not.toContain('? crossQuoteJobs.length');
    expect(mmNode).toContain('MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK');
    expect(mmNode).toContain('if (readModel.isBootstrapDepthComplete(currentHealth)) return;');
    expect(mmNode).toContain('if (deps.isDepthComplete(beforeDrive) && deps.canCheckCompletion()) return beforeDrive;');
    expect(mmNode).toContain('const hubsDepthReady = hubs.length > 0 && hubs.every((entry) => entry.depthReady);');
    expect(mmNode).toContain('const crossDepthReady = !cross.applicable || (');
    expect(mmNode).toContain('ready: pairs.length > 0 && pairs.every(pair => pair.ready) && blockers.length === 0');
    expect(mmNode).not.toContain('const finalizedByPair = countFinalizedCrossOffersByPair(env, targetSpecs);');
    expect(mmNode).not.toContain('(finalizedByPair.get(spec.pairId) || 0) === 0');
    expect(mmNode).not.toContain('const selectedPairs = new Set<string>();');
    expect(mmNode).not.toContain('if (selectedPairs.has(spec.pairId)) continue;');
    expect(mmNode).toContain('for (const spec of candidates.slice(0, allowedNewOffers)) {');
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
    expect(mmNode).toContain(
      'const hasSourceAccountCrossOffer = (env: RuntimeReplica, route: CrossJurisdictionSwapRoute): boolean => {',
    );
    expect(mmNode).toContain('if (hasSourceAccountCrossOffer(env, route)) return true;');
    expect(mmNode).not.toContain(
      'const isMarketMakerBootstrapReady = (health: MarketMakerHealth | null): boolean => {',
    );
    expect(mmNode).toContain('const isMarketMakerDepthComplete = (health: MarketMakerHealth | null): boolean => {');
    expect(mmNode).toContain('const isMarketMakerFullDepthComplete = (health: MarketMakerHealth | null): boolean => {');
    expect(mmNode).toContain(
      'const isMarketMakerCrossDepthComplete = (health: MarketMakerHealth | null): boolean => {',
    );
    const healthControllerBlock = extractSourceBlock(
      mmNode,
      'const createMarketMakerHealthController =',
      'type MarketMakerHttpHandlerDeps =',
    );
    expect(healthControllerBlock).toContain('const publishReady = (): MarketMakerHealth | null => {');
    expect(healthControllerBlock).toContain(
      'if (!currentHealth || !isMarketMakerCrossDepthComplete(currentHealth)) return publish({ includeCross: true });',
    );
    expect(healthControllerBlock).toContain('crossOverride: currentHealth.cross');
    expect(mmNode).toContain("if (deps.phase() === 'offers-ready') {");
    expect(mmNode).toContain('const before = deps.health.publishReady();');
    expect(mmNode).toContain('if (isMarketMakerFullDepthComplete(before)) return;');
    expect(mmNode).toContain("await deps.driveQuotes('steady');");
    expect(mmNode).toContain('const after = deps.health.publishReady();');
    const refreshCachedHealthBlock = extractSourceBlock(
      mmNode,
      'const refreshHealth = (): void => {',
      'const maintainQuotes = async (): Promise<void> => {',
    );
    expect(refreshCachedHealthBlock).toContain('deps.health.publishReady();');
    expect(refreshCachedHealthBlock).not.toContain('includeCross: true');
    expect(mmNode).not.toContain('bootstrapCrossExpectedRoutes === false');
    expect(mmNode).not.toContain('crossOverride: buildNeutralMarketMakerCrossHealth()');
    expect(mmNode).not.toContain('Math.max(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK, expectedOffersPerHub)');
    expect(mmNode).toMatch(/const quoteReadyHubEntityIds = hubEntityIds\.filter\(\(?hubEntityId\)? =>/);
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
    expect(mmNode).not.toContain(
      'if (!isMarketMakerConnectivityReady(env, sourceContext.entityId, sourceHubEntityIds, sourceTokenIds)) return;',
    );
    expect(mmNode).not.toContain(
      'if (!isMarketMakerConnectivityReady(env, targetContext.entityId, targetHubEntityIds, targetTokenIds)) return;',
    );
    expect(mmNode).toContain(
      'const targetAccount = getAccountReplica(env, targetContext.entityId, route.target.entityId);',
    );
    expect(hubNode).toContain('isCanonicalAccountOpener(bootstrap.entityId, peer.entityId)');
  });

  test('prod runtime child keeps merge debug output structured and gated', () => {
    const mergeSource = readFileSync(join(repoRoot, 'runtime/entity/consensus/input-merge.ts'), 'utf8');
    expect(mergeSource).toContain("const entityInputMergeLog = createStructuredLogger('entity.input.merge');");
    expect(mergeSource).toContain("entityInputMergeLog.warn('frame.conflict'");
    expect(mergeSource).not.toContain('console.');
  });

  test('health enrichment cannot erase an active reset failure', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const recompute = extractSourceBlock(
      orchestrator,
      'const recomputeHealthWithMarketMaker = (',
      'const enrichMarketMakerFromHubSnapshots = async',
    );
    expect(recompute).toContain('const resetOk = deriveResetHealthOk(health.reset);');
    expect(recompute).toContain('health.coreOk &&\n    resetOk &&');
    expect(recompute).toContain("resetOk ? null : 'reset'");
  });

  test('isolated e2e runner bounds green-path MM teardown and cleans child ports', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
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
      'runtime/scripts/run-e2e-parallel-isolated.ts',
      'runtime/scripts/rpc-settlement-anvil.ts',
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

  test('production bootstrap starts stateful Anvil chains sequentially', () => {
    const smoke = readFileSync(join(repoRoot, 'runtime/scripts/local-prod-smoke.ts'), 'utf8');
    const primaryStart = smoke.indexOf("startManaged('anvil',");
    const primaryReady = smoke.indexOf("await waitForRpc(rpcPort, '0x7a69', 'Testnet')");
    const secondaryStart = smoke.indexOf("startManaged('anvil2',");
    const secondaryReady = smoke.indexOf("await waitForRpc(rpc2Port, '0x7a6a', 'Tron')");
    expect(primaryStart).toBeGreaterThan(0);
    expect(primaryReady).toBeGreaterThan(primaryStart);
    expect(secondaryStart).toBeGreaterThan(primaryReady);
    expect(secondaryReady).toBeGreaterThan(secondaryStart);
  });

  test('isolated e2e outer timeout exceeds every declared Playwright test timeout', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
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
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-fast.ts'), 'utf8');
    expect(runner).toContain('const stackConcurrency = isCi ? 1 : 8;');
    expect(runner).toContain('`--shards=${stackConcurrency}`');
    expect(runner).toContain('`--max-mm-concurrency=${isCi ? 1 : 2}`');
    expect(runner).toContain('`--max-reset-concurrency=${isCi ? 1 : 4}`');
  });

  test('isolated e2e overlaps the bounded market-maker queue with plain stacks', () => {
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
    expect(runner).toContain('const prioritizedMarketMakerIndex = activeMarketMakerTasks < args.maxMmConcurrency');
    expect(runner).toContain('!claimed[index] && task.requireMarketMaker');
    expect(runner).toContain('!claimed[index] && !task.requireMarketMaker');
  });

  test('managed runtime teardown stops J-event producers before draining runtime and network IO', () => {
    const runtimeMain = readFileSync(join(repoRoot, 'runtime/runtime/composition.ts'), 'utf8');
    const runtimeLoop = readFileSync(join(repoRoot, 'runtime/runtime/loop.ts'), 'utf8');
    const runtimeWatchers = readFileSync(join(repoRoot, 'runtime/runtime/loop-watchers.ts'), 'utf8');
    const nodeQuiesce = readFileSync(join(repoRoot, 'runtime/orchestrator/node-runtime-quiesce.ts'), 'utf8');
    const sources = [
      readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8'),
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
      expect(source).toContain("from './node-runtime-quiesce';");
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
    const hubSource = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
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

    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
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
    const startServer = readFileSync(join(repoRoot, 'scripts/start-server.sh'), 'utf8');
    const bootstrapMonitor = readFileSync(join(repoRoot, 'scripts/watch-prod-bootstrap.ts'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(deploy).toContain('start_production_anvil anvil2 scripts/start-anvil2.sh');
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
    expect(deploy).toContain('bun scripts/watch-prod-bootstrap.ts http://127.0.0.1:8080/api/health 0');
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
    expect(deploy).toContain('PRODUCTION_STATE_MIGRATION_COLLISION');
    expect(deploy).toContain('if [ "$PRODUCTION" != "1" ]; then');
    expect(deploy).toContain('echo "[deploy] preserving checkout state until production migration completes"');
    expect(deploy).toContain('rmdir data db db-tmp 2>/dev/null || true');
    expect(deploy).toContain('chmod -R go-rwx "$XLN_STATE_ROOT"');
    expect(deploy).toContain('rm -rf "$XLN_RDB_ROOT/runtime/prod-main"');
    expect(deploy).toContain('"$XLN_RDB_ROOT/watchtower/prod-main"');
    expect(deploy).toContain('"$XLN_RDB_ROOT/watchtower/push-main"');
    expect(deploy).not.toContain('-- --reset');
    expect(deploy).toContain('--kill-timeout 60000 --restart-delay 2000');
    const startAnvil = deploy.slice(
      deploy.indexOf('start_production_anvil()'),
      deploy.indexOf('ensure_production_anvil_memory_restart_disabled()'),
    );
    expect(startAnvil).not.toContain('--max-memory-restart');
    expect(deploy).toContain('ensure_production_anvil_memory_restart_disabled anvil scripts/start-anvil.sh');
    expect(deploy).toContain('ensure_production_anvil_memory_restart_disabled anvil2 scripts/start-anvil2.sh');
    expect(deploy).toContain(
      'run_or_fail_deploy "unsafe Anvil PM2 supervision" bun scripts/check-anvil-supervision.ts',
    );
    expect(deploy).toContain('wait_for_anvil_state_checkpoint "$XLN_JDB_ROOT/anvil-state.json"');
    expect(deploy).toContain('wait_for_anvil_state_checkpoint "$XLN_JDB_ROOT/anvil2-state.json"');
    expect(deploy).toContain('pm2 delete xln-server >/dev/null 2>&1 || true');
    expect(deploy).toContain(
      'run_or_fail_deploy "failed to start xln-server via pm2" pm2 start scripts/start-server.sh --name xln-server --interpreter bash --max-memory-restart 900M',
    );
    expect(deploy).toContain('export XLN_MESH_PRESERVE_STATE_ON_RESET=1');
    expect(deploy).toContain('install -m 600 /dev/null "$XLN_RDB_ROOT/runtime/.mesh-reset-once"');
    expect(deploy).not.toContain('export XLN_MESH_PRESERVE_STATE_ON_RESET=0');
    expect(startServer).toContain('export XLN_MESH_PRESERVE_STATE_ON_RESET=0');
    expect(startServer).toContain('MESH_RESET_CLAIMED');
    expect(startServer).toContain('MESH_RESET_RETRY');
    expect(startServer).toContain('MESH_RESET_FINALIZED');
    expect(deploy.match(/git clean -fd -e data\/ -e db\/ -e db-tmp\//g)).toHaveLength(2);
    expect(
      deploy.match(/if \[ -f \/var\/lib\/xln\/\.checkout-state-migrated \]; then git clean -fd; else/g),
    ).toHaveLength(2);
    expect(deploy).not.toContain('pm2 restart xln-server');
    expect(packageJson.scripts['deploy:prod']).toContain('--reset-mesh');
    expect(packageJson.scripts['deploy:prod']).not.toContain('--code-only');
    expect(packageJson.scripts['deploy:prod:runtime']).toContain('--reset-mesh');
    expect(packageJson.scripts['deploy:prod:runtime']).not.toContain('--code-only');
    expect(packageJson.scripts['deploy:prod:runtime:code']).toBeUndefined();
    expect(packageJson.scripts['deploy:prod:runtime:reset']).toContain('--reset-mesh');
    expect(packageJson.scripts['deploy:prod:fresh']).toContain('--reset-mesh');
  });

  test('prod remote runtime import e2e cannot reset the shared prod mesh implicitly', () => {
    const baseline = readFileSync(join(repoRoot, 'tests/utils/e2e-baseline.ts'), 'utf8');
    const radapterRemote = ['tests/e2e-radapter-remote-part-1.spec.ts', 'tests/e2e-radapter-remote-part-2.spec.ts']
      .map(file => readFileSync(join(repoRoot, file), 'utf8'))
      .join('\n');
    const appLayout = readFileSync(join(repoRoot, 'frontend/src/routes/app/+layout.svelte'), 'utf8');
    const importFlow = readFileSync(join(repoRoot, 'frontend/src/lib/utils/remoteRuntimeImportFlow.ts'), 'utf8');
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const runtimeImportHttp = readFileSync(join(repoRoot, 'runtime/orchestrator/runtime-import-http.ts'), 'utf8');
    const bootstrapTimeline = readFileSync(join(repoRoot, 'runtime/orchestrator/bootstrap-timeline-stages.ts'), 'utf8');
    const isolatedRunner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');

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
    const diagnose = readFileSync(join(repoRoot, 'scripts/prod-diagnose.sh'), 'utf8');
    expect(diagnose).toContain('payload.marketMaker.startupPhase !== "offers-ready"');
    expect(diagnose).not.toContain('payload.marketMaker.startupPhase !== "ready"');
  });

  test('market maker activates executable arguments before deriving runtime keys', () => {
    const core = readMarketMakerNodeModule('mm-node-core.ts');
    const run = readMarketMakerNodeModule('mm-node-run.ts');
    const activation = run.indexOf('activateMarketMakerProcessArgs();');
    const runtimeCreation = run.indexOf('const env = await main(resolvedArgs.seed, {');

    expect(core).toContain("if (!seed) throw new Error('Market-maker seed is required");
    expect(core).toContain("if (!directWsUrl) throw new Error('[MESH-MM] Missing required --direct-ws-url')");
    expect(activation).toBeGreaterThan(0);
    expect(runtimeCreation).toBeGreaterThan(activation);
  });

  test('node orchestrators validate J adapters without mutating committed replicas', () => {
    const sources = [
      readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8'),
      readMarketMakerNodeModule('mm-node-core.ts'),
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
    const mmProgress = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-bootstrap-progress.ts'), 'utf8');
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
    expect(readMarketMakerNodeModule('mm-node-health.ts')).toContain('computeCanonicalEntityHashesFromEnv');
    expect(readMarketMakerNodeModule('mm-node-run.ts')).toContain('computeCanonicalStateHashFromEnv');
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
    const smoke = readFileSync(join(repoRoot, 'runtime/scripts/local-prod-smoke.ts'), 'utf8');
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const mmNode = readMarketMakerNodeSource();
    const benchmark = readFileSync(join(repoRoot, 'runtime/scripts/bootstrap-benchmark.ts'), 'utf8');
    const soundcheck = readFileSync(join(repoRoot, 'runtime/scripts/bootstrap-soundcheck.ts'), 'utf8');

    expect(packageJson).toContain(
      '"prod:bootstrap:bench": "bun runtime/scripts/run-with-test-cleanup.ts --reason=bootstrap-bench -- bun runtime/scripts/bootstrap-benchmark.ts"',
    );
    expect(packageJson).toContain(
      '"prod:bootstrap:fresh": "bun runtime/scripts/run-with-test-cleanup.ts --reason=bootstrap-fresh -- bun runtime/scripts/bootstrap-soundcheck.ts --mode=fresh"',
    );
    expect(packageJson).toContain(
      '"prod:bootstrap:template": "bun runtime/scripts/run-with-test-cleanup.ts --reason=bootstrap-template -- bun runtime/scripts/bootstrap-soundcheck.ts --mode=template"',
    );
    expect(packageJson).toContain(
      '"prod:bootstrap:clone": "bun runtime/scripts/run-with-test-cleanup.ts --reason=bootstrap-clone --keep-test-artifacts -- bun runtime/scripts/bootstrap-soundcheck.ts --mode=clone"',
    );
    expect(packageJson).toContain(
      '"prod:bootstrap:hydrate": "bun runtime/scripts/run-with-test-cleanup.ts --reason=bootstrap-hydrate --keep-test-artifacts -- bun runtime/scripts/bootstrap-soundcheck.ts --mode=hydrate"',
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
    expect(orchestrator).toContain("join(marketMakerChild.dbPath, 'bootstrap-events.jsonl')");
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
    expect(orchestrator).toContain('if (preserveState) await Promise.all(h23.map(child => spawnHub(child)));');
    expect(orchestrator).toContain('await Promise.all(hubChildren.map(child => waitForHubSelfReady(child)));');
    expect(orchestrator).toContain('await Promise.all(h23.map(async child => {');
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
    expect(smoke).toContain('marketMakerFullDepthReady(health) &&');
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
    expect(smoke).toContain('MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK:');
    expect(smoke).toContain("process.env['MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK'] || '45'");
    expect(smoke).toContain('MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK:');
    expect(smoke).toContain("process.env['MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] || '135'");
    expect(smoke).toContain("process.env['MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE'] || '3'");
    expect(mmNode).toContain("process.env['MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE'] || '3'");
    expect(mmNode).toContain('remainingSourceHubGroups -= 1;');
    expect(mmNode).toContain('const orderedSourceHubs = [...sourceHubs].sort');
    expect(mmNode).not.toContain('const sourceHubScans = [...sourceHubs]');
    const bootstrapCrossBranch = mmNode.slice(
      mmNode.indexOf('const maintainBootstrapCrossQuotes = async ('),
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
    expect(mmNode).toContain('input.state.bootstrapCrossCursor = nextCursor;');
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
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
    const isolatedRuntime = readFileSync(join(repoRoot, 'runtime/scripts/e2e-isolated-runtime.ts'), 'utf8');
    const fatalHelper = readFileSync(join(repoRoot, 'runtime/scripts/e2e-fatal-log-monitor.ts'), 'utf8');
    const runnerLockHelper = readFileSync(join(repoRoot, 'runtime/scripts/e2e-runner-lock.ts'), 'utf8');
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
    expect(fatalHelper).not.toContain('/PENDING[-_]FRAME[-_]STALE/');
    expect(fatalHelper).toContain('/MM_READY_TIMEOUT/');
    expect(fatalHelper).toContain('/\\[ERROR\\].*CROSS_J_[A-Z0-9_:-]*/');
    expect(fatalHelper).toContain('/ROUTE_NO_P2P/');
    expect(fatalHelper).toContain('/child\\.unexpected_exit/');
    expect(fatalHelper).toContain('export const E2E_FATAL_LOG_TAIL_LINES = 80;');
    expect(runner).toContain('const startFailFastLogMonitor = (');
    expect(runner).toContain("import { assertMinDiskFree } from '../infra/storage-monitor';");
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
    expect(runner).toContain("from './e2e-runner-lock';");
    expect(runnerLockHelper).toContain('logsDir?: string;');
    expect(runnerLockHelper).toContain("if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;");
    expect(runnerLockHelper).toContain("if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;");
    expect(runner).toContain('const releaseRunnerLock = acquireRunnerLock(logsDir);');
    expect(standaloneMonitor).toContain("const runnerLockPath = join(e2eRoot, '.runner-lock.json');");
    expect(standaloneMonitor).toContain('findFirstRuntimeFatalLogHit(path, fromLine)');
    expect(standaloneMonitor).toContain('await stopRunner();');
    expect(standaloneMonitor).toContain("process.kill(lock.pid, 'SIGTERM')");
    expect(standaloneMonitor).toContain("process.kill(lock.pid, 'SIGKILL')");
    expect(packageJson).toContain('"test:e2e:monitor": "bun runtime/scripts/e2e-fail-fast-monitor.ts"');
    expect(packageJson).toContain('"test:cleanup": "bun runtime/scripts/test-artifact-cleanup.ts"');
    expect(packageJson).toContain('"test:unit": "bun runtime/scripts/run-unit-tests.ts"');
    expect(packageJson).toContain(
      '"test:persistence:cli": "bun runtime/scripts/run-with-test-cleanup.ts --reason=persistence-cli -- bun runtime/scripts/persistence-wal-smoke.ts"',
    );
    expect(packageJson).toContain(
      '"test:watchtower:smoke": "bun runtime/scripts/run-with-test-cleanup.ts --reason=watchtower-smoke -- bun runtime/scripts/watchtower-smoke.ts"',
    );
    expect(packageJson).toContain(
      '"test:rpc-settlement": "bun runtime/scripts/run-with-test-cleanup.ts --reason=rpc-settlement -- bun runtime/scripts/rpc-settlement-parity.ts"',
    );
    expect(packageJson).toContain(
      '"test:contracts:full": "bun runtime/scripts/run-with-test-cleanup.ts --reason=contracts --child-cwd=jurisdictions -- sh -c \\"bunx hardhat test test/*.ts test/*.cjs\\""',
    );
    expect(packageJson).toContain(
      '"test:e2e:release": "bun run prod:bootstrap:soundcheck && bun runtime/scripts/run-e2e-parallel-isolated.ts --all --exclude-market-maker',
    );
    expect(packageJson).toContain(
      '"test:e2e:mm": "bun run prod:bootstrap:soundcheck && bun runtime/scripts/run-e2e-parallel-isolated.ts --all --market-maker-only',
    );
    expect(packageJson).toContain(
      '"test:e2e:full": "bun runtime/scripts/run-e2e-parallel-isolated.ts --all --strict-browser-health --shards=7 --workers-per-shard=1 --max-mm-concurrency=2',
    );
    expect(packageJson).toContain(
      '"test:e2e:release": "bun run prod:bootstrap:soundcheck && bun runtime/scripts/run-e2e-parallel-isolated.ts --all --exclude-market-maker --strict-browser-health --shards=7',
    );
    expect(packageJson).toContain(
      '"test:e2e:mm": "bun run prod:bootstrap:soundcheck && bun runtime/scripts/run-e2e-parallel-isolated.ts --all --market-maker-only --strict-browser-health --shards=7 --workers-per-shard=1 --max-mm-concurrency=2',
    );
    expect(packageJson).toContain(
      '"test:e2e:all": "bun runtime/scripts/run-e2e-parallel-isolated.ts --all --strict-browser-health --shards=7 --workers-per-shard=1 --max-mm-concurrency=2',
    );
    expect(packageJson).toContain(
      '"test:p2p:relay": "bun runtime/scripts/run-with-test-cleanup.ts --reason=p2p-relay -- bun runtime/scenarios/p2p-relay.ts"',
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
    expect(cleanupHelper).toContain("import { sanitizeChildProcessEnv } from '../api/server/child-process-env';");
    expect(cleanupHelper).toContain('const next = sanitizeChildProcessEnv(env);');
    expect(unitTestsRunner).toContain('cleanupTestArtifactsBeforeRun({');
    expect(unitTestsRunner).toContain("reason: 'unit-tests'");
    expect(unitTestsRunner).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV');
    expect(unitTestsRunner).toContain('env: sanitizeChildProcessEnv({');
    expect(unitTestsRunner).toContain("'--keep-test-artifacts'");
    expect(unitTestsRunner).toContain("'--no-cleanup'");
    expect(unitTestsRunner).toContain('const SUBPROCESS_STDIO_TEST_FILES = [');
    expect(unitTestsRunner).toContain('`--path-ignore-patterns=**/${file}`');
    expect(unitTestsRunner).toContain("resolve(ROOT, 'runtime')");
    expect(unitTestsRunner).toContain('await ensureContractArtifacts();');
    expect(e2eFastRunner).toContain('cleanupTestArtifactsBeforeRun({');
    expect(e2eFastRunner).toContain("reason: 'e2e-fast'");
    expect(e2eFastRunner).toContain("scope: 'e2e'");
    expect(e2eFastRunner).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV');
    expect(e2eFastRunner).toContain('env: sanitizeChildProcessEnv({');
    expect(e2eCoreRunner).toContain("import { sanitizeChildProcessEnv } from '../api/server/child-process-env';");
    expect(e2eCoreRunner).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(runner).toContain("import { sanitizeChildProcessEnv } from '../api/server/child-process-env';");
    expect(isolatedRuntime).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(runner).toContain(
      "XLN_AUTO_PROVISION_EXTERNAL_FAUCET: process.env['XLN_AUTO_PROVISION_EXTERNAL_FAUCET'] ?? '1'",
    );
    expect(allTestsFast).toContain('env: sanitizeChildProcessEnv(env)');
    expect(allTestsFast).toContain('const e2eEnv = withoutTestArtifactCleanupDoneEnv(childEnv);');
    expect(allTestsFast).toContain('e2eEnv,');
    expect(systemRunner).toContain('cleanupTestArtifactsBeforeRun,');
    expect(systemRunner).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV,');
    expect(systemRunner).toContain("from './test-artifact-cleanup';");
    expect(systemRunner).toContain("import { sanitizeChildProcessEnv } from '../api/server/child-process-env';");
    expect(systemRunner).toContain("cleanupTestArtifactsBeforeRun({ reason: 'system-tests' })");
    expect(systemRunner).toContain("process.env[TEST_ARTIFACT_CLEANUP_DONE_ENV] = '1'");
    expect(systemRunner).toContain('env: sanitizeChildProcessEnv(process.env)');
    expect(systemRunner).toContain('env: sanitizeChildProcessEnv({');
    expect(soakRunner).toContain("import { sanitizeChildProcessEnv } from '../api/server/child-process-env';");
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
    const runner = readFileSync(join(repoRoot, 'runtime/scenarios/run.ts'), 'utf8');
    const p2pNode = readFileSync(join(repoRoot, 'runtime/scenarios/p2p-node.ts'), 'utf8');

    expect(runner).not.toContain('runtime/network/relay/standalone-server.ts');
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
    const bootstrapTimeline = ['bootstrap-timeline.ts', 'bootstrap-timeline-stages.ts']
      .map(file => readFileSync(join(repoRoot, 'runtime/orchestrator', file), 'utf8'))
      .join('\n');
    const types = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator-types.ts'), 'utf8');
    const healthRedaction = readFileSync(join(repoRoot, 'runtime/api/server/health-redaction.ts'), 'utf8');

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
    const meshCommon = readFileSync(join(repoRoot, 'runtime/orchestrator/mesh-common.ts'), 'utf8');
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
    expect(quotePipeline).toMatch(/\.slice\(\s*0,\s*MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE,\s*\)/);
    expect(quotePipeline).not.toContain('const hubEntityIds = [job.hub.entityId];');
    expect(quotePipeline).toContain('await maintainSameContextQuotes({');
    expect(quotePipeline).toContain('const enqueued = await maintainMarketMakerCrossQuotes(');
    expect(quotePipeline).toContain('job.sourceHubs,');
    expect(quotePipeline).toContain('job.targetHubs,');
    expect(quotePipeline).toContain("if (input.mode === 'steady') return true;");
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
    const runner = readFileSync(join(repoRoot, 'runtime/scripts/run-e2e-parallel-isolated.ts'), 'utf8');
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
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const ensureStart = mmNode.indexOf('const ensureMarketMakerHubConnectivity = async (');
    const readyStart = mmNode.indexOf('const isMarketMakerConnectivityReady = (');
    expect(ensureStart).toBeGreaterThan(0);
    expect(readyStart).toBeGreaterThan(ensureStart);

    const ensureConnectivity = mmNode.slice(ensureStart, readyStart);
    expect(mmNode).toContain("import { deriveAccountWatchSeed } from '../protocol/account-watch-seed';");
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
    expect(orchestrator).toContain("'--support-peer-identities-json', JSON.stringify(getMarketMakerIdentities())");
    expect(orchestrator).not.toContain('--mesh-hub-identities-json');
  });

  test('hub and market maker prefer authenticated direct entity delivery with relay fallback', () => {
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const hubTransport = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-runtime-transport.ts'), 'utf8');
    const mmNode = readMarketMakerNodeSource();
    const p2p = readFileSync(join(repoRoot, 'runtime/network/p2p/p2p.ts'), 'utf8');

    expect(p2p).not.toContain('preferRelayForEntityInput');
    expect(hubNode).not.toContain("process.env['XLN_ENABLE_DIRECT_ENTITY_INPUT_DISPATCH'] === '1'");
    expect(hubTransport).not.toContain("process.env['XLN_ENABLE_DIRECT_ENTITY_INPUT_DISPATCH'] === '1'");
    expect(mmNode).not.toContain("process.env['XLN_ENABLE_DIRECT_ENTITY_INPUT_DISPATCH'] === '1'");
    expect(hubTransport).toContain('route.sendEntityInputsDelivery(');
    expect(mmNode).toContain('directRuntimeWs.sendEntityInputsDelivery(targetRuntimeId, envelope, ingressTimestamp)');
    expect(hubNode).not.toContain('preferRelayForEntityInput');
    expect(mmNode).not.toContain('preferRelayForEntityInput');
    expect(mmNode).not.toContain('allowDirectClients: false');
  });

  test('hub support-peer provisioning uses full jurisdiction token sets', () => {
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    expect(hubNode).toContain("import { getTokenIdsForJurisdiction } from '../account/utils';");
    expect(hubNode).toContain('const tokenIdsForHubJurisdiction = (');
    expect(hubNode).toContain('const tokenCatalogForHubJurisdiction = (');

    const planSupportStart = hubNode.indexOf('const planSupportPeerInputs = (');
    const planHubStart = hubNode.indexOf('const planHubPeerInputs = (', planSupportStart);
    expect(planSupportStart).toBeGreaterThan(0);
    expect(planHubStart).toBeGreaterThan(planSupportStart);
    const planSupportPeerInputs = hubNode.slice(planSupportStart, planHubStart);
    expect(planSupportPeerInputs).toContain('const tokenIds = tokenIdsForHubJurisdiction(owner);');
    expect(planSupportPeerInputs).toContain('const [openTokenId = HUB_MESH_TOKEN_ID, ...extraTokenIds] = tokenIds;');
    expect(planSupportPeerInputs).toContain('...extraTokenIds.map(tokenId => ({');
    expect(planSupportPeerInputs).toContain('const missingTokenIds = tokenIds.filter(');
    expect(planSupportPeerInputs).not.toContain('DEFAULT_ACCOUNT_TOKEN_IDS');

    const reserveStart = hubNode.indexOf('const getReserveHealth = (');
    const supportPeerReserveEnd = hubNode.indexOf('const getEntityJurisdictionName = (');
    expect(reserveStart).toBeGreaterThan(0);
    expect(supportPeerReserveEnd).toBeGreaterThan(reserveStart);
    const reserveBootstrap = hubNode.slice(reserveStart, supportPeerReserveEnd);
    expect(reserveBootstrap).toContain('tokenCatalogForHubJurisdiction(tokenCatalog, {');
    expect(reserveBootstrap).toContain(
      'const bootstrapTokens = tokenCatalogForHubJurisdiction(catalog, { jurisdictionName });',
    );
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

  test('hub mesh bootstrap uses live entity jurisdiction and provisions the external faucet by default', () => {
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const driveStart = hubNode.indexOf('const advanceHubMeshBootstrap = async (');
    const driveEnd = hubNode.indexOf('const run = async (): Promise<void> => {', driveStart);
    expect(driveStart).toBeGreaterThan(0);
    expect(driveEnd).toBeGreaterThan(driveStart);
    const driveMeshBootstrap = hubNode.slice(driveStart, driveEnd);
    expect(driveMeshBootstrap).toContain('getEntityJurisdiction(input.env, input.bootstrap.entityId)');
    expect(driveMeshBootstrap).toContain('readVisibleHubProfiles(input.env, jurisdiction)');
    expect(driveMeshBootstrap).toContain('if (requiredProfiles.length !== resolvedArgs.meshHubNames.length) return;');
    expect(hubNode).toContain('peerReady = peerProfiles.length >= expected;');
    expect(driveMeshBootstrap).toContain('input.milestones.reserveReady = await ensureHubMeshReserves(input);');
    const creditFence = driveMeshBootstrap.indexOf('if (!creditReady) return;');
    const reserveProvision = driveMeshBootstrap.indexOf('if (!input.milestones.reserveReady) {');
    expect(creditFence).toBeGreaterThan(0);
    expect(reserveProvision).toBeGreaterThan(creditFence);
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
    expect(hubNode).toContain('if (!resolvedArgs.deployTokens || !AUTO_PROVISION_EXTERNAL_FAUCET) return;');
    expect(driveMeshBootstrap).toContain('await input.ensureFaucetReady();');
    expect(hubNode).not.toContain(
      'if (resolvedArgs.deployTokens) {\n    void externalWalletApi.provisionFaucetWallet()',
    );
    expect(hubNode).not.toContain('void externalWalletApi.provisionFaucetWallet()');
  });

  test('secondary hubs wait until every primary contract address has deployed bytecode', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const readiness = extractSourceBlock(
      orchestrator,
      'const waitForShardJurisdictions = async (child: HubChild): Promise<void> =>',
      'const runReset = async (options: OrchestratorResetOptions = configuredResetOptions): Promise<void> =>',
    );

    expect(readiness).toContain('await findMissingRpcContractCode(args.rpcUrl, contracts)');
    expect(readiness).toContain('if (hasRpc2 && missingCode.length === 0 && !probeError)');
    expect(readiness).not.toContain('if (hasShardRpc2Jurisdiction(jurisdictionsConfig)) {\n      return;');
  });

  test('custody bootstrap waits until market maker readiness completes', () => {
    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const custodyBootstrapSource = readFileSync(join(repoRoot, 'runtime/orchestrator/custody-bootstrap.ts'), 'utf8');
    const marketMakerAwait = orchestrator.indexOf('await waitForMarketMakerReady();');
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

  test('production account openers bind one explicit role authority per party', () => {
    const sources = [
      'runtime/orchestrator/daemon-control.ts',
      'runtime/orchestrator/hub-node.ts',
      'runtime/orchestrator/mm-node-core.ts',
      'runtime/runtime/swap-command-plan.ts',
      'frontend/src/lib/components/Entity/onboarding-runtime-input.ts',
      'frontend/src/lib/components/Entity/hub-discovery-profile.ts',
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
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          entities: [
            {
              entityId: '0x' + 'a'.repeat(64),
              isHub: true,
              metadata: {
                jurisdiction: {
                  name: 'Tron',
                  chainId: 31338,
                  depositoryAddress: '0x2222222222222222222222222222222222222222',
                },
              },
            },
            {
              entityId: '0x' + 'b'.repeat(64),
              isHub: true,
              metadata: {
                jurisdiction: {
                  name: 'Tron',
                  chainId: 31338,
                  depositoryAddress: '0x2222222222222222222222222222222222222222',
                },
              },
            },
            {
              entityId: '0x' + 'c'.repeat(64),
              isHub: true,
              metadata: {
                jurisdiction: {
                  name: 'Tron',
                  chainId: 31338,
                  depositoryAddress: '0x2222222222222222222222222222222222222222',
                },
              },
            },
            {
              entityId: '0x' + '1'.repeat(64),
              isHub: true,
              metadata: {
                jurisdiction: {
                  name: 'Testnet',
                  chainId: 31337,
                  depositoryAddress: '0x1111111111111111111111111111111111111111',
                },
              },
            },
            {
              entityId: '0x' + '2'.repeat(64),
              isHub: true,
              metadata: {
                jurisdiction: {
                  name: 'Testnet',
                  chainId: 31337,
                  depositoryAddress: '0x1111111111111111111111111111111111111111',
                },
              },
            },
            {
              entityId: '0x' + '3'.repeat(64),
              isHub: true,
              metadata: {
                jurisdiction: {
                  name: 'Testnet',
                  chainId: 31337,
                  depositoryAddress: '0x1111111111111111111111111111111111111111',
                },
              },
            },
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
    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    expect(hubNode).toContain(
      'context.faucetRelayStore.activeHubEntityIds =\n      context.hubBootstraps.map(entry => entry.entityId);',
    );
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
    expect(debugApi).toContain("import { buildKnownProfileBundle } from '../api/server/gossip-profiles';");
    expect(debugApi).toContain("if (deps.pathname === '/api/gossip/profile')");
    expect(debugApi).toContain('const bundle = buildKnownProfileBundle({');
    expect(debugApi).toContain('relayStore: deps.relayStore');
    expect(debugApi).toContain('found: !!bundle.profile');
    expect(debugApi).toContain("safeStringify({ ok: false, error: 'entityId is required' })");
  });

  test('fresh deploy stops runtime processes before deleting runtime state', () => {
    const deploy = readPlatformDeploy();
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
    for (const key of ['arrakis', 'wakanda', 'tron']) {
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
        JSON.stringify({
          success: true,
          serverDurationMs: 0,
          requestId: 'offchain_1',
          statusUrl: '/api/control/runtime-input/offchain_1/status',
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
      const body = JSON.stringify({ hubEntityId, userEntityId: `0x${'cd'.repeat(32)}` });
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
      expect((await response.json()).statusUrl).toBe(
        `/api/hub/runtime-input/offchain_1/status?hubEntityId=${encodeURIComponent(hubEntityId)}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('explicit hub action proxy fails fast when the selected child is absent', async () => {
    const originalFetch = globalThis.fetch;
    const hubEntityId = `0x${'ef'.repeat(32)}`;
    let pollCalls = 0;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true }), {
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
          body: JSON.stringify({ hubEntityId }),
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
        body: JSON.stringify({ entityId }),
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
          body: JSON.stringify({ padding: 'x'.repeat(MAX_WALLET_SNAPSHOT_BODY_BYTES) }),
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
          body: JSON.stringify({ entityId: suppliedEntityId }),
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
    const poll = readFileSync(join(repoRoot, 'runtime/jurisdiction/adapter/rpc-watcher-poll.ts'), 'utf8');
    const ingress = readFileSync(join(repoRoot, 'runtime/jurisdiction/adapter/rpc-watcher-ingress.ts'), 'utf8');
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
    const routes = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-api-routes.ts'), 'utf8');
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
          body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }),
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
      await server.stop(true);
    }
  }, 2_000);

});
