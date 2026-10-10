import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveSignerAddressSync } from '../../../account/crypto';
import { encodeBoard, hashBoard } from '../../../entity/factory';
import { createMarketMakerIdentityResolver } from '../../../orchestrator/market-maker/identity-resolver';
import {
  bindHubMesh,
  hubMeshReady,
  parseConfiguredPeerIdentities,
  type ConfiguredPeerIdentity,
} from '../../../orchestrator/mesh/hub-mesh-peers';
import { resetMeshJurisdictionsCache } from '../../../orchestrator/mesh/mesh-jurisdictions';
import { safeStringify } from '../../../protocol/serialization';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const primaryJ = { name: 'Testnet', chainId: 31337, depositoryAddress: addr('11') };
const tronJ = { name: 'Tron', chainId: 31338, depositoryAddress: addr('22') };

const identities = (): ConfiguredPeerIdentity[] => parseConfiguredPeerIdentities(safeStringify([
  { name: 'H1', entityId: entity('a1'), signerId: addr('a1'), jurisdictionName: 'Testnet', chainId: 31337, depositoryAddress: addr('11') },
  { name: 'H2', entityId: entity('a2'), signerId: addr('a2'), jurisdictionName: 'Testnet', chainId: 31337, depositoryAddress: addr('11') },
  { name: 'H3', entityId: entity('a3'), signerId: addr('a3'), jurisdictionName: 'Testnet', chainId: 31337, depositoryAddress: addr('11') },
  { name: 'H1', entityId: entity('b1'), signerId: addr('b1'), jurisdictionName: 'Tron', chainId: 31338, depositoryAddress: addr('22') },
]), 'HUB_IDENTITIES');

const profile = (entityId: string, name: string) => ({ entityId, name, hubName: name });
const readyPair = (counterpartyId: string) => ({ counterpartyId, ready: true });

describe('hub mesh binds to configured hub identities', () => {
  test('an unconfigured isHub profile never becomes a peer, whatever name it declares', () => {
    const visible = [
      profile(entity('a1'), 'H1'),
      profile(entity('a2'), 'H2'),
      profile(entity('a3'), 'H3'),
      profile(entity('e1'), 'H2'),
      profile(entity('e2'), 'H1'),
      profile(entity('e3'), 'Evil'),
    ];
    const mesh = bindHubMesh(identities(), primaryJ, entity('a2'), visible);

    expect(mesh.ownerIndex).toBe(1);
    expect(mesh.gossipReady).toBe(true);
    expect(mesh.configuredPeers.map(peer => peer.entityId)).toEqual([entity('a1'), entity('a3')]);
    expect(mesh.visiblePeers.map(peer => [peer.identity.name, peer.meshIndex, peer.profile.entityId])).toEqual([
      ['H1', 0, entity('a1')],
      ['H3', 2, entity('a3')],
    ]);
    expect(mesh.visibleHubs.map(hub => hub.entityId)).toEqual([entity('a1'), entity('a2'), entity('a3')]);
    expect(hubMeshReady(mesh, [readyPair(entity('a1')), readyPair(entity('a3'))])).toBe(true);
  });

  test('an impostor using a configured name does not stand in for the missing hub', () => {
    const mesh = bindHubMesh(identities(), primaryJ, entity('a1'), [
      profile(entity('a1'), 'H1'),
      profile(entity('a2'), 'H2'),
      profile(entity('e1'), 'H3'),
    ]);
    expect(mesh.gossipReady).toBe(false);
    expect(mesh.visiblePeers.map(peer => peer.identity.entityId)).toEqual([entity('a2')]);
    expect(hubMeshReady(mesh, [readyPair(entity('a2')), readyPair(entity('e1'))])).toBe(false);
  });

  test('readiness needs every configured pair and a configured owner', () => {
    const visible = [profile(entity('a1'), 'H1'), profile(entity('a2'), 'H2'), profile(entity('a3'), 'H3')];
    const mesh = bindHubMesh(identities(), primaryJ, entity('a1'), visible);
    expect(hubMeshReady(mesh, [readyPair(entity('a2'))])).toBe(false);
    expect(hubMeshReady(mesh, [readyPair(entity('a2')), { counterpartyId: entity('a3'), ready: false }])).toBe(false);

    const outsider = bindHubMesh(identities(), primaryJ, entity('e1'), visible);
    expect(outsider.ownerIndex).toBe(-1);
    expect(hubMeshReady(outsider, [readyPair(entity('a2')), readyPair(entity('a3'))])).toBe(false);
  });

  test('each jurisdiction meshes only its own configured hubs', () => {
    const mesh = bindHubMesh(identities(), tronJ, entity('b1'), [profile(entity('b1'), 'H1'), profile(entity('a2'), 'H2')]);
    expect(mesh.ownerIndex).toBe(0);
    expect(mesh.configuredPeers).toEqual([]);
    expect(mesh.gossipReady).toBe(true);
  });

  test('malformed identity lists are rejected with the caller code', () => {
    expect(() => parseConfiguredPeerIdentities('{', 'HUB_IDENTITIES')).toThrow('HUB_IDENTITIES_JSON_INVALID:malformed JSON');
    expect(() => parseConfiguredPeerIdentities('{}', 'HUB_IDENTITIES')).toThrow('HUB_IDENTITIES_JSON_INVALID:expected array');
    expect(() => parseConfiguredPeerIdentities(safeStringify([{ name: 'H1', entityId: entity('a1') }]), 'SUPPORT_PEER_IDENTITIES'))
      .toThrow('SUPPORT_PEER_IDENTITIES_JSON_FIELDS_INVALID:index=0');
  });
});

const stack = (name: string, rpc: string, byte: string, chainId: number) => ({
  name,
  chainId,
  entityProviderDeploymentBlock: 2,
  blockTimeMs: 1_000,
  rpc,
  explorer: '',
  currency: 'TEST',
  status: 'active',
  contracts: {
    depository: addr(byte),
    entityProvider: addr(`${byte[0]}3`),
    account: addr(`${byte[0]}4`),
    deltaTransformer: addr(`${byte[0]}5`),
  },
});

// Hub-node derives its Entity exactly like scripts/bootstrap-hub.ts.
const hubNodeEntityId = (seed: string, signerLabel: string, jurisdiction: unknown): string => {
  const signer = deriveSignerAddressSync(seed, signerLabel);
  return hashBoard(encodeBoard({
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signer],
    shares: { [signer]: 1n },
    jurisdiction,
  } as Parameters<typeof encodeBoard>[0])).toLowerCase();
};

test('orchestrator hub identities match the Entities each hub-node bootstraps', () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-hub-identities-'));
  const path = join(root, 'jurisdictions.json');
  writeFileSync(path, `${safeStringify({
    version: '1',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    jurisdictions: {
      testnet: stack('Testnet', 'http://127.0.0.1:8545', '11', 31337),
      tron: stack('Tron', 'http://127.0.0.1:8546', '22', 31338),
    },
    defaults: { timeout: 60, retryAttempts: 3, gasLimit: 10_000_000 },
  })}\n`, 'utf8');
  const previousPath = process.env['XLN_JURISDICTIONS_PATH'];
  process.env['XLN_JURISDICTIONS_PATH'] = path;
  resetMeshJurisdictionsCache();
  try {
    const hubChildren = ['H1', 'H2', 'H3'].map(name => ({ name, seed: `seed-${name}`, signerLabel: `${name.toLowerCase()}-hub` }));
    const resolver = createMarketMakerIdentityResolver({
      args: { host: '127.0.0.1', rpcUrl: 'http://127.0.0.1:8545', rpcUrls: {} },
      marketMakerChild: { apiPort: 1, name: 'MM', seed: 'seed-mm', signerLabel: 'mm-1' },
      hubChildren,
      requiredTokenCount: 3,
    });
    const parsed = parseConfiguredPeerIdentities(safeStringify(resolver.getHubIdentities()), 'HUB_IDENTITIES');
    expect(parsed.map(hub => [hub.name, hub.jurisdictionName])).toEqual([
      ['H1', 'Testnet'], ['H2', 'Testnet'], ['H3', 'Testnet'],
      ['H1', 'Tron'], ['H2', 'Tron'], ['H3', 'Tron'],
    ]);
    for (const [index, hub] of hubChildren.entries()) {
      expect(parsed[index]?.entityId).toBe(hubNodeEntityId(hub.seed, hub.signerLabel, { name: 'Testnet' }));
      expect(parsed[index + 3]?.entityId).toBe(hubNodeEntityId(hub.seed, `${hub.signerLabel}:Tron`, { name: 'Tron' }));
    }
    const h3 = bindHubMesh(parsed, { chainId: 31337, depositoryAddress: addr('11') }, parsed[2]?.entityId ?? '', []);
    expect(h3.ownerIndex).toBe(2);
    expect(h3.configuredPeers.map(peer => peer.name)).toEqual(['H1', 'H2']);
  } finally {
    if (previousPath === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
    else process.env['XLN_JURISDICTIONS_PATH'] = previousPath;
    resetMeshJurisdictionsCache();
    rmSync(root, { recursive: true, force: true });
  }
});
