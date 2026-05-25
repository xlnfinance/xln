import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Interface, Wallet, hexlify, keccak256, solidityPacked, toUtf8Bytes } from 'ethers';

import * as xln from '../../runtime/runtime.ts';
import { startStandaloneWatchtowerServer, type StandaloneWatchtowerServer } from '../../runtime/watchtower/standalone-server';
import { buildTowerAppointmentOwnerMessage, encryptRuntimeRecoveryBundle } from '../../runtime/recovery/crypto';
import type { JReplica, JurisdictionConfig, TowerAppointmentV1 } from '../../runtime/xln-api';
import {
  buildDelayedLastResortAppointmentsForTower,
  resolveDefaultRecoveryTowerUrls,
  tryRestoreRuntimeEnvFromTower,
  type Runtime,
} from '../../frontend/src/lib/stores/vaultStore';
import { createDefaultDelta } from '../../runtime/validation-utils';
import type { AccountMachine } from '../../runtime/types';
import { runWatchtowerSweep } from '../../runtime/watchtower/action';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const servers: StandaloneWatchtowerServer[] = [];
const tempRoots: string[] = [];
const disputeStartedInterface = new Interface([
  'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes initialArguments)',
]);

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    await rm(root, { recursive: true, force: true });
  }
});

const installJurisdiction = (env: ReturnType<typeof xln.createEmptyEnv>, name = 'TowerFlow'): JurisdictionConfig => {
  const jurisdiction: JurisdictionConfig = {
    name,
    address: 'http://127.0.0.1:8545',
    chainId: 31337,
    depositoryAddress: addr('11'),
    entityProviderAddress: addr('12'),
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    rpcs: [jurisdiction.address],
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: addr('13'),
      deltaTransformer: addr('14'),
    },
  } as JReplica);
  return jurisdiction;
};

const makeAccount = (selfId: string, counterpartyId: string): AccountMachine => {
  const [leftEntity, rightEntity] = selfId.toLowerCase() < counterpartyId.toLowerCase()
    ? [selfId, counterpartyId]
    : [counterpartyId, selfId];
  const delta = createDefaultDelta(1);
  delta.leftCreditLimit = 10n ** 30n;
  delta.rightCreditLimit = 10n ** 30n;
  return {
    leftEntity,
    rightEntity,
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      stateHash: '',
      deltas: [],
      byLeft: true,
    },
    deltas: new Map([[1, delta]]),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    proofHeader: { fromEntity: selfId, toEntity: counterpartyId, nonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    onChainSettlementNonce: 0,
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    rebalancePolicy: new Map(),
  };
};

const encodeDisputeHash = (
  initialNonce: number,
  startedByLeft: boolean,
  disputeTimeout: bigint,
  initialProofbodyHash: string,
  initialArguments: string,
): string => keccak256(
  solidityPacked(
    ['uint256', 'bool', 'uint256', 'bytes32', 'bytes32'],
    [BigInt(initialNonce), startedByLeft, disputeTimeout, initialProofbodyHash, keccak256(initialArguments)],
  ),
);

describe('watchtower recovery full flow', () => {
  test('localhost defaults do not require an implicit tower unless configured explicitly', () => {
    expect(resolveDefaultRecoveryTowerUrls({
      hostname: 'localhost',
      globalUrls: undefined,
      localUrls: undefined,
    })).toEqual([]);
    expect(resolveDefaultRecoveryTowerUrls({
      hostname: '127.0.0.1',
      globalUrls: undefined,
      localUrls: undefined,
    })).toEqual([]);
    expect(resolveDefaultRecoveryTowerUrls({
      hostname: 'localhost',
      localUrls: JSON.stringify(['http://127.0.0.1:9100']),
    })).toEqual(['http://127.0.0.1:9100']);
    expect(resolveDefaultRecoveryTowerUrls({
      hostname: 'xln.finance',
      globalUrls: undefined,
      localUrls: undefined,
    })).toEqual(['https://tower.xln.finance']);
  });

  test('frontend restore path recovers the highest valid bundle from a standalone tower', async () => {
    const towerRoot = join(process.cwd(), '.tmp-tests', `tower-restore-${Date.now()}`);
    tempRoots.push(towerRoot);
    await mkdir(towerRoot, { recursive: true });

    const towerServer = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-restore-flow',
      dbPath: join(towerRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(towerServer);

    const runtimeSeed = 'test test test test test test test test test test test junk';
    const wallet = Wallet.createRandom();
    const runtimeId = wallet.address.toLowerCase();
    const env = xln.createEmptyEnv(runtimeSeed);
    env.runtimeId = runtimeId;
    env.dbNamespace = `${runtimeId}-${Date.now()}-restore-flow`;
    env.quietRuntimeLogs = true;
    const jurisdiction = installJurisdiction(env, 'RestoreFlow');
    const entityId = `0x${'ab'.repeat(32)}`;

    xln.enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId: runtimeId,
        data: {
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [runtimeId],
            shares: { [runtimeId]: 1n },
            jurisdiction,
          },
          isProposer: true,
          profileName: 'Restore Flow',
        },
      }],
      entityInputs: [],
    });
    await xln.process(env);

    const bundle = xln.buildRuntimeRecoveryBundle(env, {
      signers: [{
        index: 0,
        derivationIndex: 0,
        address: runtimeId,
        name: 'Signer 1',
        entityId,
        jurisdiction: jurisdiction.name,
      }],
    });
    const encrypted = await encryptRuntimeRecoveryBundle(bundle, runtimeSeed);
    const signedAt = Date.now();
    const signature = await wallet.signMessage(
      buildTowerAppointmentOwnerMessage(
        runtimeId,
        'blind_backup',
        encrypted.lookupKey,
        0,
        encrypted.bundleHash,
        encrypted.height,
        signedAt,
        undefined,
      ),
    );
    const appointment: TowerAppointmentV1 = {
      type: 'tower_appointment',
      version: 1,
      towerMode: 'blind_backup',
      lookupKey: encrypted.lookupKey,
      slot: 0,
      bundle: encrypted,
      ownerProof: {
        runtimeId,
        signedAt,
        signature,
      },
    };
    await towerServer.store.upsertAppointment(appointment);

    const runtime: Runtime = {
      id: runtimeId,
      label: 'Recovered runtime',
      seed: runtimeSeed,
      signers: [{
        index: 0,
        derivationIndex: 0,
        address: runtimeId,
        name: 'Signer 1',
        entityId,
        jurisdiction: jurisdiction.name,
      }],
      activeSignerIndex: 0,
      createdAt: Date.now(),
      recovery: {
        towers: [{ url: `http://127.0.0.1:${towerServer.server.port}`, towerMode: 'blind_backup', enabled: true }],
        minSuccessfulTowers: 1,
      },
    };

    const restored = await tryRestoreRuntimeEnvFromTower(runtime, xln);
    expect(restored).not.toBeNull();
    expect(restored?.bundle.runtimeHeight).toBe(bundle.runtimeHeight);
    expect(restored?.env.runtimeId).toBe(runtimeId);
    expect(restored?.env.eReplicas.size).toBe(env.eReplicas.size);
    expect(runtime.signers[0]?.entityId).toBe(entityId);
    await xln.closeRuntimeDb(restored!.env);
    await xln.closeInfraDb(restored!.env);

    const reloaded = await xln.loadEnvFromDB(runtimeId, runtimeSeed);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.runtimeId).toBe(runtimeId);
    expect(reloaded?.height).toBe(bundle.runtimeHeight);
    expect(reloaded?.eReplicas.size).toBe(env.eReplicas.size);
  });

  test('frontend last-resort builder emits a tower-bound appointment for dispute-capable accounts', async () => {
    const runtimeSeed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const rootWallet = new Wallet(hexlify(xln.deriveSignerKeySync(runtimeSeed, '1')));
    const signerAddress = rootWallet.address.toLowerCase();
    const entityId = `0x${'44'.repeat(32)}`;
    const counterpartyId = `0x${'55'.repeat(32)}`;
    const proofBodyHash = `0x${'66'.repeat(32)}`;
    const proofHanko = `0x${'77'.repeat(80)}`;
    const towerWallet = Wallet.createRandom();
    const env = xln.createEmptyEnv(runtimeSeed);
    env.runtimeId = signerAddress;
    env.dbNamespace = `${signerAddress}-${Date.now()}-active-builder`;
    env.quietRuntimeLogs = true;
    const jurisdiction = installJurisdiction(env, 'ActiveBuilder');

    xln.enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId: signerAddress,
        data: {
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signerAddress],
            shares: { [signerAddress]: 1n },
            jurisdiction,
          },
          isProposer: true,
          profileName: 'Active Builder',
        },
      }],
      entityInputs: [],
    });
    await xln.process(env);

    const replica = [...env.eReplicas.values()][0];
    expect(replica).toBeTruthy();
    const account = makeAccount(entityId, counterpartyId);
    account.counterpartyDisputeProofNonce = 9;
    account.counterpartyDisputeProofBodyHash = proofBodyHash;
    account.counterpartyDisputeProofHanko = proofHanko;
    account.disputeProofBodiesByHash = {
      [proofBodyHash]: { tokenIds: [1], offdeltas: [-123n], transformers: [] },
    };
    replica!.state.accounts.set(counterpartyId, account);

    const runtime: Runtime = {
      id: signerAddress,
      label: 'Active Builder Runtime',
      seed: runtimeSeed,
      signers: [{
        index: 0,
        derivationIndex: 0,
        address: signerAddress,
        name: 'Signer 1',
        entityId,
        jurisdiction: jurisdiction.name,
      }],
      activeSignerIndex: 0,
      createdAt: Date.now(),
      recovery: {
        towers: [{ url: 'http://tower.test', towerMode: 'delayed_last_resort', enabled: true }],
      },
    };

    const encryptedBundle = {
      version: 1 as const,
      runtimeId: signerAddress,
      lookupKey: keccak256(toUtf8Bytes('blind-lookup')),
      height: 12,
      createdAt: 1000,
      bundleHash: keccak256(toUtf8Bytes('bundle-hash')),
      iv: '0x1234',
      ciphertext: '0xabcd',
    };

    const uploads = await buildDelayedLastResortAppointmentsForTower(
      runtime,
      env,
      xln,
      { url: 'http://tower.test', towerMode: 'delayed_last_resort', enabled: true },
      towerWallet.address.toLowerCase(),
      encryptedBundle,
    );

    expect(uploads.length).toBe(1);
    const upload = uploads[0]!;
    expect(upload.lookupKey).not.toBe(encryptedBundle.lookupKey);
    expect(upload.appointment.towerMode).toBe('delayed_last_resort');
    expect(upload.appointment.activePayload?.proofNonce).toBe(9);
    expect(upload.appointment.activePayload?.proofBodyHash).toBe(proofBodyHash);
    expect(upload.appointment.activePayload?.lastResortWindowBlocks).toBe(1152);
    const remedy = JSON.parse(String(upload.appointment.activePayload?.encryptedRemedy || '{}'));
    expect(remedy.watchedEntityId).toBe(entityId);
    expect(remedy.latestProof.counterentity).toBe(counterpartyId);
    expect(remedy.latestProof.finalNonce).toBe(9);
    expect(remedy.towerAddress).toBe(towerWallet.address.toLowerCase());
    expect(remedy.lastResortWindowBlocks).toBe(1152);
    expect(typeof remedy.ownerAuthorizationHanko).toBe('string');
    expect(remedy.ownerAuthorizationHanko.startsWith('0x')).toBe(true);
  });

  test('standalone tower executes a builder-produced delayed last-resort remedy and exposes the action receipt', async () => {
    const towerRoot = join(process.cwd(), '.tmp-tests', `tower-last-resort-flow-${Date.now()}`);
    tempRoots.push(towerRoot);
    await mkdir(towerRoot, { recursive: true });

    const runtimeSeed = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const rootWallet = new Wallet(hexlify(xln.deriveSignerKeySync(runtimeSeed, '1')));
    const signerAddress = rootWallet.address.toLowerCase();
    const entityId = `0x${'88'.repeat(32)}`;
    const counterpartyId = `0x${'99'.repeat(32)}`;
    const proofBodyHash = `0x${'aa'.repeat(32)}`;
    const proofHanko = `0x${'bb'.repeat(80)}`;
    const towerWallet = Wallet.createRandom();
    const env = xln.createEmptyEnv(runtimeSeed);
    env.runtimeId = signerAddress;
    env.dbNamespace = `${signerAddress}-${Date.now()}-last-resort-flow`;
    env.quietRuntimeLogs = true;
    const jurisdiction = installJurisdiction(env, 'LastResortFlow');

    xln.enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId: signerAddress,
        data: {
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signerAddress],
            shares: { [signerAddress]: 1n },
            jurisdiction,
          },
          isProposer: true,
          profileName: 'Last Resort Flow',
        },
      }],
      entityInputs: [],
    });
    await xln.process(env);

    const replica = [...env.eReplicas.values()][0];
    expect(replica).toBeTruthy();
    const account = makeAccount(entityId, counterpartyId);
    account.counterpartyDisputeProofNonce = 9;
    account.counterpartyDisputeProofBodyHash = proofBodyHash;
    account.counterpartyDisputeProofHanko = proofHanko;
    account.disputeProofBodiesByHash = {
      [proofBodyHash]: { tokenIds: [1], offdeltas: [-123n], transformers: [] },
    };
    replica!.state.accounts.set(counterpartyId, account);

    const runtime: Runtime = {
      id: signerAddress,
      label: 'Last Resort Flow Runtime',
      seed: runtimeSeed,
      signers: [{
        index: 0,
        derivationIndex: 0,
        address: signerAddress,
        name: 'Signer 1',
        entityId,
        jurisdiction: jurisdiction.name,
      }],
      activeSignerIndex: 0,
      createdAt: Date.now(),
      recovery: {
        towers: [{ url: 'http://tower.flow', towerMode: 'delayed_last_resort', enabled: true }],
      },
    };

    const encryptedBundle = {
      version: 1 as const,
      runtimeId: signerAddress,
      lookupKey: keccak256(toUtf8Bytes('blind-lookup:last-resort-flow')),
      height: 21,
      createdAt: 2000,
      bundleHash: keccak256(toUtf8Bytes('bundle-hash:last-resort-flow')),
      iv: '0x1234',
      ciphertext: '0xabcd',
    };

    const uploads = await buildDelayedLastResortAppointmentsForTower(
      runtime,
      env,
      xln,
      { url: 'http://tower.flow', towerMode: 'delayed_last_resort', enabled: true },
      towerWallet.address.toLowerCase(),
      encryptedBundle,
    );
    expect(uploads.length).toBe(1);
    const upload = uploads[0]!;

    const towerServer = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-last-resort-flow',
      dbPath: join(towerRoot, 'tower.level'),
      towerPrivateKey: towerWallet.privateKey,
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(towerServer);

    const put = await fetch(`http://127.0.0.1:${towerServer.server.port}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(upload.appointment),
    });
    expect(put.ok).toBe(true);

    const initialProofbodyHash = `0x${'cc'.repeat(32)}`;
    const initialArguments = '0x1234';
    const disputeHash = encodeDisputeHash(7, true, 100n, initialProofbodyHash, initialArguments);
    const result = await runWatchtowerSweep(towerServer.store, {
      lookupKey: upload.lookupKey,
      towerPrivateKey: towerWallet.privateKey,
      providerFactory: () => ({
        getBlockNumber: async () => 95,
        getLogs: async () => {
          const event = disputeStartedInterface.encodeEventLog(
            disputeStartedInterface.getEvent('DisputeStarted'),
            [
              entityId,
              counterpartyId,
              7n,
              initialProofbodyHash,
              initialArguments,
            ],
          );
          return [{ topics: event.topics, data: event.data }];
        },
      }),
      contractFactory: () => ({
        accountKey: async () => '0xfeed',
        _accounts: async () => ({
          nonce: 7n,
          disputeHash,
          disputeTimeout: 100n,
        }),
        watchtowerCounterDispute: async () => ({
          hash: '0xwatchtowerflow',
          wait: async () => ({ blockNumber: 96 }),
        }),
      }),
    });

    expect(result).toEqual({
      scanned: 1,
      submitted: 1,
      skipped: 0,
      errors: 0,
    });

    const actionsResponse = await fetch(`http://127.0.0.1:${towerServer.server.port}/api/watchtower/actions/${upload.lookupKey}`);
    expect(actionsResponse.ok).toBe(true);
    const actionsPayload = await actionsResponse.json() as { ok: boolean; receipts?: Array<{ status?: string; txHash?: string }> };
    expect(actionsPayload.ok).toBe(true);
    expect(actionsPayload.receipts?.length).toBe(1);
    expect(actionsPayload.receipts?.[0]?.status).toBe('submitted');
    expect(actionsPayload.receipts?.[0]?.txHash).toBe('0xwatchtowerflow');
  });
});
