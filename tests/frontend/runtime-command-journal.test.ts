import { expect, test } from 'bun:test';
import { HDNodeWallet, Mnemonic, getIndexedAccountPath } from 'ethers';
import {
  canonicalRuntimeInput,
  createRemoteRuntimeCommandIntent,
} from '../../frontend/src/lib/stores/runtimeCommandIntentCodec';
import {
  installRuntimeCommandJournalKeys,
  lockRuntimeCommandJournal,
} from '../../frontend/src/lib/stores/runtimeCommandJournalKeyring';
import {
  decryptProtectedRemoteRuntimeCommandIntentRecord,
  encryptProtectedRemoteRuntimeCommandIntentRecord,
} from '../../frontend/src/lib/stores/runtimeCommandJournalStorage';
import { RUNTIME_COMMAND_JOURNAL_DATABASE } from '../../frontend/src/lib/contracts/browserPersistence';

const SEED = 'test test test test test test test test test test test junk';
const FINGERPRINT = '0x01fe56d4322ab531393851ee54e1f751c8358fc2fc3730a432963661e33f50d3';
const COMMAND_ID = 'runtime-command:00000000-0000-4000-8000-000000000002';

const runtimeId = HDNodeWallet.fromMnemonic(
  Mnemonic.fromPhrase(SEED),
  getIndexedAccountPath(0),
).address.toLowerCase();

test('runtime command journal contract preserves exact database identity', () => {
  expect(RUNTIME_COMMAND_JOURNAL_DATABASE).toEqual({
    name: 'xln-runtime-command-journal-v1',
    version: 2,
    stores: ['intents'],
    retiredStores: ['meta'],
  });
});

test('protected runtime command intent round-trips with real WebCrypto and rejects tampering', async () => {
  const input = {
    runtimeTxs: [{ type: 'importReplica', entityId: 'journal-characterization', amount: 7n } as never],
    entityInputs: [],
    jInputs: [],
  };
  const canonical = canonicalRuntimeInput(input);
  const intent = createRemoteRuntimeCommandIntent({
    commandId: COMMAND_ID,
    commandSequence: 9,
    runtimeId,
    serverFingerprint: FINGERPRINT,
    input,
    createdAt: 1_723_000_000_000,
  });

  await installRuntimeCommandJournalKeys(runtimeId, SEED);
  try {
    const encrypted = await encryptProtectedRemoteRuntimeCommandIntentRecord(intent, canonical.encoded);
    expect(encrypted).toMatchObject({
      version: 1,
      commandId: COMMAND_ID,
      runtimeId,
      serverFingerprint: FINGERPRINT,
    });
    expect(encrypted.iv.byteLength).toBe(12);
    expect(encrypted.ciphertext.byteLength).toBe(encrypted.payloadBytes + 16);
    expect(await decryptProtectedRemoteRuntimeCommandIntentRecord(encrypted)).toEqual(intent);

    const ciphertext = encrypted.ciphertext.slice(0);
    new Uint8Array(ciphertext)[0] ^= 1;
    await expect(decryptProtectedRemoteRuntimeCommandIntentRecord({
      ...encrypted,
      ciphertext,
    })).rejects.toThrow(`RUNTIME_COMMAND_INTENT_DECRYPT_FAILED:${COMMAND_ID}`);
  } finally {
    lockRuntimeCommandJournal(runtimeId);
  }
});

test('pure journal intent creation is deterministic when clock and command ID are supplied', () => {
  const options = {
    commandId: COMMAND_ID,
    commandSequence: 3,
    runtimeId,
    serverFingerprint: FINGERPRINT,
    input: { runtimeTxs: [], entityInputs: [], jInputs: [] },
    createdAt: 123,
  };
  expect(createRemoteRuntimeCommandIntent(options)).toEqual(createRemoteRuntimeCommandIntent(structuredClone(options)));
});
