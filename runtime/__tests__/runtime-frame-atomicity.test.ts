import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';

import { generateLazyEntityId } from '../entity/factory';
import { initCrontab } from '../entity/scheduler';
import { dbRootPath } from '../runtime/platform';
import { safeStringify } from '../protocol/serialization';
import { cloneIsolatedRuntimeSnapshot } from '../runtime/input-clone';
import {
  closeInfraDb,
  closeRuntimeDb,
  applyRuntimeInput,
  cloneRuntimeFrameMempool,
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeWalDb,
  getRuntimeStorageDb,
  handleInboundP2PEntityInput,
  handleInboundReliableReceipt,
  processRuntime,
} from '../runtime';
import {
  createReliableDeliveryReceipt,
  getInputReliableIdentity,
} from '../runtime/reliable-delivery';
import { decodeBuffer, encodeBuffer } from '../storage/codec';
import { KEY_HEAD } from '../storage/keys';
import { readStorageHead } from '../storage';
import {
  buildCanonicalEntityReplicaSnapshot,
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../storage/wal/snapshot';
import type { AccountInput } from '../types/account';
import type { ConsensusConfig, EntityInput, EntityReplica, EntityState, JurisdictionConfig } from '../entity/types';
import type { RuntimeReplica, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeInput, RuntimeTx } from '../runtime/types';
import { enableStrictScenario } from '../scenarios/helpers';
import {
  buildEntityHashesToSign,
  cloneAccountInputWithoutPostCommitHankos,
} from '../entity/consensus/hanko-witness';
import { markLocalJAuthorityRuntimeTx } from '../jurisdiction/machine/registration-evidence';
import { readStorageFrameRecord } from '../storage/read';
import { createTestJReplica } from './helpers/j-replica';

const TEST_RUN_ID = `${process.pid}-${Date.now()}`;
const cleanupNamespaces: string[] = [];

const address = (byte: string): string => `0x${byte.repeat(20)}`;
const hash = (byte: string): string => `0x${byte.repeat(32)}`;

const cleanupRuntimeStorage = (namespace: string): void => {
  const base = join(dbRootPath, namespace);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-events', '-infra']) {
    rmSync(`${base}${suffix}`, { recursive: true, force: true });
  }
};

afterEach(() => {
  while (cleanupNamespaces.length > 0) cleanupRuntimeStorage(cleanupNamespaces.pop()!);
});

const jurisdiction: JurisdictionConfig = {
  name: 'AtomicityTestnet',
  address: 'rpc://atomicity-testnet',
  chainId: 31_337,
  depositoryAddress: address('d1'),
  entityProviderAddress: address('e1'),
};

const makeAliasedBoardRuntimeInput = (): {
  boards: ConsensusConfig[];
  runtimeInput: RuntimeInput;
} => {
  const sharedJurisdiction = { ...jurisdiction };
  const makeBoard = (validators: string[]): ConsensusConfig => ({
    mode: 'proposer-based',
    threshold: 1n,
    validators,
    shares: Object.fromEntries(validators.map(validator => [validator, 1n])),
    jurisdiction: sharedJurisdiction,
  });
  const boards = [
    makeBoard(['1', '2', '3', '4']),
    makeBoard(['6', '7', '8', '9']),
    makeBoard(['5']),
  ];
  return {
    boards,
    runtimeInput: {
      runtimeTxs: boards.flatMap(config => config.validators.map((signerId, index) => ({
        type: 'importReplica' as const,
        entityId: hash(signerId.padStart(2, '0').slice(-2)),
        signerId,
        data: {
          config,
          isProposer: index === 0,
          position: { x: index, y: 0, z: 0 },
        },
      }))),
      entityInputs: [],
    },
  };
};

const installJurisdiction = (env: RuntimeReplica): void => {
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, createTestJReplica({
    name: jurisdiction.name,
    rpcs: [jurisdiction.address!],
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      account: address('a1'),
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      deltaTransformer: address('f1'),
    },
  }));
};

const board = (leader: string, validator: string): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 2n,
  validators: [leader, validator],
  shares: { [leader]: 1n, [validator]: 1n },
  jurisdiction,
});

const makeEntityState = (entityId: string, config: ConsensusConfig): EntityState => ({
  entityId,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config,
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  profile: {
    name: 'Atomicity entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
  crontabState: initCrontab(),
  swapTradingPairs: [],
  pendingCrossJurisdictionFillAcks: new Map(),
  crossJurisdictionBookAdmissions: new Map(),
});

const installValidatorReplica = (
  env: RuntimeReplica,
  leader: string,
  validator: string,
): EntityReplica => {
  const config = board(leader, validator);
  const entityId = generateLazyEntityId(config.validators, config.threshold).toLowerCase();
  const replica: EntityReplica = {
    entityId,
    signerId: validator,
    entityEncPubKey: '',
    mempool: [],
    isProposer: false,
    state: makeEntityState(entityId, config),
  };
  env.state.eReplicas.set(`${entityId}:${validator}`, replica);
  return replica;
};

const importReplicaTx = (slot: string) => {
  const leader = address(`${slot}1`);
  const validator = address(`${slot}2`);
  const config = board(leader, validator);
  return {
    type: 'importReplica' as const,
    entityId: generateLazyEntityId(config.validators, config.threshold).toLowerCase(),
    signerId: validator,
    data: {
      config,
      isProposer: false,
      profileName: `Imported ${slot}`,
    },
  };
};

const localImportReplicaTx = (env: RuntimeReplica, slot: string) => {
  const signerId = env.runtimeId!;
  const coValidatorId = address(`${slot}f`);
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 2n,
    validators: [signerId, coValidatorId],
    shares: { [signerId]: 1n, [coValidatorId]: 1n },
    jurisdiction,
  };
  return {
    type: 'importReplica' as const,
    entityId: generateLazyEntityId(config.validators, config.threshold).toLowerCase(),
    signerId,
    data: {
      config,
      isProposer: true,
      profileName: `Local ${slot}`,
    },
  };
};

const exactQueuedInput = (env: RuntimeReplica): RuntimeInput => ({
  runtimeTxs: env.runtimeMempool?.runtimeTxs ?? [],
  entityInputs: env.runtimeMempool?.entityInputs ?? [],
  ...(env.runtimeMempool?.jInputs?.length ? { jInputs: env.runtimeMempool.jInputs } : {}),
  ...(env.runtimeMempool?.reliableReceipts?.length
    ? { reliableReceipts: env.runtimeMempool.reliableReceipts }
    : {}),
});

const createTestReliableReceipt = (
  targetEnv: RuntimeReplica,
  entityId: string,
  signerId: string,
): { from: string; receipt: ReliableDeliveryReceipt } => {
  const receiver = createEmptyEnv(`runtime ingress receipt ${TEST_RUN_ID}`);
  const output: RoutedEntityInput = {
    runtimeId: targetEnv.runtimeId!,
    entityId,
    signerId,
    hashPrecommitFrame: { height: 1, frameHash: hash('b1') },
    hashPrecommits: new Map([[address('b2'), [`0x${'b3'.repeat(65)}`]]]),
  };
  const identity = getInputReliableIdentity(output);
  if (!identity) throw new Error('TEST_RELIABLE_INGRESS_IDENTITY_MISSING');
  return {
    from: receiver.runtimeId!,
    receipt: createReliableDeliveryReceipt(receiver, identity, 'exact'),
  };
};

const corruptCurrentHeadAhead = async (env: RuntimeReplica): Promise<void> => {
  const currentDb = getRuntimeStorageDb(env);
  const head = await readStorageHead(currentDb);
  if (!head) throw new Error('TEST_STORAGE_CURRENT_HEAD_MISSING');
  const batch = currentDb.batch();
  batch.put(KEY_HEAD, encodeBuffer({ ...head, latestHeight: head.latestHeight + 1 }));
  await batch.write({ sync: true });
};

const closeTestEnv = async (env: RuntimeReplica): Promise<void> => {
  await closeRuntimeDb(env);
  await closeInfraDb(env);
};

describe('runtime frame atomicity', () => {
  test('a caller waiting for the writer lock cannot resume after Runtime halts', async () => {
    const env = createEmptyEnv(`runtime sticky halt waiter ${TEST_RUN_ID}`);
    env.quietRuntimeLogs = true;
    let releaseWriter!: () => void;
    env.infrastructure!.processingPromise = new Promise<void>(resolve => {
      releaseWriter = resolve;
    });
    const heightBefore = env.state.height;
    const waitingProcess = processRuntime(env);

    env.infrastructure!.lifecyclePhase = 'halted';
    env.infrastructure!.halted = true;
    // Match the real writer release order: clear ownership before waking the
    // queued caller. Leaving a resolved Promise installed makes any correct
    // `while (processingPromise)` lock implementation spin forever.
    env.infrastructure!.processingPromise = null;
    releaseWriter();

    await expect(waitingProcess).rejects.toThrow('RUNTIME_PROCESS_HALTED');
    expect(env.state.height).toBe(heightBefore);
    expect(env.infrastructure?.processingPromise).toBeNull();
  });

  test('frame input cloning preserves every shared board config without cross-message aliases', () => {
    const { runtimeInput: source } = makeAliasedBoardRuntimeInput();

    const cloned = cloneRuntimeFrameMempool(source);
    const clonedImports = cloned.runtimeTxs.filter((tx) => tx.type === 'importReplica');
    expect(clonedImports).toHaveLength(9);
    for (const [index, runtimeTx] of clonedImports.entries()) {
      expect(runtimeTx.data.config.shares).toEqual(
        (source.runtimeTxs[index] as Extract<RuntimeTx, { type: 'importReplica' }>).data.config.shares,
      );
      expect(runtimeTx.data.config).not.toBe(
        (source.runtimeTxs[index] as Extract<RuntimeTx, { type: 'importReplica' }>).data.config,
      );
    }
    expect(clonedImports[4]!.data.config).not.toBe(clonedImports[5]!.data.config);
  });

  test('frame input cloning preserves repeated jurisdictions inside one registration RuntimeTx', () => {
    const config: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [address('31')],
      shares: { [address('31')]: 1n },
      jurisdiction,
    };
    const registration: RuntimeTx = {
      type: 'recordNumberedRegistrationIntent',
      data: {
        status: 'pending',
        request: {
          version: 1,
          intentId: hash('32'),
          stackKey: hash('33'),
          payerSignerId: address('34'),
          entityProviderAddress: jurisdiction.entityProviderAddress,
          entities: ['first', 'second'].map(name => ({ name, boardHash: hash('35'), config })),
        },
        requestHash: hash('36'),
        rawTransaction: '0x12',
        transactionHash: hash('37'),
        transactionNonce: 0,
      },
    };

    const [cloned] = cloneRuntimeFrameMempool({ runtimeTxs: [registration], entityInputs: [] }).runtimeTxs;
    if (cloned?.type !== 'recordNumberedRegistrationIntent') throw new Error('TEST_REGISTRATION_TX_MISSING');
    const [first, second] = cloned.data.request.entities;
    expect(first?.config.jurisdiction?.chainId).toBe(jurisdiction.chainId);
    expect(second?.config.jurisdiction?.chainId).toBe(jurisdiction.chainId);
    expect(first?.config).not.toBe(second?.config);
    expect(first?.config.jurisdiction).not.toBe(second?.config.jurisdiction);
  });

  test('frame input cloning isolates a shared rebalance policy inside one Entity input', () => {
    const rebalancePolicy = {
      r2cRequestSoftLimit: 500n,
      hardLimit: 10_000n,
      maxAcceptableFee: 15n,
    };
    const source: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [{
        entityId: hash('a1'),
        signerId: address('a2'),
        entityTxs: ['b1', 'b2', 'b3', 'b4'].map(byte => ({
          type: 'openAccount' as const,
          data: {
            targetEntityId: hash(byte),
            creditAmount: 1_000n,
            tokenId: 1,
            rebalancePolicy,
          },
        })),
      }],
    };

    const cloned = cloneRuntimeFrameMempool(source);
    const policies = cloned.entityInputs[0]!.entityTxs!.map(tx => {
      if (tx.type !== 'openAccount') throw new Error(`TEST_OPEN_ACCOUNT_EXPECTED:${tx.type}`);
      return tx.data.rebalancePolicy;
    });

    expect(policies).toEqual(Array.from({ length: 4 }, () => rebalancePolicy));
    expect(new Set(policies).size).toBe(4);
    expect(policies.every(policy => policy !== rebalancePolicy)).toBe(true);
  });

  test('frame input cloning isolates shared policies in proposed and prepared frames', () => {
    const rebalancePolicy = {
      r2cRequestSoftLimit: 500n,
      hardLimit: 10_000n,
      maxAcceptableFee: 15n,
    };
    const frameTxs = (): EntityTx[] => ['c1', 'c2', 'c3', 'c4'].map(byte => ({
      type: 'openAccount',
      data: {
        targetEntityId: hash(byte),
        creditAmount: 1_000n,
        tokenId: 1,
        rebalancePolicy,
      },
    }));
    const preparedFrame = {
      height: 1,
      parentFrameHash: hash('d1'),
      stateRoot: hash('d2'),
      authorityRoot: hash('d3'),
      timestamp: 1_000,
      txs: frameTxs(),
      events: [],
      hash: hash('d4'),
      leader: { proposerSignerId: address('d5'), view: 0 },
      hashesToSign: buildEntityHashesToSign(hash('d7'), 1, hash('d2')),
    };
    const sharedSignatures = [`0x${'d6'.repeat(65)}`];
    const preparedVote = {
      entityId: hash('d7'),
      targetHeight: 2,
      previousFrameHash: preparedFrame.hash,
      fromView: 0,
      toView: 1,
      previousLeaderId: address('d5'),
      nextLeaderId: address('da'),
      voterId: address('db'),
      signature: `0x${'dd'.repeat(65)}`,
      preparedFrame,
    };
    const source: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [{
        entityId: hash('d7'),
        signerId: address('d8'),
        proposedFrame: {
          ...preparedFrame,
          height: 2,
          parentFrameHash: preparedFrame.hash,
          txs: frameTxs(),
          hash: hash('d9'),
          hashesToSign: buildEntityHashesToSign(hash('d7'), 2, hash('d2')),
          leader: {
            proposerSignerId: address('da'),
            view: 1,
            certificate: {
              entityId: preparedVote.entityId,
              targetHeight: preparedVote.targetHeight,
              previousFrameHash: preparedVote.previousFrameHash,
              fromView: preparedVote.fromView,
              toView: preparedVote.toView,
              previousLeaderId: preparedVote.previousLeaderId,
              nextLeaderId: preparedVote.nextLeaderId,
              votes: new Map([[preparedVote.voterId, preparedVote.signature]]),
              preparedVotes: new Map([[preparedVote.voterId, preparedVote]]),
              preparedFrameHash: preparedFrame.hash,
            },
          },
        },
        hashPrecommitFrame: { height: 2, frameHash: hash('d9') },
        hashPrecommits: new Map([
          [address('db'), sharedSignatures],
          [address('dc'), sharedSignatures],
        ]),
        leaderTimeoutVote: preparedVote,
      }],
    };

    const cloned = cloneRuntimeFrameMempool(source).entityInputs[0]!;
    const proposedPolicies = cloned.proposedFrame!.txs.map(tx => {
      if (tx.type !== 'openAccount') throw new Error(`TEST_OPEN_ACCOUNT_EXPECTED:${tx.type}`);
      return tx.data.rebalancePolicy;
    });
    const preparedPolicies = cloned.leaderTimeoutVote!.preparedFrame!.txs.map(tx => {
      if (tx.type !== 'openAccount') throw new Error(`TEST_OPEN_ACCOUNT_EXPECTED:${tx.type}`);
      return tx.data.rebalancePolicy;
    });
    const certifiedPreparedFrame = cloned.proposedFrame!.leader.certificate!
      .preparedVotes!.get(preparedVote.voterId)!.preparedFrame!;
    const certifiedPreparedPolicies = certifiedPreparedFrame.txs.map(tx => {
      if (tx.type !== 'openAccount') throw new Error(`TEST_OPEN_ACCOUNT_EXPECTED:${tx.type}`);
      return tx.data.rebalancePolicy;
    });

    expect(proposedPolicies).toEqual(Array.from({ length: 4 }, () => rebalancePolicy));
    expect(preparedPolicies).toEqual(Array.from({ length: 4 }, () => rebalancePolicy));
    expect(certifiedPreparedPolicies).toEqual(Array.from({ length: 4 }, () => rebalancePolicy));
    expect(new Set(proposedPolicies).size).toBe(4);
    expect(new Set(preparedPolicies).size).toBe(4);
    expect(new Set(certifiedPreparedPolicies).size).toBe(4);
    expect(cloned.hashPrecommits?.get(address('db'))).not.toBe(sharedSignatures);
    expect(cloned.hashPrecommits?.get(address('dc'))).not.toBe(sharedSignatures);
    expect(cloned.hashPrecommits?.get(address('db')))
      .not.toBe(cloned.hashPrecommits?.get(address('dc')));
  });

  test('Hanko payload cloning isolates shared Account frame transaction fields', () => {
    const route = [hash('e1'), hash('e2')];
    const input: AccountInput = {
      kind: 'frame',
      fromEntityId: hash('e3'),
      toEntityId: hash('e4'),
      proposal: {
        frame: {
          height: 1,
          timestamp: 1_000,
          jHeight: 1,
          accountTxs: [1n, 2n, 3n, 4n].map(amount => ({
            type: 'direct_payment',
            data: { tokenId: 1, amount, route },
          })),
          prevFrameHash: hash('e5'),
          accountStateRoot: hash('e6'),
          stateHash: hash('e7'),
          deltas: [],
        },
      },
    };

    const cloned = cloneAccountInputWithoutPostCommitHankos(input);
    if (cloned.kind !== 'frame') throw new Error(`TEST_ACCOUNT_FRAME_EXPECTED:${cloned.kind}`);
    const routes = cloned.proposal.frame.accountTxs.map(tx => {
      if (tx.type !== 'direct_payment') throw new Error(`TEST_DIRECT_PAYMENT_EXPECTED:${tx.type}`);
      return tx.data.route;
    });

    expect(routes).toEqual(Array.from({ length: 4 }, () => route));
    expect(new Set(routes).size).toBe(4);
    expect(routes.every(clonedRoute => clonedRoute !== route)).toBe(true);
  });

  test('durable RuntimeInput restore isolates repeated board configs', () => {
    const { runtimeInput } = makeAliasedBoardRuntimeInput();
    const restored = createEmptyEnv(`runtime-input-clone-restore-${TEST_RUN_ID}`);

    restoreDurableRuntimeSnapshot(restored, { runtimeInput });

    const imports = restored.runtimeMempool!.runtimeTxs.filter(tx => tx.type === 'importReplica');
    expect(imports).toHaveLength(9);
    expect(imports.slice(4, 8).map(tx => tx.data.config.validators)).toEqual(
      Array.from({ length: 4 }, () => ['6', '7', '8', '9']),
    );
    expect(new Set(imports.slice(4, 8).map(tx => tx.data.config)).size).toBe(4);
  });

  test('checkpoint cloning isolates repeated board configs across replica entries', () => {
    const { boards } = makeAliasedBoardRuntimeInput();
    const eReplicas = boards.flatMap(config => config.validators.map((signerId, index) => [
      `${signerId}:${index}`,
      {
        entityId: signerId,
        signerId,
        entityEncPubKey: '',
        mempool: [],
        isProposer: index === 0,
        state: {
          entityId: signerId,
          config,
          profile: { name: signerId },
          position: { x: index, y: 0, z: 0 },
        },
      },
    ]));

    const cloned = cloneIsolatedRuntimeSnapshot({
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      eReplicas,
      jReplicas: [],
    });
    const replicas = cloned.eReplicas as Array<[string, { state: { config: ConsensusConfig } }]>;

    expect(replicas).toHaveLength(9);
    expect(replicas.slice(4, 8).map(([, replica]) => replica.state.config.validators)).toEqual(
      Array.from({ length: 4 }, () => ['6', '7', '8', '9']),
    );
    expect(new Set(replicas.slice(4, 8).map(([, replica]) => replica.state.config)).size).toBe(4);
  });

  test('binary storage decode remains safe when the runtime snapshot is cloned', () => {
    const { runtimeInput } = makeAliasedBoardRuntimeInput();
    const decoded = decodeBuffer(encodeBuffer({ runtimeInput })) as Record<string, unknown>;

    const cloned = cloneIsolatedRuntimeSnapshot(decoded);
    const imports = (cloned.runtimeInput as RuntimeInput).runtimeTxs
      .filter(tx => tx.type === 'importReplica');

    expect(imports.slice(4, 8).map(tx => tx.data.config.validators)).toEqual(
      Array.from({ length: 4 }, () => ['6', '7', '8', '9']),
    );
    expect(new Set(imports.slice(4, 8).map(tx => tx.data.config)).size).toBe(4);
  });

  test('strict scenarios preserve the original runtime failure instead of replacing its stack', async () => {
    const env = createEmptyEnv(`strict scenario original failure ${TEST_RUN_ID}`);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const restoreStrictScenario = enableStrictScenario(env, 'original failure regression');

    try {
      const failure = await applyRuntimeInput(env, {
        runtimeTxs: [{ type: 'deliberatelyInvalidRuntimeTx' } as unknown as RuntimeTx],
        entityInputs: [],
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('RUNTIME_TX_UNKNOWN: deliberatelyInvalidRuntimeTx');
      expect((failure as Error).stack).toContain('runtime/runtime/tx-handlers.ts');
      expect((failure as Error).stack).not.toContain('console.error:');
    } finally {
      restoreStrictScenario();
    }
  });

  test('detached entity inputs remain visible until the runtime frame settles', async () => {
    const env = createEmptyEnv(`runtime in-flight entity signal ${TEST_RUN_ID}`);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.runtimeConfig = {
      ...env.runtimeConfig,
      storage: { ...env.runtimeConfig?.storage, enabled: true },
    };
    installJurisdiction(env);
    cleanupNamespaces.push(env.dbNamespace!);
    const baselineImport = localImportReplicaTx(env, 'b');
    enqueueRuntimeInput(env, { runtimeTxs: [baselineImport], entityInputs: [] });
    await processRuntime(env);
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: baselineImport.entityId,
        signerId: baselineImport.signerId,
        entityTxs: [],
      }],
    });

    const processPromise = processRuntime(env);
    let observedDetachedEntityInput = false;
    let maximumInFlightEntityInputs = 0;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      maximumInFlightEntityInputs = Math.max(
        maximumInFlightEntityInputs,
        Number(env.infrastructure?.inFlightEntityInputs || 0),
      );
      if (
        env.infrastructure?.processingPromise &&
        Number(env.infrastructure.inFlightEntityInputs || 0) > 0 &&
        env.runtimeMempool?.entityInputs.length === 0
      ) {
        observedDetachedEntityInput = true;
        break;
      }
      await Promise.resolve();
    }

    try {
      expect({ observedDetachedEntityInput, maximumInFlightEntityInputs })
        .toEqual({ observedDetachedEntityInput: true, maximumInFlightEntityInputs: 1 });
      await processPromise;
      expect(env.infrastructure?.inFlightEntityInputs).toBe(0);

      await corruptCurrentHeadAhead(env);
      enqueueRuntimeInput(env, {
        runtimeTxs: [importReplicaTx('c')],
        entityInputs: [{
          entityId: baselineImport.entityId,
          signerId: baselineImport.signerId,
          entityTxs: [],
        }],
      });
      await expect(processRuntime(env)).rejects.toThrow('STORAGE_CURRENT_AHEAD_OF_HISTORY');
      expect(env.infrastructure?.inFlightEntityInputs).toBe(0);
    } finally {
      await closeTestEnv(env);
    }
  });

  test('persists replayable runtime commands without process-local authorization symbols', async () => {
    const env = createEmptyEnv(`runtime local command persistence ${TEST_RUN_ID}`);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.runtimeConfig = {
      ...env.runtimeConfig,
      storage: { ...env.runtimeConfig?.storage, enabled: true },
    };
    installJurisdiction(env);
    cleanupNamespaces.push(env.dbNamespace!);

    const cursorTx = markLocalJAuthorityRuntimeTx({
      type: 'advanceJWatcherCursor' as const,
      data: {
        depositoryAddress: jurisdiction.depositoryAddress!,
        chainId: jurisdiction.chainId,
        blockNumber: 1,
      },
    });
    expect(Object.getOwnPropertySymbols(cursorTx)).toHaveLength(1);

    enqueueRuntimeInput(env, { runtimeTxs: [cursorTx], entityInputs: [] });
    await processRuntime(env);

    const persisted = await readStorageFrameRecord(getRuntimeWalDb(env), env.state.height);
    expect(persisted?.runtimeInput.runtimeTxs).toEqual([{
      type: 'advanceJWatcherCursor',
      data: {
        depositoryAddress: jurisdiction.depositoryAddress,
        chainId: jurisdiction.chainId,
        blockNumber: 1,
      },
    }]);
    expect(Object.getOwnPropertySymbols(persisted!.runtimeInput.runtimeTxs[0]!)).toHaveLength(0);
  });

  test('the single Runtime mempool remains lossless beyond former ingress thresholds', () => {
    const env = createEmptyEnv(`runtime ingress load ${TEST_RUN_ID}`);
    env.quietRuntimeLogs = true;
    installJurisdiction(env);
    const replica = installValidatorReplica(env, address('c1'), env.runtimeId!);
    const sourceRuntimeId = address('c3');
    const input = {
      entityId: replica.entityId,
      signerId: replica.signerId,
      entityTxs: [],
      padding: 'x'.repeat(4 * 1024 * 1024 + 1),
    } as RoutedEntityInput & { padding: string };

    expect(handleInboundP2PEntityInput(env, sourceRuntimeId, input, env.state.timestamp))
      .toEqual({ kind: 'queued' });
    input.padding = '';
    for (let index = 0; index < 1_024; index += 1) {
      expect(handleInboundP2PEntityInput(env, sourceRuntimeId, input, env.state.timestamp))
        .toEqual({ kind: 'queued' });
    }
    const reliable = createTestReliableReceipt(env, replica.entityId, replica.signerId);
    expect(handleInboundReliableReceipt(env, reliable.from, reliable.receipt)).toBe('queued');
    expect(env.runtimeMempool?.entityInputs).toHaveLength(1_025);
    expect(env.runtimeMempool?.reliableReceipts).toHaveLength(1);
  });

  test('receipt ingress is fenced before it can enter the Runtime mempool', () => {
    const env = createEmptyEnv(`runtime receipt quiesce fence ${TEST_RUN_ID}`);
    env.quietRuntimeLogs = true;
    installJurisdiction(env);
    const replica = installValidatorReplica(env, address('c5'), env.runtimeId!);
    const reliable = createTestReliableReceipt(env, replica.entityId, replica.signerId);
    env.infrastructure!.persistenceQuiescing = true;

    expect(handleInboundReliableReceipt(env, reliable.from, reliable.receipt))
      .toBe('deferred');
    expect(env.runtimeMempool?.reliableReceipts ?? []).toHaveLength(0);
    expect(env.infrastructure?.receivedReliableReceiptLedger).toBeUndefined();
    expect(env.infrastructure?.receivedReliableTerminalWatermarks).toBeUndefined();
  });

  test('each Runtime owns one active mempool while a detached frame executes', async () => {
    const activeEnv = createEmptyEnv(`runtime ingress owner ${TEST_RUN_ID}`);
    activeEnv.scenarioMode = true;
    activeEnv.quietRuntimeLogs = true;
    activeEnv.runtimeConfig = {
      ...activeEnv.runtimeConfig,
      storage: { ...activeEnv.runtimeConfig?.storage, enabled: true },
    };
    installJurisdiction(activeEnv);
    cleanupNamespaces.push(activeEnv.dbNamespace!);

    const baselineImport = localImportReplicaTx(activeEnv, '5');
    enqueueRuntimeInput(activeEnv, { runtimeTxs: [baselineImport], entityInputs: [] });
    await processRuntime(activeEnv);
    enqueueRuntimeInput(activeEnv, { runtimeTxs: [importReplicaTx('6')], entityInputs: [] });
    const processPromise = processRuntime(activeEnv);

    let observedDetachedIngressTail = false;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if ((activeEnv.runtimeMempool?.runtimeTxs.length ?? -1) === 0) {
        observedDetachedIngressTail = true;
        break;
      }
      await Bun.sleep(0);
    }
    expect(observedDetachedIngressTail).toBe(true);
    const durableWhileActive = buildDurableRuntimeMachineSnapshot(activeEnv);
    expect((durableWhileActive.runtimeInput as RuntimeInput).runtimeTxs).toEqual([]);
    expect(() => restoreDurableRuntimeSnapshot(activeEnv, durableWhileActive))
      .toThrow('RUNTIME_SNAPSHOT_RESTORE_DURING_ACTIVE_FRAME');

    const otherEnv = createEmptyEnv(`runtime ingress other ${TEST_RUN_ID}`);
    otherEnv.scenarioMode = true;
    otherEnv.quietRuntimeLogs = true;
    installJurisdiction(otherEnv);
    const otherReplica = installValidatorReplica(otherEnv, address('51'), otherEnv.runtimeId!);
    const otherInput: RoutedEntityInput = {
      entityId: otherReplica.entityId,
      signerId: otherReplica.signerId,
      entityTxs: [],
    };
    expect(handleInboundP2PEntityInput(otherEnv, address('53'), otherInput, otherEnv.state.timestamp))
      .toEqual({ kind: 'queued' });
    expect(otherEnv.runtimeMempool?.entityInputs).toEqual([{ ...otherInput, from: address('53') }]);
    expect(activeEnv.runtimeMempool?.entityInputs).toHaveLength(0);

    try {
      await processPromise;

      const postFrameInput: RoutedEntityInput = {
        entityId: baselineImport.entityId,
        signerId: baselineImport.signerId,
        entityTxs: [],
      };
      expect(handleInboundP2PEntityInput(
        activeEnv,
        address('54'),
        postFrameInput,
        activeEnv.state.timestamp,
      )).toEqual({ kind: 'queued' });
      expect(activeEnv.runtimeMempool?.entityInputs)
        .toEqual([{ ...postFrameInput, from: address('54') }]);
    } finally {
      await closeTestEnv(activeEnv);
    }
  });

  test('ingress validation rejects an unknown second Entity before the first mutation', async () => {
    const env = createEmptyEnv(`runtime apply atomicity ${TEST_RUN_ID}`);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;
    installJurisdiction(env);

    const leader = address('11');
    const validator = address('12');
    const replica = installValidatorReplica(env, leader, validator);
    env.infrastructure!.entityRuntimeHints = new Map([
      [hash('21'), { runtimeId: address('22'), seenAt: env.state.timestamp }],
    ]);

    const remoteEntityId = hash('31');
    const remoteRuntimeId = address('32');
    const imported = importReplicaTx('4');
    const first: EntityInput = {
      from: remoteRuntimeId,
      entityId: replica.entityId,
      signerId: validator,
      entityTxs: [{
        type: 'accountInput',
        data: {
          kind: 'dispute',
          fromEntityId: remoteEntityId,
          toEntityId: replica.entityId,
          domain: {
            chainId: 31_337,
            depositoryAddress: `0x${'dd'.repeat(20)}`,
          },
          disputeSeal: {
            hanko: '0x01',
            hash: hash('41'),
            proofBodyHash: hash('42'),
            proofNonce: 1,
          },
        },
      }],
    };
    const second: EntityInput = {
      entityId: hash('ff'),
      signerId: validator,
      entityTxs: [],
    };
    const ingress: RuntimeInput = {
      runtimeTxs: [imported],
      entityInputs: [first, second],
      timestamp: env.state.timestamp,
    };
    const ingressBytes = safeStringify({
      runtimeTxs: ingress.runtimeTxs,
      entityInputs: ingress.entityInputs,
    });

    // Prove the first item would mutate several Runtime-owned structures.
    // The mixed batch below must reject before any of those writes begin.
    const control = createEmptyEnv(`runtime apply atomicity control ${TEST_RUN_ID}`);
    control.scenarioMode = true;
    control.quietRuntimeLogs = true;
    control.state.timestamp = env.state.timestamp;
    installJurisdiction(control);
    const controlReplica = installValidatorReplica(control, leader, validator);
    control.infrastructure!.entityRuntimeHints = new Map([
      [hash('21'), { runtimeId: address('22'), seenAt: control.state.timestamp }],
      [controlReplica.entityId, { runtimeId: address('23'), seenAt: control.state.timestamp }],
    ]);
    enqueueRuntimeInput(control, {
      runtimeTxs: [structuredClone(imported)],
      entityInputs: [structuredClone(first)],
      timestamp: control.state.timestamp,
    });
    await processRuntime(control);
    expect(control.state.eReplicas.get(`${controlReplica.entityId}:${validator}`)?.mempool).toHaveLength(1);
    expect(control.infrastructure?.entityRuntimeHints?.get(remoteEntityId)?.runtimeId).toBe(remoteRuntimeId);
    expect(control.state.eReplicas.get(`${imported.entityId}:${imported.signerId}`)?.certifiedFrameAnchor)
      .toBeDefined();

    const replicaBefore = safeStringify(buildCanonicalEntityReplicaSnapshot(replica));
    const hintsBefore = safeStringify(env.infrastructure!.entityRuntimeHints);
    enqueueRuntimeInput(env, ingress);

    await expect(processRuntime(env)).rejects.toThrow('RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET');

    const restored = env.state.eReplicas.get(`${replica.entityId}:${validator}`);
    expect(restored).toBeDefined();
    expect(safeStringify(restored)).toBe(replicaBefore);
    expect(restored?.mempool).toEqual([]);
    expect(restored?.proposal).toBeUndefined();
    expect(restored?.lockedFrame).toBeUndefined();
    expect(restored?.lastConsensusProgressAt).toBeUndefined();
    expect(env.state.eReplicas.has(`${imported.entityId}:${imported.signerId}`)).toBe(false);
    expect([...env.state.eReplicas.values()].some(candidate => candidate.certifiedFrameAnchor)).toBe(false);
    expect([...env.state.eReplicas.values()].some(candidate => candidate.certifiedFrameLineage?.length)).toBe(false);
    expect(safeStringify(env.infrastructure!.entityRuntimeHints)).toBe(hintsBefore);
    expect(env.infrastructure!.entityRuntimeHints?.has(remoteEntityId)).toBe(false);
    expect(safeStringify(exactQueuedInput(env))).toBe(ingressBytes);
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);
    expect(env.state.height).toBe(0);
    expect(env.state.timestamp).toBe(1_000);
  });

  test('post-mutation LevelDB failure halts unreadable RAM and retains exact input', async () => {
    const seed = `runtime storage rollback ${TEST_RUN_ID}`;
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.runtimeConfig = {
      ...env.runtimeConfig,
      storage: { ...env.runtimeConfig?.storage, enabled: true },
    };
    installJurisdiction(env);
    cleanupNamespaces.push(env.dbNamespace!);

    const baselineImport = importReplicaTx('5');
    enqueueRuntimeInput(env, { runtimeTxs: [baselineImport], entityInputs: [] });
    await processRuntime(env);

    const baselineReplica = env.state.eReplicas.get(`${baselineImport.entityId}:${baselineImport.signerId}`);
    if (!baselineReplica) throw new Error('TEST_BASELINE_REPLICA_MISSING');
    const heightBefore = env.state.height;
    const timestampBefore = env.state.timestamp;

    await corruptCurrentHeadAhead(env);

    const attemptedImport = importReplicaTx('6');
    const ingress: RuntimeInput = {
      runtimeTxs: [attemptedImport],
      entityInputs: [],
      timestamp: timestampBefore,
    };
    const ingressBytes = safeStringify({
      runtimeTxs: ingress.runtimeTxs,
      entityInputs: ingress.entityInputs,
    });
    enqueueRuntimeInput(env, ingress);

    try {
      await expect(processRuntime(env)).rejects.toThrow('STORAGE_CURRENT_AHEAD_OF_HISTORY');

      // Runtime owns its State and no longer pays O(total state) for a working
      // clone. Once mutation starts, RAM is deliberately unreadable: only the
      // durable WAL head below is authoritative until operator recovery.
      expect(env.infrastructure?.halted).toBe(true);
      expect(env.infrastructure?.fatalDebugPayload?.message)
        .toContain('RUNTIME_MUTATION_FAILED_RELOAD_REQUIRED');
      expect(safeStringify(exactQueuedInput(env))).toBe(ingressBytes);
      expect(env.runtimeMempool?.queuedAt).toBe(timestampBefore);
      const walHead = await readStorageHead(getRuntimeWalDb(env));
      expect(walHead?.latestHeight).toBe(heightBefore);
      await expect(processRuntime(env)).rejects.toThrow('RUNTIME_PROCESS_HALTED');
    } finally {
      await closeTestEnv(env);
    }
  });

  test('later reliable ingress survives a post-mutation Runtime halt', async () => {
    const seed = `runtime later ingress rollback ${TEST_RUN_ID}`;
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.runtimeConfig = {
      ...env.runtimeConfig,
      storage: { ...env.runtimeConfig?.storage, enabled: true },
    };
    installJurisdiction(env);
    cleanupNamespaces.push(env.dbNamespace!);

    const baselineImport = localImportReplicaTx(env, '7');
    enqueueRuntimeInput(env, { runtimeTxs: [baselineImport], entityInputs: [] });
    await processRuntime(env);
    const heightBefore = env.state.height;
    const timestampBefore = env.state.timestamp;
    await corruptCurrentHeadAhead(env);

    const attemptedImport = importReplicaTx('8');
    const frameA: RuntimeInput = {
      runtimeTxs: [attemptedImport],
      entityInputs: [],
      timestamp: timestampBefore,
    };
    enqueueRuntimeInput(env, frameA);

    const frameB: RoutedEntityInput = {
      runtimeId: env.runtimeId!,
      entityId: baselineImport.entityId,
      signerId: baselineImport.signerId,
      hashPrecommitFrame: { height: 1, frameHash: hash('91') },
      hashPrecommits: new Map([[address('92'), [`0x${'93'.repeat(65)}`]]]),
    };
    const sourceRuntimeId = address('94');
    const processPromise = processRuntime(env);
    let observedDetachedIngressTail = false;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (
        env.infrastructure?.processingPromise &&
        (env.runtimeMempool?.runtimeTxs.length ?? -1) === 0
      ) {
        observedDetachedIngressTail = true;
        break;
      }
      await Bun.sleep(0);
    }
    expect(observedDetachedIngressTail).toBe(true);
    try {
      expect(handleInboundP2PEntityInput(env, sourceRuntimeId, frameB, env.state.timestamp))
        .toEqual({ kind: 'queued' });
      await expect(processPromise).rejects.toThrow('STORAGE_CURRENT_AHEAD_OF_HISTORY');

      expect(env.infrastructure?.halted).toBe(true);
      expect(env.infrastructure?.fatalDebugPayload?.message)
        .toContain('RUNTIME_MUTATION_FAILED_RELOAD_REQUIRED');
      expect(env.runtimeMempool?.runtimeTxs).toEqual(frameA.runtimeTxs);
      expect(env.runtimeMempool?.entityInputs.filter(input => input.hashPrecommitFrame))
        .toEqual([{ ...frameB, from: sourceRuntimeId }]);
      // Transport admission only appends bytes. Reliable frontier state changes
      // when this input belongs to the next isolated Runtime frame.
      expect(env.infrastructure?.pendingReliableIngress?.size ?? 0).toBe(0);
      const walHead = await readStorageHead(getRuntimeWalDb(env));
      expect(walHead?.latestHeight).toBe(heightBefore);
    } finally {
      await closeTestEnv(env);
    }
  });

  test('pre-quiesce reliable ingress is replayed against the committed frame state', async () => {
    const seed = `runtime later ingress commit ${TEST_RUN_ID}`;
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.runtimeConfig = {
      ...env.runtimeConfig,
      storage: { ...env.runtimeConfig?.storage, enabled: true },
    };
    installJurisdiction(env);
    cleanupNamespaces.push(env.dbNamespace!);

    const baselineImport = localImportReplicaTx(env, '9');
    enqueueRuntimeInput(env, { runtimeTxs: [baselineImport], entityInputs: [] });
    await processRuntime(env);
    const heightBefore = env.state.height;

    const frameA = importReplicaTx('a');
    enqueueRuntimeInput(env, { runtimeTxs: [frameA], entityInputs: [] });
    const processPromise = processRuntime(env);
    expect(env.infrastructure?.processingPromise).toBeTruthy();
    let observedDetachedIngressTail = false;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if ((env.runtimeMempool?.runtimeTxs.length ?? -1) === 0) {
        observedDetachedIngressTail = true;
        break;
      }
      await Bun.sleep(0);
    }
    expect(observedDetachedIngressTail).toBe(true);

    const frameB: RoutedEntityInput = {
      runtimeId: env.runtimeId!,
      entityId: baselineImport.entityId,
      signerId: baselineImport.signerId,
      hashPrecommitFrame: { height: 1, frameHash: hash('a1') },
      hashPrecommits: new Map([[address('a2'), [`0x${'a3'.repeat(65)}`]]]),
    };
    const sourceRuntimeId = address('a4');
    try {
      expect(handleInboundP2PEntityInput(env, sourceRuntimeId, frameB, env.state.timestamp))
        .toEqual({ kind: 'queued' });
      // The transport accepted frameB while this R-frame was running. It belongs
      // to the next frame even if persistence quiesces before this frame commits.
      env.scenarioMode = false;
      env.infrastructure!.persistenceQuiescing = true;
      env.infrastructure!.persistencePaused = true;
      await processPromise;

      expect(env.state.height).toBe(heightBefore + 1);
      expect(env.state.eReplicas.has(`${frameA.entityId}:${frameA.signerId}`)).toBe(true);
      expect(env.runtimeMempool?.entityInputs).toEqual([{ ...frameB, from: sourceRuntimeId }]);
      expect(env.infrastructure?.pendingReliableIngress?.size ?? 0).toBe(0);
    } finally {
      env.scenarioMode = true;
      await closeTestEnv(env);
    }
  });
});
