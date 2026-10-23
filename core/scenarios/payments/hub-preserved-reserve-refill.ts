/**
 * Preserved Hub restart with a signed Account frame retained for an offline
 * peer. The Hub-owned dev-chain reserve refill must run without discarding,
 * acknowledging or duplicating that frame; the peer commits it on reconnect.
 */
import { closeRuntimeDb, closeInfraDb, loadEnvFromDB, processRuntime } from '../../runtime';
import type { RuntimeReplica } from '../../runtime/types';
import { getLiveJAdapter } from '../../runtime/j-submit/live-jadapters';
import { safeStringify } from '../../protocol/serialization';
import { bootScenario } from '../harness/boot';
import { assert, readScenarioJurisdictionUnix } from '../harness/helpers';
import { hasLocalRuntimeWork, hasPendingRuntimeWork } from '../../orchestrator/mesh/mesh-common';
import { ensureHubBootstrapReserves } from '../../orchestrator/hub/node/hub-reserves';
import {
  createRecoveryNetwork,
  recoveryReplica,
  pumpRecoveryActors,
  openRecoveryAccount,
} from './htlc-recovery-network';

const NEGATIVE_ROUNDS = 20;

export async function hubPreservedReserveRefill(runtimeReplica: RuntimeReplica): Promise<RuntimeReplica> {
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'hub-preserved-reserve-refill',
    signerIds: ['1'],
    runtimeReplica,
    storageEnabled: true,
  });
  const jReplica = env.state.jReplicas.get(jurisdiction.name);
  if (!jReplica) throw new Error('HUB_RESERVE_REFILL_J_REPLICA_MISSING');
  jReplica.rpcs = [jurisdiction.address];
  env.state.timestamp = (await readScenarioJurisdictionUnix(jadapter)) * 1_000;
  const network = await createRecoveryNetwork(env, jadapter, jurisdiction);
  const { hub, alice, bob, actors, route } = network;
  const aliceClient = network.clients[0];
  if (!aliceClient) throw new Error('HUB_RESERVE_REFILL_ALICE_SOCKET_MISSING');
  try {
    await openRecoveryAccount(hub, alice, actors);

    // Alice leaves through authenticated transport readiness, then the Hub
    // signs one direct payment to her. The committed output stays retained.
    aliceClient.setReady(false);
    await pumpRecoveryActors([], () => !route.canDeliver(alice.signer), 'Alice offline');
    const aliceBefore = recoveryReplica(alice).state.accounts.get(hub.id);
    if (!aliceBefore) throw new Error('HUB_RESERVE_REFILL_ALICE_ACCOUNT_MISSING');
    const aliceHeightBefore = aliceBefore.currentHeight;
    const offdeltaBefore = aliceBefore.state.deltas.get(1)?.offdelta;
    if (offdeltaBefore === undefined) throw new Error('HUB_RESERVE_REFILL_DELTA_MISSING');
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
              description: 'retained while Alice is offline',
            },
          },
        ],
      },
    ]);
    for (let i = 0; i < 4; i++) await processRuntime(hub.env);
    const pendingBefore = recoveryReplica(hub).state.accounts.get(alice.id)?.pendingFrame;
    if (!pendingBefore) throw new Error('HUB_RESERVE_REFILL_PENDING_FRAME_MISSING');
    // Recovery may re-originate other committed outputs; the invariant is the
    // exact ordered outbox owed to the offline peer.
    const aliceOutbox = () =>
      safeStringify((hub.env.pendingNetworkOutputs ?? []).filter(o => o.runtimeId === alice.signer));
    const otherOutbox = () =>
      (hub.env.pendingNetworkOutputs ?? [])
        .filter(o => o.runtimeId !== alice.signer)
        .map(
          o =>
            `${o.runtimeId === bob.signer ? 'bob' : o.runtimeId === hub.signer ? 'hub' : o.runtimeId}:${o.entityTxs?.length ?? 0}`,
        );
    const outboxBefore = aliceOutbox();
    const extrasSeen = new Set<string>(otherOutbox().map(e => `before:${e}`));
    assert(
      (hub.env.pendingNetworkOutputs ?? []).some(output => output.runtimeId === alice.signer),
      'signed frame retained for offline Alice',
      hub.env,
    );
    const hubHeightBefore = recoveryReplica(hub).state.accounts.get(alice.id)?.currentHeight ?? -1;

    // Preserved start: reopen the Hub from checkpoint + ordered Runtime WAL.
    await hub.adapter.close();
    await closeRuntimeDb(hub.env);
    await closeInfraDb(hub.env);
    const restored = await loadEnvFromDB(hub.signer, hub.seed);
    if (!restored) throw new Error('HUB_RESERVE_REFILL_WAL_REOPEN_FAILED');
    hub.env = restored;
    restored.scenarioMode = true;
    restored.quietRuntimeLogs = true;
    const adapter = getLiveJAdapter(restored, jurisdiction.name);
    if (!adapter?.pollNow) throw new Error('HUB_RESERVE_REFILL_RESTORED_WATCHER_MISSING');
    hub.adapter = adapter;
    network.bindHub();
    await network.shareProfiles();
    adapter.startWatching(restored);

    const frameKey = (frame: { height: number; stateHash: string; prevFrameHash: string }) =>
      `${frame.height}:${frame.stateHash}:${frame.prevFrameHash}`;
    const assertRetained = (label: string) => {
      const account = recoveryReplica(hub).state.accounts.get(alice.id);
      assert(
        !!account?.pendingFrame && frameKey(account.pendingFrame) === frameKey(pendingBefore),
        `${label}: pending frame height/hash unchanged`,
        hub.env,
      );
      assert(account?.currentHeight === hubHeightBefore, `${label}: Hub Account height unchanged`, hub.env);
      const outbox = aliceOutbox();
      for (const extra of otherOutbox()) extrasSeen.add(`${label}:${extra}`);
      let at = 0;
      while (at < outbox.length && outbox[at] === outboxBefore[at]) at += 1;
      assert(
        outbox === outboxBefore,
        `${label}: ordered committed outbox unchanged; len ${outboxBefore.length}->${outbox.length} at ${at}: ` +
          `${outboxBefore.slice(Math.max(0, at - 120), at + 200)} ||| ${outbox.slice(Math.max(0, at - 120), at + 200)}`,
        hub.env,
      );
    };
    assertRetained('WAL reopen');

    // Bounded negative: the old mesh gate (any pending Runtime work) stays
    // closed for as long as Alice is offline; the local-work gate opens.
    let oldGateClosed = 0;
    for (let i = 0; i < NEGATIVE_ROUNDS; i++) {
      await processRuntime(restored);
      if (hasPendingRuntimeWork(restored)) oldGateClosed += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(oldGateClosed === NEGATIVE_ROUNDS, `old gate closed ${oldGateClosed}/${NEGATIVE_ROUNDS}`, restored);
    assert(!hasLocalRuntimeWork(restored), 'local-work gate admits the mesh bootstrap', restored);
    assertRetained('after redelivery attempts');

    // The Hub-owned dev-chain refill, exactly as the mesh loop calls it. A
    // concurrent writer pump stands in for the Hub Runtime loop.
    let pumping = true;
    const pump = (async () => {
      while (pumping) {
        await processRuntime(restored);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    })();
    const steps: string[] = [];
    let health: Awaited<ReturnType<typeof ensureHubBootstrapReserves>>;
    try {
      health = await ensureHubBootstrapReserves(
        {
          hubName: 'H1',
          deployTokens: true,
          tokenCatalogsByEntityId: new Map(),
          startTiming: () => Date.now(),
          finishTiming: () => {},
        },
        restored,
        [{ entityId: hub.id, signerId: hub.signer, name: 'H1', jurisdictionName: jurisdiction.name, primary: true }],
        step => steps.push(step),
      );
    } finally {
      pumping = false;
      await pump;
    }
    assert(steps.includes('H1:fund-batch:done'), `refill funded on chain: ${steps.join(',')}`, restored);
    assert(health.ok === true && health.targetMet === true, `reserve target met: ${safeStringify(health)}`, restored);
    for (const token of health.tokens) {
      assert(token.current === token.expectedMin, `token ${token.tokenId} exact target ${token.current}`, restored);
      const chain = await adapter.getReserves(hub.id, token.tokenId);
      assert(
        chain.toString() === token.current,
        `token ${token.tokenId} chain=${chain} local=${token.current}`,
        restored,
      );
    }
    assertRetained('after reserve refill');
    assert(
      recoveryReplica(alice).state.accounts.get(hub.id)?.currentHeight === aliceHeightBefore,
      'offline Alice has not committed',
      alice.env,
    );

    // Reconnect: the retained frame is delivered and committed exactly once.
    aliceClient.setReady(true);
    await pumpRecoveryActors([], () => route.canDeliver(alice.signer), 'Alice rejoined');
    await pumpRecoveryActors(
      actors,
      () => {
        const h = recoveryReplica(hub).state.accounts.get(alice.id);
        const a = recoveryReplica(alice).state.accounts.get(hub.id);
        return !!h && !!a && !h.pendingFrame && !a.pendingFrame && (hub.env.pendingNetworkOutputs?.length ?? 0) === 0;
      },
      'retained frame committed after reconnect',
    );
    const hubAccount = recoveryReplica(hub).state.accounts.get(alice.id);
    const aliceAccount = recoveryReplica(alice).state.accounts.get(hub.id);
    assert(
      !!hubAccount?.currentFrame && frameKey(hubAccount.currentFrame) === frameKey(pendingBefore),
      'Hub committed the original signed frame',
      hub.env,
    );
    assert(
      hubAccount?.currentHeight === pendingBefore.height && aliceAccount?.currentHeight === pendingBefore.height,
      'exactly one Account frame committed on both sides',
      hub.env,
    );
    const hubOffdelta = hubAccount?.state.deltas.get(1)?.offdelta;
    const aliceOffdelta = aliceAccount?.state.deltas.get(1)?.offdelta;
    assert(hubOffdelta === aliceOffdelta, 'both sides agree on the delta', hub.env);
    const moved = (aliceOffdelta ?? 0n) - offdeltaBefore;
    assert(moved === 1n || moved === -1n, `exactly one unit moved: ${moved}`, hub.env);
    network.assertHealthy();
    console.log(
      `HUB_PRESERVED_RESERVE_REFILL_OK:oldGateClosed=${oldGateClosed}/${NEGATIVE_ROUNDS} ` +
        `pendingHeight=${pendingBefore.height} aliceOutbox=${outboxBefore.length}B extras=[${[...extrasSeen].join(';')}] tokens=${health.tokens.map(t => `${t.tokenId}=${t.current}`).join(',')} ` +
        `moved=${moved}`,
    );
    return restored;
  } finally {
    await network.close();
  }
}
