import { expect, mock, test } from 'bun:test';

// Commands always target the current adapter; count what a stale session sends.
const sends: unknown[] = [];
const shown: string[] = [];
mock.module('./store', () => ({
  useApp: { getState: () => ({ toast: (text: string) => shown.push(text), setChainSync: () => {} }) },
}));
let releaseHydration: () => void = () => {};
mock.module('./commands', () => ({
  sendRuntimeInput: async (input: unknown) => {
    sends.push(input);
    return { ok: true };
  },
}));
mock.module('./adapter', () => ({
  getEmbeddedEnv: () => null,
  requireAdapter: () => ({ read: async () => [] }),
  connectEmbedded: async () => {},
  lockEmbeddedRuntime: async () => {},
}));
mock.module('./financial/roles', () => ({
  accountDisputeConfig: () => ({ leftResponseSeconds: 10, rightResponseSeconds: 10 }),
}));
mock.module('@xln/frontend/lib/utils/onboarding/onboardingPreferences', () => ({
  getOpenAccountRebalancePolicyData: () => null,
  hydrateJurisdictionPolicyDefaults: () => new Promise<void>(resolve => (releaseHydration = resolve)),
}));

const { openFirstHubAccount } = await import('./hosted');
const { isChainCatchupCancelled } = await import('./chain-catchup');


const hubId = `0x${'ab'.repeat(32)}`;
const entityId = `0x${'cd'.repeat(32)}`;
const stack = {
  apiBase: 'http://localhost',
  relayUrl: 'ws://localhost/relay',
  jurisdiction: { name: 'Testnet' },
  jurisdictions: [],
  hubs: [{ entityId: hubId, name: 'H1', online: true }],
} as unknown as Parameters<typeof openFirstHubAccount>[2];
const env = { state: { eReplicas: new Map() }, runtimeMempool: { runtimeTxs: [], entityInputs: [] } } as unknown as Parameters<
  typeof openFirstHubAccount
>[1];
const xlnWith = (connected: () => boolean) =>
  ({
    getP2P: () => ({ isConnected: connected }),
    ensureGossipProfiles: async () => {},
    getTokenInfo: () => ({ decimals: 6 }),
  }) as unknown as Parameters<typeof openFirstHubAccount>[0];

const settle = (promise: Promise<void>) => promise.then(() => null, (error: unknown) => error);

test('a session replaced during policy hydration sends nothing and shows no toast', async () => {
  sends.length = 0;
  shown.length = 0;
  let session = true;
  const run = settle(openFirstHubAccount(xlnWith(() => true), env, stack, entityId, `0x${'ef'.repeat(20)}`, () => session));
  await new Promise(resolve => setTimeout(resolve, 20));
  session = false;
  releaseHydration();
  expect(isChainCatchupCancelled(await run)).toBe(true);
  expect(sends).toEqual([]);
  expect(shown).toEqual([]);
});

test('a session replaced while waiting for the relay sends nothing and shows no relay toast', async () => {
  sends.length = 0;
  shown.length = 0;
  let session = true;
  const run = settle(openFirstHubAccount(xlnWith(() => false), env, stack, entityId, `0x${'ef'.repeat(20)}`, () => session));
  await new Promise(resolve => setTimeout(resolve, 150));
  session = false;
  expect(isChainCatchupCancelled(await run)).toBe(true);
  expect(sends).toEqual([]);
  expect(shown).toEqual([]);
});
