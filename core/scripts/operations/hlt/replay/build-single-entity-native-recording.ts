#!/usr/bin/env bun

/** Deterministic canonical TS fixture for the native single-Entity replay gate. */

import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { EntityInput } from '../../../../entity/types';
import type { ManagedEntityIdentity } from '../../../../orchestrator/daemon-control';
import type { JurisdictionConfig } from '../../../../protocol/config/jurisdiction-config';
import { safeStringify } from '../../../../protocol/serialization';
import type { RuntimeInput, RuntimeReplica } from '../../../../runtime/types';
import type { EntityTx } from '../../../../types/entity-tx';
import { computeEntityConsensusSectionDigestsCold } from '../../../../entity/consensus/state-root';
import { createFixturePeerAccounts, type FixturePeerAccounts } from './fixture/fixture-peer-accounts';
import { installVerifiedPeerProfiles } from './fixture/fixture-peer-profiles';

const FIXED_CREATED_AT = 1_775_000_000_000;
const FIXTURE_SNAPSHOT_PERIOD = 1_000_000;
const FIXTURE_CHECKPOINT_PERIOD = 100;
const MAIN_SEED = 'xln-native-replay-main-v1';
const PEER_SEED = 'xln-native-replay-peer-v1';
const FIXTURE_JURISDICTION: JurisdictionConfig = {
  name: 'native-replay-jurisdiction',
  address: 'jreplica://native-replay-jurisdiction',
  chainId: 31_337,
  depositoryAddress: '0x000000000000000000000000000000000000dead',
  entityProviderAddress: '0x000000000000000000000000000000000000beef',
  blockTimeMs: 1_000,
};

export type SingleEntityNativeFixturePaths = Readonly<{
  recording: string;
  walDb: string;
  stateDb: string;
  runtimeSeedFile: string;
  manifest: string;
}>;

export type SingleEntityNativeFixtureOptions = Readonly<{
  paymentCount?: number;
  paymentBatchSize?: number;
  peerCount?: number;
  peerSetupBatch?: number;
  includeSwap?: boolean;
}>;

type RuntimeApi = typeof import('../../../../runtime');

type FixtureIdentities = Readonly<{
  main: ManagedEntityIdentity;
  peers: readonly ManagedEntityIdentity[];
}>;

const configureProcess = (workDir: string): void => {
  process.env['XLN_DB_PATH'] = join(workDir, 'db');
  process.env['XLN_RDB_ROOT'] = join(workDir, 'db');
  process.env['XLN_STORAGE_WAL_SYNC'] = '1';
  process.env['XLN_STORAGE_CERTIFIED_HISTORY'] = '1';
  process.env['XLN_STORAGE_SNAPSHOT_PERIOD_FRAMES'] = String(FIXTURE_SNAPSHOT_PERIOD);
  process.env['XLN_RSCORE_AUTHORITY'] = '0';
};

const createFixtureRuntime = (runtime: RuntimeApi, seed: string): RuntimeReplica => {
  const env = runtime.createEmptyEnv(seed);
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.state.timestamp = FIXED_CREATED_AT;
  env.runtimeConfig = {
    ...env.runtimeConfig,
    minFrameDelayMs: 0,
    storage: {
      ...env.runtimeConfig?.storage,
      enabled: true,
      materializePeriodFrames: FIXTURE_CHECKPOINT_PERIOD,
      snapshotPeriodFrames: FIXTURE_SNAPSHOT_PERIOD,
      canonicalHashPeriodFrames: 1,
    },
  };
  return env;
};

const bindFixtureJurisdiction = async (env: RuntimeReplica): Promise<void> => {
  const { createJReplica } = await import('../../../../scenarios/harness/boot');
  const replica = createJReplica(env, FIXTURE_JURISDICTION.name, FIXTURE_JURISDICTION.depositoryAddress!);
  Object.assign(replica, {
    chainId: FIXTURE_JURISDICTION.chainId,
    rpcs: [FIXTURE_JURISDICTION.address],
    depositoryAddress: FIXTURE_JURISDICTION.depositoryAddress,
    entityProviderAddress: FIXTURE_JURISDICTION.entityProviderAddress,
    contracts: {
      ...replica.contracts,
      depository: FIXTURE_JURISDICTION.depositoryAddress,
      entityProvider: FIXTURE_JURISDICTION.entityProviderAddress,
      account: '0x000000000000000000000000000000000000cafe',
      deltaTransformer: '0x000000000000000000000000000000000000babe',
    },
  });
};

const registerFixtureSigner = async (
  env: RuntimeReplica,
  identity: ManagedEntityIdentity,
): Promise<void> => {
  const [{ registerSignerKey }, { hexToBytes }] = await Promise.all([
    import('../../../../account/crypto'),
    import('../../../../support/bytes/hex-bytes'),
  ]);
  registerSignerKey(env, identity.signerId, hexToBytes(identity.privateKeyHex));
};

const onlyEntityReplica = (env: RuntimeReplica) => {
  if (env.state.eReplicas.size !== 1) {
    throw new Error(`NATIVE_FIXTURE_ENTITY_COUNT_INVALID:${env.state.eReplicas.size}`);
  }
  return env.state.eReplicas.values().next().value!;
};

const enqueue = (
  runtime: RuntimeApi,
  env: RuntimeReplica,
  timestamp: number,
  entityInputs: EntityInput[] = [],
  runtimeTxs: RuntimeInput['runtimeTxs'] = [],
): void => runtime.enqueueRuntimeInput(env, { runtimeTxs, entityInputs, timestamp });

/** Drive H1 plus the peer-account drain until both are quiescent. */
const pump = async (
  runtime: RuntimeApi,
  main: () => RuntimeReplica,
  peers: FixturePeerAccounts,
  getTimestamp: () => number,
  maxRounds = 80,
): Promise<void> => {
  for (let round = 0; round < maxRounds; round += 1) {
    let progressed = false;
    if (runtime.hasRuntimeWork(main())) {
      await runtime.processRuntime(main());
      progressed = true;
    }
    if ((await peers.drainReplies(getTimestamp())) > 0) progressed = true;
    if (!progressed) return;
  }
  throw new Error(`NATIVE_FIXTURE_CONVERGENCE_TIMEOUT:${maxRounds}`);
};

const identityImports = async (runtime: RuntimeApi, identities: FixtureIdentities) => ({
  main: runtime.importEntity({
    entityId: identities.main.entityId,
    signerId: identities.main.signerId,
    entitySeed: identities.main.entitySeed,
    data: {
      config: identities.main.consensusConfig,
      isProposer: true,
      profileName: identities.main.name,
      position: identities.main.position,
    },
  }),
});

const profileInput = (identity: FixtureIdentities['main']): EntityInput => ({
  entityId: identity.entityId,
  signerId: identity.signerId,
  entityTxs: [{
    type: 'profile-update',
    data: {
      profile: {
        entityId: identity.entityId,
        name: identity.name,
        avatar: '',
        bio: '',
        website: '',
      },
    },
  }],
});

const setupInputs = async (
  identities: FixtureIdentities,
): Promise<Readonly<{ main: EntityInput[]; peer: EntityInput[] }>> => {
  const [{ DEFAULT_SPREAD_DISTRIBUTION }, { defaultAccountDisputeConfigForRoleEvidence }] = await Promise.all([
    import('../../../../orderbook'),
    import('../../../../account/config/dispute-config'),
  ]);
  const credit = 10_000n * 10n ** 18n;
  return {
    main: [{
      entityId: identities.main.entityId,
      signerId: identities.main.signerId,
      entityTxs: [{
        type: 'initOrderbookExt',
        data: {
          name: 'Native Replay Hub',
          spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
          referenceTokenId: 2,
          usdQuoteAuthorityEntityId: identities.main.entityId,
          minTradeSize: 0n,
          supportedPairs: ['1/2'],
        },
      }, ...identities.peers.flatMap((peer): EntityTx[] => [
        { type: 'extendCredit', data: { counterpartyEntityId: peer.entityId, tokenId: 1, amount: credit } },
        { type: 'extendCredit', data: { counterpartyEntityId: peer.entityId, tokenId: 2, amount: credit } },
      ])],
    }],
    peer: identities.peers.map(peer => ({
      entityId: peer.entityId,
      signerId: peer.signerId,
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: identities.main.entityId,
          disputeConfig: defaultAccountDisputeConfigForRoleEvidence(
            { entityId: peer.entityId, isHub: false, source: 'operator-config' },
            { entityId: identities.main.entityId, isHub: true, source: 'operator-config' },
          ),
          rebalancePolicy: { r2cRequestSoftLimit: credit, hardLimit: credit, maxAcceptableFee: 0n },
        },
      },
      { type: 'extendCredit', data: { counterpartyEntityId: identities.main.entityId, tokenId: 1, amount: credit } },
      { type: 'extendCredit', data: { counterpartyEntityId: identities.main.entityId, tokenId: 2, amount: credit } }],
    })),
  };
};

/** Causal setup slices: peer order preserved, no sorting. */
const setupSlices = (inputs: readonly EntityInput[], batch: number): EntityInput[][] => {
  const slices: EntityInput[][] = [];
  for (let index = 0; index < inputs.length; index += batch) slices.push(inputs.slice(index, index + batch));
  return slices;
};

/** initOrderbookExt stays first and alone; credit txs follow in bounded batches. */
const mainSetupBatches = (input: EntityInput, batch: number): EntityInput[] => {
  const [orderbook, ...credits] = input.entityTxs ?? [];
  if (!orderbook || orderbook.type !== 'initOrderbookExt') {
    throw new Error(`NATIVE_FIXTURE_MAIN_SETUP_SHAPE:${orderbook?.type ?? 'missing'}`);
  }
  const batches: EntityInput[] = [
    { entityId: input.entityId, signerId: input.signerId, entityTxs: [orderbook] },
  ];
  for (let index = 0; index < credits.length; index += batch) {
    batches.push({
      entityId: input.entityId,
      signerId: input.signerId,
      entityTxs: credits.slice(index, index + batch),
    });
  }
  return batches;
};

const tailInputs = async (identities: FixtureIdentities): Promise<Readonly<{
  payment: (start: number, count: number) => EntityInput;
}>> => {
  const { getTokenInfo } = await import('../../../../account/utils');
  const eth = 10n ** BigInt(getTokenInfo(1).decimals);
  return {
    payment: (start, count) => ({
      entityId: identities.main.entityId,
      signerId: identities.main.signerId,
      entityTxs: Array.from({ length: count }, (_, offset): EntityTx => {
        const paymentIndex = start + offset;
        const target = identities.peers[paymentIndex % identities.peers.length]!;
        return {
          type: 'directPayment',
          data: {
            targetEntityId: target.entityId,
            tokenId: 1,
            amount: eth / 10n,
            route: [identities.main.entityId, target.entityId],
            deliveryMode: 'direct',
            description: `native replay direct payment ${paymentIndex}`,
          },
        };
      }),
    }),
  };
};

const assertTail = (
  baseHeight: number,
  frames: readonly import('../../../../storage/types').PersistedFrameJournal[],
): void => {
  if (frames.length === 0 || frames[0]?.height !== baseHeight + 1) {
    throw new Error(`NATIVE_FIXTURE_TAIL_EMPTY_OR_GAPPED:${baseHeight}:${frames.length}`);
  }
  for (const [index, frame] of frames.entries()) {
    if (frame.height !== baseHeight + index + 1) throw new Error(`NATIVE_FIXTURE_TAIL_GAP:${frame.height}`);
    if (frame.runtimeInput.runtimeTxs.length !== 0 || (frame.runtimeInput.jInputs?.length ?? 0) !== 0) {
      throw new Error(`NATIVE_FIXTURE_FORBIDDEN_RUNTIME_LANE:${frame.height}`);
    }
  }
  if (frames.at(-1)!.height >= FIXTURE_SNAPSHOT_PERIOD) {
    throw new Error(`NATIVE_FIXTURE_TAIL_CROSSES_SNAPSHOT:${frames.at(-1)!.height}`);
  }
};

export const buildSingleEntityNativeRecording = async (
  outputDirectory: string,
  options: SingleEntityNativeFixtureOptions = {},
): Promise<SingleEntityNativeFixturePaths> => {
  const paymentCount = options.paymentCount ?? 1;
  const paymentBatchSize = options.paymentBatchSize ?? 1;
  const peerCount = options.peerCount ?? 1;
  const peerSetupBatch = options.peerSetupBatch ?? 64;
  if (!Number.isSafeInteger(paymentCount) || paymentCount < 1) {
    throw new Error(`NATIVE_FIXTURE_PAYMENT_COUNT:${paymentCount}`);
  }
  if (!Number.isSafeInteger(paymentBatchSize) || paymentBatchSize < 1) {
    throw new Error(`NATIVE_FIXTURE_PAYMENT_BATCH_SIZE:${paymentBatchSize}`);
  }
  if (!Number.isSafeInteger(peerCount) || peerCount < 1) {
    throw new Error(`NATIVE_FIXTURE_PEER_COUNT:${peerCount}`);
  }
  if (!Number.isSafeInteger(peerSetupBatch) || peerSetupBatch < 1) {
    throw new Error(`NATIVE_FIXTURE_PEER_SETUP_BATCH:${peerSetupBatch}`);
  }
  if (options.includeSwap === true) {
    throw new Error('NATIVE_FIXTURE_SWAP_UNSUPPORTED_WITHOUT_PEER_ENTITY');
  }
  const workDir = resolve(outputDirectory);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  configureProcess(workDir);

  const [runtime, { deriveManagedEntityIdentity }, dbPaths, recordingApi] = await Promise.all([
    import('../../../../runtime'),
    import('../../../../orchestrator/daemon-control'),
    import('../../../../storage/runtime-dbs'),
    import('./recording'),
  ]);
  const identities: FixtureIdentities = {
    main: deriveManagedEntityIdentity({
      name: 'Native Replay Hub', seed: MAIN_SEED, signerLabel: 'owner', jurisdiction: FIXTURE_JURISDICTION,
    }),
    peers: Array.from({ length: peerCount }, (_, index) => deriveManagedEntityIdentity({
      name: index === 0 ? 'Native Replay Peer' : `Native Replay Peer ${index + 1}`,
      seed: index === 0 ? PEER_SEED : `${PEER_SEED}-${index + 1}`,
      signerLabel: 'owner',
      jurisdiction: FIXTURE_JURISDICTION,
    })),
  };
  let main = createFixtureRuntime(runtime, MAIN_SEED);
  await bindFixtureJurisdiction(main);
  await registerFixtureSigner(main, identities.main);
  const mainRef = (): RuntimeReplica => main;
  let timestamp = FIXED_CREATED_AT;
  const peers = createFixturePeerAccounts({
    runtime,
    main: mainRef,
    mainIdentity: identities.main,
    peerIdentities: identities.peers,
    jurisdiction: FIXTURE_JURISDICTION,
    peerSeed: PEER_SEED,
  });
  peers.installDispatch();
  const pumpMain = () => pump(runtime, mainRef, peers, () => timestamp);

  try {
    const imports = await identityImports(runtime, identities);
    enqueue(runtime, main, ++timestamp, [], [imports.main]);
    await pumpMain();
    enqueue(runtime, main, ++timestamp, [profileInput(identities.main)]);
    await pumpMain();
    // Verified peer routes must exist before any signed genesis reaches H1.
    const signing = peers.signingContext();
    await installVerifiedPeerProfiles({
      main: mainRef, signingEnv: signing.env, peers: signing.peers, timestamp,
    });

    const setup = await setupInputs(identities);
    for (const slice of setupSlices(setup.peer, peerSetupBatch)) {
      await peers.seedAccounts(slice, ++timestamp);
      await pumpMain();
    }
    for (const batchInput of mainSetupBatches(setup.main[0]!, peerSetupBatch)) {
      enqueue(runtime, main, ++timestamp, [batchInput]);
      await pumpMain();
    }

    // Mirror a restored production Runtime starting on a fresh host: publish
    // its complete base once into an empty namespace, then append only WAL
    // until the configured 100-frame checkpoint cadence is due.
    await runtime.closeRuntimeDb(main);
    main.dbNamespace = `${main.runtimeId}-native-replay-base`;
    await runtime.persistRestoredEnvToDB(main);
    peers.installDispatch();

    const baseHeight = main.state.height;
    const [baseFrame] = await runtime.readPersistedFrameJournals(main, {
      fromHeight: baseHeight,
      toHeight: baseHeight,
      limit: 1,
      includeRuntimeMachine: false,
    });
    if (!baseFrame || baseFrame.height !== baseHeight) {
      throw new Error(`NATIVE_FIXTURE_BASE_FRAME_MISSING:${baseHeight}`);
    }
    const signers = [{ index: 1, address: main.runtimeId!, name: 'Native Replay Runtime' }];
    const snapshot = runtime.buildRuntimeRecoveryBundle(main, {
      kind: 'snapshot', signers, createdAt: FIXED_CREATED_AT,
    });
    const sourceStateDb = dbPaths.resolveStorageDbPath(main, 'current');
    const stateDb = join(workDir, 'runtime-replay-single-entity-state');
    await runtime.closeRuntimeDb(main);
    if (!existsSync(sourceStateDb)) throw new Error(`NATIVE_FIXTURE_BASE_DB_MISSING:${sourceStateDb}`);
    cpSync(sourceStateDb, stateDb, { recursive: true, force: true });
    const { importRscoreCheckpointIntoFrozenState } = await import('./import-rscore-checkpoint');
    const importedCheckpoint = await importRscoreCheckpointIntoFrozenState({
      mode: 'offline-pre-authority-import',
      env: main,
      entity: onlyEntityReplica(main),
      identity: identities.main,
      stateDbPath: stateDb,
      timestamp,
      expectedReplicaMetaDigest: baseFrame.replicaMetaDigest,
    });
    if (importedCheckpoint.accountsRoot !== onlyEntityReplica(main).state.accounts.rootHash()) {
      throw new Error('NATIVE_FIXTURE_RSCORE_OFFLINE_IMPORT_ROOT');
    }
    // closeRuntimeDb detaches transport handles by design; the Runtime keeps
    // its state but the canonical in-process direct-server session must bind again.
    peers.installDispatch();

    const accountsRoots = new Map<number, string>();
    const entitySections = new Map<number, ReturnType<typeof computeEntityConsensusSectionDigestsCold>>();
    const unregister = runtime.registerRuntimeFrameCommitCallback(main, ({ height }) => {
      const state = onlyEntityReplica(main).state;
      accountsRoots.set(height, state.accounts.rootHash());
      entitySections.set(height, computeEntityConsensusSectionDigestsCold(state));
    });
    const tail = await tailInputs(identities);
    for (let start = 0; start < paymentCount; start += paymentBatchSize) {
      const count = Math.min(paymentBatchSize, paymentCount - start);
      enqueue(runtime, main, ++timestamp, [tail.payment(start, count)]);
      await pumpMain();
    }
    unregister();

    const targetHeight = main.state.height;
    const frames = await runtime.readPersistedFrameJournals(main, {
      fromHeight: baseHeight + 1,
      toHeight: targetHeight,
      limit: targetHeight - baseHeight,
      includeRuntimeMachine: false,
    });
    assertTail(baseHeight, frames);
    const tailBundle = runtime.buildRuntimeRecoveryBundle(main, {
      kind: 'journal_tail',
      signers,
      createdAt: FIXED_CREATED_AT,
      baseCheckpoint: { height: baseHeight, hash: snapshot.checkpointHash! },
      frames,
    });
    const recording = runtime.buildRuntimeRecording([snapshot, tailBundle], FIXED_CREATED_AT);
    const entityRecords = await runtime.readPersistedEntityFrameHistoryRecords(
      main, identities.main.entityId, 1_000, { maxRuntimeHeight: targetHeight },
    );
    const entityFrames = entityRecords.filter(record => record.runtimeHeight > baseHeight).map(record => {
      const accountsRoot = accountsRoots.get(record.runtimeHeight);
      if (!accountsRoot) throw new Error(`NATIVE_FIXTURE_ACCOUNTS_ROOT_MISSING:${record.runtimeHeight}`);
      const sections = entitySections.get(record.runtimeHeight);
      if (!sections) throw new Error(`NATIVE_FIXTURE_ENTITY_SECTIONS_MISSING:${record.runtimeHeight}`);
      return {
        runtimeHeight: record.runtimeHeight,
        entityId: record.entityId,
        entityHeight: record.entityHeight,
        frameHash: record.link.frame.hash,
        stateRoot: record.link.frame.stateRoot,
        authorityRoot: record.link.frame.authorityRoot,
        accountsRoot,
        sections,
      };
    }).sort((left, right) => left.runtimeHeight - right.runtimeHeight);
    const accountFrames = (await Promise.all(identities.peers.map(peerIdentity =>
      runtime.readPersistedAccountFrameHistoryRecords(
        main, identities.main.entityId, peerIdentity.entityId, 1_000, { maxRuntimeHeight: targetHeight },
      ),
    ))).flat().filter(record => record.runtimeHeight > baseHeight).map(record => ({
      runtimeHeight: record.runtimeHeight,
      entityId: record.entityId,
      counterpartyId: record.counterpartyId,
      source: record.source,
      frame: record.frame,
    })).sort((left, right) => left.runtimeHeight - right.runtimeHeight || left.frame.height - right.frame.height);
    const authorityFrameOracle = { entityFrames, accountFrames };
    const authorityEvidence = (await import('./authority-evidence')).buildHltAuthorityEvidence(
      frames, authorityFrameOracle,
    );
    const distinctActiveAccounts = new Set(
      authorityEvidence.economicOperations.operations.flatMap(op =>
        op.stages.map(stage => `${stage.ownerEntityId}|${stage.counterpartyId}`),
      ),
    ).size;
    if (distinctActiveAccounts !== peerCount) {
      throw new Error(
        `NATIVE_FIXTURE_DISTINCT_ACTIVE_ACCOUNTS_MISMATCH:` +
        `expected=${peerCount}:actual=${distinctActiveAccounts}`,
      );
    }
    const submittedPayments = authorityEvidence.economicOperations.coverage.directPayments;
    if (submittedPayments < paymentCount) {
      throw new Error(
        `NATIVE_FIXTURE_SUBMITTED_PAYMENTS_INSUFFICIENT:` +
        `expected=${paymentCount}:actual=${submittedPayments}`,
      );
    }
    const finalAccounts = onlyEntityReplica(main).state.accounts;
    if (finalAccounts.size !== peerCount) {
      throw new Error(
        `NATIVE_FIXTURE_ACCOUNT_COUNT_MISMATCH:expected=${peerCount}:actual=${finalAccounts.size}`,
      );
    }
    for (const [counterpartyId, account] of finalAccounts.entries()) {
      if ((account as { pendingFrame?: unknown }).pendingFrame !== undefined) {
        throw new Error(`NATIVE_FIXTURE_PENDING_ACCOUNT_FRAME:${counterpartyId}`);
      }
    }
    peers.assertQuiescent();
    const evidenceCoverage = {
      outbox: frames.filter(frame => frame.runtimeOutputCount > 0).length,
      events: entityRecords.filter(record =>
        record.runtimeHeight > baseHeight && record.link.frame.events.length > 0).length,
      ackCommit: accountFrames.filter(row => row.source === 'ackCommit').length,
      peerCommit: accountFrames.filter(row => row.source === 'peerCommit').length,
    };
    const requiredEvidence = [evidenceCoverage.outbox, evidenceCoverage.events, evidenceCoverage.ackCommit];
    if (requiredEvidence.some(count => count === 0)) {
      const messages = [...new Set(frames.flatMap(frame => frame.logs.map(entry => entry.message)))];
      const entityEventTypes = [...new Set(entityRecords.flatMap(record =>
        record.runtimeHeight > baseHeight ? record.link.frame.events.map(event => event.type) : []))];
      throw new Error(
        `NATIVE_FIXTURE_EVIDENCE_COVERAGE_INCOMPLETE:` +
        safeStringify({ ...evidenceCoverage, messages, entityEventTypes }),
      );
    }
    const artifact = {
      schema: recordingApi.HLT_HUB_RECORDING_SCHEMA,
      createdAt: FIXED_CREATED_AT,
      source: {
        workDir,
        users: peerCount,
        workload: `single-entity-${peerCount}-accounts-pay-${paymentCount}`,
      },
      recording,
      totals: recordingApi.summarizeHltHubFrames(frames),
      featurePolicy: {
        hubRebalance: 'disabled' as const,
        crossJ: 'disabled' as const,
        disputes: 'disabled' as const,
        lending: 'disabled' as const,
      },
      authorityFrameOracle,
      authorityEvidence,
    };
    const paths: SingleEntityNativeFixturePaths = {
      recording: join(workDir, 'runtime-replay-single-entity.json'),
      walDb: dbPaths.resolveRuntimeWalDbPath(main),
      stateDb,
      runtimeSeedFile: join(workDir, 'runtime.seed'),
      manifest: join(workDir, 'runtime-replay-single-entity.paths.json'),
    };
    recordingApi.writeHltHubRecording(paths.recording, artifact);
    writeFileSync(paths.runtimeSeedFile, `${MAIN_SEED}\n`, { mode: 0o600 });
    writeFileSync(paths.manifest, `${safeStringify(paths, 2)}\n`, { mode: 0o600 });
    return paths;
  } finally {
    await runtime.closeRuntimeDb(main).catch(() => undefined);
    await runtime.closeInfraDb(main).catch(() => undefined);
  }
};

const cliOutputDirectory = (): string => {
  const index = process.argv.indexOf('--output-dir');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return resolve(value || join(process.cwd(), '.logs', 'rscore-native-fixture'));
};

const cliPositiveInteger = (flag: string, defaultValue: number): number => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return defaultValue;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`NATIVE_FIXTURE_CLI:${flag}`);
  return value;
};

if (import.meta.main) {
  const startedAt = performance.now();
  const paths = await buildSingleEntityNativeRecording(cliOutputDirectory(), {
    paymentCount: cliPositiveInteger('--payments', 1),
    paymentBatchSize: cliPositiveInteger('--payment-batch-size', 1),
    peerCount: cliPositiveInteger('--peers', 1),
    peerSetupBatch: cliPositiveInteger('--peer-setup-batch', 64),
    includeSwap: false,
  });
  mkdirSync(dirname(paths.manifest), { recursive: true });
  console.log(safeStringify({ ...paths, elapsedMs: Math.round(performance.now() - startedAt) }));
}
