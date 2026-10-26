import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import * as runtime from '../../../core/runtime';
import { getLiveJAdapter } from '../../../core/runtime/j-submit/live-jadapters';
import { readStorageFrameRecord } from '../../../core/storage/read/read';
import { safeStringify } from '../../../core/protocol/serialization';
import { hubSeed, userSeed, walletFor, waitFor, dumpFailure, startCrossTransport } from '../cross-swap-context';
import { hub, alice, bob, positions, pairQuiet, configureFees, pay, swap, lending, type Envs } from './same-j-steps';

// Pay, same-J Swap and Lending between two sovereign Runtimes whose user and
// hub Entities all live on the native TVM jurisdiction. Runs on the ledger left
// by the native cross-swap/withdrawal proofs; a progress marker forbids blind
// resubmission after an uncertain attempt.
const data = resolve(process.env['XLN_TRON_STAND_PATH'] || resolve(import.meta.dir, '../../../db/native-tron-release-20260918'));
assert.equal(process.env['XLN_DB_PATH'], `${data}/cross-runtime`);
assert.equal(process.env['XLN_JURISDICTIONS_PATH'], `${data}/dual-jurisdictions.json`);
const restore = process.argv.includes('--restore');
const progressPath = `${data}/same-j-progress.json`;
assert.equal(await Bun.file(progressPath).exists(), restore, 'Inspect the WAL before resuming an existing same-J attempt');
const previous = restore ? await Bun.file(`${data}/same-j.json`).json() : null;
const hubEnv = await runtime.main(hubSeed, { numericSignerPrewarmCount: 1 });
const userEnv = await runtime.main(userSeed, { numericSignerPrewarmCount: 1 });
const all = [hubEnv, userEnv];
const envs: Envs = { hubEnv, userEnv, hubWallet: walletFor(hubEnv), userWallet: walletFor(userEnv) };
const adapter = getLiveJAdapter(userEnv, hub.network);
assert(adapter?.mode === 'tron', 'Same-J flows must run on the native TVM adapter');
let transport: ReturnType<typeof startCrossTransport> | null = null;
const timings: Record<string, number> = {};
const save = async (stage: string) => {
  await Bun.write(progressPath, safeStringify({ stage, timings, positions: positions(envs) }, 2));
  console.log('SAME_J_STAGE', stage);
};
const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  await save(`${name}-submitting`);
  const started = performance.now();
  const result = await run();
  timings[name] = Math.round(performance.now() - started);
  await save(`${name}-complete`);
  return result;
};
try {
  let report: Record<string, unknown> = {};
  if (!restore) {
    const chain = { chainId: adapter.chainId, depository: adapter.addresses.depository };
    for (const env of all) runtime.startRuntimeLoop(env);
    await envs.hubWallet.connect({ mode: 'embedded', runtimeId: hubEnv.runtimeId! });
    await envs.userWallet.connect({ mode: 'embedded', runtimeId: userEnv.runtimeId! });
    transport = startCrossTransport(hubEnv, userEnv);
    for (const env of all) runtime.startJurisdictionWatchers(env);
    await waitFor('TVM hub profile', () => Boolean(userEnv.gossip.getProfile(hub.entityId)), 30_000);
    await waitFor('accounts quiet', () => pairQuiet(envs, alice) && pairQuiet(envs, bob), 30_000);
    await timed('fees', () => configureFees(envs));
    const payment = await timed('pay', () => pay(envs));
    const exchange = await timed('swap', () => swap(envs));
    const loan = await timed('lending', () => lending(envs));
    for (const env of all) await runtime.stopJurisdictionWatchersAndWait(env);
    for (const env of all) assert(await runtime.waitForRuntimeWorkDrained(env, 10_000), 'Pending financial work');
    for (const env of all) assert(await runtime.stopRuntimeLoopAndWait(env, 10_000));
    report = { chain, payment, swap: exchange, lending: loan };
  }
  const final = positions(envs);
  assert(pairQuiet(envs, alice) && pairQuiet(envs, bob), 'Account roots must agree with no pending work');
  if (restore) assert.deepEqual(JSON.parse(safeStringify(final)), previous.final);
  const anchors = [];
  for (const env of all) {
    const frame = await readStorageFrameRecord(runtime.getRuntimeWalDb(env), env.state.height);
    assert(frame);
    anchors.push({ runtimeId: env.runtimeId, height: env.state.height, frameHash: frame.frameHash, postStateHash: frame.postStateHash });
  }
  if (restore) assert.deepEqual(anchors, previous.anchors);
  await Bun.write(`${data}/same-j${restore ? '-restore' : ''}.json`, safeStringify({
    kind: 'NATIVE_TVM_SAME_J_PAY_SWAP_LENDING', restore, ...report, timings, final, anchors,
    scope: 'Private native TVM hub and users over authenticated sockets; bilateral credit claims, no on-chain movement in these flows',
  }, 2));
  await save(restore ? 'restored' : 'complete');
  console.log('NATIVE_SAME_J_VERIFIED', safeStringify({ restore, timings, anchors }));
} catch (error) {
  await dumpFailure(`${data}/same-j-failure.json`, all, error);
  throw error;
} finally {
  envs.hubWallet.disconnect(); envs.userWallet.disconnect();
  for (const env of all) {
    await runtime.stopJurisdictionWatchersAndWait(env);
    await runtime.stopRuntimeLoopAndWait(env, 10_000);
    await runtime.stopP2PAndWait(env, 10_000);
    await runtime.closeRuntimeDb(env);
    for (const name of env.state.jReplicas.keys()) await getLiveJAdapter(env, name)?.close();
    await runtime.closeInfraDb(env);
  }
  transport?.close();
}
process.exit(0);
