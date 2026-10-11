import { strict as assert } from 'node:assert';
import * as runtime from '../../core/runtime';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../core/account/crypto';
import { EmbeddedRuntimeAdapter } from '../../core/api/runtime-adapter/embedded';
import { loadJurisdictionsAsync } from '../../core/jurisdiction/adapter/kernel/jurisdiction-loader';
import { getLiveJAdapter } from '../../core/runtime/j-submit/live-jadapters';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../../core/swapbook/types';
import { deriveDelta } from '../../core/account/utils';
import { computeAccountStateRoot } from '../../core/account/commitment/state-root';
import { safeStringify } from '../../core/protocol/serialization';
import type { RuntimeReplica } from '../../core/runtime/types';
import { createHubDirectRuntimeRoute } from '../../core/orchestrator/hub/hub-runtime-transport';
import { startStandaloneRelayServer } from '../../core/network/relay/standalone-server';

export const hubSeed = 'xln-native-cross-release-20260918-public-observer';
export const userSeed = 'xln-native-cross-release-20260918-public-users';
export const credit = 100_000_000n;
export const amount = 10_000_000n;
export const party = (seed: string, name: string, network: string) => {
  const signerId = deriveSignerAddressSync(seed, name).toLowerCase();
  registerSignerKey(seed, signerId, deriveSignerKeySync(seed, name));
  return { name, network, signerId, entityId: runtime.generateLazyEntityId([signerId], 1n) };
};
export type Party = ReturnType<typeof party>;
export const hubs = [party(hubSeed, 'Ethereum hub', 'Private Ethereum'), party(hubSeed, 'Tron hub', 'Native TVM')] as const;
export const users = [party(userSeed, 'Alice Ethereum', 'Private Ethereum'), party(userSeed, 'Alice Tron', 'Native TVM'),
  party(userSeed, 'Bob Ethereum', 'Private Ethereum'), party(userSeed, 'Bob Tron', 'Native TVM')] as const;
export const replica = (env: RuntimeReplica, owner: Party) => {
  const value = env.state.eReplicas.get(`${owner.entityId}:${owner.signerId}`);
  assert(value, `Missing replica ${owner.name}`);
  return value;
};
export const walletFor = (env: RuntimeReplica) => new EmbeddedRuntimeAdapter({ getEnv: () => env,
  enqueueRuntimeInput: runtime.enqueueRuntimeInput, validateRuntimeInputAdmission: runtime.validateRuntimeInputAdmission,
  registerRuntimePublishedCallback: runtime.registerRuntimePublishedCallback,
  submitCrossJurisdictionIntent: async (target, route) => {
    await runtime.submitCrossJurisdictionIntent(target, route);
    return { delivered: true };
  },
});
export const startCrossTransport = (hubEnv: RuntimeReplica, userEnv: RuntimeReplica) => {
  assert(hubEnv.runtimeId && userEnv.runtimeId);
  const relay = startStandaloneRelayServer({ host: '127.0.0.1', port: 18987,
    serverId: 'native-cross', serverRuntimeId: hubEnv.runtimeId });
  const route = createHubDirectRuntimeRoute(hubEnv, hubSeed, () => true, { lastSeen: null, lastError: null });
  const direct = Bun.serve<{ type: 'direct-runtime' }>({ hostname: '127.0.0.1', port: 18988,
    fetch(request, server) {
      const upgraded = route.maybeUpgrade(request, server);
      return upgraded.handled ? upgraded.response : new Response('Not found', { status: 404 });
    }, websocket: route.websocket,
  });
  assert(runtime.startP2P(hubEnv, { relayUrls: ['ws://127.0.0.1:18987'], wsUrl: 'ws://127.0.0.1:18988/ws',
    advertiseEntityIds: hubs.map(hub => hub.entityId), gossipPollMs: 250 }));
  assert(runtime.startP2P(userEnv, { relayUrls: ['ws://127.0.0.1:18987'], seedRuntimeIds: [hubEnv.runtimeId],
    advertiseEntityIds: users.map(user => user.entityId), gossipPollMs: 250 }));
  return { close: () => { direct.stop(true); relay.close(); } };
};
export const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) { console.log('CROSS_SWAP_STAGE', label); return; }
    await Bun.sleep(50);
  }
  throw new Error(`CROSS_SWAP_TIMEOUT:${label}`);
};
export const connectChains = async (env: RuntimeReplica) => {
  const entries = Object.values((await loadJurisdictionsAsync()).jurisdictions);
  for (const entry of entries) {
    assert(entry.entityProviderDeploymentBlock !== undefined, `Missing deployment receipt: ${entry.name}`);
    if (!env.state.jReplicas.has(entry.name)) runtime.enqueueRuntimeInput(env, { runtimeTxs: [{ type: 'importJ', data: {
      name: entry.name, chainId: entry.chainId, ticker: entry.currency, rpcs: [entry.rpc], blockTimeMs: entry.blockTimeMs,
      entityProviderDeploymentBlock: entry.entityProviderDeploymentBlock, contracts: entry.contracts,
    } }], entityInputs: [] });
  }
  await waitFor('jurisdictions imported', () => entries.every(entry => Boolean(getLiveJAdapter(env, entry.name))));
  for (const entry of entries) assert.equal(getLiveJAdapter(env, entry.name)?.mode, entry.mode);
  runtime.startJurisdictionWatchers(env);
};
export const createParties = async (env: RuntimeReplica, owners: readonly Party[], seed: string, wallet: EmbeddedRuntimeAdapter) => {
  for (const owner of owners) {
    if (env.state.eReplicas.has(`${owner.entityId}:${owner.signerId}`)) continue;
    const network = env.state.jReplicas.get(owner.network);
    assert(network?.contracts?.depository && network.contracts.entityProvider);
    assert(network.entityProviderDeploymentBlock !== undefined);
    const jurisdiction = { name: owner.network, address: network.contracts.depository,
      depositoryAddress: network.contracts.depository, entityProviderAddress: network.contracts.entityProvider,
      chainId: Number(network.chainId), entityProviderDeploymentBlock: network.entityProviderDeploymentBlock };
    const { config } = runtime.createLazyEntity(owner.name, [owner.signerId], 1n, jurisdiction, env);
    await wallet.send({ runtimeTxs: [runtime.importEntity({ entityId: owner.entityId, signerId: owner.signerId,
      entitySeed: seed, data: { config, isProposer: true, profileName: owner.name } })], entityInputs: [] });
    await waitFor(`created ${owner.name}`, () => env.state.eReplicas.has(`${owner.entityId}:${owner.signerId}`));
  }
};
export const enableHubs = async (env: RuntimeReplica, wallet: EmbeddedRuntimeAdapter) => {
  for (const hub of hubs) {
    if (replica(env, hub).state.orderbookExt) continue;
    await wallet.send({ runtimeTxs: [], entityInputs: [{ entityId: hub.entityId, signerId: hub.signerId, entityTxs: [
      { type: 'setHubConfig', data: { matchingStrategy: 'amount', policyVersion: 1, routingFeePPM: 0,
        baseFee: 0n, swapTakerFeeBps: 0, rebalanceLiquidityFeeBps: 0n, rebalanceTimeoutMs: 60_000 } },
      { type: 'initOrderbookExt', data: { name: hub.name, spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
        referenceTokenId: 1, usdQuoteAuthorityEntityId: hub.entityId, minTradeSize: 10n ** 18n,
        supportedPairs: ['1/2'] } },
    ] }] });
    await waitFor(`configured ${hub.name}`, () => Boolean(replica(env, hub).state.orderbookExt));
  }
};
export const account = (env: RuntimeReplica, owner: Party, peer: Party) => replica(env, owner).state.accounts.get(peer.entityId);
export const accountSnapshot = (env: RuntimeReplica, owner: Party, peer: Party) => {
  const value = account(env, owner, peer);
  assert(value, `Missing account ${owner.name}`);
  const delta = value.state.deltas.get(1);
  assert(delta);
  return { owner: owner.entityId, peer: peer.entityId, height: value.currentHeight,
    root: computeAccountStateRoot(value.state), pending: Boolean(value.pendingFrame), queued: value.mempool.length,
    pulls: value.state.pulls?.size ?? 0, offers: value.state.swapOffers?.size ?? 0,
    view: deriveDelta(delta, value.state.leftEntity === owner.entityId) };
};
export const allAccounts = (hubEnv: RuntimeReplica, userEnv: RuntimeReplica) => users.map(user => {
  const hub = hubs.find(hub => hub.network === user.network);
  assert(hub);
  return { user: accountSnapshot(userEnv, user, hub), hub: accountSnapshot(hubEnv, hub, user) };
});
export const dumpFailure = async (path: string, envs: RuntimeReplica[], error: unknown) => {
  await Bun.write(path, safeStringify({ error: String(error), runtimes: envs.map(env => ({ runtimeId: env.runtimeId,
    height: env.state.height, replicas: [...env.state.eReplicas].map(([key, value]) => [key, {
      ...value, state: { ...value.state,
        accounts: [...value.state.accounts].map(([peer, account]) => [peer, { ...account,
          state: { ...account.state, deltas: [...account.state.deltas], pulls: [...(account.state.pulls ?? [])],
            swapOffers: [...account.state.swapOffers] },
        }]),
        settlementContinuations: [...(value.state.settlementContinuations ?? [])],
      },
    }]), infrastructure: {
      lifecycle: env.infrastructure?.lifecyclePhase, pendingNetworkOutputs: env.pendingNetworkOutputs,
    } })) }, 2));
};
