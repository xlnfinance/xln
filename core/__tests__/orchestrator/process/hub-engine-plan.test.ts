import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

import {
  assertRustHubBinaryFresh,
  buildRustHubProcessPlan,
  canonicalHubEngine,
  parseRustHubStatus,
} from '../../../orchestrator/process/hub-engine-plan';
import { buildRustHubGenesisConfig } from '../../../orchestrator/process/rust-hub-genesis';
import { safeStringify } from '../../../protocol/serialization';

test('canonical dev topology is Rust H1 and TypeScript H2/H3', () => {
  expect(['H1', 'H2', 'H3'].map(canonicalHubEngine)).toEqual([
    'rust', 'typescript', 'typescript',
  ]);
  expect(() => canonicalHubEngine('MM')).toThrow('HUB_ENGINE_NAME_INVALID:MM');
});

test('mesh supervisor dispatches canonical per-hub process kinds', () => {
  const supervisor = readFileSync(
    join(import.meta.dir, '../../../orchestrator/orchestrator.ts'),
    'utf8',
  );
  const hubSpawner = readFileSync(
    join(import.meta.dir, '../../../orchestrator/process/spawn/hub.ts'),
    'utf8',
  );
  const source = `${supervisor}\n${hubSpawner}`;
  expect(supervisor).toContain('const engine = canonicalHubEngine(name)');
  expect(supervisor).toContain('engine,');
  expect(hubSpawner).toContain("child.engine === 'rust'");
  expect(hubSpawner).toContain("{ executable: 'bun', processArgs, rustIdentity: null }");
  expect(hubSpawner).toContain('directWsUrl: `ws://${status.listen}/ws`');
  expect(supervisor).toContain("? 'rscore/target/release/xlnrs'");
  expect(hubSpawner).toContain('stdio: invocation.rustIdentity');
  expect(supervisor).toContain('driveNativeH1Bootstrap(h1, shouldStartMarketMaker)');
  expect(supervisor).toContain('/api/control/runtime/entity-inputs');
  expect(supervisor).toContain('/api/account/status');
  expect(source).not.toContain('offlineTsImport');
  expect(source).not.toContain('rust-handoff');
  expect(hubSpawner).toContain("const custodyRuntimeSeed = deps.runtimeSeedFor('CUSTODY')");
  expect(hubSpawner).toContain('const routes = [...hubRoutes, ...supportRoutes');
});

test('dev lets Cargo verify native H1 before orchestration inside one bounded process', () => {
  const launcher = readFileSync(join(import.meta.dir, '../../../../scripts/dev/run-dev.ts'), 'utf8');
  const preflight = readFileSync(
    join(import.meta.dir, '../../../../scripts/dev/checks/check-rscore-runtime-freshness.ts'),
    'utf8',
  );
  const freshness = launcher.indexOf('check-rscore-runtime-freshness.ts');
  const prepare = launcher.indexOf('scripts/dev/prepare-start.sh');
  expect(freshness).toBeGreaterThan(-1);
  expect(prepare).toBeGreaterThan(freshness);
  expect(preflight).toContain('const BUILD_TIMEOUT_MS = 30_000');
  expect(preflight).toContain('if (stopping) return stopping');
  expect(preflight).toContain('await buildNativeH1()');
  expect(preflight).toContain('utimesSync(runtimeBinary');
  expect(preflight).toContain('assertRustHubBinaryFresh(repositoryRoot)');
});

test('live Rust H1 smoke rejects a stale production binary', () => {
  const smoke = readFileSync(
    join(import.meta.dir, '../../../scripts/operations/production/local-prod-smoke.ts'),
    'utf8',
  );
  expect(smoke).toContain("if (process.env['XLN_HLT_ENGINE'] === 'rust')");
  expect(smoke).toContain(
    "assertRustHubBinaryFresh(repoRoot, process.env['XLN_RSCORE_BINARY'])",
  );
});

test('Rust H1 process plan has no TS bootstrap/import/handoff path', () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-rust-h1-plan-'));
  const binary = join(root, 'xlnrs');
  writeFileSync(binary, 'binary');
  try {
    const plan = buildRustHubProcessPlan({
      name: 'H1', apiHost: '127.0.0.1', apiPort: 21001,
      directHost: '127.0.0.1', directPort: 22001,
      dbPath: join(root, 'h1'), runtimeSeedFile: join(root, 'seed'),
      entityKeyFile: join(root, 'entity-key'), routesFile: join(root, 'routes.json'),
      genesisFile: join(root, 'genesis.json'),
      jurisdictionsPath: join(root, 'jurisdictions.json'), runtimeSignerLabel: '1',
      entitySignerLabel: 'h1-hub', primaryEntityId: `0x${'11'.repeat(32)}`,
      workers: 8, binary,
    });
    expect(plan.executable).toBe(binary);
    expect(plan.args).toContain('--jurisdictions');
    expect(plan.args).toContain('--genesis-config');
    expect(plan.args).toContain('--primary-entity-id');
    expect(plan.args).not.toContain('--offline-ts-import');
    expect(plan.args.join(' ')).not.toContain('hub-node.ts');
    expect(plan.args.join(' ')).not.toContain('handoff');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Rust H1 refuses to bind its HTTP and direct listeners to one socket', () => {
  expect(() => buildRustHubProcessPlan({
    name: 'H1', apiHost: '127.0.0.1', apiPort: 21001,
    directHost: '127.0.0.1', directPort: 21001,
    dbPath: '/tmp/h1', runtimeSeedFile: '/tmp/seed', entityKeyFile: '/tmp/key',
    routesFile: '/tmp/routes', genesisFile: '/tmp/genesis', jurisdictionsPath: '/tmp/j',
    runtimeSignerLabel: '1', entitySignerLabel: 'h1-hub',
    primaryEntityId: `0x${'11'.repeat(32)}`, workers: 8,
    binary: process.execPath,
  })).toThrow('RUST_HUB_LISTENER_COLLISION:127.0.0.1:21001');
});

test('dev freshness detector rejects stale native H1 bytes before the bounded build', () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-rust-h1-fresh-'));
  const source = join(root, 'rscore/crates/runtime/src/lib.rs');
  const binary = join(root, 'rscore/target/release/xlnrs');
  mkdirSync(join(root, 'rscore/crates/runtime/src'), { recursive: true });
  mkdirSync(join(root, 'rscore/target/release'), { recursive: true });
  writeFileSync(source, 'source');
  writeFileSync(binary, 'binary');
  try {
    const now = new Date();
    const older = new Date(now.getTime() - 1_000);
    utimesSync(binary, older, older);
    utimesSync(source, now, now);
    expect(() => assertRustHubBinaryFresh(root)).toThrow(
      'RUST_HUB_BINARY_STALE:',
    );
    utimesSync(binary, now, now);
    expect(assertRustHubBinaryFresh(root)).toBe(binary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Rust stdout readiness is strict and process-owned', () => {
  expect(parseRustHubStatus('noise')).toBeNull();
  expect(parseRustHubStatus(safeStringify({
    status: 'ready', runtimeId: `0x${'11'.repeat(20)}`, listen: '127.0.0.1:22001', height: 0,
  }))).toEqual({
    status: 'ready', runtimeId: `0x${'11'.repeat(20)}`, listen: '127.0.0.1:22001', height: 0,
  });
  expect(() => parseRustHubStatus('{"status":"ready","height":0}'))
    .toThrow('RUST_HUB_READY_IDENTITY_INVALID');
});

test('Rust H1 genesis is explicit native machine configuration, not imported state', () => {
  const address = (byte: string): string => `0x${byte.repeat(40)}`;
  const genesis = buildRustHubGenesisConfig({
    name: 'H1',
    runtimeId: address('1'),
    primaryEntitySignerLabel: 'hub-1',
    entityEncryptionPublicKeys: { Testnet: `0x${'22'.repeat(32)}` },
    jurisdictionsJson: safeStringify({
      jurisdictions: {
        arrakis: {
          name: 'Testnet', primary: true, status: 'active', chainId: 31337,
          rpc: '/rpc', blockTimeMs: 10_000, entityProviderDeploymentBlock: 3,
          contracts: {
            account: address('3'), depository: address('4'),
            entityProvider: address('5'), deltaTransformer: address('6'),
          },
          tokenRegistry: [{
            symbol: 'USDC', name: 'USD Coin', address: address('7'), decimals: 6,
            tokenId: 1, tokenType: 0, externalTokenId: '0',
          }],
        },
      },
    }),
    rpcUrls: { 1: 'http://127.0.0.1:8545' },
    minFrameDelayMs: 5,
  }) as {
    machine: { runtimeId: string; activeJurisdiction: string; jReplicas: unknown[] };
    entities: Array<{
      signerLabel: string;
      primary: boolean;
      contextPolicy: { pairPolicies: unknown[] };
      profile: { name: string; isHub: boolean };
    }>;
  };
  expect(genesis.machine.runtimeId).toBe(address('1'));
  expect(genesis.machine.activeJurisdiction).toBe('Testnet');
  expect(genesis.machine.jReplicas).toHaveLength(1);
  expect(safeStringify(genesis.machine.jReplicas)).toContain('tokenRegistry');
  expect(genesis.entities).toHaveLength(1);
  expect(genesis.entities[0]?.signerLabel).toBe('hub-1');
  expect(genesis.entities[0]?.primary).toBe(true);
  expect(genesis.entities[0]?.contextPolicy.pairPolicies).toHaveLength(3);
  expect(genesis.entities[0]?.profile).toMatchObject({ name: 'H1', isHub: true });
  expect(safeStringify(genesis)).not.toContain('checkpoint');
  expect(safeStringify(genesis)).not.toContain('import');
});

test('Rust H1 genesis creates one canonical Entity per active jurisdiction', () => {
  const address = (byte: string): string => `0x${byte.repeat(40)}`;
  const jurisdiction = (name: string, chainId: number, rpc: string, primary: boolean) => ({
    name, primary, status: 'active', chainId, rpc, blockTimeMs: 10_000,
    entityProviderDeploymentBlock: 3,
    contracts: {
      account: address('3'), depository: address('4'),
      entityProvider: address('5'), deltaTransformer: address('6'),
    },
    tokenRegistry: [{
      symbol: 'USDC', name: 'USD Coin', address: address('7'), decimals: 6,
      tokenId: 1, tokenType: 0, externalTokenId: '0',
    }],
  });
  const genesis = buildRustHubGenesisConfig({
    name: 'H1',
    runtimeId: address('1'),
    primaryEntitySignerLabel: 'hub-1',
    entityEncryptionPublicKeys: {
      Testnet: `0x${'22'.repeat(32)}`,
      Sibling: `0x${'33'.repeat(32)}`,
    },
    jurisdictionsJson: safeStringify({
      jurisdictions: {
        arrakis: jurisdiction('Testnet', 31337, '/rpc', true),
        sibling: jurisdiction('Sibling', 31338, '/rpc2', false),
      },
    }),
    rpcUrls: {
      1: 'http://127.0.0.1:8545',
      2: 'http://127.0.0.1:8546',
    },
    minFrameDelayMs: 0,
  }) as { entities: Array<{ signerLabel: string; primary: boolean }> };
  expect(genesis.entities).toEqual([
    expect.objectContaining({ signerLabel: 'hub-1', primary: true }),
    expect.objectContaining({ signerLabel: 'hub-1:Sibling', primary: false }),
  ]);
});
