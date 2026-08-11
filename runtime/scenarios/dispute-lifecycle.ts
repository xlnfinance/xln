/**
 * Dispute Lifecycle Scenario (unilateral dispute path)
 *
 * Verifies:
 * 1) disputeStart freezes account immediately (local shadow state)
 * 2) DisputeStarted/DisputeFinalized are handled unilaterally (no j_event_claim path)
 * 3) DisputeFinalized clears activeDispute but keeps the account finalized-disputed
 * 4) finalized Accounts stay permanently closed and reject later business traffic
 */

import type { RuntimeReplica } from '../runtime/types';
import { defaultAccountDisputeConfigForParties } from '../account/dispute-config';
import { startRuntimeHistoryTraceForTesting } from '../runtime/history-retention';
import { bootScenario, registerEntities, fundEntities } from './boot';
import {
  getProcess,
  converge,
  syncChain,
  processJEvents,
  assert,
  findReplica,
  usd,
  enableStrictScenario,
  pinScenarioJurisdictionUnix,
  readScenarioJurisdictionUnix,
  advanceScenarioPastDisputeTimeout,
} from './helpers';

const USDC = 1;
const DETERMINISTIC_DISPUTE_START_UNIX = 4_102_500_000;

type Registered = { id: string; signer: string; name: string };
const requireRegistered = (entity: Registered | undefined, name: string): Registered => {
  if (!entity) {
    throw new Error(`DISPUTE_LIFECYCLE_MISSING_ENTITY:${name}`);
  }
  return entity;
};

export async function runDisputeLifecycle(_existingEnv?: RuntimeReplica): Promise<RuntimeReplica> {
  console.log('\n' + '='.repeat(80));
  console.log('  DISPUTE LIFECYCLE SCENARIO (UNILATERAL)');
  console.log('='.repeat(80));

  const process = await getProcess();
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'dispute-lifecycle',
    signerIds: ['2', '3'],
    seed: 'dispute-lifecycle-deterministic',
    ...(_existingEnv?.scenarioJAdapterMode
      ? { mode: _existingEnv.scenarioJAdapterMode }
      : {}),
    ...(_existingEnv?.runtimeConfig?.storage?.enabled !== undefined
      ? { storageEnabled: _existingEnv.runtimeConfig.storage.enabled }
      : {}),
  });
  env.quietRuntimeLogs = true;
  const visualTrace = _existingEnv?.scenarioMode
    ? startRuntimeHistoryTraceForTesting(env)
    : null;
  const scenarioDebug = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.['XLN_SCENARIO_DEBUG'] === '1';
  if (scenarioDebug) env.scenarioLogLevel = 'debug';
  const restoreStrict = enableStrictScenario(env, 'dispute-lifecycle');

  try {
    const advanceRuntimeTimestamp = (nextTs: number) => {
      // Entity timestamps are consensus state and advance only inside a signed
      // frame. The runtime clock makes scheduledWake due; its frame commits the
      // matching Entity timestamp without mutating a certified state in place.
      env.state.timestamp = nextTs;
    };

    const registered = await registerEntities(
      env,
      jadapter,
      [
        { name: 'Alice', signer: '2', position: { x: -20, y: -30, z: 0 } },
        { name: 'Hub', signer: '3', position: { x: 20, y: -30, z: 0 } },
      ],
      jurisdiction,
    ) as Registered[];
    const alice = requireRegistered(registered[0], 'Alice');
    const hub = requireRegistered(registered[1], 'Hub');

    await fundEntities(env, jadapter, [
      { id: alice.id, tokenId: USDC, amount: usd(2_000_000) },
      { id: hub.id, tokenId: USDC, amount: usd(2_000_000) },
    ]);

    // Open Alice<->Hub bilateral account
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: hub.id,
          disputeConfig: defaultAccountDisputeConfigForParties(alice.id, false, hub.id, true),
          tokenId: USDC,
          creditAmount: usd(10_000),
        },
      }],
    }]);
    for (let i = 0; i < 4; i++) await process(env);
    await converge(env, 12);

    // Seed at least one settled bilateral frame (ensures counterparty dispute proof metadata is present)
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: alice.id,
          tokenId: USDC,
          amount: usd(100),
          route: [hub.id, alice.id],
          deliveryMode: 'direct',
          description: 'dispute-seed-payment',
        },
      }],
    }]);
    for (let i = 0; i < 6; i++) await process(env);
    await converge(env, 12);

    const aliceAccountPre = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    const hubAccountPre = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(!!aliceAccountPre && !!hubAccountPre, 'Alice↔Hub account missing', env);
    assert(
      !!aliceAccountPre!.counterpartyDisputeProofHanko,
      'Missing counterpartyDisputeProofHanko before disputeStart',
      env,
    );

    // Freeze locally before creating the jurisdiction batch.
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'prepareDispute',
        data: { counterpartyEntityId: hub.id, description: 'safety-freeze-check' },
      }],
    }]);
    const aliceAccountPreparing = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    assert(aliceAccountPreparing?.status === 'disputed', 'ready prepareDispute must auto-draft disputeStart', env);

    const aliceAccountFrozen = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    assert(aliceAccountFrozen?.status === 'disputed', 'disputeStart must transition prepared account to disputed', env);
    assert(!aliceAccountFrozen?.pendingFrame, 'pendingFrame must be cleared on freeze', env);
    assert(!aliceAccountFrozen?.pendingAccountInput, 'pendingAccountInput must be cleared on freeze', env);
    assert(env.state.jReplicas.size > 0, 'jReplicas missing', env);
    assert(
      (findReplica(env, alice.id)[1].state.jBatchState?.batch?.disputeStarts?.length || 0) > 0,
      'disputeStart was not added to jBatch',
      env,
    );

    // Anvil automining derives a block timestamp from elapsed host time even
    // when genesis is fixed. Pin the economically relevant dispute-start block
    // so repeated runs exercise identical challenge windows and J-event bytes.
    await pinScenarioJurisdictionUnix(env, jadapter, DETERMINISTIC_DISPUTE_START_UNIX);

    // Broadcast disputeStart and process unilateral j-events
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }]);
    await syncChain(env, 5);
    await processJEvents(env);
    await converge(env, 12);

    const aliceAfterStart = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    const hubAfterStart = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(!!aliceAfterStart?.activeDispute, 'Alice activeDispute not set after DisputeStarted', env);
    assert(!!hubAfterStart?.activeDispute, 'Hub activeDispute not set after DisputeStarted', env);
    assert(aliceAfterStart?.status === 'disputed', 'Alice status must remain disputed after start', env);
    assert(hubAfterStart?.status === 'disputed', 'Hub status must be disputed after start', env);

    // Business txs must be blocked while disputed (only J-event bookkeeping is allowed).
    // Keep this in sync with runtime/account/tx/apply.ts disputed gate.
    const frameBeforeBlockedTraffic = Number(aliceAfterStart?.currentHeight || 0);
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: hub.id,
          tokenId: USDC,
          amount: usd(5),
          route: [alice.id, hub.id],
          deliveryMode: 'direct',
          description: 'must-fail-while-disputed',
        },
      }],
    }]);
    for (let i = 0; i < 4; i++) await process(env);
    await converge(env, 6);
    const frameAfterBlockedTraffic = Number(findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.currentHeight || 0);
    assert(
      frameAfterBlockedTraffic === frameBeforeBlockedTraffic,
      `Disputed account accepted business tx unexpectedly (${frameBeforeBlockedTraffic} -> ${frameAfterBlockedTraffic})`,
      env,
    );

    // Both sides must reject business traffic while disputed.
    const hubFrameBeforeBlockedTraffic = Number(hubAfterStart?.currentHeight || 0);
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: alice.id,
          tokenId: USDC,
          amount: usd(7),
          route: [hub.id, alice.id],
          deliveryMode: 'direct',
          description: 'must-fail-on-hub-while-disputed',
        },
      }],
    }]);
    for (let i = 0; i < 4; i++) await process(env);
    await converge(env, 6);
    const hubFrameAfterBlockedTraffic = Number(findReplica(env, hub.id)[1].state.accounts.get(alice.id)?.currentHeight || 0);
    assert(
      hubFrameAfterBlockedTraffic === hubFrameBeforeBlockedTraffic,
      `Disputed hub-side account accepted business tx unexpectedly (${hubFrameBeforeBlockedTraffic} -> ${hubFrameAfterBlockedTraffic})`,
      env,
    );

    // Finalize must not enqueue before timeout.
    const finalizeBatchCountBefore = Number(findReplica(env, alice.id)[1].state.jBatchState?.batch?.disputeFinalizations?.length || 0);
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'disputeFinalize',
        data: {
          counterpartyEntityId: hub.id,
          description: 'must-reject-early-timeout',
        },
      }],
    }]);
    await process(env);
    const finalizeBatchAfterEarly = Number(findReplica(env, alice.id)[1].state.jBatchState?.batch?.disputeFinalizations?.length || 0);
    assert(
      finalizeBatchAfterEarly === finalizeBatchCountBefore,
      `early disputeFinalize must not enqueue before timeout (${finalizeBatchCountBefore} -> ${finalizeBatchAfterEarly})`,
      env,
    );

    // Advance jurisdiction wall-clock past absolute unix challenge end.
    const timeoutUnix = Number(aliceAfterStart?.activeDispute?.disputeTimeout || 0);
    const currentUnix = await readScenarioJurisdictionUnix(jadapter);
    assert(
      timeoutUnix >= currentUnix,
      `Expected present-or-future unix timeout, got timeout=${timeoutUnix}, current=${currentUnix}`,
      env,
    );
    const reserveBeforeFinalize = await jadapter.getReserves(alice.id, USDC);
    const hubReserveBeforeFinalize = await jadapter.getReserves(hub.id, USDC);
    const aliceCollateralBeforeFinalize = aliceAfterStart?.state.deltas.get(USDC)?.collateral ?? 0n;

    await advanceScenarioPastDisputeTimeout(env, jadapter, timeoutUnix);

    let autoFinalizeObserved = false;
    for (let i = 0; i < 40; i++) {
      advanceRuntimeTimestamp((env.state.timestamp || 0) + 1000);
      await process(env);
      await syncChain(env, 3);
      await processJEvents(env);
      await converge(env, 6);
      const acc = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
      if (!acc?.activeDispute) {
        autoFinalizeObserved = true;
        break;
      }
    }
    if (!autoFinalizeObserved) {
      const aliceState = findReplica(env, alice.id)[1].state;
      const account = aliceState.accounts.get(hub.id);
      const deadlineHook = aliceState.crontabState?.hooks?.get(`dispute-deadline:${hub.id.toLowerCase()}`);
      throw new Error(
        `ASSERTION FAILED: Auto dispute finalize did not complete after timeout ` +
        `(runtimeTs=${env.state.timestamp} entityTs=${aliceState.timestamp} ` +
        `jHeight=${String(env.state.jReplicas.values().next().value?.blockNumber ?? 'missing')} ` +
        `timeout=${String(account?.activeDispute?.disputeTimeout ?? 'cleared')} ` +
        `observed=${String(account?.activeDispute?.observedOnChain ?? false)} ` +
        `finalizeQueued=${String(account?.activeDispute?.finalizeQueued ?? false)} ` +
        `hookAt=${String(deadlineHook?.triggerAt ?? 'missing')} ` +
        `draft=${aliceState.jBatchState?.batch?.disputeFinalizations?.length ?? 0} ` +
        `sent=${aliceState.jBatchState?.sentBatch?.batch?.disputeFinalizations?.length ?? 0})`,
      );
    }

    const aliceAfterFinalize = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    const hubAfterFinalize = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(!aliceAfterFinalize?.activeDispute, 'Alice activeDispute must clear after DisputeFinalized', env);
    assert(!hubAfterFinalize?.activeDispute, 'Hub activeDispute must clear after DisputeFinalized', env);
    assert(
      aliceAfterFinalize?.status === 'disputed',
      'Alice account must remain finalized-disputed until explicit reopen',
      env,
    );
    assert(
      hubAfterFinalize?.status === 'disputed',
      'Hub account must remain finalized-disputed until explicit reopen',
      env,
    );

    const aliceOnChainNonce = Number(aliceAfterFinalize?.state.jNonce || 0);
    const hubOnChainNonce = Number(hubAfterFinalize?.state.jNonce || 0);
    assert(
      Number(aliceAfterFinalize?.proofHeader?.nextProofNonce || 0) >= aliceOnChainNonce + 1,
      'Alice proofHeader.nextProofNonce must be onChain+1 after finalize',
      env,
    );
    assert(
      Number(hubAfterFinalize?.proofHeader?.nextProofNonce || 0) >= hubOnChainNonce + 1,
      'Hub proofHeader.nextProofNonce must be onChain+1 after finalize',
      env,
    );

    const reserveAfterFinalize = await jadapter.getReserves(alice.id, USDC);
    const hubReserveAfterFinalize = await jadapter.getReserves(hub.id, USDC);
    const aliceCollateralAfterFinalize = aliceAfterFinalize?.state.deltas.get(USDC)?.collateral ?? 0n;
    const reserveDelta = reserveAfterFinalize - reserveBeforeFinalize;
    const releasedCollateral = aliceCollateralBeforeFinalize - aliceCollateralAfterFinalize;
    assert(
      reserveDelta > 0n,
      `Alice reserve did not increase after dispute finalize: before=${reserveBeforeFinalize}, after=${reserveAfterFinalize}`,
      env,
    );
    assert(
      aliceCollateralAfterFinalize <= aliceCollateralBeforeFinalize,
      `Alice collateral increased after dispute finalize: before=${aliceCollateralBeforeFinalize}, after=${aliceCollateralAfterFinalize}`,
      env,
    );
    if (releasedCollateral > 0n) {
      assert(
        reserveDelta >= releasedCollateral,
        `Released collateral did not return to reserve: reserveDelta=${reserveDelta}, releasedCollateral=${releasedCollateral}`,
        env,
      );
    } else {
      assert(
        hubReserveAfterFinalize < hubReserveBeforeFinalize,
        `Alice reserve increased but Hub reserve did not decrease: hubBefore=${hubReserveBeforeFinalize}, hubAfter=${hubReserveAfterFinalize}`,
        env,
      );
    }

    const finalizedHeight = Number(aliceAfterFinalize?.currentHeight || 0);
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: hub.id,
          tokenId: USDC,
          amount: usd(1),
          route: [alice.id, hub.id],
          deliveryMode: 'direct',
          description: 'must-fail-after-finalized-dispute',
        },
      }],
    }]);
    await converge(env, 4);

    const aliceAfterRejectedTraffic = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    const hubAfterRejectedTraffic = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(aliceAfterRejectedTraffic?.status === 'disputed', 'Alice finalized account must remain closed', env);
    assert(hubAfterRejectedTraffic?.status === 'disputed', 'Hub finalized account must remain closed', env);
    assert(!aliceAfterRejectedTraffic?.activeDispute, 'Alice finalized dispute must remain cleared', env);
    assert(!hubAfterRejectedTraffic?.activeDispute, 'Hub finalized dispute must remain cleared', env);
    assert(
      Number(aliceAfterRejectedTraffic?.currentHeight || 0) === finalizedHeight,
      'Finalized account must not commit later business traffic',
      env,
    );

    if (visualTrace) env.history = [...visualTrace.snapshots];
    console.log('✅ dispute-lifecycle passed');
    return env;
  } finally {
    visualTrace?.stop();
    restoreStrict();
  }
}
