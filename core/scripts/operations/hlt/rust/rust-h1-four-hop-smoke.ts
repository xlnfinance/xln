/** Four real Account legs through native H1 and the existing H2/H3 mesh. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultAccountDisputeConfigForRoleEvidence } from '../../../../account/config/dispute-config';
import { deriveDelta, isLeftEntity } from '../../../../account/utils';
import { validateAccountDeltas } from '../../../../account/validation/delta-validation';
import { DaemonControlClient } from '../../../../orchestrator/daemon-control';
import { requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import { safeStringify } from '../../../../protocol/serialization';
import { decodeEntitySummaries, decodeHubSettlementCounters, decodeRuntimeManifestEntries, selectLocalHubIdentity } from '../boundary/worker-boundary';
import { queueLaneRuntimeInputWave } from '../lanes/lane-runtimes';
import { connectRuntime, entryByLabel, readWithRateLimitRetry, type ConnectedRuntime } from '../worker-runtime';
import type { PreparedParallelSameLoad } from '../workload/worker-same-lanes';
import { fetchNativeJson, type RustH1Handle } from './rust-h1';

const record = (value: unknown) => requireBoundaryRecord(value, 'NATIVE_FOUR_HOP_BOUNDARY');
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`NATIVE_FOUR_HOP_${message}`);
}
const wait = async <T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean, budgetMs = 10_000) => {
  const deadline = Date.now() + budgetMs;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`NATIVE_FOUR_HOP_${label}:${safeStringify(value)}`);
};
const account = async (runtime: ConnectedRuntime, owner: string, peer: string) => {
  const page = record(await readWithRateLimitRetry(runtime, `entity/${owner}/accounts`, { accountId: peer, accountsLimit: 1 }));
  assert(Array.isArray(page['items']) && page['items'].length === 1, `ACCOUNT_MISSING:${owner}:${peer}`);
  const row = record(page['items'][0]), state = record(row['state']);
  assert(state['locks'] instanceof Map, 'LOCKS');
  const delta = validateAccountDeltas(state['deltas'], 'native four hop').get(1);
  assert(delta, 'TOKEN_MISSING');
  const derived = deriveDelta(delta, isLeftEntity(owner, peer));
  return { owner, peer, height: row['currentHeight'], domain: state['domain'], delta,
    ready: row['pendingFrame'] === undefined && row['mempoolCount'] === 0,
    locks: state['locks'].size, out: derived.outCapacity + derived.outTotalHold,
    available: derived.outCapacity };
};

export const runRustH1FourHopSmoke = async (options: {
  prepared: PreparedParallelSameLoad; rust: RustH1Handle; portBase: number; workDir: string;
}) => {
  const { prepared, rust, workDir } = options;
  const manifestPath = join(workDir, 'prod-mesh', 'runtime-import-manifest.json');
  // The canonical producer removes this file during busy health and refreshes
  // after 10 seconds. Await that publication, never synthesize access tokens.
  await wait('RUNTIME_MANIFEST', () => Bun.file(manifestPath).exists(), Boolean, 15_000);
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  const h2 = await connectRuntime(entryByLabel(entries, 'H2'));
  const h3 = await connectRuntime(entryByLabel(entries, 'H3'));
  const lanes = prepared.traderRuntimes.filter(lane => lane.port === Number(new URL(lane.hostIngress.baseUrl).port));
  const sender = lanes[0], receiver = lanes[1];
  assert(sender && receiver && sender.runtimeId !== receiver.runtimeId, 'SOVEREIGN_USERS');
  const connect = (lane: typeof sender) => connectRuntime({ label: 'four-hop-user', engine: 'ts',
    wsUrl: `ws://127.0.0.1:${lane.port}/rpc`, token: lane.hostIngress.authKey });
  const source = await connect(sender), target = await connect(receiver);
  try {
    const h2id = selectLocalHubIdentity(decodeEntitySummaries(await h2.adapter.read('entities')), h2.adapter.runtimeId, 31_337).entityId;
    const h3id = selectLocalHubIdentity(decodeEntitySummaries(await h3.adapter.read('entities')), h3.adapter.runtimeId, 31_337).entityId;
    const route = [sender.identity.entityId, rust.ready.entityId, h2id, h3id, receiver.identity.entityId];
    assert(new Set(route).size === 5, 'DISTINCT_ROUTE');
    const controls = [sender, receiver].map(lane => new DaemonControlClient({
      baseUrl: lane.hostIngress.baseUrl, authKey: lane.hostIngress.authKey, timeoutMs: 10_000,
    }));
    // Throughput lanes initially know only H1. Enable normal discovery for these
    // two real runtimes before asking them to connect outside that measured topology.
    await Promise.all(controls.map((client, i) => client.configureP2P({
      relayUrls: [`ws://127.0.0.1:${options.portBase + 4}/relay`],
      advertiseEntityIds: [i === 0 ? sender.identity.entityId : receiver.identity.entityId], gossipPollMs: 250,
    })));
    await controls[1]!.waitForDirectEntityRoutes([h3id], 10_000);
    await queueLaneRuntimeInputWave(0, [{ lane: receiver, input: { runtimeTxs: [], entityInputs: [{
      entityId: receiver.identity.entityId, signerId: receiver.identity.signerId, entityTxs: [
        { type: 'openAccount', data: { targetEntityId: h3id, disputeConfig: defaultAccountDisputeConfigForRoleEvidence(
          { entityId: receiver.identity.entityId, isHub: false, source: 'operator-config' },
          { entityId: h3id, isHub: true, source: 'operator-config' },
          new Map([[receiver.identity.entityId, false], [h3id, true]]),
        ) } },
        { type: 'extendCredit', data: { counterpartyEntityId: h3id, tokenId: 1, amount: 100_000_000n } },
      ],
    }] } }]);
    await wait('RECEIVER_ACCOUNT', async () => record(await readWithRateLimitRetry(h3, `entity/${h3id}/accounts`,
      { accountId: receiver.identity.entityId, accountsLimit: 1 })), page => Array.isArray(page['items']) && page['items'].length === 1);
    // The receiver grants H3 outgoing capacity. Read H3's committed side, not its own credit.
    await wait('RECEIVER_CREDIT', () => account(h3, h3id, receiver.identity.entityId), view => view.ready && view.available >= 1_000_000n);
    await controls[0]!.waitForDirectEntityRoutes([rust.ready.entityId], 10_000);
    await wait('ONION_PROFILES', () => Promise.all([
      { entityId: rust.ready.entityId, runtimeId: rust.ready.runtimeId },
      { entityId: h2id, runtimeId: h2.adapter.runtimeId },
      { entityId: h3id, runtimeId: h3.adapter.runtimeId },
      { entityId: receiver.identity.entityId, runtimeId: receiver.runtimeId },
    ].map(row => controls[0]!.hubProfileSendReady(row.entityId, row.runtimeId))), result => result.every(Boolean));
    const read = () => Promise.all([
      account(source, route[0]!, route[1]!), account(h2, route[2]!, route[1]!),
      account(h2, route[2]!, route[3]!), account(h3, route[3]!, route[2]!),
      account(h3, route[3]!, route[4]!), account(target, route[4]!, route[3]!),
    ]);
    const clean = (views: Awaited<ReturnType<typeof read>>) => views.every(view => view.ready && view.locks === 0 && view.delta.leftHold === 0n && view.delta.rightHold === 0n);
    const api = `http://127.0.0.1:${options.portBase + 10}`;
    const native = (peer: string) => fetchNativeJson(`${api}/api/account/status?hubEntityId=${rust.ready.entityId}&counterpartyEntityId=${peer}&tokenIds=1`).then(record);
    const counters = async () => {
      const n = record(await fetchNativeJson(`${api}/api/metrics`));
      const ts = await Promise.all([[h2, h2id], [h3, h3id]].map(async ([runtime, id]) =>
        decodeHubSettlementCounters(await (runtime as ConnectedRuntime).adapter.read(`entity/${id}/settlement-counters`))));
      return { native: n, ts, fees: [BigInt(String(n['paybookFeesEarned'])), ...ts.map(row => row.paybookFeesEarned)] };
    };
    const before = await wait('INITIAL_CLEAN', read, clean);
    assert(before.every(view => safeStringify(view.domain) === safeStringify(before[0]!.domain)), 'SAME_DOMAIN');
    const nativeBefore = await Promise.all([native(route[0]!), native(route[2]!)]);
    assert(nativeBefore.every(row => row['ready'] === true), 'NATIVE_READY');
    const nativeForward = nativeBefore[1]!['tokens'];
    assert(Array.isArray(nativeForward) && nativeForward.length === 1 && BigInt(String(record(nativeForward[0])['hubOutCapacity'])) >= 2_000_000n, 'NATIVE_FORWARD_CAPACITY');
    const beforeCounters = await counters();
    const amount = 1_000_000n;
    assert(before[0]!.available >= amount * 2n && before[2]!.available >= amount * 2n && before[4]!.available >= amount, 'FORWARD_CAPACITY');
    await queueLaneRuntimeInputWave(1, [{ lane: sender, input: { runtimeTxs: [], entityInputs: [{
      entityId: sender.identity.entityId, signerId: sender.identity.signerId, entityTxs: [{ type: 'htlcPayment', data: {
        targetEntityId: receiver.identity.entityId, route, tokenId: 1, amount, maxSenderDebit: amount * 2n,
        deliveryMode: 'async', description: 'native-four-hop-economic-proof',
      } }],
    }] } }]);
    const after = await wait('ECONOMIC_FINALITY', read, views => clean(views) && views[5]!.out - before[5]!.out === amount && views.every((view, i) => Number(view.height) > Number(before[i]!.height)));
    const afterCounters = await wait('PAYBOOK_DRAIN', counters, value => value.native['paybookOpen'] === 0 &&
      Number(value.native['completedPayments']) === Number(beforeCounters.native['completedPayments']) + 1 &&
      Number(value.native['height']) > Number(beforeCounters.native['height']) &&
      value.ts.every((row, i) => row.paybookOpen === 0 && row.completedPayments === beforeCounters.ts[i]!.completedPayments + 1));
    const paid = [before[0]!.out - after[0]!.out, after[1]!.out - before[1]!.out,
      before[2]!.out - after[2]!.out, before[4]!.out - after[4]!.out];
    const fees = afterCounters.fees.map((value, i) => value - beforeCounters.fees[i]!);
    writeFileSync(join(workDir, 'native-four-hop-economic-boundary.json'), `${safeStringify({ route, amount, paid, fees, before, after, nativeBefore, beforeCounters, afterCounters }, 2)}\n`);
    assert(paid[3] === amount, 'RECIPIENT_EXACT');
    for (let i = 0; i < 3; i++) assert(paid[i]! - paid[i + 1]! === fees[i] && fees[i]! >= 0n, `FEE_CONSERVATION_${i}:paid=${paid.join(',')}:fees=${fees.join(',')}`);
    for (const [left, right] of [[2, 3], [4, 5]]) {
      assert(after[left!]!.delta.offdelta === after[right!]!.delta.offdelta && after[left!]!.height === after[right!]!.height, 'TS_BILATERAL');
    }
    const nativeAfter = await Promise.all([native(route[0]!), native(route[2]!)]);
    nativeAfter.forEach((row, i) => {
      assert(row['ready'] === true && row['currentHeight'] === after[i]!.height, 'NATIVE_BILATERAL_HEIGHT');
      assert(Array.isArray(row['tokens']) && row['tokens'].length === 1, 'NATIVE_TOKEN');
      const delta = record(record(row['tokens'][0])['delta']);
      assert(BigInt(String(delta['offdelta'])) === after[i]!.delta.offdelta && delta['leftHold'] === '0' && delta['rightHold'] === '0', 'NATIVE_BILATERAL_MONEY');
    });
    writeFileSync(join(workDir, 'native-four-hop.json'), `${safeStringify({ route, engineByHub: ['rust', 'ts', 'ts'], amount, paid, fees, before, after, nativeBefore, nativeAfter, beforeCounters, afterCounters }, 2)}\n`);
    console.log('[load] native H1 four-hop GREEN');
  } finally {
    for (const runtime of [source, target, h2, h3]) runtime.adapter.disconnect();
  }
};
