import { expect, test } from '../../tests/global-setup.mts';

const runtimeId = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const serverFingerprint = `0x${'cd'.repeat(32)}`;
const walletSeed = 'test test test test test test test test test test test junk';
const wrongWalletSeed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('remote command survives reload encrypted and retries with the same ID after unlock', { tag: '@resilience' }, async ({ page }) => {
  const consoleNoise: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleNoise.push(`${message.type()}: ${message.text()}`);
    }
  });
  await page.goto('/site.webmanifest');

  const created = await page.evaluate(async ({ runtimeId, serverFingerprint, walletSeed }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('xln-runtime-command-journal-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('intents', { keyPath: 'commandId' });
        request.result.createObjectStore('meta');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    const keyringPath = '/src/lib/stores/runtimeCommandJournalKeyring.ts';
    const intentPath = '/src/lib/stores/runtimeCommandIntent.ts';
    const keyring = await import(keyringPath);
    const intents = await import(intentPath);
    await keyring.installRuntimeCommandJournalKeys(runtimeId, walletSeed);
    const input = { runtimeTxs: [], entityInputs: [], jInputs: [] };
    const commandId = await intents.resolveRemoteRuntimeCommandId({ input, runtimeId, serverFingerprint });
    const secondCommandId = await intents.resolveRemoteRuntimeCommandId({ input, runtimeId, serverFingerprint });

    const persisted = await new Promise<{ raw: Record<string, unknown>; stores: string[] }>((resolve, reject) => {
      const request = indexedDB.open('xln-runtime-command-journal-v1', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('intents', 'readonly').objectStore('intents').get(commandId);
        read.onerror = () => reject(read.error);
        read.onsuccess = () => {
          const result = read.result as Record<string, unknown>;
          const stores = Array.from(db.objectStoreNames);
          db.close();
          resolve({ raw: result, stores });
        };
      };
    });
    return { commandId, secondCommandId, rawKeys: Object.keys(persisted.raw).sort(), stores: persisted.stores };
  }, { runtimeId, serverFingerprint, walletSeed });

  expect(created.secondCommandId).not.toBe(created.commandId);
  expect(created.stores).toEqual(['intents']);
  expect(created.rawKeys).toEqual([
    'ciphertext',
    'commandId',
    'inputHmac',
    'iv',
    'payloadBytes',
    'runtimeId',
    'serverFingerprint',
    'version',
  ]);

  await page.reload();
  const lockedError = await page.evaluate(async ({ runtimeId, serverFingerprint }) => {
    const intentPath = '/src/lib/stores/runtimeCommandIntent.ts';
    const intents = await import(intentPath);
    try {
      await intents.listUnresolvedRemoteRuntimeCommandIntents(runtimeId, serverFingerprint);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, { runtimeId, serverFingerprint });
  expect(lockedError).toBe(`RUNTIME_COMMAND_JOURNAL_LOCKED:${runtimeId}`);

  const restored = await page.evaluate(async ({ runtimeId, serverFingerprint, walletSeed, wrongWalletSeed, commandId }) => {
    const keyringPath = '/src/lib/stores/runtimeCommandJournalKeyring.ts';
    const intentPath = '/src/lib/stores/runtimeCommandIntent.ts';
    const keyring = await import(keyringPath);
    const intents = await import(intentPath);
    let wrongWalletError: string | null = null;
    try {
      await keyring.installRuntimeCommandJournalKeys(runtimeId, wrongWalletSeed);
    } catch (error) {
      wrongWalletError = error instanceof Error ? error.message : String(error);
    }
    await keyring.installRuntimeCommandJournalKeys(runtimeId, walletSeed);
    const records = await intents.listUnresolvedRemoteRuntimeCommandIntents(runtimeId, serverFingerprint);
    const restored = records.find((record: { commandId: string }) => record.commandId === commandId);
    if (!restored) throw new Error(`RESTORED_RUNTIME_COMMAND_MISSING:${commandId}`);
    const retryId = await intents.resolveRemoteRuntimeCommandId({
      input: restored.input,
      runtimeId,
      serverFingerprint,
      commandId,
    });
    for (const record of records) await intents.settleRemoteRuntimeCommandIntent(record.commandId);
    return {
      retryId,
      wrongWalletError,
      remaining: (await intents.listUnresolvedRemoteRuntimeCommandIntents(runtimeId, serverFingerprint)).length,
    };
  }, { runtimeId, serverFingerprint, walletSeed, wrongWalletSeed, commandId: created.commandId });

  expect(restored.retryId).toBe(created.commandId);
  expect(restored.wrongWalletError).toBe(`RUNTIME_COMMAND_JOURNAL_VAULT_ID_MISMATCH:${runtimeId}`);
  expect(restored.remaining).toBe(0);
  expect(consoleNoise).toEqual([]);
});
