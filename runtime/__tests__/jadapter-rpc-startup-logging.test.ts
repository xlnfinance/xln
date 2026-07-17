import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('rpc jadapter startup and watcher lifecycle logs stay structured', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/jadapter/rpc.ts'), 'utf8');

  expect(source).toContain("const rpcLog = createStructuredLogger('jadapter.rpc');");
  for (const noisyStartupString of [
    'fromReplica mode - connecting to contracts',
    'connected to existing contracts',
    'Using existing contracts',
    'Deploying stack',
    'Depository pre-funded',
    'TokenRegistry:',
    'Stack deployed',
    'watcher already running',
    'starting event watcher',
    'watcher started',
    'watcher stopped',
  ]) {
    expect(source, noisyStartupString).not.toContain(noisyStartupString);
  }
  expect(source).toContain("rpcLog.info('contracts.deploy.ready'");
  expect(source).toContain("rpcLog.info('watcher.ready'");
});

test('runtime dev startup status logs stay structured', () => {
  const runtime = readFileSync(join(process.cwd(), 'runtime/runtime.ts'), 'utf8');
  const hubNode = readFileSync(join(process.cwd(), 'runtime/orchestrator/hub-node.ts'), 'utf8');
  const marketMakerNode = readFileSync(join(process.cwd(), 'runtime/orchestrator/mm-node.ts'), 'utf8');
  const orchestrator = readFileSync(join(process.cwd(), 'runtime/orchestrator/orchestrator.ts'), 'utf8');
  const wsClient = readFileSync(join(process.cwd(), 'runtime/networking/ws-client.ts'), 'utf8');
  const bootstrapHub = readFileSync(join(process.cwd(), 'scripts/bootstrap-hub.ts'), 'utf8');
  const localConfig = readFileSync(join(process.cwd(), 'runtime/jadapter/local-config.ts'), 'utf8');
  const logger = readFileSync(join(process.cwd(), 'runtime/infra/logger.ts'), 'utf8');
  const devRunner = readFileSync(join(process.cwd(), 'scripts/dev/run-dev.sh'), 'utf8');
  const runtimeConsoleLines = runtime
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('console.'));

  expect(runtime).not.toContain('console.log(`JAdapter watcher started for jReplica');
  expect(runtime).toContain("runtimeLog.debug('jadapter_watcher.started'");
  expect(runtime).toContain("throw new Error('RUNTIME_DB_CLOSE_LOOP_DRAIN_TIMEOUT')");
  expect(runtime).toContain("throwSettledErrors(shutdown, 'RUNTIME_DB_CLOSE_QUIESCE_FAILED')");
  expect(runtime).toContain("runtimeLog.error('loop.error'");
  expect(runtimeConsoleLines).toEqual([
    "console.log(`\\n⏸️  FRAME STEPPING: Stopped at frame ${env.height}`);",
    "console.log('═'.repeat(80));",
    'console.log(formatRuntime(env, { maxAccounts: 10, maxLocks: 20, maxSwaps: 20 }));',
    "console.log('═'.repeat(80) + '\\n');",
    "console.log('💾 State captured - use jq on /tmp/{scenario}-runtime.json for deep queries');",
  ]);

  expect(hubNode).not.toContain('RPC contracts have no code; deploying fresh stack instead of using stale addresses:');
  expect(hubNode).toContain("nodeLog.error('jurisdiction_contracts.code_missing'");
  expect(hubNode).toContain("nodeLog.error('jurisdictions_file.invalid'");
  expect(hubNode).not.toContain('Ignore malformed local file and keep falling back');
  expect(hubNode).toContain("nodeLog.info('bootstrap_ready_snapshot.persisted'");
  expect(hubNode).not.toContain('console.log(`Importing sibling hub jurisdiction');
  expect(hubNode).not.toContain('console.log(`Sibling hub ready');
  expect(hubNode).toContain("nodeLog.debug('sibling_jurisdiction.importing'");
  expect(hubNode).toContain("nodeLog.debug('sibling_jurisdiction.ready'");
  expect(marketMakerNode).not.toContain('console.log(`[MESH-MM] BOOTSTRAP_READY_SNAPSHOT_PERSISTED');
  expect(marketMakerNode).not.toContain('BOOTSTRAP_READY_HASH hash=${fingerprint.hash}');
  expect(marketMakerNode).not.toContain('console.log(`[MESH-MM] Sibling MM ready');
  expect(marketMakerNode).not.toContain('Token universe for market making:');
  expect(marketMakerNode).toContain("nodeLog.info('bootstrap.ready_snapshot.persisted'");
  expect(marketMakerNode).toContain("nodeLog.info('bootstrap.ready_hash'");
  expect(marketMakerNode).toContain("nodeLog.debug('sibling_mm.ready'");
  expect(marketMakerNode).toContain("nodeLog.debug('token_universe.ready'");
  expect(orchestrator).not.toContain('console.log(`HUB_READY_SNAPSHOTS_PERSISTED');
  expect(orchestrator).toContain("meshLog.info('hub_ready_snapshots.persisted'");
  expect(orchestrator).not.toContain('[MESH] runtime import manifest refresh failed');
  expect(orchestrator).toContain("meshLog.warn('runtime_import_manifest.refresh_failed'");
  expect(wsClient).not.toContain('console.log(`[WS] Connected to ${this.options.url}`)');
  expect(wsClient).toContain("const wsLog = createStructuredLogger('runtime.wsClient');");
  expect(wsClient).toContain("wsLog.debug('connected'");
  expect(localConfig).not.toContain('console.log(');
  expect(localConfig).toContain("const localConfigLog = createStructuredLogger('jadapter.localConfig');");
  expect(localConfig).toContain("localConfigLog.debug('default_dispute_delay.ready'");
  expect(logger).toContain("process.env['XLN_LOG_WARN_STDOUT'] === '1' ? console.log : console.warn");
  expect(devRunner).toContain('XLN_LOG_WARN_STDOUT="${XLN_LOG_WARN_STDOUT:-1}"');
  expect(devRunner).toContain('RUNTIME_VERBOSE_LOGS XLN_LOG_WARN_STDOUT');

  for (const noisyBootstrapString of [
    '[BOOTSTRAP] Starting hub bootstrap',
    '[BOOTSTRAP] Name:',
    '[BOOTSTRAP] Region:',
    '[BOOTSTRAP] Signer:',
    '[BOOTSTRAP] Creating hub entity',
    '[BOOTSTRAP] Gossip verification:',
    '[BOOTSTRAP] hub bootstrap complete',
  ]) {
    expect(bootstrapHub, noisyBootstrapString).not.toContain(noisyBootstrapString);
  }
  expect(bootstrapHub).toContain("bootstrapLog.info('hub.ready'");
});
