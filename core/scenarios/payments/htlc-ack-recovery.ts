/** Late preimage + withheld upstream ACK survive WAL reopen and reach the real J. */
import { closeRuntimeDb, closeInfraDb, loadEnvFromDB } from '../../runtime';
import type { RuntimeReplica } from '../../runtime/types';
import { getLiveJAdapter } from '../../runtime/j-submit/live-jadapters';
import { bootScenario, registerEntities } from '../harness/boot';
import { openAccount } from './test-economy';
import {
  assert,
  converge,
  findReplica,
  getProcess,
  processWithOffline,
  requireRuntimeSeed,
  enableStrictScenario,
  readScenarioJurisdictionUnix,
  pinScenarioJurisdictionUnix,
} from '../harness/helpers';
import { quoteHtlcPaymentRoute } from '../../pathfinding/htlc-quote';
import { withDeterministicHtlcTestSecret } from '../../protocol/htlc/test-secret-capability';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import { earliestDerivedDeadline } from '../../entity/scheduler/derived-deadlines';
import { HTLC_ENFORCEMENT_RESERVE_MS } from '../../account/consensus/dispute/deadline-policy';
import { safeStringify } from '../../protocol/serialization';

const SECRET = `0x${'81'.repeat(32)}`;
const HASHLOCK = hashHtlcSecret(SECRET);

export async function htlcAckRecovery(runtimeReplica: RuntimeReplica): Promise<RuntimeReplica> {
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'htlc-ack-recovery',
    signerIds: ['2', '3', '4'],
    runtimeReplica,
    storageEnabled: true,
  });
  env.quietRuntimeLogs = true;
  const jReplica = env.state.jReplicas.get(jurisdiction.name);
  if (!jReplica) throw new Error('HTLC_ACK_RECOVERY_J_REPLICA_MISSING');
  jReplica.rpcs = [jurisdiction.address];
  const restoreStrict = enableStrictScenario(env, 'HTLC ACK RECOVERY');
  try {
    const process = await getProcess();
    const seed = requireRuntimeSeed(env, 'HTLC ACK RECOVERY');
    env.state.timestamp = (await readScenarioJurisdictionUnix(jadapter)) * 1_000;
    const registered = await registerEntities(
      env,
      jadapter,
      [
        { name: 'Alice', signer: '2', position: { x: -20, y: 0, z: 0 } },
        { name: 'Hub', signer: '3', position: { x: 0, y: 0, z: 0 } },
        { name: 'Bob', signer: '4', position: { x: 20, y: 0, z: 0 } },
      ],
      jurisdiction,
    );
    const [alice, hub, bob] = registered;
    if (!alice || !hub || !bob) throw new Error('HTLC_ACK_RECOVERY_ENTITIES_MISSING');
    await openAccount(env, { ...alice, type: 'user' }, { ...hub, type: 'hub' }, 10_000n, 1);
    await openAccount(env, { ...hub, type: 'hub' }, { ...bob, type: 'user' }, 10_000n, 1);
    await converge(env);
    const quote = quoteHtlcPaymentRoute(env.gossip.getProfiles(), [alice.id, hub.id, bob.id], 1, 10n);
    await process(env, [
      {
        entityId: alice.id,
        signerId: alice.signer,
        entityTxs: [
          withDeterministicHtlcTestSecret(
            {
              type: 'htlcPayment',
              data: {
                targetEntityId: bob.id,
                tokenId: 1,
                amount: 10n,
                maxSenderDebit: quote.senderLockAmount,
                route: [alice.id, hub.id, bob.id],
                deliveryMode: 'async',
                description: 'late-ack-recovery',
              },
            },
            SECRET,
          ),
        ],
      },
    ]);
    // Pause Hub only after it signs the downstream lock, retaining genuine peer traffic.
    for (let i = 0; i < 15; i++) {
      const downstream = findReplica(env, hub.id)[1].state.accounts.get(bob.id);
      if (downstream?.pendingFrame?.accountTxs.some(tx => tx.type === 'htlc_lock')) break;
      await process(env);
    }
    const inbound = findReplica(env, hub.id)[1].state.accounts.get(alice.id)?.state.locks.get(HASHLOCK);
    assert(!!inbound, 'Hub must hold the signed upstream lock', env);
    for (let i = 0; i < 8; i++) await processWithOffline(env, undefined, new Set([hub.signer]), 'hold-preimage');
    // Controlled Runtime time, never an in-place mutation of committed Entity time.
    // The downstream leg expires earlier; retain its own 30s enforcement reserve too.
    env.state.timestamp = Number(inbound!.timelock) - HTLC_ENFORCEMENT_RESERVE_MS - 40_000;
    const offline = new Set([alice.signer]);
    await pinScenarioJurisdictionUnix(env, jadapter, Math.floor(env.state.timestamp / 1_000));
    for (let i = 0; i < 12; i++) {
      await processWithOffline(env, undefined, offline, 'withhold-upstream-ack');
      if (findReplica(env, hub.id)[1].state.paybook.entries.get(HASHLOCK)?.secretAckPending) break;
    }
    const pending = findReplica(env, hub.id)[1].state.paybook.entries.get(HASHLOCK);
    assert(pending?.secret === SECRET && pending.secretAckPending, 'verified preimage must await upstream ACK', env);
    const wakeAt = Number(inbound!.timelock) - HTLC_ENFORCEMENT_RESERVE_MS;
    assert(
      earliestDerivedDeadline(findReplica(env, hub.id)[1].state) === wakeAt,
      'wake must preserve the enforcement reserve',
      env,
    );
    const runtimeId = env.runtimeId;
    assert(!!runtimeId, 'Runtime identity required for WAL reopen', env);
    await jadapter.close();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    const restored = await loadEnvFromDB(runtimeId, seed);
    if (!restored) throw new Error('HTLC_ACK_RECOVERY_WAL_REOPEN_FAILED');
    restored.scenarioMode = true;
    restored.quietRuntimeLogs = true;
    const restoreReplayedStrict = enableStrictScenario(restored, 'HTLC ACK RECOVERY REPLAY');
    try {
      const restoredEntry = findReplica(restored, hub.id)[1].state.paybook.entries.get(HASHLOCK);
      assert(
        restoredEntry?.secret === SECRET && restoredEntry.secretAckPending,
        'WAL replay must retain verified preimage and pending ACK',
        restored,
      );
      assert(
        earliestDerivedDeadline(findReplica(restored, hub.id)[1].state) === wakeAt,
        'WAL replay must reconstruct the same early wake',
        restored,
      );
      restored.state.timestamp = wakeAt;
      const adapter = getLiveJAdapter(restored, jurisdiction.name);
      if (!adapter?.pollNow) throw new Error('HTLC_ACK_RECOVERY_RESTORED_WATCHER_MISSING');
      adapter.startWatching(restored);
      await pinScenarioJurisdictionUnix(restored, adapter, Math.floor(wakeAt / 1_000));
      for (let i = 0; i < 12; i++) {
        await processWithOffline(restored, undefined, offline, 'recover-upstream-right');
        if (findReplica(restored, hub.id)[1].state.jBatchState?.batch.disputeStarts.length) break;
      }
      const draft = findReplica(restored, hub.id)[1].state.jBatchState?.batch.disputeStarts;
      assert(draft?.length === 1, 'deadline must draft exactly one real dispute', restored);
      await processWithOffline(
        restored,
        [{ entityId: hub.id, signerId: hub.signer, entityTxs: [{ type: 'j_broadcast', data: {} }] }],
        offline,
        'broadcast-upstream-right',
      );
      // A disconnected Alice cannot be part of a global convergence requirement.
      // Keep the actual transport partition while polling authenticated J receipts.
      for (let i = 0; i < 25; i++) {
        await adapter.pollNow();
        await processWithOffline(restored, undefined, offline, 'observe-real-dispute');
        if (findReplica(restored, hub.id)[1].state.accounts.get(alice.id)?.activeDispute?.observedOnChain) break;
        await new Promise<void>(resolve => setTimeout(resolve, 100));
      }
      const account = findReplica(restored, hub.id)[1].state.accounts.get(alice.id);
      if (!account?.activeDispute?.observedOnChain) {
        const hubReplica = findReplica(restored, hub.id)[1];
        throw new Error(
          `HTLC_ACK_RECOVERY_J_BOUNDARY:${safeStringify({
            activeDispute: account?.activeDispute,
            batch: hubReplica.state.jBatchState,
            submission: hubReplica.jSubmitState,
            nonce: await adapter.getEntityNonce(hub.id),
            jHeight: hubReplica.state.lastFinalizedJHeight,
            pendingJ: restored.infrastructure?.pendingCommittedJOutbox,
            watcher: adapter.getWatcherScanProgress?.(),
            depth: adapter.getFinalityDepth?.(),
            block: await adapter.getCurrentBlockNumber?.(),
            queued: restored.runtimeMempool.entityInputs.map(input => ({
              entity: input.entityId,
              signer: input.signerId,
              txs: input.entityTxs?.map(tx => tx.type),
            })),
          })}`,
        );
      }
      assert(
        account?.activeDispute?.observedOnChain === true,
        'authenticated real J receipt must confirm the dispute',
        restored,
      );
      assert(
        account.activeDispute.starterInitialArguments?.toLowerCase().includes(SECRET.slice(2)) === true,
        'the authenticated dispute must carry the retained preimage',
        restored,
      );
      console.log(`HTLC_ACK_RECOVERY_OK:route=3 preimage=retained wake=${wakeAt} realJDisputes=1`);
      return restored;
    } finally {
      restoreReplayedStrict();
    }
  } finally {
    restoreStrict();
  }
}
