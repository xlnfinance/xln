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
  const bootstrapHub = readFileSync(join(process.cwd(), 'scripts/bootstrap-hub.ts'), 'utf8');

  expect(runtime).not.toContain('console.log(`JAdapter watcher started for jReplica');
  expect(runtime).toContain("runtimeLog.debug('jadapter_watcher.started'");

  expect(hubNode).not.toContain('RPC contracts have no code; deploying fresh stack instead of using stale addresses:');
  expect(hubNode).toContain("nodeLog.info('jurisdiction_contracts.stale_dropped'");
  expect(hubNode).toContain("nodeLog.info('bootstrap_ready_snapshot.persisted'");
  expect(marketMakerNode).not.toContain('console.log(`[MESH-MM] BOOTSTRAP_READY_SNAPSHOT_PERSISTED');
  expect(marketMakerNode).not.toContain('BOOTSTRAP_READY_HASH hash=${fingerprint.hash}');
  expect(marketMakerNode).toContain("nodeLog.info('bootstrap.ready_snapshot.persisted'");
  expect(marketMakerNode).toContain("nodeLog.info('bootstrap.ready_hash'");
  expect(orchestrator).not.toContain('console.log(`HUB_READY_SNAPSHOTS_PERSISTED');
  expect(orchestrator).toContain("meshLog.info('hub_ready_snapshots.persisted'");

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
