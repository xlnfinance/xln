import { describe, expect, test } from 'bun:test';
import { getHealthStatus } from '../../../api/server/health';
import { startJurisdictionWatchers } from '../../../runtime';
import { pauseJurisdictionWatchersAndWait } from '../../../runtime/loop/loop-watchers';
import { attachLiveJAdapter } from '../../../runtime/j-submit/live-jadapters';
import { bootScenario } from '../../../scenarios/harness/boot';
import { createBrowserVMAdapter } from '../../../jurisdiction/adapter/browservm/browservm';

const boot = (name: string) => bootScenario({ name, seed: name, signerIds: ['1'], storageEnabled: false, mode: 'browservm' });

describe('canonical J-watcher ownership', () => {
  test('health reports the committed J-watcher cursor instead of the provider head', async () => {
    const { env, jadapter, jurisdiction } = await boot('watcher-health-owner');
    try {
      const replica = env.state.jReplicas.get(jurisdiction.name);
      if (!replica) throw new Error('WATCHER_HEALTH_J_REPLICA_MISSING');
      const chainHead = await jadapter.getCurrentBlockNumber();
      expect(Number(replica.blockNumber)).not.toBe(chainHead);
      const health = await getHealthStatus(env);
      expect(health.jMachines).toHaveLength(1);
      expect(health.jMachines[0]?.lastBlock).toBe(Number(replica.blockNumber));
      expect(health.jMachines[0]?.watching).toBe(true);
      expect(health.jMachines[0]?.status).toBe('healthy');
    } finally { await jadapter.close(); }
  });

  test('one env starts only one watcher for aliases of the same real observation source', async () => {
    const { env, jadapter, jurisdiction } = await boot('watcher-duplicate-owner');
    const vm = jadapter.getBrowserVM();
    if (!vm) throw new Error('WATCHER_DUPLICATE_VM_MISSING');
    const duplicate = await createBrowserVMAdapter({ mode: 'browservm', chainId: jadapter.chainId },
      jadapter.provider, jadapter.signer, vm);
    try {
      const replica = env.state.jReplicas.get(jurisdiction.name);
      if (!replica) throw new Error('WATCHER_DUPLICATE_J_REPLICA_MISSING');
      env.state.jReplicas.set('duplicate', { ...replica, name: 'duplicate' });
      attachLiveJAdapter(env, 'duplicate', duplicate);
      await jadapter.stopWatchingAndWait();
      duplicate.startWatching(env);
      expect(jadapter.isWatching()).toBe(false);
      expect(duplicate.isWatching()).toBe(true);
      startJurisdictionWatchers(env);
      expect(jadapter.isWatching()).toBe(true);
      expect(duplicate.isWatching()).toBe(false);
      startJurisdictionWatchers(env);
      expect(duplicate.isWatching()).toBe(false);
    } finally { await duplicate.close(); await jadapter.close(); }
  });

  test('paused watcher cannot be resurrected by later Runtime work', async () => {
    const { env, jadapter } = await boot('watcher-paused-owner');
    try {
      expect(jadapter.isWatching()).toBe(true);
      await pauseJurisdictionWatchersAndWait(env);
      startJurisdictionWatchers(env);
      expect(env.infrastructure.jurisdictionWatchersPaused).toBe(true);
      expect(jadapter.isWatching()).toBe(false);
    } finally { await jadapter.close(); }
  });
});
