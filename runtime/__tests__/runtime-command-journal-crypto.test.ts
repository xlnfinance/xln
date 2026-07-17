import { expect, test } from 'bun:test';
import { HDNodeWallet, Mnemonic, getIndexedAccountPath } from 'ethers';

import {
  computeRuntimeCommandInputHmac,
  installRuntimeCommandJournalKeys,
  isRuntimeCommandJournalUnlocked,
  lockRuntimeCommandJournal,
  signRuntimeAdapterOwnerBinding,
} from '../../frontend/src/lib/stores/runtimeCommandJournalKeyring';
import {
  decryptProtectedRemoteRuntimeCommandIntentRecord,
  encryptProtectedRemoteRuntimeCommandIntentRecord,
} from '../../frontend/src/lib/stores/runtimeCommandJournalStorage';
import { canonicalRuntimeInput } from '../../frontend/src/lib/stores/runtimeCommandIntentCodec';
import {
  listUnresolvedRemoteRuntimeCommandIntents,
  resolveRemoteRuntimeCommandId,
  settleRemoteRuntimeCommandIntent,
} from '../../frontend/src/lib/stores/runtimeCommandIntent';
import { submitRuntimeCommand } from '../../frontend/src/lib/stores/runtimeCommandBus';
import { RuntimeAdapterError } from '../radapter/errors';
import { verifyRuntimeAdapterOwnerBinding } from '../radapter/owner-binding';

const seed = 'test test test test test test test test test test test junk';
const otherSeed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const runtimeIdForSeed = (phrase: string): string =>
  HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase), getIndexedAccountPath(0)).address.toLowerCase();
const runtimeId = runtimeIdForSeed(seed);
const hmacCommandId = 'runtime-command:00000000-0000-4000-8000-000000000000';

test('locked-journal predicate returns false before remote server identity is known', () => {
  expect(isRuntimeCommandJournalUnlocked('')).toBe(false);
  expect(isRuntimeCommandJournalUnlocked('remote')).toBe(false);
});

test('runtime command journal key is wallet-derived and disappears on lock', async () => {
  await installRuntimeCommandJournalKeys(runtimeId, seed);
  expect(isRuntimeCommandJournalUnlocked(runtimeId)).toBe(true);

  const first = await computeRuntimeCommandInputHmac(runtimeId, hmacCommandId, '{"payment":7}');
  const retry = await computeRuntimeCommandInputHmac(runtimeId, hmacCommandId, '{"payment":7}');
  expect(first).toMatch(/^0x[0-9a-f]{64}$/);
  expect(retry).toBe(first);
  expect(await computeRuntimeCommandInputHmac(
    runtimeId,
    'runtime-command:00000000-0000-4000-8000-000000000099',
    '{"payment":7}',
  )).not.toBe(first);

  lockRuntimeCommandJournal(runtimeId);
  expect(isRuntimeCommandJournalUnlocked(runtimeId)).toBe(false);
  await expect(computeRuntimeCommandInputHmac(runtimeId, hmacCommandId, '{"payment":7}'))
    .rejects.toThrow(`RUNTIME_COMMAND_JOURNAL_LOCKED:${runtimeId}`);

  const interruptedInstall = installRuntimeCommandJournalKeys(runtimeId, seed);
  lockRuntimeCommandJournal(runtimeId);
  await expect(interruptedInstall)
    .rejects.toThrow(`RUNTIME_COMMAND_JOURNAL_KEY_INSTALL_INTERRUPTED:${runtimeId}`);
  expect(isRuntimeCommandJournalUnlocked(runtimeId)).toBe(false);
});

test('unlocked journal proves only its matching runtime owner identity', async () => {
  await installRuntimeCommandJournalKeys(runtimeId, seed);
  const challenge = `0x${'42'.repeat(32)}`;
  const capability = 'xlnra1.full.owner-binding-test';
  const signature = signRuntimeAdapterOwnerBinding(runtimeId, challenge, capability);

  expect(verifyRuntimeAdapterOwnerBinding(runtimeId, challenge, capability, signature)).toBe(true);
  expect(verifyRuntimeAdapterOwnerBinding(
    runtimeIdForSeed(otherSeed),
    challenge,
    capability,
    signature,
  )).toBe(false);
  lockRuntimeCommandJournal(runtimeId);
  expect(() => signRuntimeAdapterOwnerBinding(runtimeId, challenge, capability))
    .toThrow(`RUNTIME_COMMAND_JOURNAL_LOCKED:${runtimeId}`);
});

test('runtime command journal rejects a different wallet and keeps input identities vault-bound', async () => {
  await installRuntimeCommandJournalKeys(runtimeId, seed);
  const expected = await computeRuntimeCommandInputHmac(runtimeId, hmacCommandId, '{"payment":7}');
  lockRuntimeCommandJournal(runtimeId);

  await expect(installRuntimeCommandJournalKeys(runtimeId, otherSeed))
    .rejects.toThrow(`RUNTIME_COMMAND_JOURNAL_VAULT_ID_MISMATCH:${runtimeId}`);
  const otherRuntimeId = runtimeIdForSeed(otherSeed);
  await installRuntimeCommandJournalKeys(otherRuntimeId, otherSeed);
  const otherWallet = await computeRuntimeCommandInputHmac(otherRuntimeId, hmacCommandId, '{"payment":7}');
  expect(otherWallet).not.toBe(expected);
  lockRuntimeCommandJournal(otherRuntimeId);
});

test('runtime command journal exposes only a keyed input identity and authenticated routing metadata', async () => {
  await installRuntimeCommandJournalKeys(runtimeId, seed);
  const canonical = canonicalRuntimeInput({
    runtimeTxs: [],
    entityInputs: [],
    jInputs: [],
  });
  const intent = {
    commandId: 'runtime-command:00000000-0000-4000-8000-000000000001',
    commandSequence: 1,
    runtimeId,
    serverFingerprint: `0x${'cd'.repeat(32)}`,
    inputHash: canonical.hash,
    input: canonical.input,
    status: 'accepted' as const,
    createdAt: 7,
    upstreamReceiptId: 'secret-receipt',
    statusUrl: '/secret/status',
  };

  const record = await encryptProtectedRemoteRuntimeCommandIntentRecord(intent, canonical.encoded);
  expect(record.inputHmac).toMatch(/^0x[0-9a-f]{64}$/);
  expect('inputHash' in record).toBe(false);
  expect('status' in record).toBe(false);
  expect('upstreamReceiptId' in record).toBe(false);
  expect('statusUrl' in record).toBe(false);
  expect(await decryptProtectedRemoteRuntimeCommandIntentRecord(record)).toEqual(intent);

  const corrupt = { ...record, serverFingerprint: `0x${'ef'.repeat(32)}` };
  await expect(decryptProtectedRemoteRuntimeCommandIntentRecord(corrupt))
    .rejects.toThrow('RUNTIME_COMMAND_INTENT_DECRYPT_FAILED');

  const corruptCiphertext = new Uint8Array(record.ciphertext.slice(0));
  corruptCiphertext[0] = (corruptCiphertext[0] ?? 0) ^ 1;
  await expect(decryptProtectedRemoteRuntimeCommandIntentRecord({
    ...record,
    ciphertext: corruptCiphertext.buffer,
  })).rejects.toThrow('RUNTIME_COMMAND_INTENT_DECRYPT_FAILED');
  await expect(decryptProtectedRemoteRuntimeCommandIntentRecord({
    ...record,
    payloadBytes: Number.MAX_SAFE_INTEGER,
  })).rejects.toThrow('RUNTIME_COMMAND_INTENT_STORAGE_LIMIT_EXCEEDED');
  await expect(decryptProtectedRemoteRuntimeCommandIntentRecord({ version: 1 }))
    .rejects.toThrow('RUNTIME_COMMAND_INTENT_STORAGE_VERSION_UNSUPPORTED:1');

  lockRuntimeCommandJournal(runtimeId);
  await expect(decryptProtectedRemoteRuntimeCommandIntentRecord(record))
    .rejects.toThrow(`RUNTIME_COMMAND_JOURNAL_LOCKED:${runtimeId}`);
});

test('separate user intents get separate IDs while a lost-response retry reuses its exact ID', async () => {
  const serverFingerprint = `0x${'dc'.repeat(32)}`;
  const input = { runtimeTxs: [], entityInputs: [], jInputs: [] };
  const first = await resolveRemoteRuntimeCommandId({ input, runtimeId, serverFingerprint });
  const second = await resolveRemoteRuntimeCommandId({ input, runtimeId, serverFingerprint });
  expect(second).not.toBe(first);

  const retry = await resolveRemoteRuntimeCommandId({
    input,
    runtimeId,
    serverFingerprint,
    commandId: first,
  });
  expect(retry).toBe(first);
  expect(await listUnresolvedRemoteRuntimeCommandIntents(runtimeId, serverFingerprint))
    .toHaveLength(2);

  await expect(resolveRemoteRuntimeCommandId({
    input: { runtimeTxs: [], entityInputs: [] },
    runtimeId,
    serverFingerprint,
    commandId: first,
  })).rejects.toThrow('RUNTIME_COMMAND_ID_PAYLOAD_MISMATCH');
  await settleRemoteRuntimeCommandIntent(first);
  await settleRemoteRuntimeCommandIntent(second);
});

test('remote command lifecycle preserves timeout retries and deletes terminal intents', async () => {
  const serverFingerprint = `0x${'ed'.repeat(32)}`;
  const input = { runtimeTxs: [], entityInputs: [], jInputs: [] };
  let firstCommandId = '';
  await expect(submitRuntimeCommand({
    input,
    runtimeId,
    mode: 'remote',
    serverFingerprint,
  }, async (_progress, receipt) => {
    firstCommandId = receipt.commandId;
    throw new Error('network timeout after command send');
  })).rejects.toThrow('network timeout after command send');

  const unresolved = await listUnresolvedRemoteRuntimeCommandIntents(runtimeId, serverFingerprint);
  expect(unresolved.map(intent => intent.commandId)).toEqual([firstCommandId]);

  const retried = await submitRuntimeCommand({
    input,
    runtimeId,
    mode: 'remote',
    serverFingerprint,
    commandId: firstCommandId,
  }, async (progress, receipt) => {
    await progress.accepted(7, { receiptId: 'receipt-7', statusUrl: '/status/receipt-7' });
    await progress.observed(8);
    return receipt.commandId;
  });
  expect(retried.result).toBe(firstCommandId);
  expect(await listUnresolvedRemoteRuntimeCommandIntents(runtimeId, serverFingerprint)).toEqual([]);

  await expect(submitRuntimeCommand({
    input,
    runtimeId,
    mode: 'remote',
    serverFingerprint,
  }, async () => {
    throw new Error('invalid input rejected');
  })).rejects.toThrow('invalid input rejected');
  expect(await listUnresolvedRemoteRuntimeCommandIntents(runtimeId, serverFingerprint)).toEqual([]);

  await expect(submitRuntimeCommand({
    input,
    runtimeId,
    mode: 'remote',
    serverFingerprint,
  }, async () => {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      'runtime adapter commandId was reused with a different payload',
    );
  })).rejects.toThrow('commandId was reused');
  expect(await listUnresolvedRemoteRuntimeCommandIntents(runtimeId, serverFingerprint)).toEqual([]);

  await expect(submitRuntimeCommand({
    input,
    runtimeId,
    mode: 'remote',
    serverFingerprint,
  }, async () => {
    throw new Error('E_INTERNAL: response construction failed');
  })).rejects.toThrow('E_INTERNAL: response construction failed');
  const uncertain = await listUnresolvedRemoteRuntimeCommandIntents(runtimeId, serverFingerprint);
  expect(uncertain).toHaveLength(1);
  await settleRemoteRuntimeCommandIntent(uncertain[0]!.commandId);
});
