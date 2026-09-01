import { describe, expect, test } from 'bun:test';
import {
  createEmptyAccountJClaimAccumulator,
  hashAccountJClaimNode,
} from '../../../account/j-claims/j-claim-accumulator';
import { getAccountJClaimKey } from '../../../account/j-claims/j-claim-codec';
import { applyAccountInput, proposeAccountFrame } from '../../../account/consensus';
import { isProposedAccountFrame } from '../../../account/consensus/result';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { generateLazyEntityId } from '../../../entity/factory';
import { signEntityHashes } from '../../../hanko/signing';
import { safeStringify } from '../../../protocol/serialization';
import { aggregateWorkerPhaseResults } from '../../../rscore/ts-worker/coordinator/result';
import { TsAccountCanonicalRoot } from '../../../rscore/ts-worker/sharding';
import { TsAccountWorkerCoordinator } from '../../../rscore/ts-worker/coordinator';
import {
  createWorkerJClaimAttempt,
  pruneWorkerJClaimNodes,
} from '../../../rscore/ts-worker/worker-j-claim-attempt';
import type {
  TsAccountWorkerEffect,
  TsAccountWorkerPhaseResult,
} from '../../../rscore/ts-worker/protocol';
import type { AccountJClaimNode } from '../../../types/finance/account-j-claims';
import type { AccountInput, AccountTx } from '../../../types/account';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { createEmptyEnv } from '../../../runtime';
import { installJurisdictions, makeAccount, makeJurisdiction } from '../../helpers/cross-j';

const ZERO = `0x${'00'.repeat(32)}`;
const accountId = (index: number): string => `0x${index.toString(16).padStart(64, '0')}`;

const claimNode = (index: number): AccountJClaimNode => {
  const record = {
    version: 1,
    accountKey: `0x${(index + 100).toString(16).padStart(64, '0')}`,
    side: 'left',
    jHeight: index,
    jBlockHash: ZERO,
    eventsHash: ZERO,
  } as const;
  return { version: 1, type: 'leaf', key: getAccountJClaimKey(record), record };
};

const effect = (order: number, owner: string, index: number): TsAccountWorkerEffect => {
  const node = claimNode(index);
  return {
    phase: 'inbound',
    order,
    accountId: owner,
    result: {
      ok: true,
      events: [],
      accountJClaimNodeChanges: {
        newNodes: [{ hash: hashAccountJClaimNode(node), node }],
        replacedNodeHashes: [],
      },
    },
  };
};

const response = (
  workerIndex: number,
  effects: readonly TsAccountWorkerEffect[],
) => ({
  workerIndex,
  response: {
    value: {
      workerIndex,
      effects,
      subroots: [],
      operations: effects.length,
      shardRows: [[workerIndex, effects.length]],
      operationsProfile: {},
      elapsedUs: 1,
      heapUsedBytes: 0,
      timings: { transitionUs: 1, proposalUs: 0, rootUs: 0, materializeUs: 0 },
      threadCpuUserUs: 0,
      threadCpuSystemUs: 0,
    } satisfies TsAccountWorkerPhaseResult,
    requestBytes: 0,
    responseBytes: 0,
    encodeMs: 0,
    decodeMs: 0,
    roundTripMs: 0,
    workerEncodeMs: 0,
  },
});

const aggregate = (
  workerIndexes: readonly number[],
  responses: readonly ReturnType<typeof response>[],
) => aggregateWorkerPhaseResults({
  responses,
  logicalShardToWorker: Array.from({ length: 4096 }, () => 0),
  includePostAccounts: false,
  expectedEffects: workerIndexes.map((workerIndex, order) => ({
    workerIndex,
    phase: 'inbound',
    accountId: accountId(order + 1),
  })),
  needShardRoot: false,
  rootTree: new TsAccountCanonicalRoot(),
  dispatchMs: 0,
  joinMs: 0,
});

const realWorkerClaim = async (workers: number) => {
  const seed = 'ts-worker-real-jclaim';
  const env = createEmptyEnv(seed);
  env.quietRuntimeLogs = true;
  const jurisdiction = makeJurisdiction('ts-worker-jclaim', 31_337, 'dd', 'ee');
  installJurisdictions(env, jurisdiction);
  env.state.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    blockTimeMs: jurisdiction.blockTimeMs,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
    chainId: jurisdiction.chainId,
    rpcs: [jurisdiction.address],
    tokenRegistry: [],
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: `0x${'98'.repeat(20)}`,
      deltaTransformer: `0x${'99'.repeat(20)}`,
    },
  } satisfies JReplica);
  const signer = deriveSignerAddressSync(seed, 'peer').toLowerCase();
  registerSignerKey(env, signer, deriveSignerKeySync(seed, 'peer'));
  const peer = generateLazyEntityId([signer], 1n).toLowerCase();
  const owner = accountId(9_999);
  const domain = { chainId: 31_337, depositoryAddress: `0x${'dd'.repeat(20)}` };
  const proposer = makeAccount(peer, owner, domain);
  const receiver = makeAccount(owner, peer, domain);
  const blockHash = `0x${'77'.repeat(32)}`;
  const tx: Extract<AccountTx, { type: 'j_event_claim' }> = {
    type: 'j_event_claim',
    data: {
      jHeight: 7,
      jBlockHash: blockHash,
      events: [{
        type: 'AccountSettled',
        data: {
          leftEntity: proposer.state.leftEntity,
          rightEntity: proposer.state.rightEntity,
          tokenId: 1,
          leftReserve: '0',
          rightReserve: '0',
          collateral: '107',
          ondelta: '3',
          nonce: 7,
        },
        blockNumber: 7,
        blockHash,
        transactionHash: `0x${'78'.repeat(32)}`,
        logIndex: 0,
      }],
    },
  };
  const context = createAccountConsensusContext(env);
  const admitted = await applyAccountInput(context, proposer, { kind: 'enqueue', txs: [tx] });
  if (!admitted.ok || admitted.admittedAccountTxCount !== 1) {
    throw new Error('TS_ACCOUNT_WORKER_REAL_JCLAIM_ADMISSION');
  }
  const proposed = await proposeAccountFrame(context, proposer, 1_000, 0);
  if (!isProposedAccountFrame(proposed)) throw new Error('TS_ACCOUNT_WORKER_REAL_JCLAIM_PROPOSAL');
  const hashes = proposed.hashesToSign ?? [];
  const hankos = await signEntityHashes(env, peer, signer, hashes.map(row => row.hash));
  const witness = new Map(hashes.map((row, index) => [row.hash.toLowerCase(), hankos[index]!]));
  const input = structuredClone(proposed.accountInput) as AccountInput;
  if (input.kind !== 'ack_frame') throw new Error(`TS_ACCOUNT_WORKER_REAL_JCLAIM_INPUT:${input.kind}`);
  input.proposal.frameHanko = witness.get(input.proposal.frame.stateHash.toLowerCase());
  if (!input.proposal.frameHanko) throw new Error('TS_ACCOUNT_WORKER_REAL_JCLAIM_HANKO');
  if (input.proposal.disputeHanko) {
    input.proposal.disputeHanko.hanko = witness.get(input.proposal.disputeHanko.hash.toLowerCase());
    if (!input.proposal.disputeHanko.hanko) throw new Error('TS_ACCOUNT_WORKER_REAL_JCLAIM_DISPUTE_HANKO');
  }

  const coordinator = await TsAccountWorkerCoordinator.create({
    ownerEntityId: owner,
    workerCount: workers,
    logicalShardToWorker: Array.from({ length: 4096 }, (_, shardId) => shardId % workers),
    accounts: new Map([[peer, receiver]]),
    jReplicas: env.state.jReplicas,
  });
  const result = await coordinator.applyAccountInputs({
    frameId: `real-jclaim-${workers}`,
    expectedAccountsRoot: coordinator.accountsRoot,
    entityTimestamp: 1_000,
    finalizedJHeight: 0,
    inputs: [{ accountId: peer, input }],
  });
  await coordinator.proposeAccountFrames({
    frameId: `real-jclaim-${workers}`,
    timestamp: 1_000,
    jHeight: 0,
    envelopeUpdates: [],
    txs: [],
    proposals: [],
  });
  const applied = result.effects[0]?.result;
  if (!applied || !('ok' in applied) || !applied.ok) {
    throw new Error(`TS_ACCOUNT_WORKER_REAL_JCLAIM_REJECTED:${safeStringify(applied)}`);
  }
  return applied.accountJClaimNodeChanges;
};

describe('TS worker jClaim positional fold', () => {
  test('same-Account transition sees the prior transition node before publish', () => {
    const committed = new Map<string, AccountJClaimNode>();
    const attempt = createWorkerJClaimAttempt(committed);
    const first = claimNode(1);
    const firstHash = hashAccountJClaimNode(first);
    attempt.absorb({ newNodes: [{ hash: firstHash, node: first }], replacedNodeHashes: [] });

    expect(attempt.store.get(firstHash)).toEqual(first);
    expect(committed.has(firstHash)).toBe(false);

    const second = claimNode(2);
    const secondHash = hashAccountJClaimNode(second);
    attempt.absorb({
      newNodes: [{ hash: secondHash, node: second }],
      replacedNodeHashes: [firstHash],
    });
    expect(attempt.store.get(firstHash)).toEqual(first);
    expect(attempt.store.get(secondHash)).toEqual(second);

    attempt.publish();
    expect([...committed.keys()]).toEqual([firstHash, secondHash]);
  });

  test('W1 and reversed-completion W4 restore identical dense effects and deltas', () => {
    const effects = Array.from({ length: 4 }, (_, order) => effect(order, accountId(order + 1), order + 1));
    const w1 = aggregate(
      [0, 0, 0, 0],
      [response(0, effects)],
    );
    const w4 = aggregate(
      [0, 1, 2, 3],
      [
        response(3, [effects[3]!]),
        response(2, [effects[2]!]),
        response(1, [effects[1]!]),
        response(0, [effects[0]!]),
      ],
    );
    expect(w4.effects).toEqual(w1.effects);
    expect(w4.effects.map(row => row.order)).toEqual([0, 1, 2, 3]);
  });

  test('real W1 and W4 workers return the same committed jClaim node delta', async () => {
    const w1 = await realWorkerClaim(1);
    const w4 = await realWorkerClaim(4);
    expect(w1?.newNodes.length).toBeGreaterThan(0);
    expect(w4).toEqual(w1);
  });

  test('duplicate, missing, out-of-range, and wrong-owner positions fail loud', () => {
    const first = effect(0, accountId(1), 1);
    const duplicate = effect(0, accountId(2), 2);
    expect(() => aggregate([0, 0], [response(0, [first, duplicate])]))
      .toThrow('TS_ACCOUNT_WORKER_EFFECT_ORDER_DUPLICATE');
    expect(() => aggregate([0, 0], [response(0, [first])]))
      .toThrow('TS_ACCOUNT_WORKER_EFFECT_ORDER_MISSING');
    expect(() => aggregate([0], [response(0, [effect(1, accountId(1), 1)])]))
      .toThrow('TS_ACCOUNT_WORKER_EFFECT_ORDER_RANGE');
    expect(() => aggregate([1], [response(0, [first])]))
      .toThrow('TS_ACCOUNT_WORKER_EFFECT_BINDING');
  });

  test('corrupt transient node fails before it reaches the committed worker cache', () => {
    const committed = new Map<string, AccountJClaimNode>();
    const attempt = createWorkerJClaimAttempt(committed);
    expect(() => attempt.absorb({
      newNodes: [{ hash: ZERO, node: claimNode(7) }],
      replacedNodeHashes: [],
    })).toThrow('TS_ACCOUNT_WORKER_JCLAIM_DELTA_CORRUPT');
    expect(committed.size).toBe(0);
  });

  test('local prune retains a shared live node and removes it after the last resident root', () => {
    const shared = claimNode(11);
    const sharedHash = hashAccountJClaimNode(shared);
    const stale = claimNode(12);
    const staleHash = hashAccountJClaimNode(stale);
    const store = new Map([[sharedHash, shared], [staleHash, stale]]);
    const first = makeAccount(accountId(100), accountId(101));
    const second = makeAccount(accountId(100), accountId(102));
    first.state.leftPendingJClaims = { version: 1, root: sharedHash, count: 1n };
    second.state.rightPendingJClaims = { version: 1, root: sharedHash, count: 1n };

    pruneWorkerJClaimNodes(store, [[first, second]]);
    expect([...store.keys()]).toEqual([sharedHash]);

    first.state.leftPendingJClaims = createEmptyAccountJClaimAccumulator();
    // The candidate no longer reaches `shared`, but the retained rollback base
    // does; both resident sets must participate until restore is impossible.
    pruneWorkerJClaimNodes(store, [[first], [second]]);
    expect([...store.keys()]).toEqual([sharedHash]);
    pruneWorkerJClaimNodes(store, [[first]]);
    expect(store.size).toBe(0);
  });
});
