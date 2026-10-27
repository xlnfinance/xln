import { expect, test } from 'bun:test';
import {
  getJWatcherDrainProgressKey,
  getJWatcherDrainStatus,
  isJWatcherDrainComplete,
  observeJWatcherDrainProgress,
  setRuntimeDeliveryReady,
} from '@xln/core/api/public/runtime-public';
import { createEmptyEnv, startRuntimeLoop, stopRuntimeLoopAndWait } from '@xln/core/runtime';
import { getRuntimeCommandReadiness } from '@xln/core/runtime/replica/lifecycle';
import {
  chainSyncText,
  createChainCatchupProbe,
  isChainCatchupCancelled,
  openAfterChainCatchup,
  type ChainSyncView,
} from './chain-catchup';

type DrainStatus = ReturnType<typeof getJWatcherDrainStatus>;
type Target = Parameters<typeof getJWatcherDrainStatus>[1];

test('a stalled chain catch-up is shown and keeps the fence closed until progress drains it', async () => {
  const env = createEmptyEnv(`chain-catchup-${process.pid}-${Date.now()}`);
  env.quietRuntimeLogs = true;
  setRuntimeDeliveryReady(env, false);
  startRuntimeLoop(env);
  const payment = { runtimeTxs: [], entityInputs: [{ entityId: `0x${'ab'.repeat(32)}`, signerId: `0x${'cd'.repeat(20)}`, entityTxs: [] }] };
  let through = 3;
  let nowMs = 0;
  const status = (): DrainStatus => ({
    chainId: 31337,
    depositoryAddress: `0x${'de'.repeat(20)}`,
    targetBlock: 10,
    committedCursor: through,
    authenticatedThrough: through,
    replicas: [],
  });
  const xln = {
    // A stalled-but-not-throwing RPC: the watcher simply stops advancing.
    getJWatcherDrainStatus: () => status(),
    isJWatcherDrainComplete,
    observeJWatcherDrainProgress,
    getJWatcherDrainProgressKey,
    setRuntimeDeliveryReady,
  };
  const views: Array<ChainSyncView | null> = [];
  const probe = createChainCatchupProbe(xln, env, [{ adapter: {}, targetBlock: 10 } as Target], () => 'Testnet', view => views.push(view), () => true, () => nowMs);
  const fenced = () => {
    expect(env.infrastructure?.entityInputsReady).toBe(false);
    expect(getRuntimeCommandReadiness(env, payment)).toEqual({ ready: false, reason: 'j-catchup' });
  };
  try {
    await openAfterChainCatchup(xln, env, probe, () => true, async poll => {
      expect(poll()).toBe(false);
      expect(views.at(-1)).toEqual({ state: 'syncing', jurisdiction: 'Testnet', through: 3, target: 10 });
      // No progress for the shared drain deadline: the stall is shown, the fence stays closed.
      nowMs = 60_000;
      expect(poll()).toBe(false);
      expect(views.at(-1)).toEqual({ state: 'stalled', jurisdiction: 'Testnet', through: 3, target: 10 });
      expect(chainSyncText({ state: 'stalled', jurisdiction: 'Testnet', through: 3, target: 10 })).toContain('not progressing');
      nowMs = 90_000;
      expect(poll()).toBe(false);
      fenced();
      // Progress resumes: the deadline resets and the view returns to syncing.
      through = 7;
      expect(poll()).toBe(false);
      expect(views.at(-1)).toEqual({ state: 'syncing', jurisdiction: 'Testnet', through: 7, target: 10 });
      fenced();
      through = 10;
      expect(poll()).toBe(true);
      expect(views.at(-1)).toBeNull();
      fenced();
    });
    expect(env.infrastructure?.entityInputsReady).toBe(true);
    expect(getRuntimeCommandReadiness(env, payment).ready).toBe(true);
  } finally {
    await stopRuntimeLoopAndWait(env);
  }
});

const stalledSetup = () => {
  const env = createEmptyEnv(`chain-catchup-lock-${process.pid}-${Date.now()}-${Math.random()}`);
  env.quietRuntimeLogs = true;
  setRuntimeDeliveryReady(env, false);
  const xln = {
    getJWatcherDrainStatus: (): DrainStatus => ({
      chainId: 31337,
      depositoryAddress: `0x${'de'.repeat(20)}`,
      targetBlock: 10,
      committedCursor: 3,
      authenticatedThrough: 3,
      replicas: [],
    }),
    isJWatcherDrainComplete,
    observeJWatcherDrainProgress,
    getJWatcherDrainProgressKey,
    setRuntimeDeliveryReady,
  };
  return { env, xln, target: { adapter: {}, targetBlock: 10 } as Target };
};

test('a lock during a stalled catch-up ends the wait silently and keeps the fence closed', async () => {
  const { env, xln, target } = stalledSetup();
  let session = true;
  let nowMs = 0;
  const views: Array<ChainSyncView | null> = [];
  const owns = () => session;
  const probe = createChainCatchupProbe(xln, env, [target], () => 'Testnet', view => views.push(view), owns, () => nowMs);
  let polls = 0;
  const result = openAfterChainCatchup(xln, env, probe, owns, async poll => {
    for (;;) {
      polls += 1;
      if (poll()) return;
      nowMs += 30_000;
      if (polls === 3) session = false;
    }
  });
  const error = await result.then(() => null, (caught: unknown) => caught);
  expect(isChainCatchupCancelled(error)).toBe(true);
  expect(polls).toBe(4);
  expect(views.at(-1)?.state).toBe('stalled');
  expect(views).toHaveLength(2);
  expect(env.infrastructure?.entityInputsReady).toBe(false);
});

test('a replaced session cannot publish into the new session view or open its fence', async () => {
  const { env, xln, target } = stalledSetup();
  let owner = 'old';
  const views: Array<{ owner: string; view: ChainSyncView | null }> = [];
  const probeFor = (name: string) =>
    createChainCatchupProbe(xln, env, [target], () => 'Testnet', view => views.push({ owner: name, view }), () => owner === name);
  const oldProbe = probeFor('old');
  expect(oldProbe()).toBe(false);
  owner = 'new';
  const newProbe = probeFor('new');
  expect(newProbe()).toBe(false);
  expect(() => oldProbe()).toThrow('WALLET_LOCKED');
  expect(views.map(entry => entry.owner)).toEqual(['old', 'new']);
  const opened = await openAfterChainCatchup(xln, env, () => true, () => owner === 'old', async () => {}).then(
    () => true,
    (caught: unknown) => !isChainCatchupCancelled(caught),
  );
  expect(opened).toBe(false);
  expect(env.infrastructure?.entityInputsReady).toBe(false);
});
