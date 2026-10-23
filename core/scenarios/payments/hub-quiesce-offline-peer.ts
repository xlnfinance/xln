/**
 * Hub shutdown quiesce with a signed Account frame owed to an offline peer.
 *
 * Active peer: a pendingFrame whose proposal reached the peer keeps both the
 * wallet-lock drain and the node drain open until the real ACK commits.
 * Offline peer: the same frame retained undelivered still blocks a wallet
 * lock, but the node quiesce completes; checkpoint plus ordered WAL rebuilds
 * the exact signed frame and the whole ordered outbox, and the peer commits it
 * exactly once on reconnect.
 */
import {
  closeRuntimeDb,
  closeInfraDb,
  loadEnvFromDB,
  processRuntime,
  waitForRuntimeWorkDrained,
} from '../../runtime';
import type { RuntimeReplica } from '../../runtime/types';
import { getLiveJAdapter } from '../../runtime/j-submit/live-jadapters';
import { safeStringify } from '../../protocol/serialization';
import { quiesceNodeRuntime } from '../../orchestrator/process/node-runtime-quiesce';
import { bootScenario } from '../harness/boot';
import { assert, readScenarioJurisdictionUnix } from '../harness/helpers';
import {
  createRecoveryNetwork,
  recoveryReplica,
  pumpRecoveryActors,
  openRecoveryAccount,
  type RecoveryActor,
} from './htlc-recovery-network';

const BLOCKED_DRAIN_MS = 600;

const payHubToAlice = async (hub: RecoveryActor, alice: RecoveryActor, description: string) => {
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
            description,
          },
        },
      ],
    },
  ]);
};

const frameKey = (frame: { height: number; stateHash: string; prevFrameHash: string }) =>
  `${frame.height}:${frame.stateHash}:${frame.prevFrameHash}`;

const firstDifference = (left: string, right: string): string => {
  let at = 0;
  while (at < left.length && left[at] === right[at]) at += 1;
  return `len ${left.length}->${right.length} at ${at}: ${left.slice(Math.max(0, at - 160), at + 240)} ||| ` +
    `${right.slice(Math.max(0, at - 160), at + 240)}`;
};

export async function hubQuiesceOfflinePeer(runtimeReplica: RuntimeReplica): Promise<RuntimeReplica> {
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'hub-quiesce-offline-peer',
    signerIds: ['1'],
    runtimeReplica,
    storageEnabled: true,
  });
  const jReplica = env.state.jReplicas.get(jurisdiction.name);
  if (!jReplica) throw new Error('HUB_QUIESCE_J_REPLICA_MISSING');
  jReplica.rpcs = [jurisdiction.address];
  env.state.timestamp = (await readScenarioJurisdictionUnix(jadapter)) * 1_000;
  const network = await createRecoveryNetwork(env, jadapter, jurisdiction);
  const { hub, alice, actors, route } = network;
  const aliceClient = network.clients[0];
  if (!aliceClient) throw new Error('HUB_QUIESCE_ALICE_SOCKET_MISSING');
  const hubAccount = () => recoveryReplica(hub).state.accounts.get(alice.id);
  const aliceAccount = () => recoveryReplica(alice).state.accounts.get(hub.id);
  const committedBoth = () => {
    const h = hubAccount();
    const a = aliceAccount();
    return !!h && !!a && !h.pendingFrame && !a.pendingFrame && (hub.env.pendingNetworkOutputs?.length ?? 0) === 0;
  };
  try {
    await openRecoveryAccount(hub, alice, actors);

    // 1. Active peer: the proposal reached Alice, whose Runtime has not run.
    // Neither drain may report quiet before her real ACK commits the frame.
    await payHubToAlice(hub, alice, 'active peer ACK in flight');
    await pumpRecoveryActors(
      [hub],
      () => !!hubAccount()?.pendingFrame && (hub.env.pendingNetworkOutputs?.length ?? 0) === 0,
      'active proposal delivered',
    );
    const activeHeight = hubAccount()?.pendingFrame?.height ?? -1;
    const walletActive = await waitForRuntimeWorkDrained(hub.env, BLOCKED_DRAIN_MS, 50);
    const nodeActive = await waitForRuntimeWorkDrained(hub.env, BLOCKED_DRAIN_MS, 50, {
      parkUndeliveredPeerFrames: true,
    });
    assert(!walletActive && !nodeActive, `active ACK blocks drains wallet=${walletActive} node=${nodeActive}`, hub.env);
    await pumpRecoveryActors(actors, committedBoth, 'active frame committed');
    assert(hubAccount()?.currentHeight === activeHeight, `active frame ${activeHeight} committed once`, hub.env);
    const nodeQuiet = await waitForRuntimeWorkDrained(hub.env, 5_000, 50, { parkUndeliveredPeerFrames: true });
    assert(nodeQuiet, 'node drain quiet after the real ACK', hub.env);

    // 2. Offline peer: the next signed frame is retained undelivered.
    aliceClient.setReady(false);
    await pumpRecoveryActors([], () => !route.canDeliver(alice.signer), 'Alice offline');
    const aliceHeightBefore = aliceAccount()?.currentHeight ?? -1;
    const offdeltaBefore = aliceAccount()?.state.deltas.get(1)?.offdelta;
    if (offdeltaBefore === undefined) throw new Error('HUB_QUIESCE_DELTA_MISSING');
    // The WAL stores the whole outbox as of each committed Runtime frame. Later
    // non-advancing ticks may still retire a committed local wake in RAM only
    // (frame/intake/finalize.ts skips the empty frame); recovery re-applies it.
    let committedOutbox = '';
    const recordCommit = async (tick: () => Promise<unknown> = () => processRuntime(hub.env)) => {
      const height = hub.env.state.height;
      await tick();
      if (hub.env.state.height !== height) committedOutbox = safeStringify(hub.env.pendingNetworkOutputs ?? []);
    };
    await recordCommit(() => payHubToAlice(hub, alice, 'retained while Alice is offline'));
    for (let i = 0; i < 4; i++) await recordCommit();
    if (!committedOutbox) throw new Error('HUB_QUIESCE_COMMITTED_OUTBOX_MISSING');
    const pendingBefore = hubAccount()?.pendingFrame;
    if (!pendingBefore) throw new Error('HUB_QUIESCE_PENDING_FRAME_MISSING');
    const pendingBytes = safeStringify(pendingBefore);
    const outboxBefore = safeStringify(hub.env.pendingNetworkOutputs ?? []);
    const heightBefore = hub.env.state.height;
    assert(
      (hub.env.pendingNetworkOutputs ?? []).some(output => output.runtimeId === alice.signer),
      'signed frame retained for offline Alice',
      hub.env,
    );

    // Wallet lock semantics are unchanged: it still refuses to report quiet.
    const walletOffline = await waitForRuntimeWorkDrained(hub.env, BLOCKED_DRAIN_MS, 50);
    assert(!walletOffline, 'wallet-lock drain still waits on the offline frame', hub.env);

    // 3. The production node shutdown quiesce (hub-node.ts SIGTERM path).
    const quiesce = await quiesceNodeRuntime(hub.env, { workTimeoutMs: 10_000, loopTimeoutMs: 10_000 });
    assert(quiesce.runtimeDrained && quiesce.runtimeIdle, `node quiesce ${safeStringify(quiesce)}`, hub.env);
    assert(safeStringify(hubAccount()?.pendingFrame) === pendingBytes, 'quiesce kept the signed frame', hub.env);
    const outboxAfterQuiesce = safeStringify(hub.env.pendingNetworkOutputs ?? []);
    assert(outboxAfterQuiesce === outboxBefore, `quiesce kept the outbox ${firstDifference(outboxBefore, outboxAfterQuiesce)}`, hub.env);
    assert(hub.env.state.height === heightBefore, `quiesce appended no frame ${heightBefore}->${hub.env.state.height}`, hub.env);

    // 4. Stop exactly like the node, then reopen from checkpoint + ordered WAL.
    await hub.adapter.close();
    await closeRuntimeDb(hub.env);
    await closeInfraDb(hub.env);
    const restored = await loadEnvFromDB(hub.signer, hub.seed);
    if (!restored) throw new Error('HUB_QUIESCE_WAL_REOPEN_FAILED');
    hub.env = restored;
    restored.scenarioMode = true;
    restored.quietRuntimeLogs = true;
    const adapter = getLiveJAdapter(restored, jurisdiction.name);
    if (!adapter?.pollNow) throw new Error('HUB_QUIESCE_RESTORED_WATCHER_MISSING');
    hub.adapter = adapter;
    network.bindHub();
    await network.shareProfiles();
    adapter.startWatching(restored);

    assert(restored.state.height === heightBefore, `WAL height ${heightBefore}->${restored.state.height}`, restored);
    assert(safeStringify(hubAccount()?.pendingFrame) === pendingBytes, 'WAL rebuilt the exact signed frame', restored);
    const outboxRestored = safeStringify(restored.pendingNetworkOutputs ?? []);
    assert(
      outboxRestored === committedOutbox,
      `WAL rebuilt the whole committed outbox ${firstDifference(committedOutbox, outboxRestored)}`,
      restored,
    );
    // Live applied the committed local wake on its next writer tick. The
    // restored Runtime does the same on its first tick (processRuntime flushes
    // the committed outbox), reaching the exact live pre-shutdown outbox
    // without appending a Runtime frame.
    await processRuntime(restored);
    const restoredQuiet = await waitForRuntimeWorkDrained(restored, 5_000, 50, { parkUndeliveredPeerFrames: true });
    assert(restoredQuiet, 'restored Runtime quiet after its first tick', restored);
    const outboxDrained = safeStringify(restored.pendingNetworkOutputs ?? []);
    assert(
      outboxDrained === outboxBefore,
      `restored drain reached the whole live outbox ${firstDifference(outboxBefore, outboxDrained)}`,
      restored,
    );
    assert(restored.state.height === heightBefore, `restored drain appended no frame ${restored.state.height}`, restored);
    assert(safeStringify(hubAccount()?.pendingFrame) === pendingBytes, 'restored drain kept the signed frame', restored);
    assert(aliceAccount()?.currentHeight === aliceHeightBefore, 'offline Alice has not committed', alice.env);

    // 5. Reconnect: the original frame commits exactly once on both sides.
    aliceClient.setReady(true);
    await pumpRecoveryActors([], () => route.canDeliver(alice.signer), 'Alice rejoined');
    await pumpRecoveryActors(actors, committedBoth, 'retained frame committed after reconnect');
    const hubCommitted = hubAccount();
    assert(
      !!hubCommitted?.currentFrame && frameKey(hubCommitted.currentFrame) === frameKey(pendingBefore),
      'Hub committed the original signed frame',
      restored,
    );
    assert(
      hubCommitted?.currentHeight === pendingBefore.height && aliceAccount()?.currentHeight === pendingBefore.height,
      'exactly one Account frame committed on both sides',
      restored,
    );
    const moved = (aliceAccount()?.state.deltas.get(1)?.offdelta ?? 0n) - offdeltaBefore;
    assert(hubCommitted?.state.deltas.get(1)?.offdelta === aliceAccount()?.state.deltas.get(1)?.offdelta, 'deltas agree', restored);
    assert(moved === 1n || moved === -1n, `exactly one unit moved: ${moved}`, restored);
    network.assertHealthy();
    console.log(
      `HUB_QUIESCE_OFFLINE_PEER_OK:activeHeight=${activeHeight} pendingHeight=${pendingBefore.height} ` +
        `runtimeHeight=${heightBefore} committedOutbox=${committedOutbox.length}B liveOutbox=${outboxBefore.length}B ` +
        `moved=${moved}`,
    );
    return restored;
  } finally {
    await network.close();
  }
}
