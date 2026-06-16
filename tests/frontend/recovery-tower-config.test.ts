import { expect, test } from 'bun:test';
import { AbiCoder, HDNodeWallet, Mnemonic, ParamType, Wallet, getIndexedAccountPath, keccak256, toUtf8Bytes } from 'ethers';

import {
  buildDelayedLastResortAppointmentsForTower,
  buildRuntimeRecoveryConfigForMode,
  discoverRuntimeRecoveryCandidates,
  parseRuntimeRecoveryCandidateFile,
  resolveDefaultRecoveryTowerUrls,
  tryRestoreRuntimeEnvFromTower,
} from '../../frontend/src/lib/stores/vaultStore';
import * as xln from '../../runtime/runtime';
import { decryptTowerPayloadWithWatchSeed } from '../../runtime/recovery/crypto';
import { deserializeTaggedJson } from '../../runtime/serialization-utils';
import type { EncryptedRuntimeRecoveryBundleV1, Env, XLNModule } from '../../runtime/xln-api';

test('resolveDefaultRecoveryTowerUrls uses same-origin production tower by default', () => {
  expect(resolveDefaultRecoveryTowerUrls({
    hostname: 'xln.finance',
    globalUrls: undefined,
    localUrls: undefined,
  })).toEqual(['https://xln.finance']);
});

test('resolveDefaultRecoveryTowerUrls stays disabled by default on localhost', () => {
  expect(resolveDefaultRecoveryTowerUrls({
    hostname: 'localhost',
    globalUrls: undefined,
    localUrls: undefined,
    envUrls: undefined,
  })).toEqual([]);
});

test('resolveDefaultRecoveryTowerUrls enables explicit dev watchtower on localhost', () => {
  expect(resolveDefaultRecoveryTowerUrls({
    hostname: 'localhost',
    globalUrls: undefined,
    localUrls: undefined,
    envUrls: 'http://127.0.0.1:9100',
  })).toEqual(['http://127.0.0.1:9100']);
});

test('runtime recovery modes keep tower setup out of seed creation defaults', () => {
  expect(buildRuntimeRecoveryConfigForMode('official', {
    officialTowerUrl: 'https://xln.finance/',
  }).towers).toEqual([{
    id: 'official-watchtower',
    url: 'https://xln.finance',
    towerMode: 'delayed_last_resort',
    enabled: true,
  }]);

  expect(buildRuntimeRecoveryConfigForMode('backup_only', {
    officialTowerUrl: 'https://xln.finance/',
  }).towers?.[0]?.towerMode).toBe('blind_backup');

  expect(buildRuntimeRecoveryConfigForMode('local_only', {
    officialTowerUrl: 'https://xln.finance/',
    manualTowers: [{ url: 'http://127.0.0.1:9100/', towerMode: 'delayed_last_resort' }],
  })).toMatchObject({
    useDefaultTowers: false,
    towers: [{ url: 'http://127.0.0.1:9100', towerMode: 'delayed_last_resort', enabled: true }],
  });
});

const testMnemonic = 'test test test test test test test test test test test junk';
const testWatchSeed = `0x${'42'.repeat(32)}`;
const abiCoder = AbiCoder.defaultAbiCoder();
const proofBodyParam = ParamType.from(
  'tuple(bytes32 watchSeed,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)',
);
const proofBodyHashOf = (proofBody: Record<string, unknown>): string =>
  keccak256(abiCoder.encode([proofBodyParam], [proofBody]));

const deriveTestAddress = (index = 0): string =>
  HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(testMnemonic), getIndexedAccountPath(index)).address.toLowerCase();

const makeTestRecoveryEnv = (runtimeId: string, entityId: string, counterpartyId: string): Env => {
  const env = xln.createEmptyEnv(testMnemonic);
  env.runtimeId = runtimeId;
  env.dbNamespace = `tower-active-encryption-${Date.now()}`;
  env.activeJurisdiction = 'Local';
  env.jReplicas.set('Local', {
    name: 'Local',
    rpcs: ['http://127.0.0.1:8545'],
    chainId: 31337,
    depositoryAddress: '0x1111111111111111111111111111111111111111',
    entityProviderAddress: '0x2222222222222222222222222222222222222222',
    contracts: {
      depository: '0x1111111111111111111111111111111111111111',
      entityProvider: '0x2222222222222222222222222222222222222222',
      account: '0x3333333333333333333333333333333333333333',
      deltaTransformer: '0x4444444444444444444444444444444444444444',
    },
  } as Env['jReplicas'] extends Map<string, infer T> ? T : never);

  const proofBody = {
    watchSeed: testWatchSeed,
    offdeltas: ['0'],
    tokenIds: [1],
    transformers: [],
  };
  const proofBodyHash = proofBodyHashOf(proofBody);
  env.eReplicas.set(`${entityId}:${runtimeId}`, {
    entityId,
    signerId: runtimeId,
    state: {
      entityId,
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [runtimeId],
        shares: { [runtimeId]: 1n },
        jurisdiction: {
          name: 'Local',
          address: 'http://127.0.0.1:8545',
          chainId: 31337,
          depositoryAddress: '0x1111111111111111111111111111111111111111',
          entityProviderAddress: '0x2222222222222222222222222222222222222222',
        },
      },
      accounts: new Map([[counterpartyId, {
        watchSeed: testWatchSeed,
        counterpartyDisputeProofNonce: 7,
        counterpartyDisputeProofBodyHash: proofBodyHash,
        counterpartyDisputeProofHanko: '0xcafe',
        disputeProofBodiesByHash: {
          [proofBodyHash]: proofBody,
        },
      }]]),
    },
  } as unknown as Env['eReplicas'] extends Map<string, infer T> ? T : never);

  return env;
};

test('delayed last-resort appointments require encrypted tower action payloads', async () => {
  const runtimeId = deriveTestAddress(0);
  const entityId = `0x${'ab'.repeat(32)}`;
  const counterpartyId = `0x${'cd'.repeat(32)}`;
  const env = makeTestRecoveryEnv(runtimeId, entityId, counterpartyId);
  const towerWallet = Wallet.createRandom();
  const encryptedBundle: EncryptedRuntimeRecoveryBundleV1 = {
    version: 1,
    runtimeId,
    lookupKey: keccak256(toUtf8Bytes('blind-backup-lookup')),
    height: 7,
    createdAt: 123_456,
    bundleHash: keccak256(toUtf8Bytes('encrypted-runtime-bundle')),
    iv: '0x1234',
    ciphertext: '0xabcd',
  };
  const runtime = {
    id: runtimeId,
    label: 'Tower Active Encryption',
    seed: testMnemonic,
    signers: [{
      index: 0,
      derivationIndex: 0,
      address: runtimeId,
      name: 'Signer 1',
      entityId,
      jurisdiction: 'Local',
    }],
    activeSignerIndex: 0,
    createdAt: 1,
    recovery: {
      towers: [{ url: 'http://127.0.0.1:9100', towerMode: 'delayed_last_resort' as const }],
    },
  };

  const uploads = await buildDelayedLastResortAppointmentsForTower(
    runtime,
    env,
    xln as unknown as XLNModule,
    { url: 'http://127.0.0.1:9100', towerMode: 'delayed_last_resort' },
    towerWallet.address.toLowerCase(),
    encryptedBundle,
  );

  expect(uploads.length).toBe(1);
  const encryptedRemedy = uploads[0]!.appointment.lastResortPayload?.encryptedRemedy || '';
  const encryptedPayload = deserializeTaggedJson<Record<string, unknown>>(encryptedRemedy);
  expect(encryptedPayload.type).toBe('tower_encrypted_payload');
  expect(encryptedPayload.alg).toBe('watch-seed-aes-256-gcm');
  expect(encryptedRemedy).not.toContain('counter_dispute_remedy');

  const plaintext = await decryptTowerPayloadWithWatchSeed(encryptedRemedy, testWatchSeed);
  const remedy = JSON.parse(plaintext) as { type?: string; towerAddress?: string; watchedEntityId?: string };
  expect(remedy.type).toBe('counter_dispute_remedy');
  expect(remedy.towerAddress).toBe(towerWallet.address.toLowerCase());
  expect(remedy.watchedEntityId).toBe(entityId);
});

test('tower restore checks discovery before restore to avoid expected missing-backup 404s', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const lookupKey = `0x${'99'.repeat(32)}`;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    expect(init?.method).toBe('POST');
    expect(String(input)).toContain('/api/recovery/discover');
    return new Response(JSON.stringify({
      ok: true,
      lookupKey,
      available: false,
      latestReceipt: null,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const restored = await tryRestoreRuntimeEnvFromTower({
      id: deriveTestAddress(0),
      label: 'No Backup Yet',
      seed: testMnemonic,
      signers: [],
      activeSignerIndex: 0,
      createdAt: 1,
      recovery: {
        useDefaultTowers: false,
        towers: [{ url: 'http://127.0.0.1:9100', towerMode: 'blind_backup' }],
      },
    }, {
      deriveRuntimeRecoveryLookupKey: () => lookupKey,
      decryptRuntimeRecoveryBundle: async () => {
        throw new Error('decrypt should not run without discovery availability');
      },
      restoreEnvFromRecoveryBundles: async () => {
        throw new Error('restore should not run without discovery availability');
      },
      persistRestoredEnvToDB: async () => {
        throw new Error('persist should not run without discovery availability');
      },
    } as unknown as XLNModule);

    expect(restored).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/recovery/discover');
    expect(calls[0]).not.toContain('/api/tower/restore');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime recovery discovery asks every tower and sorts candidates by runtime height', async () => {
  const originalFetch = globalThis.fetch;
  const runtimeId = deriveTestAddress(0);
  const lookupKey = keccak256(toUtf8Bytes('discovery-lookup'));
  const calls: string[] = [];
  const encryptedBundle = (height: number, createdAt: number): EncryptedRuntimeRecoveryBundleV1 => ({
    version: 1,
    runtimeId,
    lookupKey,
    height,
    createdAt,
    bundleHash: keccak256(toUtf8Bytes(`bundle-${height}`)),
    iv: `0x${String(height).padStart(4, '0')}`,
    ciphertext: `0x${String(createdAt).padStart(4, '0')}`,
  });
  const bundleByTower: Record<string, EncryptedRuntimeRecoveryBundleV1> = {
    'http://127.0.0.1:9101': encryptedBundle(7, 700),
    'http://127.0.0.1:9102': encryptedBundle(30, 3000),
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const towerUrl = Object.keys(bundleByTower).find((tower) => url.includes(tower));
    if (!towerUrl) return new Response('not found', { status: 404 });
    if (url.includes('/api/recovery/discover')) {
      return new Response(JSON.stringify({
        ok: true,
        lookupKey,
        available: true,
        latestReceipt: null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      bundle: bundleByTower[towerUrl],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await discoverRuntimeRecoveryCandidates(testMnemonic, {
      towers: [
        { url: 'http://127.0.0.1:9101', towerMode: 'blind_backup' },
        { url: 'http://127.0.0.1:9102', towerMode: 'blind_backup' },
      ],
      xln: {
        deriveRuntimeRecoveryLookupKey: () => lookupKey,
        decryptRuntimeRecoveryBundle: async (encrypted: EncryptedRuntimeRecoveryBundleV1) => ({
          version: 1,
          kind: 'snapshot',
          runtimeId,
          runtimeHeight: encrypted.height,
          runtimeTimestamp: 0,
          createdAt: encrypted.createdAt,
          signers: [{ index: 0, address: runtimeId, name: 'Signer 1' }],
          checkpoint: { runtimeId, height: encrypted.height },
          checkpointHash: keccak256(toUtf8Bytes(`checkpoint-${encrypted.height}`)),
        }),
      } as unknown as XLNModule,
    });

    expect(result.checkedTowers).toBe(2);
    expect(calls.filter((call) => call.includes('/api/recovery/discover'))).toHaveLength(2);
    expect(calls.filter((call) => call.includes('/api/tower/restore'))).toHaveLength(2);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.runtimeHeight).toBe(30);
    expect(result.candidates[1]?.runtimeHeight).toBe(7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('local runtime backup file is parsed as an explicit recovery candidate', async () => {
  const runtimeId = deriveTestAddress(0);
  const lookupKey = keccak256(toUtf8Bytes('file-lookup'));
  const encrypted: EncryptedRuntimeRecoveryBundleV1 = {
    version: 1,
    runtimeId,
    lookupKey,
    height: 44,
    createdAt: 4_400,
    bundleHash: keccak256(toUtf8Bytes('file-bundle')),
    iv: '0x1111',
    ciphertext: '0x2222',
  };

  const candidate = await parseRuntimeRecoveryCandidateFile(
    testMnemonic,
    JSON.stringify({ version: 1, bundles: [encrypted] }),
    {
      sourceLabel: 'flash-drive-backup.json',
      xln: {
        decryptRuntimeRecoveryBundle: async () => ({
          version: 1,
          kind: 'snapshot',
          runtimeId,
          runtimeHeight: 44,
          runtimeTimestamp: 0,
          createdAt: 4_400,
          signers: [{ index: 0, address: runtimeId, name: 'Signer 1' }],
          checkpoint: { runtimeId, height: 44 },
          checkpointHash: keccak256(toUtf8Bytes('file-checkpoint')),
        }),
      } as unknown as XLNModule,
    },
  );

  expect(candidate.source).toBe('file');
  expect(candidate.sourceLabel).toBe('flash-drive-backup.json');
  expect(candidate.runtimeHeight).toBe(44);
  expect(candidate.signerCount).toBe(1);
});
