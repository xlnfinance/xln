import { describe, expect, test } from 'bun:test';
import { applyAccountInput, proposeAccountFrame } from '../../../account/consensus';
import type { AccountConsensusContext } from '../../../account/consensus/context';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { createDefaultDelta } from '../../../account/state/delta';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import { computeIntegrityDigest } from '../../../support/bytes/integrity-checksum';
import { projectPortableAccountDoc } from '../../../storage/read/projections';
import { makeAccount } from '../../helpers/cross-j';
import type { AccountPeerInput, AccountReplica, AccountTx } from '../../../types/account';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { TsAccountWorkerCoordinator } from '../../../rscore/ts-worker';
import {
  computeTsAccountLogicalShardRoot,
  tsAccountLogicalShard,
  TsAccountShardRootTree,
} from '../../../rscore/ts-worker/sharding';
import { createWorkerConsensusContext, type TsAccountWorkerState } from '../../../rscore/ts-worker/worker-state';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { encodeBoard, hashBoard } from '../../../entity/factory';
import { signEntityHashes } from '../../../hanko/signing';
import { createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { createEmptyEnv } from '../../../runtime';
import { getStaticSwapTokenDimensions, SWAP_LOT_SCALE } from '../../../orderbook/types';

/**
 * L2 parity: the worker-thread Account engine must be byte-identical to the
 * canonical sequential TS transitions (`applyAccountInput` / `proposeAccountFrame`)
 * across all three traffic kinds — inbound peer AccountInputs (dispute lane,
 * real ECDSA Hanko verified by the same canonical verifier on both sides),
 * local admissions mixing direct payments, HTLC locks, and same-J swap offers
 * — for worker counts 1/2/4/8, with effects restored
 * by original input ordinal and Account state never returned per frame.
 */

const OWNER = `0x${'ff'.repeat(32)}`;
const RUNTIME_SEED = 'ts-worker-parity-seed';
const DISPUTE_BODY = `0x${'44'.repeat(32)}`;
const COUNT = 96;
const WORKER_COUNTS = [1, 2, 4, 8] as const;

const PARITY_JURISDICTION: JReplica = {
  name: 'ts-worker-parity',
  blockNumber: 0n,
  stateRoot: null,
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  position: { x: 0, y: 0, z: 0 },
  chainId: 31_337,
  contracts: {
    depository: `0x${'dd'.repeat(20)}`,
    entityProvider: `0x${'ee'.repeat(20)}`,
    account: `0x${'98'.repeat(20)}`,
    deltaTransformer: `0x${'99'.repeat(20)}`,
  },
};

const signingEnv = createEmptyEnv(RUNTIME_SEED);

/**
 * Deterministic synthetic Account ids spread across many three-nibble shards
 * for local-admission traffic; inbound dispute peers use real board-hash ids.
 */
const syntheticAccountIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => {
    const shard = (index * 631) % 4096;
    const prefix = shard.toString(16).padStart(3, '0');
    const suffix = index.toString(16).padStart(61, '0');
    return `0x${prefix}${suffix}`;
  });

/**
 * Each inbound peer Entity id is the canonical single-signer board hash of a
 * deterministically derived signer address, so `signEntityHashes` and the real
 * `verifyHankoForHash` (no stub) accept the same Hanko on both sides.
 */
const peerAccountId = (index: number): string => {
  const signerLabel = `parity-peer-${String(index)}`;
  const address = deriveSignerAddressSync(RUNTIME_SEED, signerLabel).toLowerCase();
  registerSignerKey(signingEnv, address, deriveSignerKeySync(RUNTIME_SEED, signerLabel));
  const boardHash = hashBoard(encodeBoard({
    mode: 'proposer-based',
    threshold: 1n,
    validators: [address],
    shares: { [address]: 1n },
  })).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(boardHash)) {
    throw new Error(`PARITY_PEER_BOARD_HASH_INVALID:${boardHash}`);
  }
  return boardHash;
};

const INBOUND_COUNT = 32;
const inboundAccountIds = Array.from({ length: INBOUND_COUNT }, (_, index) => peerAccountId(index));

const parityAccount = (accountId: string, disputePeer = false): AccountReplica => {
  const account = makeAccount(OWNER, accountId);
  const tokenTwo = createDefaultDelta(2);
  tokenTwo.leftCreditLimit = 10n ** 30n;
  tokenTwo.rightCreditLimit = 10n ** 30n;
  account.state.deltas = account.state.deltas.updated(2, tokenTwo);
  account.proofHeader = { fromEntity: OWNER, toEntity: accountId, nextProofNonce: 1 };
  if (disputePeer) {
    // Dispute-lane preconditions, mirroring the canonical monotonicity fixture:
    // fresh proof nonce 5 strictly above jNonce 4, with a live proof body.
    account.state.jNonce = 4;
    account.currentDisputeProofBodyHash = DISPUTE_BODY;
  }
  account.currentFrame.accountStateRoot = computeAccountStateRoot(account.state);
  return account;
};

const paymentTx = (accountId: string, amount: bigint): AccountTx => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount,
    route: [accountId],
    fromEntityId: OWNER,
    toEntityId: accountId,
    deliveryMode: 'direct',
  },
});

const htlcLockTx = (lockIndex: number): AccountTx => ({
  type: 'htlc_lock',
  data: {
    lockId: `0x${String(lockIndex).padStart(2, '0').repeat(32)}`,
    hashlock: `0x${'ab'.repeat(32)}`,
    timelock: 60_000n,
    revealBeforeHeight: 100,
    amount: 1n,
    tokenId: 1,
  },
});

/** Same-J resting offer, mirroring the canonical swap authorization fixture. */
const swapOfferTx = (offerId: string): AccountTx => ({
  type: 'swap_offer',
  data: {
    offerId,
    giveTokenId: 1,
    ...getStaticSwapTokenDimensions(1, 2),
    giveAmount: 2n * SWAP_LOT_SCALE,
    wantTokenId: 2,
    wantAmount: 2n * SWAP_LOT_SCALE,
    maxFee: 200n,
    minNetReceive: 2n * SWAP_LOT_SCALE - 200n,
  },
});

/** Real inbound peer dispute input: canonical hash + really signed Hanko. */
const inboundDisputeInput = async (accountId: string, index: number): Promise<AccountPeerInput> => {
  const account = parityAccount(accountId, true);
  const hash = createDisputeProofHashWithNonce(
    account.state,
    DISPUTE_BODY,
    account.state.domain,
    5,
    true,
  );
  const signerId = deriveSignerAddressSync(RUNTIME_SEED, `parity-peer-${String(index)}`).toLowerCase();
  const hankos = await signEntityHashes(signingEnv, accountId, signerId, [hash]);
  const hanko = hankos[0];
  if (!hanko) throw new Error(`PARITY_PEER_HANKO_MISSING:${accountId}`);
  return {
    kind: 'dispute',
    fromEntityId: accountId,
    toEntityId: OWNER,
    domain: account.state.domain,
    disputeConfig: account.state.disputeConfig,
    watchSeed: account.state.watchSeed,
    disputeHanko: {
      hanko,
      hash,
      proofBodyHash: DISPUTE_BODY,
      proofNonce: 5,
      proposerIsLeft: true,
    },
  };
};

type EffectRecord = Readonly<{ phase: string; order: number; accountId: string; result: unknown }>;

type SequentialOutcome = Readonly<{
  shadowRoot: string;
  inboundEffects: readonly EffectRecord[];
  outboundEffects: readonly EffectRecord[];
}>;

/** Canonical sequential baseline: the exact transitions the workers must reuse. */
const runSequential = async (
  ids: readonly string[],
  txsByAccount: readonly AccountTx[][],
  inboundIds: readonly string[],
  inboundInputs: readonly AccountPeerInput[],
): Promise<SequentialOutcome> => {
  const accounts = new Map<string, AccountReplica>();
  const isInbound = new Set(inboundIds);
  for (const accountId of ids) {
    accounts.set(accountId, parityAccount(accountId, isInbound.has(accountId)));
  }
  const workerStub = {
    jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
    jClaimNodes: new Map(),
    settlementBoardAuthorities: new Map(),
  } as unknown as TsAccountWorkerState;
  const inboundEffects: EffectRecord[] = [];
  const context: AccountConsensusContext = createWorkerConsensusContext(workerStub, 1_000, 0, workerStub.jClaimNodes);
  for (const [order, item] of inboundInputs.entries()) {
    const account = accounts.get(item.fromEntityId);
    if (!account) throw new Error(`PARITY_INBOUND_ACCOUNT_MISSING:${item.fromEntityId}`);
    inboundEffects.push({
      phase: 'inbound',
      order,
      accountId: item.fromEntityId,
      result: await applyAccountInput(context, account, item, {
        entityTimestamp: 1_000,
        finalizedJHeight: 0,
        owningEntityIsHub: false,
        verifyHanko: context.verifyHanko,
      }),
    });
  }
  const outboundEffects: EffectRecord[] = [];
  for (const [order, accountId] of ids.entries()) {
    const account = accounts.get(accountId);
    if (!account) throw new Error(`PARITY_ACCOUNT_MISSING:${accountId}`);
    outboundEffects.push({
      phase: 'outbound-enqueue',
      order,
      accountId,
      result: await applyAccountInput(context, account, { kind: 'enqueue', txs: txsByAccount[order] ?? [] }),
    });
  }
  for (const [order, accountId] of ids.entries()) {
    const account = accounts.get(accountId);
    if (!account) throw new Error(`PARITY_ACCOUNT_MISSING:${accountId}`);
    outboundEffects.push({
      phase: 'outbound-proposal',
      order: ids.length + order,
      accountId,
      result: await proposeAccountFrame(context, account, 1_000, 0),
    });
  }
  const shardLeaves = new Map<number, Map<string, string>>();
  for (const [accountId, account] of accounts) {
    const shardId = tsAccountLogicalShard(accountId);
    const leaves = shardLeaves.get(shardId) ?? new Map<string, string>();
    leaves.set(accountId, computeEntityAccountValueHash(account));
    shardLeaves.set(shardId, leaves);
  }
  const tree = new TsAccountShardRootTree();
  tree.update([...shardLeaves].map(([shardId, leaves]) => ({
    shardId,
    root: computeTsAccountLogicalShardRoot(
      shardId,
      [...leaves].map(([accountId, valueHash]) => ({ accountId, valueHash })),
    ),
  })));
  return { shadowRoot: tree.root, inboundEffects, outboundEffects };
};

const runCoordinator = async (
  ids: readonly string[],
  txsByAccount: readonly AccountTx[][],
  inboundInputs: readonly AccountPeerInput[],
  workers: number,
) => {
  const isInbound = new Set(inboundInputs.map(input => input.fromEntityId));
  const accounts = new Map(ids.map(accountId => [
    accountId,
    parityAccount(accountId, isInbound.has(accountId)),
  ]));
  const coordinator = await TsAccountWorkerCoordinator.create({
    ownerEntityId: OWNER,
    workerCount: workers,
    logicalShardToWorker: Array.from({ length: 4096 }, (_, shardId) => shardId % workers),
    accounts,
    jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
  });
  const inbound = await coordinator.applyAccountInputs({
      frameId: 'parity-frame-1',
      entityTimestamp: 1_000,
      finalizedJHeight: 0,
      inputs: inboundInputs.map(input => ({ accountId: input.fromEntityId, input })),
    });
    if (inbound.checkpointChanges !== undefined) {
      throw new Error('PARITY_INBOUND_CHECKPOINT_LEAKED');
    }
    const outbound = await coordinator.proposeAccountFrames({
      frameId: 'parity-frame-1',
      timestamp: 1_000,
      jHeight: 0,
      txs: ids.map((accountId, order) => ({ accountId, txs: txsByAccount[order] ?? [] })),
      proposalAccountIds: ids,
      checkpointDue: false,
    });
    // Normal frames must not return Account replicas: only ordered effects,
    // changed shard subroots, and metrics.
    if (outbound.checkpointChanges !== undefined) {
      throw new Error('PARITY_CHECKPOINT_LEAKED_ON_NORMAL_FRAME');
    }
  return { inbound, outbound };
};

const digest = (effects: readonly unknown[]): string =>
  computeIntegrityDigest(encodeCanonicalConsensusBytes(effects as unknown[]));

describe('TS Account worker engine parity with canonical sequential transitions', () => {
  const ids = [
    ...syntheticAccountIds(COUNT - INBOUND_COUNT),
    ...inboundAccountIds,
  ];
  const txsByAccount: AccountTx[][] = ids.map((accountId, index) => {
    if (index % 3 === 0) return [paymentTx(accountId, BigInt(index + 1)), htlcLockTx(index)];
    if (index % 3 === 1) {
      const offerId = `parity-offer-${String(index)}`;
      return [swapOfferTx(offerId)];
    }
    return [paymentTx(accountId, BigInt(index + 1))];
  });
  let inboundInputs: AccountPeerInput[] = [];
  const fixtureInboundInputs = async (): Promise<AccountPeerInput[]> => {
    if (inboundInputs.length === 0) inboundInputs = await Promise.all(inboundAccountIds.map(inboundDisputeInput));
    return inboundInputs;
  };

  test('fixture mixes inbound peers, payments, HTLC locks, and same-J swap offers', async () => {
    await fixtureInboundInputs();
    expect(new Set(ids.map(tsAccountLogicalShard)).size).toBe(COUNT);
    expect(new Set(ids).size).toBe(COUNT);
    const flat = txsByAccount.flat();
    expect(flat.filter(tx => tx.type === 'direct_payment')).toHaveLength(COUNT - Math.ceil(COUNT / 3));
    expect(flat.filter(tx => tx.type === 'htlc_lock')).toHaveLength(Math.ceil(COUNT / 3));
    expect(flat.filter(tx => tx.type === 'swap_offer')).toHaveLength(Math.floor(COUNT / 3));
    expect(inboundInputs.every(input => input.kind === 'dispute')).toBeTrue();
  });

  test('sequential baseline accepts the real-Hanko inbound dispute inputs', async () => {
    const inputs = await fixtureInboundInputs();
    const baseline = await runSequential(ids, txsByAccount, inboundAccountIds, inputs);
    for (const effect of baseline.inboundEffects) {
      const result = effect.result as { ok: boolean; error?: string };
      if (!result.ok) throw new Error(`PARITY_SEQUENTIAL_INBOUND_REJECTED:${effect.accountId}:${safeText(result)}`);
    }
    expect(baseline.inboundEffects).toHaveLength(INBOUND_COUNT);
  });

  test('sequential baseline admits the local admission fixtures', async () => {
    const inputs = await fixtureInboundInputs();
    const baseline = await runSequential(ids, txsByAccount, inboundAccountIds, inputs);
    let offers = 0;
    for (const effect of baseline.outboundEffects) {
      if (effect.phase !== 'outbound-enqueue') continue;
      const result = effect.result as { ok: boolean; admittedAccountTxCount?: number };
      if (!result.ok) throw new Error(`PARITY_SEQUENTIAL_REJECTED:${effect.phase}:${effect.accountId}`);
      offers += result.admittedAccountTxCount ?? 0;
    }
    expect(baseline.outboundEffects).toHaveLength(COUNT * 2);
    // Swap offers are canonical Account state, not just mempool noise.
    expect(offers).toBe(txsByAccount.reduce((sum, txs) => sum + txs.length, 0));
  });

  for (const workers of WORKER_COUNTS) {
    test(`worker=${workers} matches the sequential baseline byte-for-byte (inbound + outbound)`, async () => {
      const inputs = await fixtureInboundInputs();
      const baseline = await runSequential(ids, txsByAccount, inboundAccountIds, inputs);
      const { inbound, outbound } = await runCoordinator(ids, txsByAccount, inputs, workers);
      expect(inbound.effects).toHaveLength(INBOUND_COUNT);
      expect(outbound.effects).toHaveLength(COUNT * 2);
      for (const effect of [...inbound.effects, ...outbound.effects]) {
        if (!effect.result.ok) throw new Error(`PARITY_WORKER_REJECTED:${effect.phase}:${effect.accountId}`);
      }
      // Effects restored by original input ordinal: dense, positional, no
      // rejected placeholders and no cross-worker sorting artifacts.
      expect(outbound.effects.map(effect => effect.order))
        .toEqual(Array.from({ length: COUNT * 2 }, (_, order) => order));
      expect(inbound.effects.map(effect => effect.order))
        .toEqual(Array.from({ length: INBOUND_COUNT }, (_, order) => order));
      expect(digest(inbound.effects)).toBe(digest(baseline.inboundEffects));
      expect(digest(outbound.effects)).toBe(digest(baseline.outboundEffects));
      expect(outbound.shadowAccountsRoot).toBe(baseline.shadowRoot);
    });
  }

  test('Account documents cross IPC only at the configured checkpoint cadence', async () => {
    const accounts = new Map(ids.map(accountId => [
      accountId,
      parityAccount(accountId, inboundAccountIds.includes(accountId)),
    ]));
    const coordinator = await TsAccountWorkerCoordinator.create({
      ownerEntityId: OWNER,
      workerCount: 2,
      logicalShardToWorker: Array.from({ length: 4096 }, (_, shardId) => shardId % 2),
      accounts,
      jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
    });
    await coordinator.applyAccountInputs({
        frameId: 'parity-checkpoint-1',
        entityTimestamp: 1_000,
        finalizedJHeight: 0,
        inputs: [],
      });
      const normal = await coordinator.proposeAccountFrames({
        frameId: 'parity-checkpoint-1',
        timestamp: 1_000,
        jHeight: 0,
        txs: ids.map((accountId, order) => ({ accountId, txs: txsByAccount[order] ?? [] })),
        proposalAccountIds: ids,
        checkpointDue: false,
      });
      expect(normal.checkpointChanges).toBeUndefined();
      const encodedEffects = encodeCanonicalConsensusBytes(normal.effects);
      // Returning the resident replicas would cost at least one portable
      // document per Account per frame; the actual effects batch is a small
      // fraction of that, proving replicas are not shipped back per frame.
      const portableDocsBytes = ids.reduce((sum, accountId) =>
        sum + encodeCanonicalConsensusBytes(
          projectPortableAccountDoc(accounts.get(accountId) as AccountReplica),
        ).byteLength, 0);
      expect(encodedEffects.byteLength).toBeLessThan(portableDocsBytes);

      await coordinator.applyAccountInputs({
        frameId: 'parity-checkpoint-2',
        entityTimestamp: 2_000,
        finalizedJHeight: 0,
        inputs: [],
      });
      const checkpoint = await coordinator.proposeAccountFrames({
        frameId: 'parity-checkpoint-2',
        timestamp: 2_000,
        jHeight: 0,
        txs: [],
        proposalAccountIds: [],
        checkpointDue: true,
      });
      expect(checkpoint.checkpointChanges?.accounts).toHaveLength(COUNT);
    expect(checkpoint.shadowAccountsRoot).toBe(normal.shadowAccountsRoot);
  });
});

const safeText = (result: { ok: boolean; error?: string }): string =>
  result.error === undefined ? 'unknown' : String(result.error);
