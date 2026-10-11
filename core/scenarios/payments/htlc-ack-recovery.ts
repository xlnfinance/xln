/** Late preimage + withheld upstream ACK survive WAL reopen and reach the real J. */
import { closeRuntimeDb, closeInfraDb, loadEnvFromDB, processRuntime } from '../../runtime';
import type { RuntimeReplica } from '../../runtime/types';
import { getLiveJAdapter } from '../../runtime/j-submit/live-jadapters';
import { bootScenario } from '../harness/boot';
import {
  assert,
  assertRuntimeIdle,
  enableStrictScenario,
  readScenarioJurisdictionUnix,
  pinScenarioJurisdictionUnix,
} from '../harness/helpers';
import { quoteHtlcPaymentRoute } from '../../pathfinding/htlc-quote';
import { withDeterministicHtlcTestSecret } from '../../protocol/htlc/test-secret-capability';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import { earliestDerivedDeadline } from '../../entity/scheduler/derived-deadlines';
import { HTLC_ENFORCEMENT_RESERVE_MS } from '../../account/consensus/dispute/deadline-policy';
import { deriveDelta, isLeftEntity } from '../../account/utils';
import {
  createRecoveryNetwork,
  recoveryReplica,
  pumpRecoveryActors,
  openRecoveryAccount,
} from './htlc-recovery-network';

const SECRET = `0x${'81'.repeat(32)}`;
const HASHLOCK = hashHtlcSecret(SECRET);

const proveOfflinePayment = async (network: Awaited<ReturnType<typeof createRecoveryNetwork>>) => {
  const { alice, hub, actors, route } = network;
  const client = network.clients[0];
  if (!client) throw new Error('HTLC_RECOVERY_ALICE_SOCKET_MISSING');
  route.setReady(false);
  await pumpRecoveryActors([], () => !client.canDeliver(), 'Hub offline');
  const before = recoveryReplica(hub).state.height;
  await processRuntime(alice.env, [
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [
        {
          type: 'directPayment',
          data: {
            targetEntityId: hub.id,
            tokenId: 1,
            amount: 1n,
            route: [alice.id, hub.id],
            deliveryMode: 'direct',
            description: 'offline delivery',
          },
        },
      ],
    },
  ]);
  await processRuntime(alice.env);
  assert((alice.env.pendingNetworkOutputs?.length ?? 0) > 0, 'offline payment remains in committed outbox', alice.env);
  assert(recoveryReplica(hub).state.height === before, 'offline Hub cannot commit', hub.env);
  route.setReady(true);
  await pumpRecoveryActors(
    actors,
    () => {
      const a = recoveryReplica(alice).state.accounts.get(hub.id);
      const h = recoveryReplica(hub).state.accounts.get(alice.id);
      return !!a && !!h && !a.pendingFrame && !h.pendingFrame && recoveryReplica(hub).state.height > before;
    },
    'deferred payment committed',
  );
  const delta = recoveryReplica(hub).state.accounts.get(alice.id)?.state.deltas.get(1);
  if (!delta) throw new Error('HTLC_RECOVERY_PAYMENT_DELTA_MISSING');
  assert(
    deriveDelta(delta, isLeftEntity(hub.id, alice.id)).outPeerCredit === 1n,
    'reconnected Hub receives exactly one unit',
    hub.env,
  );
  await processRuntime(hub.env, [
    {
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [
        {
          type: 'directPayment',
          data: {
            targetEntityId: alice.id,
            tokenId: 1,
            amount: 1n,
            route: [hub.id, alice.id],
            deliveryMode: 'direct',
            description: 'offline delivery refund',
          },
        },
      ],
    },
  ]);
  await pumpRecoveryActors(
    actors,
    () =>
      [alice, hub].every(actor => {
        const peer = actor === alice ? hub : alice;
        const account = recoveryReplica(actor).state.accounts.get(peer.id);
        return !!account && !account.pendingFrame && account.state.deltas.get(1)?.offdelta === 0n;
      }),
    'exact net-zero refund',
  );
};

export async function htlcAckRecovery(runtimeReplica: RuntimeReplica): Promise<RuntimeReplica> {
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'htlc-ack-recovery',
    signerIds: ['1'],
    runtimeReplica,
    storageEnabled: true,
  });
  const jReplica = env.state.jReplicas.get(jurisdiction.name);
  if (!jReplica) throw new Error('HTLC_ACK_RECOVERY_J_REPLICA_MISSING');
  jReplica.rpcs = [jurisdiction.address];
  env.state.timestamp = (await readScenarioJurisdictionUnix(jadapter)) * 1_000;
  const network = await createRecoveryNetwork(env, jadapter, jurisdiction);
  const { hub, alice, bob, actors, route } = network;
  const aliceClient = network.clients[0];
  if (!aliceClient) throw new Error('HTLC_ACK_RECOVERY_ALICE_SOCKET_MISSING');
  const restoreStrict = actors.map(actor => enableStrictScenario(actor.env, 'HTLC ACK RECOVERY'));
  try {
    await openRecoveryAccount(alice, hub, actors);
    await openRecoveryAccount(hub, bob, actors);
    await network.shareProfiles();
    await proveOfflinePayment(network);
    const quote = quoteHtlcPaymentRoute(alice.env.gossip.getProfiles(), [alice.id, hub.id, bob.id], 1, 10n);
    await processRuntime(alice.env, [
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
    await pumpRecoveryActors(
      actors,
      () =>
        recoveryReplica(hub)
          .state.accounts.get(bob.id)
          ?.pendingFrame?.accountTxs.some(tx => tx.type === 'htlc_lock') === true,
      'downstream signed lock',
    );
    const inbound = recoveryReplica(hub).state.accounts.get(alice.id)?.state.locks.get(HASHLOCK);
    if (!inbound) throw new Error('HTLC_ACK_RECOVERY_UPSTREAM_LOCK_MISSING');

    // Hold Hub's ingress, then disconnect Alice through authenticated transport
    // readiness. WAL-owned outputs remain intact and cannot bypass this partition.
    route.setReady(false);
    aliceClient.setReady(false);
    await pumpRecoveryActors([], () => !route.canDeliver(alice.signer), 'Alice offline');
    for (let i = 0; i < 8; i++) {
      await processRuntime(bob.env);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    for (const actor of actors) {
      actor.env.state.timestamp = Number(inbound.timelock) - HTLC_ENFORCEMENT_RESERVE_MS - 40_000;
    }
    await pinScenarioJurisdictionUnix(hub.env, hub.adapter, Math.floor(hub.env.state.timestamp / 1_000));
    route.setReady(true);
    await pumpRecoveryActors(
      [hub, bob],
      () => recoveryReplica(hub).state.paybook.entries.get(HASHLOCK)?.secretAckPending === true,
      'verified secret awaiting upstream ACK',
    );
    const pending = recoveryReplica(hub).state.paybook.entries.get(HASHLOCK);
    assert(
      pending?.secret === SECRET && pending.secretAckPending,
      'verified preimage must await upstream ACK',
      hub.env,
    );
    const wakeAt = Number(inbound.timelock) - HTLC_ENFORCEMENT_RESERVE_MS;
    assert(
      earliestDerivedDeadline(recoveryReplica(hub).state) === wakeAt,
      'wake must preserve enforcement reserve',
      hub.env,
    );

    await hub.adapter.close();
    await closeRuntimeDb(hub.env);
    await closeInfraDb(hub.env);
    const restored = await loadEnvFromDB(hub.signer, hub.seed);
    if (!restored) throw new Error('HTLC_ACK_RECOVERY_WAL_REOPEN_FAILED');
    hub.env = restored;
    restored.scenarioMode = true;
    restored.quietRuntimeLogs = true;
    restoreStrict.push(enableStrictScenario(restored, 'HTLC ACK RECOVERY REPLAY'));
    const adapter = getLiveJAdapter(restored, jurisdiction.name);
    if (!adapter?.pollNow) throw new Error('HTLC_ACK_RECOVERY_RESTORED_WATCHER_MISSING');
    hub.adapter = adapter;
    network.bindHub();
    await network.shareProfiles();
    const restoredEntry = recoveryReplica(hub).state.paybook.entries.get(HASHLOCK);
    assert(
      restoredEntry?.secret === SECRET && restoredEntry.secretAckPending,
      'WAL replay must retain verified preimage and pending ACK',
      restored,
    );
    assert(
      earliestDerivedDeadline(recoveryReplica(hub).state) === wakeAt,
      'WAL replay must reconstruct the same early wake',
      restored,
    );
    for (const actor of actors) actor.env.state.timestamp = wakeAt;
    adapter.startWatching(restored);
    await pinScenarioJurisdictionUnix(restored, adapter, Math.floor(wakeAt / 1_000));
    await pumpRecoveryActors(
      [hub, bob],
      () => recoveryReplica(hub).state.jBatchState?.batch.disputeStarts.length === 1,
      'draft upstream dispute',
    );
    const draft = recoveryReplica(hub).state.jBatchState?.batch.disputeStarts;
    assert(draft?.length === 1, 'deadline must draft exactly one real dispute', restored);
    await processRuntime(restored, [
      { entityId: hub.id, signerId: hub.signer, entityTxs: [{ type: 'j_broadcast', data: {} }] },
    ]);
    for (let i = 0; i < 25; i++) {
      await adapter.pollNow();
      await processRuntime(restored);
      if (recoveryReplica(hub).state.accounts.get(alice.id)?.activeDispute?.observedOnChain) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const account = recoveryReplica(hub).state.accounts.get(alice.id);
    assert(
      account?.activeDispute?.observedOnChain === true,
      'authenticated real J receipt must confirm the dispute',
      restored,
    );
    assert(
      account?.activeDispute?.starterInitialArguments?.toLowerCase().includes(SECRET.slice(2)) === true,
      'authenticated dispute must carry the retained preimage',
      restored,
    );
    network.assertHealthy();
    // Rejoin after proving offline enforcement so the oracle also checks a drained network.
    aliceClient.setReady(true);
    await pumpRecoveryActors([], () => route.canDeliver(alice.signer), 'Alice rejoined');
    for (let i = 0; i < 12; i++) {
      for (const actor of actors) await processRuntime(actor.env);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    network.assertHealthy();
    for (const actor of actors) assertRuntimeIdle(actor.env, `HTLC recovery ${actor.id}`);
    console.log(`HTLC_ACK_RECOVERY_OK:route=3 sovereignRuntimes=3 preimage=retained wake=${wakeAt} realJDisputes=1`);
    return restored;
  } finally {
    for (const restore of restoreStrict) restore();
    await network.close();
  }
}
