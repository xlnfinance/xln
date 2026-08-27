import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveEncryptionKeyPair, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import { deriveMeshChildSeed } from '../../../orchestrator/mesh/mesh-seeds';
import {
  HLT_PROFILE_PLAN,
  deriveEntityEncryptionPrivateKeyHex,
  deriveHltTopologyRoutes,
  deriveRustH1Command,
  deriveUserNodeRoute,
  deriveUserRuntimeId,
  parseHltEngineSelection,
  serializeHltEntityRoutes,
} from '../../../scripts/operations/hlt/rust/rust-h1';

test('engine selection defaults to ts/smoke and rejects unknown values', () => {
  expect(parseHltEngineSelection({})).toEqual({ engine: 'ts', profile: 'smoke' });
  expect(parseHltEngineSelection({ XLN_HLT_ENGINE: 'rust', XLN_HLT_PROFILE: 'heavy' }))
    .toEqual({ engine: 'rust', profile: 'heavy' });
  expect(() => parseHltEngineSelection({ XLN_HLT_ENGINE: 'shadow' }))
    .toThrow('HLT_ENGINE_INVALID:shadow');
  expect(() => parseHltEngineSelection({ XLN_HLT_PROFILE: 'mega' }))
    .toThrow('HLT_PROFILE_INVALID:mega');
});

test('profile plan encodes the canonical medium packing and heavy target', () => {
  expect(HLT_PROFILE_PLAN['medium']).toEqual({ users: 1_000, runtimesPerProcess: 200 });
  expect(HLT_PROFILE_PLAN['heavy'].users).toBe(10_000);
});

/**
 * Byte-pinned TS<->Rust transport identity interop. The pinned public key is
 * asserted identically in rscore/crates/runtime/src/transport/tests.rs for
 * Rust `encryption_identity("transport-test-seed")`; any divergence in the
 * domain string, hash or clamping fails this test.
 */
test('transport encryption identity matches the pinned Rust vector', () => {
  const keyPair = deriveEncryptionKeyPair('transport-test-seed');
  expect(pubKeyToHex(keyPair.publicKey)).toBe(
    '0x953809ce01c5b3abacd9d9526a454e983aa2231c3e284e526cf433b82b5ddf7c',
  );
  expect(Buffer.from(keyPair.privateKey).toString('hex')).toBe(
    'b821ec130f8f2d23e5825cdb543b3e5a845ff262eefbea1b8f9becd74afe8c5c',
  );
  const privateKeyHex = deriveEntityEncryptionPrivateKeyHex('transport-test-seed');
  expect(privateKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
  expect(() => deriveEntityEncryptionPrivateKeyHex(' ')).toThrow('HLT_RUST_H1_RUNTIME_SEED_EMPTY');
});

test('route serialization validates real topology rows and rejects scaffolds', () => {
  const route = {
    targetEntityId: `0x${'ab'.repeat(32)}`,
    targetRuntimeId: `0x${'11'.repeat(20)}`,
    targetSignerId: `0x${'22'.repeat(20)}`,
    websocketUrl: 'ws://127.0.0.1:9911',
  };
  expect(JSON.parse(serializeHltEntityRoutes([route]))).toEqual([route]);
  expect(serializeHltEntityRoutes([])).toBe('[]\n');
  expect(() => serializeHltEntityRoutes([{ ...route, targetEntityId: '0x1234' }]))
    .toThrow('HLT_ROUTE_ENTITY_ID_INVALID:0');
  expect(() => serializeHltEntityRoutes([{ ...route, websocketUrl: 'http://127.0.0.1' }]))
    .toThrow('HLT_ROUTE_URL_INVALID:0');
});

test('user node routes derive canonical runtime/entity identity deterministically', () => {
  const seed = deriveMeshChildSeed('root-seed', 'production-swap-load:lane:1');
  const node = {
    name: 'Load Taker 0001',
    runtimeSeed: seed,
    signerLabel: 'owner',
    listenHost: '127.0.0.1',
    listenPort: 25096,
  };
  const first = deriveUserNodeRoute(node);
  const second = deriveUserNodeRoute(node);
  expect(second).toEqual(first);
  // Runtime id uses the exact canonical derivation enforced by
  // createDirectRuntimeWsRoute: deriveSignerAddressSync(seed, '1').
  expect(first.targetRuntimeId).toBe(deriveUserRuntimeId(seed));
  expect(first.targetRuntimeId).toMatch(/^0x[0-9a-f]{40}$/);
  expect(first.targetEntityId).toMatch(/^0x[0-9a-f]{64}$/);
  expect(first.targetSignerId).toMatch(/^0x[0-9a-f]{40}$/);
  expect(first.websocketUrl).toBe('ws://127.0.0.1:25096/ws');
  expect(deriveHltTopologyRoutes([node])).toEqual([first]);
  expect(() => deriveUserNodeRoute({ ...node, runtimeSeed: ' ' }))
    .toThrow('HLT_USER_RUNTIME_SEED_EMPTY');
  expect(() => deriveUserNodeRoute({ ...node, listenPort: 0 }))
    .toThrow('HLT_USER_NODE_PORT_INVALID');
});

test('rust H1 command derivation is deterministic and fail-fast', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'xln-rust-h1-cmd-'));
  try {
    const config = {
      workDir,
      runtimeSeed: 'seed-h1\n',
      routes: [],
      bindHost: '127.0.0.1',
      bindPort: 9911,
      runtimeSignerLabel: 'h1-hub',
      entitySignerLabel: 'h1-hub',
      offlineTsImport: true,
    };
    const first = deriveRustH1Command(config);
    const second = deriveRustH1Command(config);
    expect(second).toEqual(first);
    expect([...first.argv]).toEqual([
      '--native-db', join(workDir, 'rust-h1-db'),
      '--runtime-seed-file', join(workDir, 'rust-h1-runtime.seed'),
      '--entity-encryption-private-key-file', join(workDir, 'rust-h1-entity-htlc.key'),
      '--runtime-signer-label', 'h1-hub',
      '--entity-signer-label', 'h1-hub',
      '--bind', '127.0.0.1:9911',
      '--routes', join(workDir, 'rust-h1-routes.json'),
      '--workers', '8',
      '--offline-ts-import',
    ]);
    expect(() => deriveRustH1Command({ ...config, runtimeSeed: ' ' }))
      .toThrow('HLT_RUST_H1_RUNTIME_SEED_EMPTY');
    expect(() => deriveRustH1Command({ ...config, bindPort: 0 }))
      .toThrow('HLT_RUST_H1_BIND_PORT_INVALID:0');
    expect(() => deriveRustH1Command({ ...config, runtimeSignerLabel: 'Bad Label' }))
      .toThrow('HLT_RUST_H1_SIGNER_LABEL_INVALID');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
