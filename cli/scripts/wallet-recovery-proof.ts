/** Headless fresh-device recovery over the canonical CLI and Runtime APIs. */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildPersistedRuntimeRecording, closeInfraDb, closeRuntimeDb, deriveDelta,
  importRuntimeRecoveryRecording, quoteHtlcPaymentRoute, getTokenInfo,
  waitForRuntimeWorkDrained,
} from '../../core/runtime';
import type { RuntimeRecording } from '../../core/storage/recovery/bundle/types';
import { computeCanonicalStateHashFromEnv } from '../../core/storage/canonical-hash';
import { decryptRuntimeRecoveryBundle, encryptRuntimeRecoveryBundle } from '../../core/storage/recovery/bundle/crypto';
import { deserializeTaggedJson, serializeTaggedJson } from '../../core/protocol/serialization';
import { quiesceNodeRuntime } from '../../core/orchestrator/process/node-runtime-quiesce';
import { closeSession, openSession, submitQueued, type CliSession } from '../lib/session';
import { loadSettings } from '../lib/settings';
import { unlockWallet } from '../lib/identity';
import { findAccount } from '../lib/accounts';
import { executeMove } from '../lib/actions/move';
import { ensureCliPaymentProfiles, sendPayment } from '../lib/actions/pay';

const [mode, hub, recipient, evidenceDir, restoreHome] = process.argv.slice(2);
assert(mode && hub && recipient && evidenceDir && restoreHome, 'WALLET_RECOVERY_ARGUMENTS');
const passphrase = process.env['XLN_PASSPHRASE'];
assert(passphrase, 'WALLET_RECOVERY_PASSPHRASE_REQUIRED');
const amount = 10n ** BigInt(getTokenInfo(1).decimals);
const settings = await loadSettings();
const path = (name: string) => join(evidenceDir, name);
const write = (name: string, value: unknown) => writeFile(path(name), serializeTaggedJson(value), { mode: 0o600 });
const read = async <T>(name: string): Promise<T> => deserializeTaggedJson(await readFile(path(name), 'utf8')) as T;
const wait = async (label: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`WALLET_RECOVERY_TIMEOUT:${label}`);
    await Bun.sleep(25);
  }
};
const capacity = (session: CliSession): bigint => {
  const account = findAccount(session.env, session.entityId, hub);
  assert(account, 'WALLET_RECOVERY_ACCOUNT_MISSING');
  const delta = account.state.deltas.get(1);
  assert(delta, 'WALLET_RECOVERY_DELTA_MISSING');
  return deriveDelta(delta, session.entityId.toLowerCase() < hub.toLowerCase()).outCapacity;
};
const idle = (session: CliSession): boolean => {
  const account = findAccount(session.env, session.entityId, hub);
  assert(account, 'WALLET_RECOVERY_ACCOUNT_MISSING');
  return !account.pendingFrame && !account.pendingAccountInput && account.mempool.length === 0 && account.state.locks.size === 0;
};
const drain = async (session: CliSession): Promise<void> => {
  await wait('bilateral-ack', () => idle(session));
  assert(await waitForRuntimeWorkDrained(session.env, 10_000), 'WALLET_RECOVERY_DRAIN_FAILED');
  assert(idle(session), 'WALLET_RECOVERY_ACK_REAPPEARED');
};
const fingerprint = (session: CliSession) => ({
  runtimeId: session.env.runtimeId,
  entityId: session.entityId,
  signerId: session.signerId,
  runtimeHeight: session.env.state.height,
  root: computeCanonicalStateHashFromEnv(session.env),
  accounts: accountHeads(session.env),
});
const accountHeads = (env: CliSession['env']) => [...env.state.eReplicas.values()].flatMap(replica =>
    [...replica.state.accounts.entries()].map(([counterparty, account]) => ({
      entity: replica.state.entityId, counterparty, height: account.currentHeight,
      root: account.currentFrame.accountStateRoot,
    })));
const settledPayment = async (session: CliSession, ordinal: number): Promise<void> => {
  const route = [session.entityId, hub, recipient];
  await ensureCliPaymentProfiles(session, route);
  const debit = quoteHtlcPaymentRoute(session.env.gossip.getProfiles(), route, 1, amount).senderLockAmount;
  const before = capacity(session);
  assert(before >= debit, 'WALLET_RECOVERY_INSUFFICIENT_SENDER_CAPACITY');
  await sendPayment(session, { to: recipient, amount, tokenId: 1, mode: 'instant', hub });
  await wait(`payment-${ordinal}`, () => capacity(session) === before - debit && idle(session));
  await drain(session);
  await write(`sender-${ordinal}.json`, { before, after: capacity(session), debit, evidence: fingerprint(session) });
};

const fundSender = async (session: CliSession): Promise<void> => {
  const reserve = () => [...session.env.state.eReplicas.values()]
    .find(replica => replica.state.entityId === session.entityId)!.state.reserves.get(1) ?? 0n;
  const funded = 10n * amount;
  const beforeReserve = reserve();
  const beforeCapacity = capacity(session);
  for (const [kind, body] of [
    ['gas', { userAddress: session.identity.signerAddress, amount: '0.1' }],
    ['reserve', { userEntityId: session.entityId, tokenId: 1, tokenSymbol: getTokenInfo(1).symbol, amount: '10' }],
  ] as const) {
    const response = await fetch(`${settings.apiBase}/api/faucet/${kind}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const evidence = await response.text();
    assert(response.ok, `WALLET_RECOVERY_FAUCET_${kind}:${response.status}:${evidence}`);
    await write(`fund-${kind}.json`, JSON.parse(evidence));
  }
  await wait('funded-reserves', () => reserve() === beforeReserve + funded);
  await executeMove(session, { kind: 'r2c', tokenId: 1, amount: funded, counterpartyId: hub });
  await submitQueued(session.env, { runtimeTxs: [], entityInputs: [{
    entityId: session.entityId, signerId: session.signerId,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  }] }, 'wallet-recovery-r2c-broadcast');
  await wait('funded-account', () => reserve() === beforeReserve && capacity(session) === beforeCapacity + funded);
  await drain(session);
  await write('funding.json', { funded, reserve: reserve(), capacity: capacity(session) });
};

if (mode === 'recipient') {
  const session = await openSession(settings, passphrase);
  try {
    await drain(session);
    const before = capacity(session);
    await write('recipient-ready.json', { entityId: session.entityId, before });
    for (const ordinal of [1, 2]) {
      await wait(`recipient-${ordinal}`, () => capacity(session) === before + BigInt(ordinal) * amount && idle(session));
      await drain(session);
      await write(`recipient-${ordinal}.json`, { before, after: capacity(session), evidence: fingerprint(session) });
    }
  } finally { await closeSession(session); }
} else if (mode === 'export') {
  const session = await openSession(settings, passphrase);
  try {
    await wait('recipient-ready', () => existsSync(path('recipient-ready.json')));
    await fundSender(session);
    await settledPayment(session, 1);
    await wait('recipient-credit-1', () => existsSync(path('recipient-1.json')));
    await quiesceNodeRuntime(session.env, { workTimeoutMs: 10_000, loopTimeoutMs: 10_000 });
    const expected = fingerprint(session);
    const recording = await buildPersistedRuntimeRecording(session.env, {
      signers: [{ index: 0, derivationIndex: 0, address: session.signerId, name: 'Wallet', entityId: session.entityId }],
    });
    assert.equal(recording.targetHeight, expected.runtimeHeight);
    await mkdir(restoreHome, { mode: 0o700 });
    await chmod(restoreHome, 0o700);
    assert(!existsSync(join(restoreHome, 'db')), 'WALLET_RECOVERY_TARGET_NOT_FRESH');
    await copyFile(join(settings.homeDir, 'wallet.json'), join(restoreHome, 'wallet.json'));
    await chmod(join(restoreHome, 'wallet.json'), 0o600);
    await write('encrypted-recording.json', { ...recording, bundles: await Promise.all(recording.bundles.map(bundle =>
      encryptRuntimeRecoveryBundle(bundle, session.identity.mnemonic))) });
    await write('expected.json', expected);
  } finally { await closeSession(session); }
} else if (mode === 'restore') {
  assert.equal(settings.homeDir, restoreHome);
  // The normal CLI missing-history probe may create empty DB handles; the canonical importer enforces emptiness.
  const identity = await unlockWallet(settings, passphrase);
  const encrypted = await read<Omit<RuntimeRecording, 'bundles'> & {
    bundles: Awaited<ReturnType<typeof encryptRuntimeRecoveryBundle>>[];
  }>('encrypted-recording.json');
  const bundles = await Promise.all(encrypted.bundles.map(bundle => decryptRuntimeRecoveryBundle(bundle, identity.mnemonic)));
  process.env['XLN_DB_PATH'] = settings.dbPath;
  console.log('WALLET_RECOVERY_IMPORT_BEGIN');
  const restored = await importRuntimeRecoveryRecording({ ...encrypted, bundles }, identity.mnemonic);
  console.log('WALLET_RECOVERY_IMPORT_COMPLETE');
  try {
    const expected = await read<ReturnType<typeof fingerprint>>('expected.json');
    assert.equal(restored.runtimeId, expected.runtimeId);
    assert.equal(restored.state.height, expected.runtimeHeight);
    assert.equal(computeCanonicalStateHashFromEnv(restored), expected.root);
    assert.deepEqual(accountHeads(restored), expected.accounts);
    assert.equal(identity.signerAddress, expected.signerId);
    assert.equal(identity.entityId, expected.entityId);
    await write('restore-root.json', expected);
  } finally { await closeRuntimeDb(restored); await closeInfraDb(restored); }
  const session = await openSession(settings, passphrase);
  try {
    await settledPayment(session, 2);
    await wait('recipient-credit-2', () => existsSync(path('recipient-2.json')));
    await write('complete.json', { sourceDb: 'independent', restoredDb: settings.dbPath, payments: 2, rootVerified: true });
  } finally { await closeSession(session); }
} else throw new Error(`WALLET_RECOVERY_MODE_INVALID:${mode}`);
