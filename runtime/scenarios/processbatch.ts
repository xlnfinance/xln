/**
 * processbatch scenario (JAdapter-backed: BrowserVM or RPC)
 *
 * Focus: hub mixed rebalance batch through j_broadcast -> processBatch -> j_event sync.
 * Verifies:
 * - batch includes unilateral R->C + bilateral proofed C->R in same submit
 * - C->R shortcut ops carry hanko signature + nonce
 * - HankoBatchProcessed(success=true) finalizes batch
 * - AccountSettled reaches both sides and collateral updates bilaterally
 */

import type { Env, EntityReplica } from '../types';
import {
  getProcess,
  assert,
  usd,
  findReplica,
  converge,
  syncChain,
  assertBilateralSync,
} from './helpers';
import { bootScenario, registerEntities } from './boot';

const USDC = 1;
const HUB_RESERVE = usd(20_000);
const INITIAL_COLLATERAL = usd(1_200);
const C2R_A = usd(300);
const C2R_B = usd(450);
const R2C_A = usd(700);
const R2C_B = usd(550);

function hasFinalizedEvent(replica: EntityReplica, type: string): boolean {
  for (const block of replica.state.jBlockChain || []) {
    for (const event of block.events || []) {
      if (event?.type === type) return true;
    }
  }
  return false;
}

function hasSuccessfulHankoBatch(replica: EntityReplica): boolean {
  for (const block of replica.state.jBlockChain || []) {
    for (const event of block.events || []) {
      if (event?.type === 'HankoBatchProcessed' && event?.data?.success === true) {
        return true;
      }
    }
  }
  return false;
}

function getFinalizedEventCount(replica: EntityReplica, type: string): number {
  let count = 0;
  for (const block of replica.state.jBlockChain || []) {
    for (const event of block.events || []) {
      if (event?.type === type) count++;
    }
  }
  return count;
}

export async function runProcessBatchScenario(_existingEnv?: Env): Promise<Env> {
  console.log('\n' + '═'.repeat(80));
  console.log('  PROCESSBATCH MIXED REBALANCE');
  console.log('  Hub batch with C→R (proofed) + R→C (unilateral)');
  console.log('═'.repeat(80));

  const runProcess = await getProcess();
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'processbatch',
    signerIds: ['2', '3', '4', '5', '6'],
    seed: 'processbatch-mixed-seed',
  });

  assert(jurisdiction.chainId > 0, `jurisdiction.chainId>0 (got ${jurisdiction.chainId})`, env);

  const [hub, spenderA, spenderB, receiverA, receiverB] = await registerEntities(env, jadapter, [
    { name: 'Hub', signer: '2', position: { x: 0, y: 0, z: 0 } },
    { name: 'Spender-A', signer: '3', position: { x: -30, y: -20, z: 0 } },
    { name: 'Spender-B', signer: '4', position: { x: 30, y: -20, z: 0 } },
    { name: 'Receiver-A', signer: '5', position: { x: -40, y: 20, z: 0 } },
    { name: 'Receiver-B', signer: '6', position: { x: 40, y: 20, z: 0 } },
  ], jurisdiction);

  const spenders = [spenderA, spenderB];
  const receivers = [receiverA, receiverB];

  await jadapter.debugFundReserves(hub.id, USDC, HUB_RESERVE);
  await syncChain(env, 3);
  const hubReserveAfterFund = findReplica(env, hub.id)[1].state.reserves.get(String(USDC)) || 0n;
  assert(hubReserveAfterFund === HUB_RESERVE, `hub reserve funded (${hubReserveAfterFund})`, env);

  // Create bilateral accounts with Hub.
  for (const entity of [...spenders, ...receivers]) {
    await runProcess(env, [{
      entityId: entity.id,
      signerId: entity.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: hub.id, tokenId: USDC, creditAmount: 0n },
      }],
    }]);
    await runProcess(env);
  }
  await converge(env, 10);

  for (const entity of [...spenders, ...receivers]) {
    const hubAccount = findReplica(env, hub.id)[1].state.accounts.get(entity.id);
    const peerAccount = findReplica(env, entity.id)[1].state.accounts.get(hub.id);
    assert(!!hubAccount && !!peerAccount, `bilateral account exists for ${entity.name}`, env);
  }

  // Seed collateral on spender accounts so Hub can withdraw C->R through settlement shortcut.
  await runProcess(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: spenders.map((spender) => ({
      type: 'deposit_collateral' as const,
      data: { counterpartyId: spender.id, tokenId: USDC, amount: INITIAL_COLLATERAL },
    })),
  }]);
  await runProcess(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  }]);
  await syncChain(env, 6);

  for (const spender of spenders) {
    const hubDelta = findReplica(env, hub.id)[1].state.accounts.get(spender.id)?.deltas.get(USDC);
    const peerDelta = findReplica(env, spender.id)[1].state.accounts.get(hub.id)?.deltas.get(USDC);
    assert(hubDelta?.collateral === INITIAL_COLLATERAL, `${spender.name} seeded collateral on hub side`, env);
    assert(peerDelta?.collateral === INITIAL_COLLATERAL, `${spender.name} seeded collateral on peer side`, env);
  }

  // Build bilateral C->R settlements from Hub side (auto-approved by counterparties).
  await runProcess(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [
      {
        type: 'settle_propose',
        data: {
          counterpartyEntityId: spenderA.id,
          ops: [{ type: 'c2r', tokenId: USDC, amount: C2R_A }],
          memo: 'processbatch-c2r-a',
        },
      },
      {
        type: 'settle_propose',
        data: {
          counterpartyEntityId: spenderB.id,
          ops: [{ type: 'c2r', tokenId: USDC, amount: C2R_B }],
          memo: 'processbatch-c2r-b',
        },
      },
    ],
  }]);
  await converge(env, 12);

  await runProcess(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [
      { type: 'settle_execute', data: { counterpartyEntityId: spenderA.id } },
      { type: 'settle_execute', data: { counterpartyEntityId: spenderB.id } },
    ],
  }]);
  await converge(env, 8);

  // Add unilateral R->C ops for receiver accounts.
  await runProcess(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [
      {
        type: 'deposit_collateral',
        data: { counterpartyId: receiverA.id, tokenId: USDC, amount: R2C_A },
      },
      {
        type: 'deposit_collateral',
        data: { counterpartyId: receiverB.id, tokenId: USDC, amount: R2C_B },
      },
    ],
  }]);

  const hubBeforeBroadcast = findReplica(env, hub.id)[1];
  const queuedBatch = hubBeforeBroadcast.state.jBatchState?.batch;
  const queuedR2C = queuedBatch?.reserveToCollateral || [];
  const queuedC2R = queuedBatch?.collateralToReserve || [];
  const queuedSettlements = queuedBatch?.settlements || [];

  assert(queuedR2C.length > 0, 'jBatch includes reserveToCollateral before broadcast', env);
  assert(queuedC2R.length >= 2, `jBatch includes >=2 collateralToReserve ops (got ${queuedC2R.length})`, env);
  assert(queuedSettlements.length === 0, `pure C2R settlements compressed (settlements=${queuedSettlements.length})`, env);

  const r2cExpected = new Map<string, bigint>([
    [receiverA.id.toLowerCase(), R2C_A],
    [receiverB.id.toLowerCase(), R2C_B],
  ]);
  let seenR2C = 0;
  for (const op of queuedR2C) {
    for (const pair of op.pairs || []) {
      const key = String(pair.entity || '').toLowerCase();
      const expected = r2cExpected.get(key);
      if (expected !== undefined) {
        assert(BigInt(pair.amount) === expected, `R2C amount match for ${key.slice(-8)}`, env);
        seenR2C += 1;
      }
    }
  }
  assert(seenR2C === r2cExpected.size, `R2C receiver pairs found=${seenR2C}, expected=${r2cExpected.size}`, env);

  for (const op of queuedC2R) {
    assert(!!op.sig && op.sig !== '0x', `C2R op has counterparty hanko sig (${op.counterparty.slice(-8)})`, env);
    assert(Number(op.nonce) > 0, `C2R op has positive nonce (${op.counterparty.slice(-8)})`, env);
  }

  const historyBefore = hubBeforeBroadcast.state.batchHistory?.length || 0;

  await runProcess(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  }]);
  await converge(env, 6);

  const hubAfterBroadcast = findReplica(env, hub.id)[1];
  const batchHashBeforeFinalize = hubAfterBroadcast.state.jBatchState?.batchHash;
  if (jadapter.mode === 'rpc') {
    assert(!!batchHashBeforeFinalize, 'batch hash computed for j_broadcast', env);
    assert((hubAfterBroadcast.state.jBatchState?.pendingBroadcast || false) === true, 'pendingBroadcast latched after submit', env);
  }

  await syncChain(env, 6);

  const hubFinal = findReplica(env, hub.id)[1];
  const spenderAFinal = findReplica(env, spenderA.id)[1];
  const spenderBFinal = findReplica(env, spenderB.id)[1];
  const receiverAFinal = findReplica(env, receiverA.id)[1];
  const receiverBFinal = findReplica(env, receiverB.id)[1];

  const historyAfter = hubFinal.state.batchHistory || [];
  assert(historyAfter.length > historyBefore, `batchHistory grew (${historyBefore} -> ${historyAfter.length})`, env);

  const lastBatch = historyAfter[historyAfter.length - 1];
  assert(lastBatch?.status === 'confirmed', `last batch status=confirmed (got ${lastBatch?.status})`, env);
  assert((lastBatch?.opCount || 0) >= 3, `last batch opCount >= 3 (got ${lastBatch?.opCount || 0})`, env);
  assert((lastBatch?.entityNonce || 0) >= 1, `last batch entityNonce >= 1 (got ${lastBatch?.entityNonce || 0})`, env);

  assert((hubFinal.state.jBatchState?.pendingBroadcast || false) === false, 'pendingBroadcast cleared after confirmation', env);
  assert(hubFinal.state.jBatchState?.status === 'empty', `jBatchState.status=empty (got ${hubFinal.state.jBatchState?.status})`, env);
  assert(hasSuccessfulHankoBatch(hubFinal), 'hub finalized HankoBatchProcessed(success=true)', env);

  assert(hasFinalizedEvent(hubFinal, 'AccountSettled'), 'hub finalized AccountSettled event', env);
  assert(hasFinalizedEvent(spenderAFinal, 'AccountSettled'), 'spender A finalized AccountSettled event', env);
  assert(hasFinalizedEvent(spenderBFinal, 'AccountSettled'), 'spender B finalized AccountSettled event', env);
  assert(hasFinalizedEvent(receiverAFinal, 'AccountSettled'), 'receiver A finalized AccountSettled event', env);
  assert(hasFinalizedEvent(receiverBFinal, 'AccountSettled'), 'receiver B finalized AccountSettled event', env);

  const hubSpenderADelta = hubFinal.state.accounts.get(spenderA.id)?.deltas.get(USDC);
  const hubSpenderBDelta = hubFinal.state.accounts.get(spenderB.id)?.deltas.get(USDC);
  const hubReceiverADelta = hubFinal.state.accounts.get(receiverA.id)?.deltas.get(USDC);
  const hubReceiverBDelta = hubFinal.state.accounts.get(receiverB.id)?.deltas.get(USDC);

  assert(!!hubSpenderADelta && !!hubSpenderBDelta && !!hubReceiverADelta && !!hubReceiverBDelta, 'hub deltas exist for all accounts', env);
  assert(hubSpenderADelta!.collateral === INITIAL_COLLATERAL - C2R_A, `spender A collateral reduced by C2R (${hubSpenderADelta!.collateral})`, env);
  assert(hubSpenderBDelta!.collateral === INITIAL_COLLATERAL - C2R_B, `spender B collateral reduced by C2R (${hubSpenderBDelta!.collateral})`, env);
  assert(hubReceiverADelta!.collateral === R2C_A, `receiver A collateral increased by R2C (${hubReceiverADelta!.collateral})`, env);
  assert(hubReceiverBDelta!.collateral === R2C_B, `receiver B collateral increased by R2C (${hubReceiverBDelta!.collateral})`, env);

  assertBilateralSync(env, hub.id, spenderA.id, USDC, 'processbatch-spender-a');
  assertBilateralSync(env, hub.id, spenderB.id, USDC, 'processbatch-spender-b');
  assertBilateralSync(env, hub.id, receiverA.id, USDC, 'processbatch-receiver-a');
  assertBilateralSync(env, hub.id, receiverB.id, USDC, 'processbatch-receiver-b');

  const hubSettledCount = getFinalizedEventCount(hubFinal, 'AccountSettled');
  assert(hubSettledCount > 0, `hub finalized AccountSettled count > 0 (got ${hubSettledCount})`, env);

  for (const entity of [spenderA, spenderB, receiverA, receiverB]) {
    const hubAccount = hubFinal.state.accounts.get(entity.id);
    const peerAccount = findReplica(env, entity.id)[1].state.accounts.get(hub.id);
    assert((hubAccount?.lastFinalizedJHeight || 0) > 0, `hub ${entity.name} lastFinalizedJHeight > 0`, env);
    assert((peerAccount?.lastFinalizedJHeight || 0) > 0, `${entity.name} lastFinalizedJHeight > 0`, env);
  }

  console.log('\n✅ processbatch mixed scenario passed');
  console.log(`   Hub: ${hub.id}`);
  console.log(`   Spenders: ${spenderA.id}, ${spenderB.id}`);
  console.log(`   Receivers: ${receiverA.id}, ${receiverB.id}`);
  console.log(`   Batch history entries: ${historyAfter.length}`);

  await jadapter.close();
  return env;
}
