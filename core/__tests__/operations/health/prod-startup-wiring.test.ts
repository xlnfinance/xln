import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverHubIds } from '../../../orchestrator/bootstrap/custody-bootstrap';
import { createOrchestratorProxyHandlers } from '../../../orchestrator/proxy';
import { MAX_WALLET_SNAPSHOT_BODY_BYTES } from '../../../api/public/external-wallet/http';
import { E2E_FATAL_LOG_TAIL_LINES, findFirstRuntimeFatalLogHit, tailLog } from '../../../scripts/e2e/harness/e2e-fatal-log-monitor';
import { expandPlaywrightTargets } from '../../../scripts/e2e/runners/run-e2e-parallel-isolated';

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
  test('every production Runtime host exposes one canonical admin control resolver', () => {
    const sources = [
      'core/api/server/network/rpc-ws.ts',
      'core/orchestrator/hub/hub-runtime-transport.ts',
      'core/orchestrator/market-maker/node/mm-node-run.ts',
    ].map(path => readFileSync(join(repoRoot, path), 'utf8'));

    for (const source of sources) {
      expect(source).toContain('controlRuntime: resolveRuntimeAdminControl');
    }
  });

  test('managed hub BrainVault prewarms before WAL replay and opens custody only after restore', () => {
    const hub = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    const transport = readFileSync(join(repoRoot, 'core/orchestrator/hub/hub-runtime-transport.ts'), 'utf8');
    const orchestrator = readFileSync(join(repoRoot, 'core/orchestrator/orchestrator.ts'), 'utf8');
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
      readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8'),
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
    const runtimeImportHttp = readFileSync(join(repoRoot, 'core/orchestrator/replica-import/runtime-import-http.ts'), 'utf8');
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
    const orchestrator = readFileSync(join(repoRoot, 'core/orchestrator/orchestrator.ts'), 'utf8');
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
    const releaseGate = readFileSync(join(repoRoot, 'core/scripts/release/run-release-gate.ts'), 'utf8');

    expect(packageJson.scripts['check:src'].split('&&').map(command => command.trim()))
      .not.toContain('bun run check:determinism');
    expect(releaseGate).toContain(
      "{ name: 'deterministic replay oracle', command: 'bun run check:determinism', timeoutMs: 600_000 }",
    );
  });

  test('release gate proves replacement idempotency at both external I/O boundaries', () => {
    const releaseGate = readFileSync(join(repoRoot, 'core/scripts/release/run-release-gate.ts'), 'utf8');
    const coreE2e = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-core.ts'), 'utf8');
    for (const crashTest of [
      'core/__tests__/jurisdiction/submission/j-submit-crash-recovery.test.ts',
      'core/__tests__/jurisdiction/submission/j-submit-real-rpc-crash-recovery.test.ts',
    ]) {
      expect(releaseGate).toContain(crashTest);
    }
    expect(coreE2e).toContain('H2 process replacement restores authoritative health and exact configured public books');
  });

  test('bounded soak stays separate from the release gate', () => {
    const releaseGate = readFileSync(join(repoRoot, 'core/scripts/release/run-release-gate.ts'), 'utf8');

    expect(releaseGate).not.toContain("command: 'bun run soak:quick'");
  });

  test('production topology health runs after deployment, not against an unrelated release candidate', () => {
    const releaseGate = readFileSync(join(repoRoot, 'core/scripts/release/run-release-gate.ts'), 'utf8');
    const mainnetGate = readFileSync(join(repoRoot, 'core/scripts/release/run-mainnet-preflight-gate.ts'), 'utf8');

    expect(releaseGate).not.toContain("command: 'bun run prod:health'");
    expect(mainnetGate).toContain("command: 'bun run prod:health:capped-testnet'");
  });

  test('release RPC scenarios include the lock hostage terminal-evidence flow', () => {
    const releaseGate = readFileSync(join(repoRoot, 'core/scripts/release/run-release-gate.ts'), 'utf8');
    const systemRunner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-system-tests-parallel.ts'), 'utf8');

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
    const process = readFileSync(join(repoRoot, 'core/runtime/frame/process.ts'), 'utf8');
    const recoveryOutput = readFileSync(join(repoRoot, 'core/runtime/delivery/recovery-output.ts'), 'utf8');
    const postCommit = readFileSync(join(repoRoot, 'core/runtime/frame/lifecycle/post-commit.ts'), 'utf8');
    const durableOutbox = recoveryOutput.indexOf('env.pendingNetworkOutputs = buildPendingNetworkOutputs(');
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
    const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    expect(hubNode).not.toContain('HUB_BOOTSTRAP_PAUSE_STORAGE');
    expect(hubNode).not.toContain('readySnapshotInFlight');
    expect(hubNode).not.toContain('persist-ready-snapshot');
    expect(hubNode).not.toContain('prepare-ready-snapshot');
  });

  test('orchestrator has no bootstrap-specific snapshot coordinator', () => {
    const orchestrator = readFileSync(join(repoRoot, 'core/orchestrator/orchestrator.ts'), 'utf8');
    expect(orchestrator).not.toContain('persistHubReadySnapshots');
    expect(orchestrator).not.toContain('HUB_READY_SNAPSHOT');
    expect(orchestrator).not.toContain('prepare-ready-snapshot');
    expect(orchestrator).not.toContain('resume-ready-snapshot');
  });

  test('orchestrator restores the durable incident journal outside resettable runtime state', () => {
    const orchestrator = readFileSync(join(repoRoot, 'core/orchestrator/orchestrator.ts'), 'utf8');
    expect(orchestrator).toContain(
      "process.env['XLN_DEBUG_INCIDENT_JOURNAL_PATH'] || `${args.dbRoot}.debug-incidents.jsonl`",
    );
    expect(orchestrator).toContain('initialDebugId: debugIncidentJournal.debugId');
    expect(orchestrator).toContain('initialIncidents: debugIncidentJournal.incidents');
    expect(orchestrator).toContain('incidentSink: incident => debugIncidentJournal.record(incident)');
    expect(orchestrator).not.toContain('relayStore.debugId = 0');
  });

  test('standalone runtime fsyncs fatal incidents before exiting', () => {
    const server = readFileSync(join(repoRoot, 'core/api/server/index.ts'), 'utf8');
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
    const server = readFileSync(join(repoRoot, 'core/api/server/index.ts'), 'utf8');
    const packagedDaemon = readFileSync(join(repoRoot, 'packages/npm/xlnfinance/lib/process.js'), 'utf8');
    const formationPanel = readFileSync(
      join(repoRoot, 'frontend/src/lib/components/Entity/onboarding/FormationPanel.svelte'),
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

  test('managed runtime fatal remains isolated after parent incident fsync acknowledgement', () => {
    const orchestrator = readFileSync(join(repoRoot, 'core/orchestrator/orchestrator.ts'), 'utf8');
    const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    const mmNode = readMarketMakerNodeSource();
    const runtimeLoop = readFileSync(join(repoRoot, 'core/runtime/loop/loop-failure.ts'), 'utf8');

    expect(orchestrator.match(/stdio: \['pipe', 'pipe', 'pipe', 'ipc'\]/g)).toHaveLength(2);
    expect(orchestrator.match(/attachManagedChildFatalIpc\(/g)).toHaveLength(2);
    expect(orchestrator).toContain('persistManagedChildFatalReport(child, report)');
    expect(orchestrator).toContain('persistManagedChildFatalReport(marketMakerChild, report)');
    expect(hubNode).toContain('await reportManagedChildFatal({');
    expect(mmNode).toContain('await reportManagedChildFatal({');
    expect(runtimeLoop).toContain('await config.onFatal({');
    expect(runtimeLoop).toContain('haltRuntimeRequiresOperator(env, error);');
    expect(runtimeLoop).not.toContain('.exit?.(1)');
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
    expect(deploy).toContain('EXPECTED_DEPLOY_SHA="$(git rev-parse --verify \'HEAD^{commit}\')"');
    expect(deploy).toContain("git cat-file -e '$EXPECTED_DEPLOY_SHA^{commit}'");
    expect(deploy).toContain("git merge-base --is-ancestor '$EXPECTED_DEPLOY_SHA' origin/main");
    expect(deploy).toContain("git checkout -B main '$EXPECTED_DEPLOY_SHA'");
    expect(deploy).toContain("git reset --hard '$EXPECTED_DEPLOY_SHA'");
    expect(deploy).not.toContain('git checkout -B main origin/main');
    expect(deploy).not.toContain('git reset --hard origin/main');
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
    const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    const vaultStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/vault/vaultStore.ts'), 'utf8');

    expect(runtimeCreation).toContain('buildRemoteRuntimeRecoveryPeerSources({ runtimeId: recoveryRuntimeId })');
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
    const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
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
    const paymentSmoke = readFileSync(join(repoRoot, 'tests/e2e/payments/e2e-payment-smoke.spec.ts'), 'utf8');
    const receiptHelper = readFileSync(join(repoRoot, 'tests/utils/e2e-runtime-receipts.ts'), 'utf8');

    expect(paymentSmoke).toContain("Boolean(env && typeof env === 'object' && String(env.runtimeId || '').trim())");
    expect(paymentSmoke).toContain('if (await hasActivityDebugQuery(page))');
    expect(paymentSmoke).toContain("page.getByTestId('entity-history-event').count()");
    expect(receiptHelper).toContain("throw new Error('PERSISTED_RUNTIME_ENV_UNAVAILABLE')");
    expect(receiptHelper).toContain("throw new Error('PERSISTED_RUNTIME_API_UNAVAILABLE')");
    expect(receiptHelper).not.toContain('catch {\n      return { cursor: { nextHeight }');
  });

  test('fresh browser runtimes replay EntityProvider authority from deployment', () => {
    const vaultStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/vault/vaultStore.ts'), 'utf8');
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
    const vaultStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/vault/vaultStore.ts'), 'utf8');
    const vaultRecovery = readFileSync(join(repoRoot, 'frontend/src/lib/stores/vault/vault-recovery.ts'), 'utf8');
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
    const runner = readFileSync(join(repoRoot, 'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts'), 'utf8');

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

  test('audit context exposes a deterministic comment-free Runtime profile with hashes', () => {
    const generator = readFileSync(join(repoRoot, 'scripts/debug/gpt.cjs'), 'utf8');

    expect(generator).toContain("flag: '--no-comments'");
    expect(generator).toContain("outputFilename: 'llms_no_comments.txt'");
    expect(generator).toContain("profile === 'nocomments'");
    expect(generator).toContain('stripSourceCommentsForAudit(file.content)');
    expect(generator).toContain('AUDIT_CONTEXT_CRITICAL_FILE_MISSING');
    expect(generator).toContain('sha256(chunk.content)');
    expect(generator).toContain('source=${file.sourceSha256}');
    expect(generator).not.toContain("'core/input-queue.ts'");

    const criticalList = generator.match(/const CORE_CRITICAL_RUNTIME_FILES = \[([\s\S]*?)\n\];/);
    if (!criticalList?.[1]) throw new Error('AUDIT_CONTEXT_CRITICAL_LIST_MISSING');
    const criticalFiles = [...criticalList[1].matchAll(/'([^']+)'/g)]
      .map((match) => match[1])
      .filter((value): value is string => typeof value === 'string');
    expect(criticalFiles.length).toBeGreaterThanOrEqual(15);
    for (const relativePath of criticalFiles) {
      const source = readFileSync(join(repoRoot, 'core', relativePath), 'utf8');
      const header = source.match(/^\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
      expect(header).toContain('Human-audit importance:');
      expect(header).toMatch(/Key (entrypoint|entrypoints|surface|builders|checks|functions|paths|projection|projections):/);
    }
  });

  test('start-server exposes the secondary Tron RPC to the orchestrator and children', () => {
    const script = readFileSync(join(repoRoot, 'scripts/operations/start-server.sh'), 'utf8');
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
    expect(script).not.toContain('MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE');
    expect(script).not.toContain('MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK');
    expect(script).not.toContain('MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK');

    const orchestrator = readFileSync(join(repoRoot, 'core/orchestrator/orchestrator.ts'), 'utf8');
    const marketMakerPoller = readFileSync(join(repoRoot, 'core/orchestrator/market-maker/health/market-maker-child-poll.ts'), 'utf8');
    const marketMakerAggregation = readFileSync(
      join(repoRoot, 'core/orchestrator/market-maker/health/market-maker-aggregated-health.ts'),
      'utf8',
    );
    const orchestratorConfig = readFileSync(join(repoRoot, 'core/orchestrator/orchestrator-config.ts'), 'utf8');
    const runtimeEntityRouting = readFileSync(join(repoRoot, 'core/runtime/delivery/topology/entity-routing.ts'), 'utf8');
    const runtimeLoopSource = readFileSync(join(repoRoot, 'core/runtime/loop/loop.ts'), 'utf8');
    const standaloneServer = readFileSync(join(repoRoot, 'core/api/server/index.ts'), 'utf8');
    const custodyBootstrap = readFileSync(join(repoRoot, 'core/orchestrator/bootstrap/custody-bootstrap.ts'), 'utf8');
    const cli = readFileSync(join(repoRoot, 'core/api/server/cli.ts'), 'utf8');
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
    expect(standaloneServer).toContain("import { selectPredeployedJurisdiction } from './catalog/predeployed-jurisdiction';");
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
    expect(custodyBootstrap).toContain('startupSignersJson: safeStringify([');
    expect(custodyBootstrap).toContain('...(options.additionalStartupSigners ?? [])');
    expect(standaloneServer).toContain('const STARTUP_SIGNERS = (() => {');
    expect(standaloneServer).toContain('localSigners: [');
    expect(standaloneServer).toContain('...STARTUP_SIGNERS');
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
      join(repoRoot, 'core/orchestrator/market-maker/health/market-maker-public-health.ts'),
      'utf8',
    );
    expect(snapshotEnrichment).toContain('const snapshotDepthExact = isExactMarketSnapshotOrderDepth');
    expect(snapshotEnrichment).toContain('const crossExpectedDepth = buildCrossExpectedDepth');
    expect(snapshotEnrichment).toContain('expectedBidOffers + expectedAskOffers === expectedOffers');
    expect(orchestrator).toContain('syncCanonicalJurisdictionsFromShard(jurisdictionsConfig)');
    expect(orchestrator).toContain(
      'const primaryJurisdiction = resolvePrimaryHubJurisdiction(jurisdictionsConfig);',
    );
    expect(orchestrator).toContain('jurisdictionId: primaryJurisdiction.key');
    expect(orchestrator).not.toContain("jurisdictionId: 'arrakis'");
    expect(cli).toContain("const REMOTE_RPC = process.env['XLN_CLI_REMOTE_RPC'] || 'https://xln.finance/rpc';");
    expect(cli).not.toContain('/rpc/arrakis');
    expect(readFileSync(join(repoRoot, 'core/orchestrator/j-select/jurisdictions.ts'), 'utf8')).toContain(
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
    const runtimeLifecycleSource = readFileSync(join(repoRoot, 'core/runtime/loop/loop-failure.ts'), 'utf8');
    expect(runtimeLifecycleSource).toContain('haltRuntimeRequiresOperator(env, error);');
    expect(runtimeLifecycleSource).not.toContain('.exit?.(1)');
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
    expect(orchestrator).not.toContain('XLN_MARKET_MAKER_SKIP_CROSS_BOOTSTRAP');
    expect(orchestrator).toContain('const getMarketMakerIdentities = (): MarketMakerSupportPeerIdentity[] => {');
    expect(orchestrator).toContain(
      'const getMarketMakerIdentities = (): MarketMakerSupportPeerIdentity[] => {\n  // Reset may atomically replace',
    );
    expect(orchestrator).toContain('resetMeshJurisdictionsCache();\n  const primary = resolveMeshJurisdictionConfig(args.rpcUrl);');
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

    const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
    const hubVisibleProfiles = readFileSync(
      join(repoRoot, 'core/orchestrator/hub/hub-visible-profiles.ts'),
      'utf8',
    );
    const bootstrapHub = readFileSync(join(repoRoot, 'scripts/bootstrap-hub.ts'), 'utf8');
    const serverJurisdictions = readFileSync(join(repoRoot, 'core/api/server/catalog/jurisdictions.ts'), 'utf8');
    const mmNode = readMarketMakerNodeSource();
    const runtimeTxHandlers = readFileSync(join(repoRoot, 'core/runtime/tx/tx-handlers.ts'), 'utf8');
    const jurisdictionImport = readFileSync(join(repoRoot, 'core/runtime/j-submit/jurisdiction-import.ts'), 'utf8');
    const jadapterTypes = readFileSync(join(repoRoot, 'core/jurisdiction/adapter/types.ts'), 'utf8');
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
    expect(hubNode).toContain("jurisdictionName: normalizeJurisdictionDisplayName(entry['jurisdictionName'])");
    expect(hubNode).toContain('SUPPORT_PEER_IDENTITIES_JSON_INVALID:malformed JSON');
    expect(hubNode).not.toContain('} catch {\n    return [];\n  }\n};\n\nconst resolvedArgs');
    expect(hubNode).not.toContain("normalized === 'arrakis'");
    expect(hubNode).not.toContain("normalized === 'wakanda'");
    expect(hubNode).not.toContain('PRIMARY_TESTNET_JURISDICTION_NAME');
    const meshJurisdictions = readFileSync(join(repoRoot, 'core/orchestrator/mesh/mesh-jurisdictions.ts'), 'utf8');
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
    expect(mmNode).not.toContain('isCanonicalAccountOpener(mmEntityId, hubEntityId)');
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
    expect(mmNode).toContain(
      'if (hasJurisdictionReplica(env, jurisdiction) && hasLiveJurisdictionAdapter(env, jurisdiction)) return;',
    );
    const runtimeSource = readFileSync(join(repoRoot, 'core/runtime/composition.ts'), 'utf8');
    const frameDispatchSource = readFileSync(join(repoRoot, 'core/runtime/frame/dispatch.ts'), 'utf8');
    const framePreparationSource = readFileSync(join(repoRoot, 'core/runtime/frame/lifecycle/prepare.ts'), 'utf8');
    const runtimeLoopWorkSource = readFileSync(join(repoRoot, 'core/runtime/loop/loop-work.ts'), 'utf8');
    const runtimeLoopLifecycleSource = readFileSync(join(repoRoot, 'core/runtime/loop/loop-lifecycle.ts'), 'utf8');
    expect(runtimeLoopLifecycleSource).toContain(
      'const tickDelayMs = Math.max(0, Math.floor(Number(config?.tickDelayMs ?? 0)));',
    );
    expect(runtimeLoopLifecycleSource).toContain('maxEntityInputsPerFrame?: number');
    expect(runtimeLoopLifecycleSource).toContain('maxEntityTxsPerFrame?: number');
    expect(runtimeLoopWorkSource).toContain('export const applyEntityInputFrameCap =');
    expect(runtimeLoopWorkSource).toContain('export const applyEntityTxFrameCap =');
    expect(runtimeLoopWorkSource).toContain('mempool.entityInputs = [...deferredInputs, ...mempool.entityInputs];');
    expect(runtimeSource).not.toContain('prepareCrossJurisdictionEntityInputs');
    const entityAdmissionSource = readFileSync(join(repoRoot, 'core/entity/consensus/input/admission.ts'), 'utf8');
    expect(entityAdmissionSource).toContain('appendDefaultProposerCrossJMaterializations');
    expect(framePreparationSource).not.toContain('prepareHtlcPaymentEntityInputs');
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
    expect(mmNode).toContain("import { MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS } from '../../orchestrator-config';");
    expect(orchestratorConfig).toContain("readPositiveIntegerEnv('MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS', 60_000)");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '1'");
    expect(mmNode).toContain("MARKET_MAKER_BOOTSTRAP_START_DELAY_MS'] || '0'");
    expect(mmNode).toContain("MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK'] || '5'");
    expect(mmNode).toContain("MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK'] || '1000'");
    expect(mmNode).not.toContain('MARKET_MAKER_BOOTSTRAP_DEFAULT_OFFERS_PER_ACCOUNT_PER_TICK');
    expect(mmNode).not.toContain('MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_OFFERS_PER_TICK');
    expect(mmNode).not.toContain('MARKET_MAKER_BOOTSTRAP_DEFAULT_CROSS_OFFERS_PER_ACCOUNT_PER_TICK');
    expect(mmNode).not.toContain('MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_CROSS_OFFERS_PER_TICK');
    expect(mmNode).not.toContain('const selectedPairs = new Set<string>();');
    expect(mmNode).toContain('await submitCrossJurisdictionIntents(input.deps.env, routes);');
    expect(mmNode).toContain('planMarketMakerBootstrapCrossQuoteRoutes(');
    expect(mmNode).toContain('export const MARKET_MAKER_LEVELS_PER_SIDE = 10;');
    expect(mmNode).toContain("MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE'] || '1000'");
    expect(mmNode).toContain('pairs.slice(0, MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE)');
    expect(mmNode).not.toContain("MARKET_MAKER_MAX_LEVELS_PER_PAIR']");
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
    expect(mmNode).not.toContain('MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE');
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
    expect(mmNode).toContain('const quoteBatch = mergeMarketMakerQuoteEntityInputs(');
    expect(mmNode).toContain('enqueueRuntimeInput(deps.env, { runtimeTxs: [], entityInputs: quoteBatch });');
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
    expect(mmNode).not.toContain('bootstrapCrossCursor');
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
    expect(mmNode).toContain("emitMarketMakerCrossBootstrapWaveEvent('cross-wave-source-hub'");
    expect(mmNode).not.toContain('launch one per-account settlement wave and wait for');
    expect(mmNode).not.toContain('MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK');
    expect(mmNode).toContain('bootstrapCrossStarted: false,');
    expect(mmNode).toContain('readModel.allSameDepthReady(readVisibleHubProfiles(env, true))');
    expect(mmNode).not.toContain('\n      state.bootstrapCrossStarted = false;');
    expect(mmNode).toContain('const previousPhase = state.phase;');
    expect(mmNode).toContain('if (state.phase === previousPhase) return;');
    expect(mmNode).toContain('rebuildCachedHealthResponseJson();');
    expect(mmNode).toContain("state.phase = 'bootstrap-cross';");
    expect(mmNode).toContain('input.state.bootstrapCrossBatchSubmitted = true;');
    expect(mmNode).not.toContain('bootstrapCrossCursor');
    expect(mmNode).toContain("if (mode === 'steady') state.steadyCrossCursor = selection.nextCursor;");
    expect(mmNode).not.toContain('deferredBootstrapCrossInputs');
    expect(mmNode).toContain('sourceHubs,');
    expect(mmNode).toContain('targetHubs,');
    expect(mmNode).toContain("if (input.mode === 'bootstrap') {");
    expect(mmNode.replace(/\s+/g, '')).toContain(
      'allSameDepthReady(readVisibleHubProfiles(deps.env,true))&&isMarketMakerDepthComplete(health)',
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
    expect(mmNode).toContain('await submitCrossJurisdictionIntents(input.deps.env, routes);');
    expect(mmNode).toContain('cross.routes.every((route) => route.depthReady)');
    expect(mmNode).toContain('ok: hubsDepthReady && crossDepthReady');
    expect(mmNode).toContain('countCommittedMarketMakerOffersForHub(env, context.entityId, hubEntityId)');
    expect(mmNode).toContain('countCommittedMarketMakerOffersForHubPair(env, context.entityId, hubEntityId, pair)');
    expect(mmNode).toContain('return blocker ? [blocker] : [];');
    expect(mmNode).toContain('accountReady && expectedPairOffers > 0');
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
      'const hasCommittedSourceAccountCrossOffer = (env: RuntimeReplica, route: CrossJurisdictionSwapRoute): boolean => {',
    );
    expect(mmNode).toContain(
      'const hasPendingSourceAccountCrossOffer = (env: RuntimeReplica, route: CrossJurisdictionSwapRoute): boolean => {',
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
    expect(healthControllerBlock).not.toContain('MARKET_MAKER_SKIP_CROSS_BOOTSTRAP');
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
    expect(mmNode.replace(/\s+/g, '')).toContain(
      'constdesiredOffers=buildMarketMakerOfferSpecs(quoteReadyHubEntityIds,tokenIds,samePairIndex,);',
    );
    const sameChainQuotes = mmNode.slice(
      mmNode.indexOf('export const planMarketMakerQuoteEntityInputs = ('),
      mmNode.indexOf('export const maintainMarketMakerQuotes = async ('),
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
    expect(hubNode).toContain('configuredOwnerIndex > configuredPeerIndex');
    expect(hubNode).toContain('H2/H3 open toward H1 and H3');
  });
});
