import { describe, expect, test } from 'bun:test';

import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  createAccountTransitionKey,
} from '../../../account/state/candidate-overlay';
import {
  computeAccountStateRoot,
  computeAccountStateRootCold,
} from '../../../account/commitment/state-root';
import { createDefaultDelta } from '../../../account/state/delta';
import {
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
} from '../../../entity/consensus/state-root';
import { generateLazyEntityId } from '../../../entity/factory';
import {
  commitEntityFrameCandidateState,
  createEntityFrameCandidateState,
} from '../../../entity/state-clone';
import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import { applyEntityTx } from '../../../entity/tx/apply';
import { computeCanonicalStateHashFromEnv } from '../../../storage/canonical-hash';
import { decodeBuffer, encodeBuffer } from '../../../storage/codec/codec';
import {
  buildCanonicalEnvSnapshot,
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../../../storage/wal/snapshot';
import { applyRuntimeInput, createEmptyEnv } from '../../../runtime';
import type { BrowserVMState, RuntimeReplica } from '../../../runtime/types';
import type { ConsensusConfig, EntityReplica, JurisdictionConfig } from '../../../entity/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';

const hex = (byte: string, bytes: number): string => `0x${byte.repeat(bytes)}`;
const counterpartyId = hex('f1', 32);
const accountDomain = {
  chainId: 31_337,
  depositoryAddress: hex('33', 20),
};
const jurisdiction: JurisdictionConfig = {
  name: 'StateBoundaryTestnet',
  address: 'rpc://state-boundary',
  chainId: accountDomain.chainId,
  depositoryAddress: accountDomain.depositoryAddress,
  entityProviderAddress: hex('44', 20),
};

const jurisdictionReplica = (): JReplica => ({
  name: jurisdiction.name,
  blockNumber: 0n,
  stateRoot: null,
  mempool: [],
  blockDelayMs: 300,
  lastBlockTimestamp: 0,
  position: { x: 0, y: 0, z: 0 },
  rpcs: [jurisdiction.address!],
  chainId: jurisdiction.chainId,
  contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress },
  contracts: {
    depository: jurisdiction.depositoryAddress,
    entityProvider: jurisdiction.entityProviderAddress,
    account: hex('55', 20),
    deltaTransformer: hex('66', 20),
  },
});

const createCommittedAccountFixture = async (): Promise<{
  env: RuntimeReplica;
  replica: EntityReplica;
}> => {
  const env = createEmptyEnv('state-replica-boundary');
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, jurisdictionReplica());

  const signerId = env.runtimeId?.toLowerCase();
  if (!signerId) throw new Error('TEST_RUNTIME_ID_MISSING');
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
    jurisdiction,
  };
  const entityId = generateLazyEntityId([signerId], 1n, env).toLowerCase();
  await applyRuntimeInput(env, {
    runtimeTxs: [createTestEntityImportRuntimeTx(env, {
      entityId,
      signerId,
      data: { config, isProposer: true, profileName: 'State boundary' },
    })],
    entityInputs: [],
  });

  const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
  if (!replica) throw new Error('TEST_ENTITY_REPLICA_MISSING');
  const opened = await applyEntityTx(env, replica.state, {
    type: 'openAccount',
    data: {
      targetEntityId: counterpartyId,
      watchSeed: hex('77', 32),
      accountDomain,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    },
  });
  replica.state = opened.newState;
  if (!replica.state.accounts.has(counterpartyId)) {
    throw new Error('TEST_ACCOUNT_REPLICA_MISSING');
  }
  return { env, replica };
};

const browserState = (): BrowserVMState => ({
  version: 1,
  chainId: accountDomain.chainId,
  stateRoot: hex('81', 32),
  trieData: [[hex('82', 32), '0x1234']],
  nonce: '7',
  entityProviderDeploymentBlock: 1,
  chain: {
    blockHeight: 1,
    blockHash: hex('83', 32),
    blockTimestamp: 1_000,
    entityProviderDeploymentBlock: 1,
    blockHashes: [[1, hex('83', 32)]],
    blockReceiptRoots: [[1, hex('84', 32)]],
    txReceipts: [],
  },
  addresses: {
    depository: accountDomain.depositoryAddress,
    entityProvider: jurisdiction.entityProviderAddress!,
  },
});

const bytesOf = (value: unknown): string => encodeBuffer(value).toString('hex');

describe('State and Replica boundary characterization', () => {
  test('Account root commits bilateral State and excludes its Entity-owned envelope', async () => {
    const { replica } = await createCommittedAccountFixture();
    const account = replica.state.accounts.get(counterpartyId)!;
    expect(account.currentFrame.height).toBe(0);
    expect(account.currentFrame.stateHash).toBe('');
    expect(account.currentFrame.accountStateRoot).toMatch(/^0x[0-9a-f]{64}$/);
    const accountRoot = computeAccountStateRoot(account.state);
    expect(accountRoot).toBe(computeAccountStateRootCold(account.state));

    const bilateralTransition = beginAccountTransition(
      account,
      createAccountTransitionKey(account, ['boundary', 'bilateral']),
    );
    accountTransitionView(bilateralTransition).state.deltas.put(1, createDefaultDelta(1));
    const bilateralChange = commitAccountTransition(bilateralTransition).account;
    expect(computeAccountStateRoot(bilateralChange.state)).not.toBe(accountRoot);
    expect(computeAccountStateRoot(bilateralChange.state))
      .toBe(computeAccountStateRootCold(bilateralChange.state));

    const envelopeTransition = beginAccountTransition(
      account,
      createAccountTransitionKey(account, ['boundary', 'envelope']),
    );
    accountTransitionView(envelopeTransition).mempool.push({
      type: 'direct_payment',
      data: { tokenId: 1, amount: 5n },
    });
    const entityEnvelopeChange = commitAccountTransition(envelopeTransition).account;
    expect(computeAccountStateRoot(entityEnvelopeChange.state)).toBe(accountRoot);

    const witnessTransition = beginAccountTransition(
      account,
      createAccountTransitionKey(account, ['boundary', 'witness']),
    );
    accountTransitionView(witnessTransition).currentFrameHanko = hex('91', 65);
    const localWitnessChange = commitAccountTransition(witnessTransition).account;
    expect(computeAccountStateRoot(localWitnessChange.state)).toBe(accountRoot);
  });

  test('Entity root commits Account lifecycle but excludes local witnesses and history views', async () => {
    const { replica } = await createCommittedAccountFixture();
    // Reducer-unit calls return dirty Account metadata to the enclosing Entity
    // frame. A snapshot clone resets the cache here; the real frame pipeline
    // refreshes those leaves before computing its signed root.
    const baselineState = commitEntityFrameCandidateState(
      createEntityFrameCandidateState(replica.state),
    );
    const entityRoot = computeCanonicalEntityConsensusStateHash(baselineState);
    expect(entityRoot).toBe(computeCanonicalEntityConsensusStateHashCold(baselineState));

    const accountLifecycle = createEntityFrameCandidateState(baselineState);
    getEntityAccountForWrite(accountLifecycle.accounts, counterpartyId)!.mempool.push({
      type: 'direct_payment',
      data: { tokenId: 1, amount: 5n },
    });
    expect(computeCanonicalEntityConsensusStateHash(accountLifecycle)).not.toBe(entityRoot);

    const localWitness = createEntityFrameCandidateState(baselineState);
    getEntityAccountForWrite(localWitness.accounts, counterpartyId)!.currentFrameHanko = hex('92', 65);
    expect(computeCanonicalEntityConsensusStateHash(localWitness)).toBe(entityRoot);

    const historyView = createEntityFrameCandidateState(baselineState);
    historyView.prevFrameHash = hex('93', 32);
    expect(computeCanonicalEntityConsensusStateHash(historyView)).toBe(entityRoot);

    const replicaStateRoot = computeCanonicalEntityConsensusStateHash(replica.state);
    replica.htlcNotes = new Map([[`hashlock:${hex('94', 32)}`, 'history-only']]);
    expect(computeCanonicalEntityConsensusStateHash(replica.state)).toBe(replicaStateRoot);

    const committedChange = createEntityFrameCandidateState(baselineState);
    committedChange.reserves.set(1, 1n);
    expect(computeCanonicalEntityConsensusStateHash(committedChange)).not.toBe(entityRoot);
    expect(computeCanonicalEntityConsensusStateHash(committedChange))
      .toBe(computeCanonicalEntityConsensusStateHashCold(committedChange));
  });

  test('Runtime snapshot restores durable bytes and excludes live infrastructure', () => {
    const env = createEmptyEnv('runtime-state-boundary');
    env.browserVMState = browserState();
    const baselineSnapshot = buildDurableRuntimeMachineSnapshot(env);
    const baselineHash = computeCanonicalStateHashFromEnv(env);

    env.infrastructure!.pendingProfileCertificationEntityIds = new Set([counterpartyId]);
    expect(bytesOf(buildDurableRuntimeMachineSnapshot(env))).toBe(bytesOf(baselineSnapshot));
    expect(computeCanonicalStateHashFromEnv(env)).toBe(baselineHash);

    env.infrastructure!.maxEntityInputsPerFrame = 17;
    const durableSnapshot = buildDurableRuntimeMachineSnapshot(env);
    expect(bytesOf(durableSnapshot)).not.toBe(bytesOf(baselineSnapshot));
    expect(computeCanonicalStateHashFromEnv(env)).not.toBe(baselineHash);

    const decoded = decodeBuffer<Record<string, unknown>>(encodeBuffer(durableSnapshot));
    const restored = createEmptyEnv('runtime-state-boundary-restore');
    restoreDurableRuntimeSnapshot(restored, decoded);
    expect(bytesOf(buildDurableRuntimeMachineSnapshot(restored))).toBe(bytesOf(durableSnapshot));
    expect(restored.browserVMState).toEqual(env.browserVMState);
    expect(restored.infrastructure?.pendingProfileCertificationEntityIds).toBeUndefined();
  });

  test('BrowserVM state survives the canonical history binary boundary byte-for-byte', () => {
    const env = createEmptyEnv('browser-state-boundary');
    env.browserVMState = browserState();
    const snapshot = buildCanonicalEnvSnapshot(env, {
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      runtimeOutputs: [],
      description: 'State boundary',
    });
    env.browserVMState.trieData[0]![1] = '0xffff';
    expect(snapshot.browserVMState?.trieData[0]?.[1]).toBe('0x1234');

    const encoded = encodeBuffer(snapshot);
    const decoded = decodeBuffer<typeof snapshot>(encoded);
    expect(decoded.browserVMState).toEqual(snapshot.browserVMState);
    expect(decoded.browserVMState?.trieData[0]?.[1]).toBe('0x1234');
    expect(bytesOf(decoded)).toBe(encoded.toString('hex'));
  });
});
