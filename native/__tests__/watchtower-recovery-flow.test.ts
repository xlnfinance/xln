import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AbiCoder, HDNodeWallet, Interface, Mnemonic, Wallet, getIndexedAccountPath, keccak256, solidityPacked, toUtf8Bytes } from 'ethers';

import { createEntityFrameCandidateState, commitEntityFrameCandidateState } from '../../core/entity/state-clone';
import { putEntityAccountCandidate } from '../../core/entity/state/persistent-account-map';
import * as xln from '../../core/runtime.ts';
import { startStandaloneWatchtowerServer, type StandaloneWatchtowerServer } from '../../core/watchtower/standalone-server';
import {
  buildTowerAppointmentOwnerMessage,
  decryptTowerPayloadWithWatchSeed,
  encryptRuntimeRecoveryBundle,
} from '../../core/storage/recovery/bundle/crypto';
import type {
  JReplica,
  JurisdictionConfig,
  TowerAppointmentV1,
} from '../../core/api/public/runtime-module';
import {
  buildDelayedLastResortAppointmentsForTower,
  resolveDefaultRecoveryTowerUrls,
  tryRestoreRuntimeEnvFromTower,
  type Runtime,
} from '../../frontend/src/lib/stores/vault/vaultStore';
import { createDefaultDelta } from '../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../core/account/state/persistent-state-map';
import { createEmptyAccountJClaimAccumulator } from '../../core/account/j-claims/j-claim-accumulator';
import type { AccountReplica } from '../../core/types/account';
import { runWatchtowerSweep } from '../../core/watchtower/action';
import {
  resolveDbPath,
  resolveRuntimeWalDbPath,
  resolveStorageDbPath,
  resolveStorageWriterLockPath,
} from '../../core/storage/runtime-dbs';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const servers: StandaloneWatchtowerServer[] = [];
const tempRoots: string[] = [];
const resetRuntimeStorage = async (env: ReturnType<typeof xln.createEmptyEnv>): Promise<void> => {
  const paths = [
    resolveDbPath(env),
    resolveDbPath(env, 'infra'),
    resolveStorageDbPath(env, 'current'),
    resolveStorageDbPath(env, 'previous'),
    resolveRuntimeWalDbPath(env),
    resolveStorageWriterLockPath(env),
  ];
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.push(...paths);
};
const disputeStartedInterface = new Interface([
  'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bool proposerIsLeft, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterCounterArguments, bytes32 starterCounterProofCommitment, uint256 disputeTimeout, uint256 disputeStartTimestamp, uint32 leftResponseSeconds, uint32 rightResponseSeconds)',
]);
const abiCoder = AbiCoder.defaultAbiCoder();
// The frozen counterparty proof is the one the canonical builder rebuilds from
// the disputing Account. The test must not carry a second ProofBody ABI: that
// duplicate is exactly what drifted when offdeltas became the wide Int512
// tuple. Ask the production encoder for the hash the tower will be shown.
const canonicalProofBodyHashOf = (
  env: ReturnType<typeof xln.createEmptyEnv>,
  account: AccountReplica,
): string =>
  xln
    .buildAccountProofBodyFromJurisdictions({ jReplicas: env.state.jReplicas }, account)
    .proofBodyHash.toLowerCase();

const deriveFrontendWallet = (seed: string, index: number): HDNodeWallet =>
  HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(seed), getIndexedAccountPath(index));

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

const installJurisdiction = (
  env: ReturnType<typeof xln.createEmptyEnv>,
  name = 'TowerFlow',
  // The watchtower builder needs a real endpoint to put in the remedy, so that
  // is the default. Pass [] for the restore flow: with no endpoint and no
  // BrowserVM snapshot, restore derives no live J-adapter at all
  // (core/runtime/recovery/j-adapter-restore.ts:160) and therefore needs no
  // reachable chain.
  rpcs: readonly string[] = ['http://127.0.0.1:8545'],
): JurisdictionConfig => {
  const jurisdiction: JurisdictionConfig = {
    name,
    address: rpcs[0] ?? 'http://127.0.0.1:8545',
    chainId: 31337,
    depositoryAddress: addr('11'),
    entityProviderAddress: addr('12'),
  };
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    rpcs: [...rpcs],
    chainId: jurisdiction.chainId,
    watcherConfirmationDepth: 0,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: addr('13'),
      deltaTransformer: addr('14'),
    },
    position: { x: 0, y: 0, z: 0 },
  } satisfies JReplica);
  return jurisdiction;
};

const makeAccount = (
  selfId: string,
  counterpartyId: string,
  watchSeed: string,
  jurisdiction: JurisdictionConfig,
): AccountReplica => {
  const [leftEntity, rightEntity] = selfId.toLowerCase() < counterpartyId.toLowerCase()
    ? [selfId, counterpartyId]
    : [counterpartyId, selfId];
  const delta = createDefaultDelta(1);
  delta.leftCreditLimit = 10n ** 30n;
  delta.rightCreditLimit = 10n ** 30n;
  // A disputing account is frozen on a non-zero balance; the on-chain fixtures
  // below replay this exact signed window.
  delta.offdelta = -123n;
  return {
    state: {
      leftEntity,
      rightEntity,
      watchSeed,
      // The proof builder resolves the DeltaTransformer from the exact durable
      // (chainId, Depository) record, so the fixture domain must name the
      // jurisdiction this Runtime actually imported.
      domain: { chainId: jurisdiction.chainId, depositoryAddress: jurisdiction.depositoryAddress },
      deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, delta]]),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig: { leftResponseSeconds: 4, rightResponseSeconds: 6 },
      jNonce: 0,
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
    },
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
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: selfId, toEntity: counterpartyId, nonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
};

const encodeDisputeHash = (
  initialNonce: number,
  startedByLeft: boolean,
  initialProposerIsLeft: boolean,
  disputeTimeout: bigint,
  leftResponseSeconds: bigint,
  rightResponseSeconds: bigint,
  initialProofbodyHash: string,
  disputeStartTimestamp: bigint,
  starterInitialArguments: string,
  starterCounterArguments: string,
  starterCounterProofCommitment = `0x${'00'.repeat(32)}`,
): string => {
  const starterInitialArgumentsCommitment = keccak256(abiCoder.encode(
    ['bytes', 'bool', 'uint256'],
    [starterInitialArguments, startedByLeft, disputeStartTimestamp],
  ));
  const starterCounterArgumentsCommitment = keccak256(abiCoder.encode(
    ['bytes', 'bool', 'uint256'],
    [starterCounterArguments, startedByLeft, disputeStartTimestamp],
  ));
  return keccak256(solidityPacked(
    ['uint256', 'bool', 'bool', 'uint256', 'uint32', 'uint32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bool'],
    [
      BigInt(initialNonce),
      startedByLeft,
      initialProposerIsLeft,
      disputeTimeout,
      leftResponseSeconds,
      rightResponseSeconds,
      initialProofbodyHash,
      disputeStartTimestamp,
      starterInitialArgumentsCommitment,
      starterCounterArgumentsCommitment,
      starterCounterProofCommitment,
      0n,
      `0x${'00'.repeat(32)}`,
      false,
    ],
  ));
};

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
    })).toEqual(['https://xln.finance']);
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
      // Keep the quota above the real encrypted snapshot size; quota rejection
      // has a separate, deliberately tiny-limit regression in
      // watchtower-standalone.test.ts.
      maxStoredBytesPerLookupKey: 512 * 1024,
    });
    servers.push(towerServer);

    const runtimeSeed = 'test test test test test test test test test test test junk';
    const wallet = deriveFrontendWallet(runtimeSeed, 0);
    const runtimeId = wallet.address.toLowerCase();
    const env = xln.createEmptyEnv(runtimeSeed);
    env.runtimeId = runtimeId;
    const sourceDbNamespace = `${runtimeId}-${Date.now()}-restore-flow`;
    env.dbNamespace = sourceDbNamespace;
    const restoreTarget = xln.createEmptyEnv(runtimeSeed);
    restoreTarget.runtimeId = runtimeId;
    restoreTarget.dbNamespace = runtimeId;
    await resetRuntimeStorage(restoreTarget);
    await resetRuntimeStorage(env);
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    // This flow deliberately carries no BrowserVM snapshot. `importJ` with no
    // RPCs stores the whole simulated EVM trie in `browserVMState.trieData`,
    // whose contract-code nodes are ~45 KB and exceed the 10 KB durable
    // Runtime-machine row bound (core/storage/wal/runtime-machine-graph.ts:42)
    // on the first materialization, restore included. That bound is a separate
    // product defect, not this flow's subject: what is proven here is the
    // tower bundle round trip.
    const jurisdiction = installJurisdiction(env, 'RestoreFlow', []);
    const entityId = xln.generateLazyEntityId([runtimeId], 1n).toLowerCase();

    const signers = [{
      index: 0,
      derivationIndex: 0,
      address: runtimeId,
      name: 'Signer 1',
      entityId,
      jurisdiction: jurisdiction.name,
    }];
    const uploadBundleToSlot = async (slot: number) => {
      const height = env.state.height;
      const frame = height > 0 ? await xln.readPersistedFrameJournal(env, height) : null;
      if (height > 0 && !frame) throw new Error('RESTORE_FLOW_TIP_JOURNAL_MISSING');
      const uploaded = xln.buildRuntimeRecoveryBundle(env, {
        frames: frame ? [frame] : [],
        signers,
      });
      const encrypted = await encryptRuntimeRecoveryBundle(uploaded, runtimeSeed);
      const signedAt = Date.now();
      const signature = await wallet.signMessage(
        buildTowerAppointmentOwnerMessage(
          runtimeId,
          'blind_backup',
          encrypted.lookupKey,
          slot,
          encrypted,
          signedAt,
          undefined,
        ),
      );
      const appointment: TowerAppointmentV1 = {
        type: 'tower_appointment',
        version: 1,
        towerMode: 'blind_backup',
        lookupKey: encrypted.lookupKey,
        slot,
        bundle: encrypted,
        ownerProof: {
          runtimeId,
          signedAt,
          signature,
        },
      };
      await towerServer.store.upsertAppointment(appointment);
      return uploaded;
    };

    // The tower holds two owner-signed backups for the same lookup key and the
    // stale one sits in the lower slot, so slot order cannot stand in for tip
    // order: only a real height comparison picks the bundle asserted below.
    const staleBundle = await uploadBundleToSlot(0);
    xln.enqueueRuntimeInput(env, {
      runtimeTxs: [xln.importEntity({
        entityId,
        signerId: runtimeId,
        entitySeed: runtimeSeed,
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
      })],
      entityInputs: [],
    });
    await xln.processRuntime(env);
    const bundle = await uploadBundleToSlot(1);
    expect(bundle.runtimeHeight).toBeGreaterThan(staleBundle.runtimeHeight);
    expect(staleBundle.checkpoint?.eReplicas?.length ?? 0).toBe(0);

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
        useDefaultTowers: false,
        towers: [{ url: `http://127.0.0.1:${towerServer.server.port}`, towerMode: 'blind_backup', enabled: true }],
        minSuccessfulTowers: 1,
      },
    };

    const restored = await tryRestoreRuntimeEnvFromTower(runtime, xln);
    expect(restored).not.toBeNull();
    expect(restored?.bundle.runtimeHeight).toBe(bundle.runtimeHeight);
    expect(restored?.bundle.runtimeHeight).not.toBe(staleBundle.runtimeHeight);
    expect(restored?.env.runtimeId).toBe(runtimeId);
    expect(restored?.env.state.eReplicas.size).toBe(env.state.eReplicas.size);
    expect(runtime.signers[0]?.entityId).toBe(entityId);
    await xln.closeRuntimeDb(restored!.env);
    await xln.closeInfraDb(restored!.env);

    const reloaded = await xln.loadEnvFromDB(runtimeId, runtimeSeed);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.runtimeId).toBe(runtimeId);
    expect(reloaded?.state.height).toBe(bundle.runtimeHeight);
    expect(reloaded?.state.eReplicas.size).toBe(env.state.eReplicas.size);
    await xln.closeRuntimeDb(reloaded!);
    await xln.closeInfraDb(reloaded!);
    await xln.closeRuntimeDb(env);
    await xln.closeInfraDb(env);
  }, 30_000);

  test('frontend last-resort builder emits a tower-bound appointment for dispute-capable accounts', async () => {
    const runtimeSeed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const rootWallet = deriveFrontendWallet(runtimeSeed, 0);
    const signerAddress = rootWallet.address.toLowerCase();
    const entityId = xln.generateLazyEntityId([signerAddress], 1n).toLowerCase();
    const counterpartyId = xln.generateLazyEntityId([addr('55')], 1n).toLowerCase();
    const watchSeed = `0x${'46'.repeat(32)}`;
    const proofHanko = `0x${'77'.repeat(80)}`;
    const towerWallet = Wallet.createRandom();
    const env = xln.createEmptyEnv(runtimeSeed);
    env.runtimeId = signerAddress;
    env.dbNamespace = `${signerAddress}-${Date.now()}-active-builder`;
    env.quietRuntimeLogs = true;
    const jurisdiction = installJurisdiction(env, 'ActiveBuilder');

    xln.enqueueRuntimeInput(env, {
      runtimeTxs: [xln.importEntity({
        entityId,
        signerId: signerAddress,
        entitySeed: runtimeSeed,
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
      })],
      entityInputs: [],
    });
    await xln.processRuntime(env);

    const replica = [...env.state.eReplicas.values()][0];
    expect(replica).toBeTruthy();
    const account = makeAccount(entityId, counterpartyId, watchSeed, jurisdiction);
    account.counterpartyDisputeProofNonce = 9;
    account.counterpartyDisputeProofProposerIsLeft = counterpartyId.toLowerCase() < entityId.toLowerCase();
    // The retired per-account ProofBody cache is not restored here: the frozen
    // hash is the one the canonical builder derives from this Account state.
    const proofBodyHash = canonicalProofBodyHashOf(env, account);
    account.counterpartyDisputeProofBodyHash = proofBodyHash;
    account.counterpartyDisputeProofHanko = proofHanko;
    // Entity accounts are a Patricia-backed map: a committed state seals its
    // shells, so a fixture installs through the same candidate boundary the
    // Entity frame uses rather than mutating the sealed map in place.
    replica!.state = createEntityFrameCandidateState(replica!.state);
    putEntityAccountCandidate(replica!.state.accounts, counterpartyId, account);
    replica!.state = commitEntityFrameCandidateState(replica!.state);

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
      { url: 'http://tower.test', towerMode: 'delayed_last_resort', enabled: true },
      towerWallet.address.toLowerCase(),
      encryptedBundle,
    );

    expect(uploads.length).toBe(1);
    const upload = uploads[0]!;
    expect(upload.lookupKey).not.toBe(encryptedBundle.lookupKey);
    expect(upload.appointment.towerMode).toBe('delayed_last_resort');
    expect(upload.appointment.lastResortPayload?.proofNonce).toBe(9);
    expect(upload.appointment.lastResortPayload?.proofBodyHash).toBe(proofBodyHash);
    expect(upload.appointment.lastResortPayload?.lastResortWindowSeconds).toBe(2);
    const encryptedRemedy = String(upload.appointment.lastResortPayload?.encryptedRemedy || '');
    expect(encryptedRemedy).not.toContain('counter_dispute_remedy');
    const remedy = JSON.parse(await decryptTowerPayloadWithWatchSeed(encryptedRemedy, watchSeed));
    expect(remedy.watchedEntityId).toBe(entityId);
    expect(remedy.latestProof.counterentity).toBe(counterpartyId);
    expect(remedy.latestProof.finalNonce).toBe(9);
    expect(remedy.towerAddress).toBe(towerWallet.address.toLowerCase());
    expect(remedy.lastResortWindowSeconds).toBe(2);
    expect(typeof remedy.ownerAuthorizationHanko).toBe('string');
    expect(remedy.ownerAuthorizationHanko.startsWith('0x')).toBe(true);
  });

  test('standalone tower executes a builder-produced delayed last-resort remedy and exposes the action receipt', async () => {
    const towerRoot = join(process.cwd(), '.tmp-tests', `tower-last-resort-flow-${Date.now()}`);
    tempRoots.push(towerRoot);
    await mkdir(towerRoot, { recursive: true });

    const runtimeSeed = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const rootWallet = deriveFrontendWallet(runtimeSeed, 0);
    const signerAddress = rootWallet.address.toLowerCase();
    const entityId = xln.generateLazyEntityId([signerAddress], 1n).toLowerCase();
    const counterpartyId = xln.generateLazyEntityId([addr('99')], 1n).toLowerCase();
    const watchSeed = `0x${'89'.repeat(32)}`;
    const proofHanko = `0x${'bb'.repeat(80)}`;
    const towerWallet = Wallet.createRandom();
    const env = xln.createEmptyEnv(runtimeSeed);
    env.runtimeId = signerAddress;
    env.dbNamespace = `${signerAddress}-${Date.now()}-last-resort-flow`;
    env.quietRuntimeLogs = true;
    const jurisdiction = installJurisdiction(env, 'LastResortFlow');

    xln.enqueueRuntimeInput(env, {
      runtimeTxs: [xln.importEntity({
        entityId,
        signerId: signerAddress,
        entitySeed: runtimeSeed,
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
      })],
      entityInputs: [],
    });
    await xln.processRuntime(env);

    const replica = [...env.state.eReplicas.values()][0];
    expect(replica).toBeTruthy();
    const account = makeAccount(entityId, counterpartyId, watchSeed, jurisdiction);
    account.counterpartyDisputeProofNonce = 9;
    account.counterpartyDisputeProofProposerIsLeft = counterpartyId.toLowerCase() < entityId.toLowerCase();
    // The retired per-account ProofBody cache is not restored here: the frozen
    // hash is the one the canonical builder derives from this Account state.
    const proofBodyHash = canonicalProofBodyHashOf(env, account);
    account.counterpartyDisputeProofBodyHash = proofBodyHash;
    account.counterpartyDisputeProofHanko = proofHanko;
    // Entity accounts are a Patricia-backed map: a committed state seals its
    // shells, so a fixture installs through the same candidate boundary the
    // Entity frame uses rather than mutating the sealed map in place.
    replica!.state = createEntityFrameCandidateState(replica!.state);
    putEntityAccountCandidate(replica!.state.accounts, counterpartyId, account);
    replica!.state = commitEntityFrameCandidateState(replica!.state);

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
      enableOperatorApi: true,
    });
    servers.push(towerServer);

    const put = await fetch(`http://127.0.0.1:${towerServer.server.port}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(upload.appointment),
    });
    if (!put.ok) throw new Error(`TOWER_APPOINTMENT_UPLOAD_FAILED:${put.status}:${await put.text()}`);
    expect(put.ok).toBe(true);

    const initialProofbodyHash = `0x${'cc'.repeat(32)}`;
    const initialArguments = '0x1234';
    const counterArguments = '0x';
    const disputeStartTimestamp = 1_234n;
    const disputeTimeout = 100n;
    const startedByLeft = entityId.toLowerCase() < counterpartyId.toLowerCase();
    const starterInitialArgumentsCommitment = keccak256(abiCoder.encode(
      ['bytes', 'bool', 'uint256'],
      [initialArguments, startedByLeft, disputeStartTimestamp],
    ));
    const starterCounterArgumentsCommitment = keccak256(abiCoder.encode(
      ['bytes', 'bool', 'uint256'],
      [counterArguments, startedByLeft, disputeStartTimestamp],
    ));
    const disputeHash = encodeDisputeHash(
      7,
      startedByLeft,
      true,
      disputeTimeout,
      4n,
      6n,
      initialProofbodyHash,
      disputeStartTimestamp,
      initialArguments,
      counterArguments,
    );
    const result = await runWatchtowerSweep(towerServer.store, {
      lookupKey: upload.lookupKey,
      towerPrivateKey: towerWallet.privateKey,
      providerFactory: () => ({
        getBlockNumber: async () => 95,
        // The signed account window is 4 + 6 seconds and this appointment owns
        // only the final two-second last-resort slice: t=98 is the first valid
        // submission time for the absolute t=100 dispute deadline.
        getBlock: async () => ({ timestamp: 98 }),
        getLogs: async () => {
          const event = disputeStartedInterface.encodeEventLog(
            disputeStartedInterface.getEvent('DisputeStarted'),
            [
              entityId,
              counterpartyId,
              7n,
              true,
              initialProofbodyHash,
              watchSeed,
              initialArguments,
              counterArguments,
              `0x${'00'.repeat(32)}`,
              disputeTimeout,
              disputeStartTimestamp,
              4,
              6,
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
          disputeTimeout,
          disputeStartTimestamp,
          leftResponseSeconds: 4n,
          rightResponseSeconds: 6n,
          disputeInitialProofbodyHash: initialProofbodyHash,
          disputeInitialProposerIsLeft: true,
          disputeCounterNonce: 0n,
          disputeCounterProofbodyHash: `0x${'00'.repeat(32)}`,
          disputeCounterProposerIsLeft: false,
          starterInitialArgumentsCommitment,
          starterCounterArgumentsCommitment,
          starterCounterProofCommitment: `0x${'00'.repeat(32)}`,
          disputeStartedByLeft: startedByLeft,
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
