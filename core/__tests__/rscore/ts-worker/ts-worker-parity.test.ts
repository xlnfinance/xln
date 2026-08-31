import { describe, expect, test } from 'bun:test';
import { applyAccountInput, proposeAccountFrame } from '../../../account/consensus';
import type { AccountConsensusContext } from '../../../account/consensus/context';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { createDefaultDelta } from '../../../account/state/delta';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import { computeIntegrityDigest } from '../../../support/bytes/integrity-checksum';
import { makeAccount } from '../../helpers/cross-j';
import type { AccountInput, AccountReplica, AccountTx } from '../../../types/account';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { TsAccountWorkerCoordinator } from '../../../rscore/ts-worker';
import { tsAccountLogicalShard } from '../../../rscore/ts-worker/sharding';
import { createWorkerConsensusContext, type TsAccountWorkerState } from '../../../rscore/ts-worker/worker-state';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { encodeBoard, hashBoard } from '../../../entity/factory';
import { signEntityHashes } from '../../../hanko/signing';
import { createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { createEmptyEnv } from '../../../runtime';
import { getStaticSwapTokenDimensions, SWAP_LOT_SCALE } from '../../../orderbook/types';
import { projectPortableAccountDoc } from '../../../storage/read/projections';

/**
 * L2 parity: the worker-thread Account engine must be byte-identical to the
 * canonical sequential TS transitions (`applyAccountInput` / `proposeAccountFrame`)
 * across all three traffic kinds — inbound AccountInputs (dispute lane,
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
  tokenRegistry: [{
    symbol: 'TST',
    name: 'Test Token',
    address: `0x${'77'.repeat(20)}`,
    decimals: 18,
    tokenId: 1,
    tokenType: 0,
    externalTokenId: 1n,
  }],
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
    throw new Error(`PARITY_COUNTERPARTY_BOARD_HASH_INVALID:${boardHash}`);
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

const htlcLockTx = (lockIndex: number): AccountTx => {
  const hashlock = `0x${String(lockIndex).padStart(2, '0').repeat(32)}`;
  return {
    type: 'htlc_lock',
    data: {
      lockId: hashlock,
      hashlock,
      timelock: 60_000n,
      revealBeforeHeight: 100,
      amount: 1n,
      tokenId: 1,
    },
  };
};

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
const inboundDisputeInput = async (accountId: string, index: number): Promise<AccountInput> => {
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
  accountsRoot: string;
  inboundEffects: readonly EffectRecord[];
  outboundEffects: readonly EffectRecord[];
}>;

/** Canonical sequential baseline: the exact transitions the workers must reuse. */
const runSequential = async (
  ids: readonly string[],
  txsByAccount: readonly AccountTx[][],
  inboundIds: readonly string[],
  inboundInputs: readonly AccountInput[],
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
  const accountsRoot = PersistentEntityAccountMap.fromEntries(
    accounts,
    OWNER,
    computeEntityAccountValueHash,
  ).rootHash();
  return { accountsRoot, inboundEffects, outboundEffects };
};

const runCoordinator = async (
  ids: readonly string[],
  txsByAccount: readonly AccountTx[][],
  inboundInputs: readonly AccountInput[],
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
    expectedAccountsRoot: coordinator.accountsRoot,
    entityTimestamp: 1_000,
    finalizedJHeight: 0,
    inputs: inboundInputs.map(input => ({ accountId: input.fromEntityId, input })),
  });
  if (inbound.postAccounts !== undefined) {
    throw new Error('PARITY_INBOUND_POST_ACCOUNTS_LEAKED');
  }
  if (inbound.accountsRoot !== undefined || inbound.changedSubroots.length !== 0) {
    throw new Error('PARITY_INBOUND_ROOT_WAS_NOT_REQUESTED');
  }
  const outbound = await coordinator.proposeAccountFrames({
    frameId: 'parity-frame-1',
    timestamp: 1_000,
    jHeight: 0,
    txs: ids.map((accountId, order) => ({ accountId, txs: txsByAccount[order] ?? [] })),
    proposals: ids.map(accountId => ({ accountId })),
  });
  if (outbound.postAccounts?.length !== ids.length) {
    throw new Error(`PARITY_POST_ACCOUNT_ARITY:${outbound.postAccounts?.length ?? -1}:${ids.length}`);
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
  let inboundInputs: AccountInput[] = [];
  const fixtureInboundInputs = async (): Promise<AccountInput[]> => {
    if (inboundInputs.length === 0) inboundInputs = await Promise.all(inboundAccountIds.map(inboundDisputeInput));
    return inboundInputs;
  };

  // Run fail-stop before fixture signing starts crypto workers. Successful
  // pools intentionally live until process exit because terminating a
  // completed Worker crashes Bun 1.4 on macOS.
  test('worker failure is fail-stop and cannot publish a partial root', async () => {
    const validId = `0x000${'1'.repeat(61)}`;
    const missingId = `0x001${'e'.repeat(61)}`;
    const coordinator = await TsAccountWorkerCoordinator.create({
      ownerEntityId: OWNER,
      workerCount: 2,
      logicalShardToWorker: Array.from({ length: 4096 }, (_, shardId) => shardId % 2),
      accounts: new Map([[validId, parityAccount(validId)]]),
      jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
    });
    const initialRoot = coordinator.accountsRoot;
    await coordinator.applyAccountInputs({
      frameId: 'fail-stop-frame',
      expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 1_000,
      finalizedJHeight: 0,
      inputs: [],
    });
    await expect(coordinator.proposeAccountFrames({
      frameId: 'fail-stop-frame',
      timestamp: 1_000,
      jHeight: 0,
      txs: [
        { accountId: validId, txs: [paymentTx(validId, 1n)] },
        { accountId: missingId, txs: [paymentTx(missingId, 1n)] },
      ],
      proposals: [{ accountId: validId }],
    })).rejects.toThrow('TS_ACCOUNT_WORKER_COORDINATOR_FATAL');
    expect(coordinator.accountsRoot).toBe(initialRoot);
    await expect(coordinator.applyAccountInputs({
      frameId: 'after-fatal',
      expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 2_000,
      finalizedJHeight: 0,
      inputs: [],
    })).rejects.toThrow('TS_ACCOUNT_WORKER_COORDINATOR_FATAL');
  });

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

  test('worker verifies a registered peer Hanko from compact certified-board context', async () => {
    const accountId = inboundAccountIds[0];
    if (!accountId) throw new Error('certified-board fixture account missing');
    const input = await inboundDisputeInput(accountId, 0);
    const coordinator = await TsAccountWorkerCoordinator.create({
      ownerEntityId: OWNER,
      workerCount: 1,
      accounts: new Map([[accountId, parityAccount(accountId, true)]]),
      jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
    });
    const counterpartyBoardAuthority = {
      entityId: accountId,
      boardHash: accountId,
      previousBoardHash: `0x${'00'.repeat(32)}`,
      previousBoardValidUntil: 0,
      activatedAtJHeight: 0,
      logIndex: 0,
    };
    const inbound = await coordinator.applyAccountInputs({
      frameId: 'certified-board-frame',
      expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 1_000,
      finalizedJHeight: 0,
      inputs: [{ accountId, input, counterpartyBoardAuthority }],
    });
    const result = inbound.effects[0]?.result as { ok: boolean; error?: string } | undefined;
    expect(result?.ok).toBe(true);
    await coordinator.proposeAccountFrames({
      frameId: 'certified-board-frame',
      timestamp: 1_000,
      jHeight: 0,
      txs: [],
      proposals: [],
    });
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
      expect(outbound.accountsRoot).toBe(baseline.accountsRoot);
    });
  }

  test('multiple Accounts in one shard retain dense input order', async () => {
    const sameShardIds = [
      `0xabc${'f'.repeat(61)}`,
      `0xabc${'0'.repeat(61)}`,
      `0xabc${'8'.repeat(61)}`,
    ];
    expect(new Set(sameShardIds.map(tsAccountLogicalShard))).toEqual(new Set([0xabc]));
    const sameShardTxs = sameShardIds.map((accountId, index) => [
      paymentTx(accountId, BigInt(index + 1)),
    ]);
    const baseline = await runSequential(sameShardIds, sameShardTxs, [], []);
    const { inbound, outbound } = await runCoordinator(sameShardIds, sameShardTxs, [], 2);
    expect(inbound.effects).toEqual([]);
    expect(outbound.effects.map(effect => effect.accountId)).toEqual([
      ...sameShardIds,
      ...sameShardIds,
    ]);
    expect(digest(outbound.effects)).toBe(digest(baseline.outboundEffects));
    expect(outbound.accountsRoot).toBe(baseline.accountsRoot);
  });

  test('one hot shard plus many cold shards matches w1 and w8', async () => {
    const hotIds = Array.from({ length: 32 }, (_, index) =>
      `0x777${index.toString(16).padStart(61, '0')}`);
    const coldIds = syntheticAccountIds(64).map((accountId, index) =>
      `0x${((index * 61) % 4096).toString(16).padStart(3, '0')}${accountId.slice(5)}`);
    const mixedIds = [...hotIds, ...coldIds];
    expect(mixedIds.filter(accountId => tsAccountLogicalShard(accountId) === 0x777)).toHaveLength(32);
    const mixedTxs = mixedIds.map(accountId => [paymentTx(accountId, 1n)]);
    const w1 = await runCoordinator(mixedIds, mixedTxs, [], 1);
    const w8 = await runCoordinator(mixedIds, mixedTxs, [], 8);
    expect(w8.outbound.accountsRoot).toBe(w1.outbound.accountsRoot);
    expect(digest(w8.outbound.effects)).toBe(digest(w1.outbound.effects));
  });

  test('post-commit Account Hankos return to the shard owner without changing its root', async () => {
    const accountId = `0xabc${'1'.repeat(61)}`;
    const coordinator = await TsAccountWorkerCoordinator.create({
      ownerEntityId: OWNER,
      workerCount: 2,
      logicalShardToWorker: Array.from({ length: 4096 }, (_, shardId) => shardId % 2),
      accounts: new Map([[accountId, parityAccount(accountId)]]),
      jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
    });
    await coordinator.applyAccountInputs({
      frameId: 'hanko-frame', expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 1_000, finalizedJHeight: 0, inputs: [],
    });
    const outbound = await coordinator.proposeAccountFrames({
      frameId: 'hanko-frame', timestamp: 1_000, jHeight: 0,
      txs: [{ accountId, txs: [paymentTx(accountId, 1n)] }],
      proposals: [{ accountId }],
    });
    const effect = outbound.effects.find(row => row.phase === 'outbound-proposal');
    if (!effect || !effect.result.ok || effect.result.outcome !== 'proposed') {
      throw new Error('PARITY_POST_COMMIT_HANKO_PROPOSAL_MISSING');
    }
    const hashes = effect.result.hashesToSign ?? [];
    expect(hashes.length).toBeGreaterThan(0);
    const beforeRoot = coordinator.accountsRoot;
    const installed = await coordinator.installCommittedAccountHankos({
      entityHeight: 1,
      rows: [{
        accountId,
        hankos: hashes.map((entry, index) => ({
          hash: entry.hash,
          hanko: `0x${String(index + 1).padStart(2, '0').repeat(65)}`,
          type: entry.type,
          entityHeight: 1,
          createdAt: 1_000,
        })),
      }],
    });
    expect(installed).toHaveLength(1);
    expect(installed[0]?.accounts).toBe(1);
    expect(installed[0]?.attached).toBe(hashes.length);
    expect(coordinator.accountsRoot).toBe(beforeRoot);
  });

  test('exact duplicate inbound delivery replays without changing the root', async () => {
    const input = (await fixtureInboundInputs())[0];
    if (!input) throw new Error('PARITY_DUPLICATE_INPUT_MISSING');
    const accountId = input.fromEntityId;
    const coordinator = await TsAccountWorkerCoordinator.create({
      ownerEntityId: OWNER,
      workerCount: 4,
      logicalShardToWorker: Array.from({ length: 4096 }, (_, shardId) => shardId % 4),
      accounts: new Map([[accountId, parityAccount(accountId, true)]]),
      jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
    });
    const first = await coordinator.applyAccountInputs({
      frameId: 'duplicate-frame-1', expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 1_000, finalizedJHeight: 0,
      inputs: [{ accountId, input }],
    });
    await coordinator.proposeAccountFrames({
      frameId: 'duplicate-frame-1', timestamp: 1_000, jHeight: 0,
      txs: [], proposals: [],
    });
    const firstRoot = coordinator.accountsRoot;
    const second = await coordinator.applyAccountInputs({
      frameId: 'duplicate-frame-2', expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 2_000, finalizedJHeight: 0,
      inputs: [{ accountId, input }],
    });
    await coordinator.proposeAccountFrames({
      frameId: 'duplicate-frame-2', timestamp: 2_000, jHeight: 0,
      txs: [], proposals: [],
    });
    expect(first.effects).toHaveLength(1);
    expect(second.effects).toHaveLength(1);
    expect(coordinator.accountsRoot).toBe(firstRoot);
  });

  test('inbound genesis installs the canonical Account shell on its owning worker', async () => {
    const input = (await fixtureInboundInputs())[0];
    if (!input) throw new Error('PARITY_GENESIS_INPUT_MISSING');
    const accountId = input.fromEntityId;
    const initialAccount = parityAccount(accountId, true);
    const coordinator = await TsAccountWorkerCoordinator.create({
      ownerEntityId: OWNER,
      workerCount: 4,
      logicalShardToWorker: Array.from({ length: 4096 }, (_, shardId) => shardId % 4),
      accounts: new Map(),
      jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
    });
    const inbound = await coordinator.applyAccountInputs({
      frameId: 'genesis-frame', expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 1_000, finalizedJHeight: 0,
      inputs: [{
        accountId,
        input,
        initialAccount: projectPortableAccountDoc(initialAccount),
      }],
    });
    const outbound = await coordinator.proposeAccountFrames({
      frameId: 'genesis-frame', timestamp: 1_000, jHeight: 0,
      txs: [], proposals: [],
    });
    const sequential = parityAccount(accountId, true);
    const workerStub = {
      jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
      jClaimNodes: new Map(), settlementBoardAuthorities: new Map(),
    } as unknown as TsAccountWorkerState;
    const context = createWorkerConsensusContext(workerStub, 1_000, 0, workerStub.jClaimNodes);
    const expected = await applyAccountInput(context, sequential, input, {
      entityTimestamp: 1_000, finalizedJHeight: 0,
      owningEntityIsHub: false, verifyHanko: context.verifyHanko,
    });
    expect(digest(inbound.effects)).toBe(digest([{
      phase: 'inbound', order: 0, accountId, result: expected,
    }]));
    expect(outbound.accountsRoot).toBe(PersistentEntityAccountMap.fromEntries(
      [[accountId, sequential]], OWNER, computeEntityAccountValueHash,
    ).rootHash());
    expect(outbound.postAccounts?.map(row => row.accountId)).toEqual([accountId]);
  });

  test('Entity fitting retry restores the exact expected parent root', async () => {
    const accountId = `0x321${'a'.repeat(61)}`;
    const coordinator = await TsAccountWorkerCoordinator.create({
      ownerEntityId: OWNER,
      workerCount: 2,
      logicalShardToWorker: Array.from({ length: 4096 }, (_, shardId) => shardId % 2),
      accounts: new Map([[accountId, parityAccount(accountId)]]),
      jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
    });
    const parentRoot = coordinator.accountsRoot;
    await coordinator.applyAccountInputs({
      frameId: 'retry-attempt-1', expectedAccountsRoot: parentRoot,
      entityTimestamp: 1_000, finalizedJHeight: 0, inputs: [],
    });
    const abandoned = await coordinator.proposeAccountFrames({
      frameId: 'retry-attempt-1', timestamp: 1_000, jHeight: 0,
      txs: [{ accountId, txs: [paymentTx(accountId, 1n)] }],
      proposals: [{ accountId }],
    });
    expect(abandoned.accountsRoot).not.toBe(parentRoot);

    await coordinator.applyAccountInputs({
      frameId: 'retry-attempt-2', expectedAccountsRoot: parentRoot,
      entityTimestamp: 1_000, finalizedJHeight: 0, inputs: [],
    });
    const retry = await coordinator.proposeAccountFrames({
      frameId: 'retry-attempt-2', timestamp: 1_000, jHeight: 0,
      txs: [{ accountId, txs: [paymentTx(accountId, 2n)] }],
      proposals: [{ accountId }],
    });
    const baseline = await runCoordinator(
      [accountId],
      [[paymentTx(accountId, 2n)]],
      [],
      1,
    );
    expect(retry.accountsRoot).toBe(baseline.outbound.accountsRoot);
    expect(digest(retry.effects)).toBe(digest(baseline.outbound.effects));
  });

  test('local openAccount H=0 shell becomes resident before outbound admissions', async () => {
    const accountId = `0x456${'b'.repeat(61)}`;
    const shell = parityAccount(accountId);
    const txs = [paymentTx(accountId, 3n)];
    const sequential = parityAccount(accountId);
    const workerStub = {
      jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
      jClaimNodes: new Map(), settlementBoardAuthorities: new Map(),
    } as unknown as TsAccountWorkerState;
    const context = createWorkerConsensusContext(workerStub, 1_000, 0, workerStub.jClaimNodes);
    const admission = await applyAccountInput(context, sequential, { kind: 'enqueue', txs });
    const proposal = await proposeAccountFrame(context, sequential, 1_000, 0);

    const coordinator = await TsAccountWorkerCoordinator.create({
      ownerEntityId: OWNER,
      workerCount: 2,
      accounts: new Map(),
      jReplicas: new Map([[PARITY_JURISDICTION.name, PARITY_JURISDICTION]]),
    });
    await coordinator.applyAccountInputs({
      frameId: 'local-genesis', expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 1_000, finalizedJHeight: 0, inputs: [],
    });
    const outbound = await coordinator.proposeAccountFrames({
      frameId: 'local-genesis', timestamp: 1_000, jHeight: 0,
      txs: [{ accountId, txs, initialAccount: projectPortableAccountDoc(shell) }],
      proposals: [{ accountId }],
    });
    expect(digest(outbound.effects)).toBe(digest([
      { phase: 'outbound-enqueue', order: 0, accountId, result: admission },
      { phase: 'outbound-proposal', order: 1, accountId, result: proposal },
    ]));
    expect(outbound.accountsRoot).toBe(PersistentEntityAccountMap.fromEntries(
      [[accountId, sequential]], OWNER, computeEntityAccountValueHash,
    ).rootHash());
  });

  test('outbound returns only touched post-Accounts without a duplicate checkpoint channel', async () => {
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
      expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 1_000,
      finalizedJHeight: 0,
      inputs: [],
    });
    const normal = await coordinator.proposeAccountFrames({
      frameId: 'parity-checkpoint-1',
      timestamp: 1_000,
      jHeight: 0,
      txs: ids.map((accountId, order) => ({ accountId, txs: txsByAccount[order] ?? [] })),
      proposals: ids.map(accountId => ({ accountId })),
    });
    expect(normal.postAccounts?.map(row => row.accountId)).toEqual([...ids].sort());

    await coordinator.applyAccountInputs({
      frameId: 'parity-checkpoint-2',
      expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 2_000,
      finalizedJHeight: 0,
      inputs: [],
    });
    const idle = await coordinator.proposeAccountFrames({
      frameId: 'parity-checkpoint-2',
      timestamp: 2_000,
      jHeight: 0,
      txs: [],
      proposals: [],
    });
    expect(idle.postAccounts).toEqual([]);
    expect(idle.accountsRoot).toBe(normal.accountsRoot);
  });
});

const safeText = (result: { ok: boolean; error?: string }): string =>
  result.error === undefined ? 'unknown' : String(result.error);
