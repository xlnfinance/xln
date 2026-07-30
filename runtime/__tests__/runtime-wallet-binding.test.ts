import { expect, test } from 'bun:test';

import { deriveSignerAddressSync } from '../account/crypto';
import type { EntityReplica, EntityState } from '../entity/types';
import type { JAdapter } from '../jadapter/types';
import { createEmptyEnv } from '../runtime';
import { attachLiveJAdapter } from '../runtime/live-jadapters';
import { registerCommittedSingleSignerWallets } from '../runtime/recovery-infra';
import type { JReplica } from '../types/jurisdiction-runtime';

const entityId = `0x${'11'.repeat(32)}`;
const depositoryAddress = `0x${'dd'.repeat(20)}`;
const entityProviderAddress = `0x${'ee'.repeat(20)}`;

const createWalletBindingFixture = (mode: JAdapter['mode']) => {
  const seed = `wallet-binding:${mode}`;
  const env = createEmptyEnv(seed);
  const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const jurisdictionName = 'WalletBinding';
  const jurisdiction: JReplica = {
    name: jurisdictionName,
    chainId: 31337,
    rpcs: [],
    depositoryAddress,
    entityProviderAddress,
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
      jBlockChain: [],
      profile: { name: 'Wallet binding', isHub: false, avatar: '', bio: '', website: '' },
      htlcRoutes: new Map(),
      htlcFeesEarned: 0n,
      lockBook: new Map(),
      swapTradingPairs: [],
      crontabState: { entries: [] },
    } as EntityState,
  } satisfies EntityReplica);
  const boundKeys: string[] = [];
  const adapter = {
    mode,
    registerEntityWallet: (_boundEntityId: string, privateKey: string) => {
      boundKeys.push(privateKey);
    },
  } as JAdapter;
  attachLiveJAdapter(env, jurisdictionName, adapter);
  return { env, boundKeys };
};

test('only BrowserVM adapters receive committed entity private keys', () => {
  for (const mode of ['rpc', 'anvil', 'tron'] as const) {
    const { env, boundKeys } = createWalletBindingFixture(mode);
    expect(() => registerCommittedSingleSignerWallets(env)).not.toThrow();
    expect(boundKeys, mode).toEqual([]);
  }

  const { env, boundKeys } = createWalletBindingFixture('browservm');
  registerCommittedSingleSignerWallets(env);
  expect(boundKeys).toHaveLength(1);
  expect(boundKeys[0]).toMatch(/^0x[0-9a-f]{64}$/);
});
