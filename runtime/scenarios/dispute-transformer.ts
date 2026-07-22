/**
 * Worst-case programmable dispute: both peers hold a locally signed resolution
 * frame while the network is partitioned. The starter must commit its HTLC and
 * swap arguments at dispute start; the finalizer supplies the opposite side.
 */

import { ethers } from 'ethers';

import type { AccountFrame, AccountInput, AccountMachine, EntityTx, Env } from '../types';
import type { JAdapter } from '../jadapter/types';
import { deriveDisputeTokenFinalization } from '../protocol/dispute/finalization';
import { generateLockId, hashHtlcSecret } from '../protocol/htlc/utils';
import { safeStringify } from '../protocol/serialization';
import { bootScenario, fundEntities, registerEntities } from './boot';
import {
  assert,
  converge,
  enableStrictScenario,
  findReplica,
  getProcess,
  processJEvents,
  syncChain,
  usd,
} from './helpers';

const USDC = 1;
const WETH = 2;
const MAX_FILL_RATIO = 65_535n;
const WETH_LOT = 1_000_000_000_000n;

type Registered = { id: string; signer: string; name: string };
type MineableProvider = { send(method: string, params: unknown[]): Promise<unknown> };
type DecodedArguments = { fillRatios: bigint[]; secrets: string[]; pulls: string[] };
type AccountAckInput = Extract<AccountInput, { kind: 'ack' }>;

const requireRegistered = (value: Registered | undefined, name: string): Registered => {
  if (!value) throw new Error(`DISPUTE_TRANSFORMER_MISSING_ENTITY:${name}`);
  return value;
};

const frameTxTypes = (frame: AccountFrame | undefined): string[] =>
  frame?.accountTxs.map((tx) => tx.type) ?? [];

const findAccountAck = (txs: readonly EntityTx[] | undefined): AccountAckInput | undefined => {
  for (const tx of txs ?? []) {
    if (tx.type === 'accountInput' && tx.data.kind === 'ack') return structuredClone(tx.data);
    if (tx.type === 'consensusOutput' || tx.type === 'runtimeOutput') {
      const nested = findAccountAck(tx.data.entityTxs);
      if (nested) return nested;
    }
  }
  return undefined;
};

const captureQueuedAck = (env: Env, toEntityId: string): AccountAckInput | undefined => {
  const queues = [
    env.pendingOutputs ?? [],
    env.networkInbox ?? [],
    env.pendingNetworkOutputs ?? [],
    env.runtimeInput.entityInputs,
  ];
  for (const queue of queues) {
    for (const envelope of queue) {
      const ack = findAccountAck(envelope.entityTxs);
      if (ack?.toEntityId === toEntityId) return ack;
    }
  }
  return undefined;
};

const requirePendingResolution = (account: AccountMachine | undefined, side: string): AccountFrame => {
  const frame = account?.pendingFrame;
  const types = frameTxTypes(frame);
  if (!frame || !types.includes('htlc_resolve') || !types.includes('swap_resolve')) {
    throw new Error(`DISPUTE_TRANSFORMER_PENDING_FRAME_MISSING:${side}:${types.join(',') || 'none'}`);
  }
  return frame;
};

const dropPartitionedOutputs = (env: Env, entityIds: ReadonlySet<string>): void => {
  env.pendingOutputs = (env.pendingOutputs ?? []).filter((output) => !entityIds.has(output.entityId));
  env.networkInbox = (env.networkInbox ?? []).filter((output) => !entityIds.has(output.entityId));
  env.pendingNetworkOutputs = (env.pendingNetworkOutputs ?? []).filter(
    (output) => !entityIds.has(output.entityId),
  );
  env.runtimeInput.entityInputs = env.runtimeInput.entityInputs.filter((input) => {
    if (!entityIds.has(input.entityId)) return true;
    return !(input.entityTxs ?? []).some((tx) => tx.type === 'consensusOutput');
  });
};

const countOrderbookRows = (env: Env, offerIds: ReadonlySet<string>): number => {
  let rows = 0;
  for (const replica of env.eReplicas.values()) {
    for (const orderId of replica.state.orderbookExt?.orderPairs?.keys() ?? []) {
      if ([...offerIds].some((offerId) => orderId === offerId || orderId.endsWith(`:${offerId}`))) rows++;
    }
  }
  return rows;
};

const mineUntil = async (jadapter: JAdapter, target: number): Promise<void> => {
  const provider = jadapter.provider as unknown as Partial<MineableProvider>;
  if (typeof provider.send !== 'function') throw new Error('DISPUTE_TRANSFORMER_EVM_MINE_REQUIRED');
  let height = Number(await jadapter.provider.getBlockNumber());
  while (height < target) {
    await provider.send('evm_mine', []);
    height = Number(await jadapter.provider.getBlockNumber());
  }
};

const decodeArguments = (encoded: string, context: string): DecodedArguments => {
  if (encoded === '0x') throw new Error(`DISPUTE_TRANSFORMER_ARGUMENTS_EMPTY:${context}`);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [clauses] = coder.decode(['bytes[]'], encoded) as unknown as [string[]];
  const clause = clauses[0];
  if (!clause) throw new Error(`DISPUTE_TRANSFORMER_CLAUSE_MISSING:${context}`);
  const [decoded] = coder.decode(
    ['tuple(uint16[] fillRatios,bytes32[] secrets,bytes[] pulls)'],
    clause,
  ) as unknown as [{ fillRatios: bigint[]; secrets: string[]; pulls: string[] }];
  return decoded;
};

const deltaByToken = (frame: AccountFrame, tokenId: number) => {
  const delta = frame.deltas.find((entry) => entry.tokenId === tokenId);
  if (!delta) throw new Error(`DISPUTE_TRANSFORMER_FRAME_DELTA_MISSING:${tokenId}`);
  return delta;
};

const currentDelta = (account: AccountMachine, tokenId: number) => {
  const delta = account.deltas.get(tokenId);
  if (!delta) throw new Error(`DISPUTE_TRANSFORMER_BASE_DELTA_MISSING:${tokenId}`);
  return delta;
};

const combinedPendingOffdelta = (
  base: AccountMachine,
  aliceFrame: AccountFrame,
  hubFrame: AccountFrame,
  tokenId: number,
): bigint => {
  const initial = currentDelta(base, tokenId).offdelta;
  return deltaByToken(aliceFrame, tokenId).offdelta + deltaByToken(hubFrame, tokenId).offdelta - initial;
};

const readDebtOutstanding = async (jadapter: JAdapter, entityId: string, tokenId: number): Promise<bigint> =>
  BigInt(await jadapter.depository.debtOutstanding(entityId, tokenId));

export async function runDisputeTransformer(_existingEnv?: Env): Promise<Env> {
  const process = await getProcess();
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'dispute-transformer',
    signerIds: ['2', '3'],
    seed: 'dispute-transformer-deterministic',
    ...(_existingEnv?.scenarioJAdapterMode ? { mode: _existingEnv.scenarioJAdapterMode } : {}),
  });
  env.quietRuntimeLogs = true;
  env.scenarioLogLevel = 'info';
  const restoreStrict = enableStrictScenario(env, 'dispute-transformer');

  try {
    const registered = await registerEntities(env, jadapter, [
      { name: 'Alice', signer: '2', position: { x: -20, y: -30, z: 0 } },
      { name: 'Hub', signer: '3', position: { x: 20, y: -30, z: 0 } },
    ], jurisdiction) as Registered[];
    const alice = requireRegistered(registered[0], 'Alice');
    const hub = requireRegistered(registered[1], 'Hub');
    assert(alice.id.toLowerCase() < hub.id.toLowerCase(), 'Alice must be canonical left', env);

    await fundEntities(env, jadapter, [
      { id: alice.id, tokenId: USDC, amount: usd(2_000_000) },
      { id: hub.id, tokenId: USDC, amount: usd(2_000_000) },
      { id: alice.id, tokenId: WETH, amount: 100n * 10n ** 18n },
      { id: hub.id, tokenId: WETH, amount: 100n * 10n ** 18n },
    ]);

    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }],
    }]);
    await converge(env, 12);
    await process(env, [alice, hub].map((party) => ({
      entityId: party.id,
      signerId: party.signer,
      entityTxs: [
        { type: 'extendCredit' as const, data: { counterpartyEntityId: party.id === alice.id ? hub.id : alice.id, tokenId: USDC, amount: usd(1_000_000) } },
        { type: 'extendCredit' as const, data: { counterpartyEntityId: party.id === alice.id ? hub.id : alice.id, tokenId: WETH, amount: 100n * 10n ** 18n } },
      ],
    })));
    await converge(env, 16);

    // Capture one genuine, quorum-sealed ACK and let the original delivery
    // settle normally. Replaying this exact ACK after disputeStart proves the
    // frozen Account gate rejects late/retried transport input, not merely a
    // hand-written test fixture.
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: alice.id,
          tokenId: USDC,
          amount: usd(11),
          route: [hub.id, alice.id],
          description: 'signed-base-payment-and-late-ack-source',
        },
      }],
    }]);
    let lateAck: AccountAckInput | undefined;
    for (let round = 0; round < 16; round += 1) {
      lateAck ??= captureQueuedAck(env, hub.id);
      await process(env);
    }
    await converge(env, 16);
    assert(!!lateAck, 'Failed to capture a real signed ACK for late-delivery replay', env);

    const aliceSecret = ethers.keccak256(ethers.toUtf8Bytes('dispute-transformer:alice-secret'));
    const hubSecret = ethers.keccak256(ethers.toUtf8Bytes('dispute-transformer:hub-secret'));
    const aliceHashlock = hashHtlcSecret(aliceSecret);
    const hubHashlock = hashHtlcSecret(hubSecret);
    const revealHeight = Number(env.jReplicas.values().next().value?.blockNumber ?? 0n) + 20_000;
    const latestBlock = await jadapter.provider.getBlock('latest');
    if (!latestBlock) throw new Error('DISPUTE_TRANSFORMER_LATEST_BLOCK_MISSING');
    const deadline = BigInt(Number(latestBlock.timestamp) * 1_000 + 20_000_000);
    const aliceLockId = generateLockId(aliceHashlock, revealHeight, 0, env.timestamp);
    const hubLockId = generateLockId(hubHashlock, revealHeight, 1, env.timestamp);
    const giveAmount = MAX_FILL_RATIO * WETH_LOT;
    const wantAmount = MAX_FILL_RATIO * 3_000n;

    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [
        { type: 'manualHtlcLock', data: { counterpartyId: hub.id, lockId: aliceLockId, hashlock: aliceHashlock, timelock: deadline, revealBeforeHeight: revealHeight, amount: usd(7), tokenId: USDC } },
        { type: 'placeSwapOffer', data: { counterpartyEntityId: hub.id, offerId: 'alice-maker-left', giveTokenId: WETH, giveAmount, wantTokenId: USDC, wantAmount, minFillRatio: 0 } },
      ],
    }]);
    await converge(env, 12);
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [
        { type: 'manualHtlcLock', data: { counterpartyId: alice.id, lockId: hubLockId, hashlock: hubHashlock, timelock: deadline, revealBeforeHeight: revealHeight, amount: usd(3), tokenId: USDC } },
        { type: 'placeSwapOffer', data: { counterpartyEntityId: alice.id, offerId: 'hub-maker-right', giveTokenId: WETH, giveAmount, wantTokenId: USDC, wantAmount, minFillRatio: 0 } },
      ],
    }]);
    await converge(env, 12);

    const base = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    assert(!!base, 'Base bilateral account missing', env);
    assert(
      currentDelta(base!, USDC).offdelta === usd(11),
      `Signed base payment mismatch actual=${currentDelta(base!, USDC).offdelta} expected=${usd(11)}`,
      env,
    );
    const baseHeight = base!.currentHeight;
    const baseProofHash = findReplica(env, hub.id)[1].state.accounts.get(alice.id)?.counterpartyDisputeProofBodyHash;
    assert(!!baseProofHash, 'Last mutually signed dispute ProofBody missing', env);
    const partition = new Set([alice.id, hub.id]);
    await process(env, [
      {
        entityId: alice.id,
        signerId: alice.signer,
        entityTxs: [
          { type: 'resolveHtlcLock', data: { counterpartyEntityId: hub.id, lockId: hubLockId, secret: hubSecret } },
          { type: 'resolveSwap', data: { counterpartyEntityId: hub.id, offerId: 'hub-maker-right', fillRatio: 32_768, cancelRemainder: false, executionGiveAmount: 32_768n * WETH_LOT, executionWantAmount: 32_768n * 3_000n } },
        ],
      },
      {
        entityId: hub.id,
        signerId: hub.signer,
        entityTxs: [
          { type: 'resolveHtlcLock', data: { counterpartyEntityId: alice.id, lockId: aliceLockId, secret: aliceSecret } },
          { type: 'resolveSwap', data: { counterpartyEntityId: alice.id, offerId: 'alice-maker-left', fillRatio: 16_384, cancelRemainder: false, executionGiveAmount: 16_384n * WETH_LOT, executionWantAmount: 16_384n * 3_000n } },
        ],
      },
    ]);
    dropPartitionedOutputs(env, partition);
    for (let round = 0; round < 8; round += 1) {
      const aliceAccount = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
      const hubAccount = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
      if (aliceAccount?.pendingFrame && hubAccount?.pendingFrame) break;
      await process(env);
      dropPartitionedOutputs(env, partition);
    }

    const alicePending = requirePendingResolution(findReplica(env, alice.id)[1].state.accounts.get(hub.id), 'alice');
    const hubPending = requirePendingResolution(findReplica(env, hub.id)[1].state.accounts.get(alice.id), 'hub');
    const baseAccount = base!;

    const before = new Map<number, { leftReserve: bigint; rightReserve: bigint; collateral: bigint; ondelta: bigint; offdelta: bigint }>();
    for (const tokenId of [USDC, WETH]) {
      before.set(tokenId, {
        leftReserve: await jadapter.getReserves(alice.id, tokenId),
        rightReserve: await jadapter.getReserves(hub.id, tokenId),
        collateral: await jadapter.getCollateral(alice.id, hub.id, tokenId),
        ondelta: currentDelta(baseAccount, tokenId).ondelta,
        offdelta: combinedPendingOffdelta(baseAccount, alicePending, hubPending, tokenId),
      });
    }

    dropPartitionedOutputs(env, partition);
    await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [{
      type: 'prepareDispute', data: { counterpartyEntityId: alice.id, description: 'mixed-transformer-prepare' },
    }] }]);
    const prepared = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(prepared?.status === 'disputed', 'Ready dispute preparation did not auto-draft disputeStart', env);
    assert(prepared.pendingFrame === undefined, 'Prepare retained an optimistic pending frame', env);
    assert(prepared.currentHeight === baseHeight, 'Prepare changed committed Account height', env);
    assert(prepared.counterpartyDisputeProofBodyHash === baseProofHash, 'Prepare changed signed ProofBody', env);
    assert(
      countOrderbookRows(env, new Set(['alice-maker-left', 'hub-maker-right'])) === 0,
      'Prepare left a disputed swap in an orderbook',
      env,
    );
    assert(
      (prepared.disputePrepare?.pendingOrderbookRemovalIds?.length ?? 0) === 0,
      'Prepare still awaits remote orderbook removal',
      env,
    );
    const start = findReplica(env, hub.id)[1].state.jBatchState?.batch.disputeStarts[0];
    if (!start) throw new Error('DISPUTE_TRANSFORMER_START_NOT_DRAFTED');
    assert(start.proofbodyHash === baseProofHash, 'Dispute start did not use the last mutually signed ProofBody', env);
    const starter = decodeArguments(start.starterInitialArguments, 'starter.initial');
    console.log(`[DISPUTE_DEBUG:start] ${safeStringify({
      nonce: start.nonce,
      proofbodyHash: start.proofbodyHash,
      starterInitialArguments: start.starterInitialArguments,
      starterIncrementedArguments: start.starterIncrementedArguments,
      decoded: starter,
    })}`);
    assert(starter.fillRatios.some((ratio) => ratio > 0n), 'Starter swap fill argument missing', env);
    assert(starter.secrets.map((secret) => secret.toLowerCase()).includes(aliceSecret.toLowerCase()), 'Starter HTLC secret missing', env);

    const frozenBeforeLateAck = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    const frozenHeight = frozenBeforeLateAck?.currentHeight;
    const frozenProofHash = frozenBeforeLateAck?.counterpartyDisputeProofBodyHash;
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{ type: 'accountInput', data: lateAck! }],
    }]);
    const frozenAfterLateAck = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(frozenAfterLateAck?.status === 'disputed', 'Late ACK reopened the disputed Account', env);
    assert(frozenAfterLateAck?.currentHeight === frozenHeight, 'Late ACK changed frozen Account height', env);
    assert(
      frozenAfterLateAck?.counterpartyDisputeProofBodyHash === frozenProofHash,
      'Late ACK changed the selected dispute ProofBody',
      env,
    );
    assert(
      findReplica(env, hub.id)[1].state.jBatchState?.batch.disputeStarts.length === 1,
      'Late ACK drafted a second dispute start',
      env,
    );

    await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [{ type: 'j_broadcast', data: {} }] }]);
    await syncChain(env, 5);
    await processJEvents(env);
    await converge(env, 12);
    const aliceActive = findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.activeDispute;
    if (!aliceActive) throw new Error('DISPUTE_TRANSFORMER_ACTIVE_DISPUTE_MISSING');
    await mineUntil(jadapter, Number(aliceActive.disputeTimeout));

    await process(env, [{ entityId: alice.id, signerId: alice.signer, entityTxs: [{
      type: 'disputeFinalize', data: { counterpartyEntityId: hub.id, cooperative: false, description: 'mixed-transformer-finalize' },
    }] }]);
    const finalization = findReplica(env, alice.id)[1].state.jBatchState?.batch.disputeFinalizations[0];
    if (!finalization) throw new Error('DISPUTE_TRANSFORMER_FINALIZATION_NOT_DRAFTED');
    const finalizer = decodeArguments(finalization.otherArguments, 'finalizer.other');
    console.log(`[DISPUTE_DEBUG:finalize] ${safeStringify({
      initialNonce: finalization.initialNonce,
      finalNonce: finalization.finalNonce,
      initialProofbodyHash: finalization.initialProofbodyHash,
      starterArguments: finalization.starterArguments,
      otherArguments: finalization.otherArguments,
      decoded: finalizer,
    })}`);
    assert(finalizer.fillRatios.some((ratio) => ratio > 0n), 'Finalizer swap fill argument missing', env);
    assert(finalizer.secrets.map((secret) => secret.toLowerCase()).includes(hubSecret.toLowerCase()), 'Finalizer HTLC secret missing', env);

    await process(env, [{ entityId: alice.id, signerId: alice.signer, entityTxs: [{ type: 'j_broadcast', data: {} }] }]);
    await syncChain(env, 5);
    await processJEvents(env);
    await converge(env, 12);

    const [skippedClauses, clampedDeltas] = await Promise.all([
      jadapter.depository.queryFilter(jadapter.depository.filters.TransformerClauseSkipped()),
      jadapter.depository.queryFilter(jadapter.depository.filters.TransformerDeltaClamped()),
    ]);
    console.log(`[DISPUTE_DEBUG:transformers] ${safeStringify({
      skipped: skippedClauses.map((entry) => ({ blockNumber: entry.blockNumber, args: Array.from(entry.args) })),
      clamped: clampedDeltas.map((entry) => ({ blockNumber: entry.blockNumber, args: Array.from(entry.args) })),
    })}`);
    assert(skippedClauses.length === 0, `Transformer skipped ${skippedClauses.length} clause(s)`, env);
    assert(clampedDeltas.length === 0, `Transformer clamped ${clampedDeltas.length} delta(s)`, env);

    for (const tokenId of [USDC, WETH]) {
      const input = before.get(tokenId)!;
      const expected = deriveDisputeTokenFinalization({ tokenId, ...input });
      const actual = {
        leftReserve: await jadapter.getReserves(alice.id, tokenId),
        rightReserve: await jadapter.getReserves(hub.id, tokenId),
        leftDebt: await readDebtOutstanding(jadapter, alice.id, tokenId),
        rightDebt: await readDebtOutstanding(jadapter, hub.id, tokenId),
      };
      const expectedValues = {
        leftReserve: expected.after.reserves.left,
        rightReserve: expected.after.reserves.right,
        leftDebt: expected.after.debtOutstanding.left,
        rightDebt: expected.after.debtOutstanding.right,
      };
      console.log(`[DISPUTE_DEBUG:economics] ${safeStringify({ tokenId, input, expected: expectedValues, actual })}`);
      assert(actual.leftReserve === expectedValues.leftReserve, `Left reserve mismatch token=${tokenId} actual=${actual.leftReserve} expected=${expectedValues.leftReserve}`, env);
      assert(actual.rightReserve === expectedValues.rightReserve, `Right reserve mismatch token=${tokenId} actual=${actual.rightReserve} expected=${expectedValues.rightReserve}`, env);
      assert(actual.leftDebt === expectedValues.leftDebt, `Left debt mismatch token=${tokenId} actual=${actual.leftDebt} expected=${expectedValues.leftDebt}`, env);
      assert(actual.rightDebt === expectedValues.rightDebt, `Right debt mismatch token=${tokenId} actual=${actual.rightDebt} expected=${expectedValues.rightDebt}`, env);
      assert(expected.conservation.conserved, `Custody conservation failed for token ${tokenId}`, env);
    }

    console.log('✅ dispute-transformer passed: bilateral arguments + exact reserves/debts');
    return env;
  } finally {
    restoreStrict();
  }
}
