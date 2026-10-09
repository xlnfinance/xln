/** Actual Ethereum + Java TVM, native Rust sibling hubs, sovereign TS user Runtime. */
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { RemoteRuntimeAdapter } from '../../../core/api/runtime-adapter/remote';
import { deriveRuntimeAdapterCapabilityToken } from '../../../core/api/runtime-adapter/security/auth';
import * as runtime from '../../../core/runtime';
import { decodeJurisdictionsData } from '../../../core/jurisdiction/adapter/kernel/jurisdiction-loader';
import { createJAdapter } from '../../../core/jurisdiction/adapter';
import { deriveSignerAddressSync } from '../../../core/account/crypto';
import { deriveManagedEntityIdentity } from '../../../core/orchestrator/daemon-control';
import { buildRustHubGenesisConfig } from '../../../core/orchestrator/process/rust-hub-genesis';
import { assertRustHubBinaryFresh, buildRustHubProcessPlan } from '../../../core/orchestrator/process/hub-engine-plan';
import { canonicalEntitySeed } from '../../../core/runtime/registration/entity-creation';
import { deriveEntityEncryptionPrivateKey } from '../../../core/runtime/registration/entity-creation/crypto';
import { computeCodeFingerprint } from '../../../core/scripts/e2e/harness/e2e-isolated-runtime';
import { readNativeCrossState } from '../../../core/scripts/operations/hlt/cross/cross-hub';
import { buildCrossJurisdictionSwapSubmission } from '../../../core/runtime/j-submit/api';
import { createHubDirectRuntimeRoute } from '../../../core/orchestrator/hub/hub-runtime-transport';
import { defaultAccountDisputeConfigForParties } from '../../../core/account/config/dispute-config';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../../../core/orderbook/types';
import { safeStringify } from '../../../core/protocol/serialization';
import { party, walletFor, connectChains, createParties, account, accountSnapshot, credit, amount } from '../cross-swap-context';

const stand = process.env['XLN_TRON_STAND_PATH'];
const output = process.env['XLN_TRON_RUST_EVIDENCE'];
const seed = process.env['XLN_TRON_RUST_SEED'];
assert(stand && output && seed && process.env['XLN_STAND_LOCK_TOKEN'], 'explicit local stand/evidence/seed/lock required');
const data = resolve(output);
assert(!await Bun.file(`${data}/genesis.json`).exists(), 'do not overwrite prior runtime evidence');
mkdirSync(data, { recursive: true });
const registry = decodeJurisdictionsData(await Bun.file(`${stand}/dual-jurisdictions.json`).json());
const entries = Object.values(registry.jurisdictions);
assert.equal(entries.length, 2);
const native = entries.find(entry => entry.mode === 'tron');
const ethereum = entries.find(entry => entry.mode === 'rpc');
assert(native && ethereum && native.chainId !== 31338 && ethereum.chainId === 31337);
const adapters = [];
for (const entry of entries) {
  const adapter = await createJAdapter({ mode: entry.mode, chainId: entry.chainId, rpcUrl: entry.rpc, watchOnly: true,
    tronFullHost: entry.tronFullHost, tronSolidityHost: entry.tronSolidityHost,
    fromReplica: { contracts: entry.contracts, entityProviderDeploymentBlock: entry.entityProviderDeploymentBlock } });
  adapters.push(adapter);
  Object.assign(entry, { tokenRegistry: (await adapter.getTokenRegistry()).map(row => ({ ...row, externalTokenId: String(row.externalTokenId) })) });
}
const label = 'h1-hub';
const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
const genesis = buildRustHubGenesisConfig({ name: 'H1', runtimeId, seed, signerLabel: label,
  jurisdictionsJson: JSON.stringify(registry), rpcUrls: {}, minFrameDelayMs: 0 });
const hubs = genesis.entities.map(entity => ({ ...deriveManagedEntityIdentity({ name: 'H1', seed, signerLabel: entity.signerLabel }),
  network: entity.entityAuthorityJurisdiction.name }));
const primary = hubs[0]; assert(primary);
const userSeed = `${seed}:users`;
const users = [party(userSeed, 'Alice Ethereum', ethereum.name), party(userSeed, 'Alice TVM', native.name),
  party(userSeed, 'Bob Ethereum', ethereum.name), party(userSeed, 'Bob TVM', native.name)];
const userRuntimeId = deriveSignerAddressSync(userSeed, '1').toLowerCase();
writeFileSync(`${data}/runtime.seed`, `${seed}\n`, { mode: 0o600 });
writeFileSync(`${data}/entity.key`, `${deriveEntityEncryptionPrivateKey(Buffer.from(canonicalEntitySeed(seed).slice(2), 'hex'), primary.entityId)}\n`, { mode: 0o600 });
writeFileSync(`${data}/routes.json`, safeStringify(users.map(user => ({ targetEntityId: user.entityId,
  targetRuntimeId: userRuntimeId, targetSignerId: user.signerId, websocketUrl: 'ws://127.0.0.1:18988/ws' }))));
writeFileSync(`${data}/jurisdictions.json`, JSON.stringify(registry));
writeFileSync(`${data}/genesis.json`, safeStringify(genesis));
const plan = buildRustHubProcessPlan({ name: 'H1', apiHost: '127.0.0.1', apiPort: 18181, directHost: '127.0.0.1', directPort: 19181,
  dbPath: `${data}/hub`, runtimeSeedFile: `${data}/runtime.seed`, entityKeyFile: `${data}/entity.key`,
  routesFile: `${data}/routes.json`, genesisFile: `${data}/genesis.json`, jurisdictionsPath: `${data}/jurisdictions.json`,
  runtimeSignerLabel: '1', entitySignerLabel: label, primaryEntityId: primary.entityId, workers: 1,
  binary: assertRustHubBinaryFresh(process.cwd()) });
const candidate = computeCodeFingerprint();
await Bun.write(`${data}/candidate.json`, safeStringify({ ...candidate,
  binaryHash: createHash('sha256').update(await Bun.file(plan.executable).bytes()).digest('hex'),
  driverHash: createHash('sha256').update(await Bun.file(import.meta.path).bytes()).digest('hex'),
  graphHash: createHash('sha256').update(await Bun.file(`${stand}/graph.json`).bytes()).digest('hex') }));
process.env['XLN_DB_PATH'] = `${data}/users`;
process.env['XLN_JURISDICTIONS_PATH'] = `${data}/jurisdictions.json`;
const authSeed = randomBytes(32).toString('hex');
const inspectToken = deriveRuntimeAdapterCapabilityToken(authSeed, 'inspect', Date.now() + 600000, { audience: runtimeId });
const inspector = new RemoteRuntimeAdapter();
const inspectConnect = () => inspector.connect({ mode: 'remote', wsUrl: 'ws://127.0.0.1:18181/rpc', authKey: inspectToken, requestTimeoutMs: 15000 });
let child: ReturnType<typeof Bun.spawn> | undefined;
const start = (phase: string) => { child = Bun.spawn([plan.executable, ...plan.args], { env: { ...process.env, XLN_CHILD_SECRET_FD: '0' },
  stdin: new Blob([JSON.stringify({ runtimeSeed: seed, radapterAuthSeed: authSeed })]),
  stdout: Bun.file(`${data}/rust-${phase}.stdout.log`), stderr: Bun.file(`${data}/rust-${phase}.stderr.log`) }); };
const stop = async () => { if (child) { child.kill('SIGKILL'); await child.exited; child = undefined; } };
const api = 'http://127.0.0.1:18181';
const get = async (path: string) => { const response = await fetch(`${api}${path}`); const body = await response.json(); assert(response.ok, safeStringify(body)); return body; };
const wait = async (stage: string, predicate: () => Promise<boolean> | boolean) => {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { if (await predicate()) { console.log('NATIVE_CROSS_STAGE', stage); return; } await Bun.sleep(50); }
  throw new Error(`NATIVE_CROSS_TIMEOUT:${stage}`);
};
const ready = async () => { try { return (await get('/api/info')).deliveryReady === true; }
  catch (error) { if (error instanceof TypeError || (error instanceof Error && 'code' in error && error.code === 'ConnectionRefused')) return false; throw error; } };
const send = async (commandId: string, entityInputs: unknown[]) => {
  const response = await fetch(`${api}/api/control/runtime/entity-inputs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: safeStringify({ commandId, entityInputs }) }); const result = await response.json(); assert(response.ok, safeStringify(result));
};
const env = await runtime.main(userSeed, { numericSignerPrewarmCount: 1 });
assert.equal(env.runtimeId, userRuntimeId);
const wallet = walletFor(env);
const hubFor = (network: string) => { const hub = hubs.find(hub => hub.network === network); assert(hub); return hub; };
const status = (hub: typeof primary, user: typeof users[number]) => get(`/api/account/status?hubEntityId=${hub.entityId}&counterpartyEntityId=${user.entityId}&tokenIds=1`);
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  start('initial'); await wait('native dual J ready', ready); await inspectConnect();
  for (const hub of hubs) await send(`configure-${hub.entityId}`, [{ entityId: hub.entityId, signerId: hub.signerId, entityTxs: [
    { type: 'setHubConfig', data: { matchingStrategy: 'amount', policyVersion: 1, routingFeePPM: 0, baseFee: 0n,
      swapTakerFeeBps: 0, rebalanceLiquidityFeeBps: 0n, rebalanceTimeoutMs: 60000 } },
    { type: 'initOrderbookExt', data: { name: hub.network, spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
      referenceTokenId: 1, usdQuoteAuthorityEntityId: hub.entityId, minTradeSize: 10n ** 18n, supportedPairs: ['1/2'] } },
  ] }]);
  runtime.startRuntimeLoop(env);
  await wallet.connect({ mode: 'embedded', runtimeId: userRuntimeId });
  await connectChains(env); await createParties(env, users, userSeed, wallet);
  const direct = createHubDirectRuntimeRoute(env, userSeed, () => true, { lastSeen: null, lastError: null });
  server = Bun.serve({ hostname: '127.0.0.1', port: 18988, fetch(request, listener) {
    const upgraded = direct.maybeUpgrade(request, listener); return upgraded.handled ? upgraded.response : new Response('Not found', { status: 404 });
  }, websocket: direct.websocket });
  const p2p = runtime.startP2P(env, { relayUrls: [], wsUrl: 'ws://127.0.0.1:18988/ws', advertiseEntityIds: users.map(user => user.entityId), gossipPollMs: 250 });
  assert(p2p);
  for (const hub of hubs) { const response = await get(`/api/gossip/profile?entityId=${hub.entityId}`); assert(response.profile); await p2p.admitSharedProfiles([response.profile]);
    assert(env.infrastructure.verifiedProfileRoutes?.has(hub.entityId), 'authenticated native hub profile route'); }
  for (const user of users) {
    const hub = hubFor(user.network);
    await wallet.send({ runtimeTxs: [], entityInputs: [{ entityId: user.entityId, signerId: user.signerId, entityTxs: [
      { type: 'openAccount', data: { targetEntityId: hub.entityId, tokenId: 1, creditAmount: credit,
        disputeConfig: defaultAccountDisputeConfigForParties(user.entityId, false, hub.entityId, true) } },
    ] }] });
    await wait(`account-${user.name}`, async () => Boolean(account(env, user, hub)?.currentHeight) && (await status(hub, user)).ready);
    await send(`credit-${user.entityId}`, [{ entityId: hub.entityId, signerId: hub.signerId,
      entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: user.entityId, tokenId: 1, amount: credit } }] }]);
    await wait(`credit-${user.name}`, async () => { const local = accountSnapshot(env, user, hub); const remote = await status(hub, user);
      return !local.pending && !local.queued && local.view.outCapacity === credit && local.view.inCapacity === credit && remote.ready; });
  }
  const before = users.map(user => accountSnapshot(env, user, hubFor(user.network)));
  const ids = [`${seed}-alice`, `${seed}-bob`];
  for (const [index, source, target] of [[0, users[0], users[1]], [1, users[3], users[2]]] as const) {
    assert(source && target); const sourceHub = hubFor(source.network), targetHub = hubFor(target.network);
    const submission = buildCrossJurisdictionSwapSubmission(env, { orderId: ids[index], sourceUserEntityId: source.entityId,
      targetUserEntityId: target.entityId, sourceHubEntityId: sourceHub.entityId, targetHubEntityId: targetHub.entityId,
      sourceUserSignerId: source.signerId, targetUserSignerId: target.signerId,
      sourceHubSignerId: sourceHub.signerId, targetHubSignerId: targetHub.signerId,
      sourceTokenId: 1, targetTokenId: 1, sourceAmount: amount, targetAmount: amount, expiresInMs: 600000 });
    if (index === 0) {
      // Exercise native sender rejection before the valid routes. The same
      // Account roots, empty locks and successful swap below must still hold.
      await send('reject-colon-order-id', [{ entityId: sourceHub.entityId, signerId: sourceHub.signerId,
        entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: {
          route: { ...submission.route, orderId: `${seed}:invalid`, routeHash: undefined },
        } }] }]);
    }
    await wallet.submitCrossJurisdictionIntent(submission.route);
  }
  const settled = async () => { const states = await Promise.all(hubs.map(hub => readNativeCrossState(api, hub.entityId)));
    return states.every(state => ids.every(id => state.routes.some(route => route.orderId === id && route.status === 'settled' && route.filledSourceAmount === amount && route.filledTargetAmount === amount))); };
  await wait('two native cross-J routes settled', settled);
  const verify = async () => {
    const snapshots = [];
    for (const [index, user] of users.entries()) {
      const hub = hubFor(user.network), local = accountSnapshot(env, user, hub), remote = await status(hub, user);
      assert.equal(local.pending, false); assert.equal(local.queued + local.pulls + local.offers, 0); assert(remote.ready);
      assert.equal(remote.pendingFrameHeight, null, 'native pending ACK must be absent');
      assert.equal(remote.mempool, 0, 'native pending Account operations');
      assert.equal(remote.currentHeight, local.height);
      const document = await inspector.read<{ pendingFrame?: unknown; mempoolCount: number;
        currentFrame: { accountStateRoot: string }; state: { locks: Map<string, unknown>; pulls: Map<string, unknown>; swapOffers: Map<string, unknown> } }>(
        `entity/${hub.entityId}/account/${user.entityId}`);
      assert.equal(document.pendingFrame, undefined);
      assert.equal(document.mempoolCount, 0);
      assert.equal(document.currentFrame.accountStateRoot, local.root, 'both peers committed identical Account root');
      for (const collection of [document.state.locks, document.state.pulls, document.state.swapOffers]) {
        assert(collection instanceof Map, 'native Account collection decoded'); assert.equal(collection.size, 0);
      }
      assert.equal(local.view.outCapacity, index === 0 || index === 3 ? credit - amount : credit + amount);
      assert.equal(BigInt(remote.tokens[0].hubOutCapacity), local.view.inCapacity);
      assert.equal(BigInt(remote.tokens[0].delta.offdelta), account(env, user, hub)?.state.deltas.get(1)?.offdelta);
      snapshots.push({ local, remote });
    }
    return snapshots;
  };
  await wait('native published outbox drained', async () => (await get('/api/health')).quiescence.pendingNetworkOutputs === 0);
  for (const hub of hubs) {
    const state = await readNativeCrossState(api, hub.entityId);
    assert(!state.routes.some(route => route.orderId === `${seed}:invalid`), 'rejected intent never persisted as route');
  }
  const economic = await verify(); const beforeRestart = await get('/api/info');
  const anchorBefore = await inspector.read<{ height: number; postStateHash: string; canonicalStateHash?: string }>('frame/latest');
  assert.match(anchorBefore.postStateHash, /^0x[0-9a-f]{64}$/);
  inspector.disconnect(); await stop(); start('restored'); await wait('native WAL restart', ready);
  await inspectConnect();
  const anchorAfter = await inspector.read(`frame/${anchorBefore.height}`);
  assert.deepEqual(anchorAfter, anchorBefore, 'same-height durable frame and root survive SIGKILL');
  await wait('restored routes', settled);
  await wait('restored outbox drained', async () => (await get('/api/health')).quiescence.pendingNetworkOutputs === 0);
  const recovered = await verify();
  await Bun.write(`${data}/result.json`, safeStringify({ engine: 'rust', chains: entries.map(entry => ({ chainId: entry.chainId, mode: entry.mode })),
    before, economic, recovered, anchorBefore, anchorAfter, beforeRestart, afterRestart: await get('/api/info'), routes: await Promise.all(hubs.map(hub => readNativeCrossState(api, hub.entityId))) }, 2));
  console.log('NATIVE_RUST_ETHEREUM_TVM_CROSS_VERIFIED');
} finally {
  await runtime.stopJurisdictionWatchersAndWait(env); await runtime.stopRuntimeLoopAndWait(env, 10000);
  await runtime.stopP2PAndWait(env, 10000); wallet.disconnect(); inspector.disconnect(); server?.stop(true); await stop();
  await runtime.closeRuntimeDb(env); await runtime.closeInfraDb(env); for (const adapter of adapters) await adapter.close();
}
