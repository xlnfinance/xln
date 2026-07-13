import { describe, expect, test } from 'bun:test';

import { createJAdapter } from '../jadapter';
import { createEmptyEnv } from '../runtime';
import type { EntityReplica } from '../types';

const makeReplica = (entityId: string, signerId: string): EntityReplica =>
  ({
    entityId,
    signerId,
    mempool: [],
    isProposer: true,
    state: {
      entityId,
      height: 0,
      timestamp: 1,
      nonces: new Map(),
      messages: [],
      proposals: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [signerId],
        shares: { [signerId]: 1n },
      },
      reserves: new Map(),
      accounts: new Map(),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: 0,
      jBlockObservations: [],
      jBlockChain: [],
      entityEncPubKey: `${'0x'}${'11'.repeat(32)}`,
      entityEncPrivKey: `${'0x'}${'22'.repeat(32)}`,
      profile: {
        name: 'BrowserVM Entity',
        isHub: false,
        avatar: '',
        bio: '',
        website: '',
      },
      htlcRoutes: new Map(),
      htlcFeesEarned: 0n,
      htlcNotes: new Map(),
      lockBook: new Map(),
      swapTradingPairs: [],
      pendingSwapFillRatios: new Map(),
    },
  }) as EntityReplica;

describe('BrowserVM JAdapter boundary', () => {
  test('deploys, supports typed contracts, snapshots, and feeds watcher events', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
    try {
      await adapter.deployStack();
      expect(adapter.mode).toBe('browservm');
      expect(adapter.getBrowserVM()).not.toBeNull();
      expect(adapter.addresses.depository).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(adapter.addresses.entityProvider).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(await adapter.depository.getTokensLength()).toBeGreaterThan(1n);

      const beforeSnapshot = await adapter.entityProvider.nextNumber();
      const snapshot = await adapter.snapshot();
      await (await adapter.entityProvider.registerNumberedEntity(`${'0x'}${'33'.repeat(32)}`)).wait();
      expect(await adapter.entityProvider.nextNumber()).toBe(beforeSnapshot + 1n);
      await adapter.revert(snapshot);
      expect(await adapter.entityProvider.nextNumber()).toBe(beforeSnapshot);

      const env = createEmptyEnv('browservm-adapter-boundary');
      env.scenarioMode = true;
      env.timestamp = 1;
      const entityId = `${'0x'}${'44'.repeat(32)}`;
      const signerId = '1';
      env.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, signerId));

      adapter.startWatching(env);
      const events = await adapter.debugFundReserves(entityId, 1, 123n);
      expect(events.some((event) => event.name === 'ReserveUpdated')).toBe(true);

      const queued = env.runtimeMempool?.entityInputs ?? [];
      expect(queued).toHaveLength(1);
      expect(queued[0]?.entityId).toBe(entityId);
      expect(queued[0]?.entityTxs[0]?.type).toBe('j_event');
      expect(queued[0]?.entityTxs[0]?.data.event.type).toBe('ReserveUpdated');
      expect(queued[0]?.entityTxs[1]?.type).toBe('j_history_checkpoint');
    } finally {
      await adapter.close();
    }
  });
});
