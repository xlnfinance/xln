import { expect, test } from 'bun:test';
import { HDNodeWallet, Mnemonic, Wallet, getIndexedAccountPath, keccak256, toUtf8Bytes } from 'ethers';

import {
  buildDelayedLastResortAppointmentsForTower,
  resolveDefaultRecoveryTowerUrls,
} from '../../frontend/src/lib/stores/vaultStore';
import * as xln from '../../runtime/runtime';
import { decryptTowerPayloadWithPrivateKey, getTowerPayloadEncryptionPublicKey } from '../../runtime/recovery/crypto';
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
  })).toEqual([]);
});

const testMnemonic = 'test test test test test test test test test test test junk';

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

  const proofBodyHash = keccak256(toUtf8Bytes('tower-active-proof-body'));
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
        counterpartyDisputeProofNonce: 7,
        counterpartyDisputeProofBodyHash: proofBodyHash,
        counterpartyDisputeProofHanko: '0xcafe',
        disputeProofBodiesByHash: {
          [proofBodyHash]: {
            offdeltas: ['0'],
            tokenIds: [1],
            transformers: [],
          },
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

  await expect(buildDelayedLastResortAppointmentsForTower(
    runtime,
    env,
    xln as unknown as XLNModule,
    { url: 'http://127.0.0.1:9100', towerMode: 'delayed_last_resort' },
    towerWallet.address.toLowerCase(),
    encryptedBundle,
    undefined,
  )).rejects.toThrow('TOWER_ACTION_PUBLIC_KEY_REQUIRED');

  const uploads = await buildDelayedLastResortAppointmentsForTower(
    runtime,
    env,
    xln as unknown as XLNModule,
    { url: 'http://127.0.0.1:9100', towerMode: 'delayed_last_resort' },
    towerWallet.address.toLowerCase(),
    encryptedBundle,
    getTowerPayloadEncryptionPublicKey(towerWallet.privateKey),
  );

  expect(uploads.length).toBe(1);
  const encryptedRemedy = uploads[0]!.appointment.activePayload?.encryptedRemedy || '';
  const encryptedPayload = deserializeTaggedJson<Record<string, unknown>>(encryptedRemedy);
  expect(encryptedPayload.type).toBe('tower_encrypted_payload');
  expect(encryptedRemedy).not.toContain('counter_dispute_remedy');

  const plaintext = await decryptTowerPayloadWithPrivateKey(encryptedRemedy, towerWallet.privateKey);
  const remedy = JSON.parse(plaintext) as { type?: string; towerAddress?: string; watchedEntityId?: string };
  expect(remedy.type).toBe('counter_dispute_remedy');
  expect(remedy.towerAddress).toBe(towerWallet.address.toLowerCase());
  expect(remedy.watchedEntityId).toBe(entityId);
});
