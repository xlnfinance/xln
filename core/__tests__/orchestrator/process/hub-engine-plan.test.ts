import { buildRustHubPeerRoutes } from '../../../orchestrator/process/spawn/hub';
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
import { readPositiveIntegerEnv } from '../../../config/environment';
import { buildPublicDirectWsUrl } from '../../../orchestrator/replica-import/runtime-import-manifest';
import { safeStringify } from '../../../protocol/serialization';
import { planNativeHubBootstrapPeers } from '../../../orchestrator/process/reset-startup';

test('native two-jurisdiction bootstrap requires primary hub mesh and every MM owner in input order', () => {
  const owner = (name: string, jurisdictionName: string) => ({
    entityId: `${name}:${jurisdictionName}`, signerId: `${name}:${jurisdictionName}:signer`, jurisdictionName,
  });
  const primary = owner('H1', 'Testnet');
  const secondary = owner('H1', 'Tron');
  const hubs = ['H2', 'H3'].map(name => ({ name, owners: [owner(name, 'Tron'), owner(name, 'Testnet')] }));
  const support = [
    ...Array.from({ length: 3 }, (_, index) => ({ name: `MM${index + 1}`, chainId: 31337, ...owner(`MM${index + 1}`, 'Testnet'), depositoryAddress: 'testnet-depository' })),
    ...Array.from({ length: 10 }, (_, index) => ({ name: `MM${index + 1}`, chainId: 31338, ...owner(`MM${index + 1}`, 'Tron'), depositoryAddress: 'tron-depository' })),
  ];
  // Native info is key-ordered: the secondary owner may precede the primary.
  const peers = planNativeHubBootstrapPeers(primary.entityId, [secondary, primary], hubs, support);
  expect(peers).toHaveLength(15);
  expect(peers.map(peer => [peer.entityId, peer.ownerEntityId, peer.ownerSignerId, peer.tokenIds])).toEqual([
    ...Array.from({ length: 10 }, (_, index) => [`MM${index + 1}:Tron`, secondary.entityId, secondary.signerId, [1, 2, 3, 4, 5]]),
    ...['H2', 'H3'].map(name => [`${name}:Testnet`, primary.entityId, primary.signerId, [1, 3, 2]]),
    ...Array.from({ length: 3 }, (_, index) => [`MM${index + 1}:Testnet`, primary.entityId, primary.signerId, [1, 2, 3]]),
  ]);
  expect(peers.filter(peer => peer.isHub).map(peer => peer.name)).toEqual(['H2', 'H3']);
  expect(planNativeHubBootstrapPeers(primary.entityId, [secondary, primary], hubs, [])).toEqual(peers.filter(peer => peer.isHub));
});

test('the explicit plan engine selects H1 while H2/H3 remain TypeScript', () => {
  expect(['H1', 'H2', 'H3'].map(name => canonicalHubEngine(name, { XLN_HLT_ENGINE: 'ts' }))).toEqual([
    'typescript',
    'typescript',
    'typescript',
  ]);
  expect(['H1', 'H2', 'H3'].map(name => canonicalHubEngine(name, { XLN_HLT_ENGINE: 'rust' }))).toEqual([
    'rust',
    'typescript',
    'typescript',
  ]);
  expect(canonicalHubEngine('H1', {})).toBe('typescript');
  expect(() => canonicalHubEngine('H1', { XLN_HLT_ENGINE: 'native' })).toThrow('HUB_ENGINE_SELECTOR_INVALID:native');
  expect(() => canonicalHubEngine('MM')).toThrow('HUB_ENGINE_NAME_INVALID:MM');
});

test('mesh supervisor dispatches canonical per-hub process kinds', () => {
  const supervisor = readFileSync(join(import.meta.dir, '../../../orchestrator/orchestrator.ts'), 'utf8');
  const hubSpawner = readFileSync(join(import.meta.dir, '../../../orchestrator/process/spawn/hub.ts'), 'utf8');
  const source = `${supervisor}\n${hubSpawner}`;
  expect(supervisor).toContain('const engine = canonicalHubEngine(name)');
  expect(supervisor).toContain('engine,');
  expect(hubSpawner).toContain("child.engine === 'rust'");
  expect(hubSpawner).toContain("{ executable: 'bun', processArgs, rustIdentity: null }");
  expect(supervisor).toContain("? 'rscore/target/release/xlnrs'");
  expect(hubSpawner).toContain('stdio: invocation.rustIdentity');
  expect(supervisor).toContain('driveH1Bootstrap(h1, shouldStartMarketMaker)');
  expect(supervisor).toContain("if (h1.engine === 'rust') {");
  expect(supervisor).toContain('child.lastInfo?.hubEntities?.some(entity => entity.entityId)');
  expect(supervisor).toContain('/api/control/runtime/entity-inputs');
  expect(supervisor).toContain('/api/account/status');
  expect(source).not.toContain('offlineTsImport');
  expect(source).not.toContain('rust-handoff');
  expect(hubSpawner).toContain("const custodyRuntimeSeed = deps.runtimeSeedFor('CUSTODY')");
  expect(hubSpawner).toMatch(/const routes = \[\s*\.\.\.hubRoutes,\s*\.\.\.supportRoutes/);
});

test('dev verifies native bytes only when the explicit engine selects Rust H1', () => {
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
  expect(preflight).toContain("if (selectedEngine === 'rust')");
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
  expect(smoke).toContain("assertRustHubBinaryFresh(repoRoot, process.env['XLN_RSCORE_BINARY'])");
});

test('Rust H1 process plan has no TS bootstrap/import/handoff path', () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-rust-h1-plan-'));
  const binary = join(root, 'xlnrs');
  writeFileSync(binary, 'binary');
  try {
    const plan = buildRustHubProcessPlan({
      name: 'H1',
      apiHost: '127.0.0.1',
      apiPort: 18090,
      directHost: '127.0.0.1',
      directPort: readPositiveIntegerEnv('XLN_RSCORE_DIRECT_PORT', 8090, { XLN_RSCORE_DIRECT_PORT: '18094' }),
      dbPath: join(root, 'h1'),
      runtimeSeedFile: join(root, 'seed'),
      entityKeyFile: join(root, 'entity-key'),
      routesFile: join(root, 'routes.json'),
      genesisFile: join(root, 'genesis.json'),
      jurisdictionsPath: join(root, 'jurisdictions.json'),
      runtimeSignerLabel: '1',
      entitySignerLabel: 'h1-hub',
      primaryEntityId: `0x${'11'.repeat(32)}`,
      workers: 8,
      binary,
    });
    expect(plan.executable).toBe(binary);
    expect(plan.args[plan.args.indexOf('--api-bind') + 1]).toBe('127.0.0.1:18090');
    expect(plan.args[plan.args.indexOf('--bind') + 1]).toBe('127.0.0.1:18094');
    expect(buildPublicDirectWsUrl('wss://xln.finance', 8090)).toBe('wss://xln.finance:8090/ws');
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
  expect(() =>
    buildRustHubProcessPlan({
      name: 'H1',
      apiHost: '127.0.0.1',
      apiPort: 21001,
      directHost: '127.0.0.1',
      directPort: 21001,
      dbPath: '/tmp/h1',
      runtimeSeedFile: '/tmp/seed',
      entityKeyFile: '/tmp/key',
      routesFile: '/tmp/routes',
      genesisFile: '/tmp/genesis',
      jurisdictionsPath: '/tmp/j',
      runtimeSignerLabel: '1',
      entitySignerLabel: 'h1-hub',
      primaryEntityId: `0x${'11'.repeat(32)}`,
      workers: 8,
      binary: process.execPath,
    }),
  ).toThrow('RUST_HUB_LISTENER_COLLISION:127.0.0.1:21001');
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
    expect(() => assertRustHubBinaryFresh(root)).toThrow('RUST_HUB_BINARY_STALE:');
    utimesSync(binary, now, now);
    expect(assertRustHubBinaryFresh(root)).toBe(binary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Rust stdout readiness is strict and process-owned', () => {
  expect(parseRustHubStatus('noise')).toBeNull();
  expect(
    parseRustHubStatus(
      safeStringify({
        status: 'ready',
        runtimeId: `0x${'11'.repeat(20)}`,
        listen: '127.0.0.1:22001',
        height: 0,
      }),
    ),
  ).toEqual({
    status: 'ready',
    runtimeId: `0x${'11'.repeat(20)}`,
    listen: '127.0.0.1:22001',
    height: 0,
  });
});

test('a malformed Rust status line is rejected without throwing out of the stdout listener', () => {
  expect(parseRustHubStatus('{"status":"ready","height":0}')).toBeNull();
  expect(parseRustHubStatus('{"status":"metrics","height":-1}')).toBeNull();
  expect(parseRustHubStatus('{"status":"metrics","height":"7"}')).toBeNull();
  expect(parseRustHubStatus('{"status":"metrics","height":7}')).toEqual({ status: 'metrics', height: 7 });
});

test.each([
  { primaryJurisdictionOnly: false, nativeTron: false },
  { primaryJurisdictionOnly: true, nativeTron: false },
  { primaryJurisdictionOnly: false, nativeTron: true },
])('Rust H1 genesis preserves owner selection and explicit native receipt policy (%j)', ({ primaryJurisdictionOnly, nativeTron }) => {
  const address = (byte: string): string => `0x${byte.repeat(40)}`;
  const genesis = buildRustHubGenesisConfig({
    name: 'H1',
    runtimeId: address('1'),
    seed: 'native-genesis-test',
    primaryJurisdictionOnly,
    signerLabel: 'h1-hub',
    jurisdictionsJson: safeStringify({
      jurisdictions: {
        arrakis: {
          name: 'Testnet',
          primary: true,
          status: 'active',
          chainId: 31337,
          rpc: '/rpc',
          blockTimeMs: 10_000,
          entityProviderDeploymentBlock: 3,
          contracts: {
            account: address('3'),
            depository: address('4'),
            entityProvider: address('5'),
            deltaTransformer: address('6'),
          },
          tokenRegistry: [
            {
              symbol: 'USDC',
              name: 'USD Coin',
              address: address('7'),
              decimals: 6,
              tokenId: 1,
              tokenType: 0,
              externalTokenId: '0',
            },
          ],
        },
        tron: {
          ...(nativeTron ? { mode: 'tron', tronFullHost: 'http://127.0.0.1:19090', tronSolidityHost: 'http://127.0.0.1:19091' } : {}),
          name: 'Tron',
          primary: false,
          status: 'active',
          chainId: 31338,
          rpc: '/rpc2',
          blockTimeMs: 3_000,
          entityProviderDeploymentBlock: 3,
          contracts: {
            account: address('3'),
            depository: address('4'),
            entityProvider: address('5'),
            deltaTransformer: address('6'),
          },
          tokenRegistry: [
            {
              symbol: 'USDC',
              name: 'USD Coin',
              address: address('7'),
              decimals: 6,
              tokenId: 1,
              tokenType: 0,
              externalTokenId: '0',
            },
          ],
        },
      },
    }),
    rpcUrls: { 1: 'http://127.0.0.1:8545', 2: 'http://127.0.0.1:8546' },
    minFrameDelayMs: 5,
  }) as {
    machine: { runtimeId: string; activeJurisdiction: string; jReplicas: unknown[] };
    entities: { signerLabel: string; entityProfile: { name: string; isHub: boolean } }[];
  };
  expect(genesis.machine.runtimeId).toBe(address('1'));
  expect(genesis.machine.activeJurisdiction).toBe('Testnet');
  expect(genesis.machine.jReplicas).toHaveLength(primaryJurisdictionOnly ? 1 : 2);
  expect(genesis.entities.map(owner => owner.signerLabel)).toEqual(primaryJurisdictionOnly ? ['h1-hub'] : ['h1-hub', 'h1-hub:Tron']);
  expect(genesis).not.toHaveProperty('entityProfile');
  for (const owner of genesis.entities) expect(owner.entityProfile).toMatchObject({ name: 'H1', isHub: true });
  expect(safeStringify(genesis.machine.jReplicas)).toContain('tokenRegistry');
  expect(safeStringify(genesis.machine.jReplicas).includes('tron-rpc-attested')).toBe(nativeTron);
  expect(genesis.entities[0]!.entityProfile).toMatchObject({ name: 'H1', isHub: true });
  expect(safeStringify(genesis)).not.toContain('checkpoint');
  expect(safeStringify(genesis)).not.toContain('import');
});

test('native restart retains configured peer dialing routes without transient gossip', () => {
  const peers = ['H1', 'H2', 'H3'].map((name, index) => ({
    name, seed: `restart-route-${name}`, signerLabel: `hub-${index + 1}`, publicPort: 8090 + index,
  }));
  const routes = buildRustHubPeerRoutes('H1', peers, 'wss://xln.finance');
  expect(routes).toHaveLength(2);
  expect(routes.map(route => route.websocketUrl)).toEqual(['wss://xln.finance:8091/ws', 'wss://xln.finance:8092/ws']);
  expect(new Set(routes.map(route => route.targetRuntimeId)).size).toBe(2);
  expect(buildRustHubPeerRoutes('H1', peers, 'ws://127.0.0.1').map(route => route.websocketUrl))
    .toEqual(['ws://127.0.0.1:8091/ws', 'ws://127.0.0.1:8092/ws']);
});
