import { afterEach, expect, test } from 'bun:test';

import { deriveSignerAddressSync } from '../../../account/crypto';
import type { EntityReplica, EntityState } from '../../../entity/types';
import { createJAdapter, type JAdapter } from '../../../jurisdiction/adapter';
import { startRuntimeAdapterRpc } from '../../helpers/runtime-jadapter';
import { createEmptyEnv } from '../../../runtime';
import { attachLiveJAdapter } from '../../../runtime/j-submit/live-jadapters';
import { registerCommittedSingleSignerWallets } from '../../../runtime/recovery/restore-adapters';
import type { JReplica } from '../../../types/jurisdiction-runtime';

const entityId = `0x${'11'.repeat(32)}`;
const depositoryAddress = `0x${'dd'.repeat(20)}`;
const entityProviderAddress = `0x${'ee'.repeat(20)}`;

const createWalletBindingFixture = (adapter: JAdapter) => {
  const mode = adapter.mode;
  const seed = `wallet-binding:${mode}`;
  const env = createEmptyEnv(seed);
  const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const jurisdictionName = 'WalletBinding';
  const jurisdiction: JReplica = {
    name: jurisdictionName,
    chainId: 31337,
    rpcs: [],
    contracts: { depository: depositoryAddress, entityProvider: entityProviderAddress },
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
  };
  env.state.jReplicas.set(jurisdictionName, jurisdiction);
  env.state.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    entityEncPubKey: '',
    mempool: [],
    isProposer: true,
    state: {
      entityId,
      height: 0,
      timestamp: 0,
      nonces: new Map(),
      proposals: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [signerId],
        shares: { [signerId]: 1n },
        jurisdiction: {
          name: jurisdictionName,
          chainId: 31337,
          depositoryAddress,
          entityProviderAddress,
        },
      },
      reserves: new Map(),
      accounts: new Map(),
      lastFinalizedJHeight: 0,
      profile: { name: 'Wallet binding', isHub: false, avatar: '', bio: '', website: '' },
      paybook: { entries: new Map(), feesEarned: 0n },
      swapTradingPairs: [],
      crontabState: { entries: [] },
    } as EntityState,
  } satisfies EntityReplica);
  const boundKeys: string[] = [];
  const registerWallet = adapter.registerEntityWallet?.bind(adapter);
  if (registerWallet) {
    adapter.registerEntityWallet = (boundEntityId, privateKey) => {
      boundKeys.push(privateKey);
      registerWallet(boundEntityId, privateKey);
    };
  }
  attachLiveJAdapter(env, jurisdictionName, adapter);
  return { env, boundKeys, signerId };
};

const adapters: JAdapter[] = [];
afterEach(async () => {
  while (adapters.length > 0) await adapters.pop()!.close();
});

test('only BrowserVM adapters receive committed entity private keys', async () => {
  const rpc = await startRuntimeAdapterRpc();
  try {
    for (const mode of ['rpc', 'anvil', 'tron', 'browservm'] as const) {
      const adapter = await createJAdapter({ mode, chainId: 31337, rpcUrl: rpc.rpcUrl });
      adapters.push(adapter);
      const { env, boundKeys } = createWalletBindingFixture(adapter);
      expect(() => registerCommittedSingleSignerWallets(env)).not.toThrow();
      if (mode === 'browservm') {
        expect(boundKeys).toHaveLength(1);
        expect(boundKeys[0]).toMatch(/^0x[0-9a-f]{64}$/);
      } else {
        expect(boundKeys, mode).toEqual([]);
      }
    }
  } finally {
    while (adapters.length > 0) await adapters.pop()!.close();
    await rpc.close();
  }
});

test('retired board replicas remain recoverable without receiving the current wallet', async () => {
  const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
  adapters.push(adapter);
  const { env, boundKeys, signerId } = createWalletBindingFixture(adapter);
  const current = env.state.eReplicas.get(`${entityId}:${signerId}`);
  if (!current) throw new Error('WALLET_BINDING_CURRENT_REPLICA_MISSING');
  const retiredSignerId = `0x${'aa'.repeat(20)}`;
  env.state.eReplicas.set(`${entityId}:${retiredSignerId}`, {
    ...current,
    signerId: retiredSignerId,
    isProposer: false,
  });

  expect(() => registerCommittedSingleSignerWallets(env)).not.toThrow();
  expect(boundKeys).toHaveLength(1);
});
