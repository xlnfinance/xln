import { expect, test, type Page } from '@playwright/test';
import { signRuntimeAdapterServerIdentity } from '../runtime/radapter/server-identity-signer';
import { verifyRuntimeAdapterServerIdentity } from '../runtime/radapter/server-identity';

const DB_NAME = 'xln-runtime-command-journal-v1';
const INTENT_STORE = 'intents';
const DB_VERSION = 2;
const WALLET_SEED = 'test test test test test test test test test test test junk';
const IDENTITY_CHALLENGE = `0x${'42'.repeat(32)}`;
const SIGNED_SERVER_IDENTITY = signRuntimeAdapterServerIdentity(
  { runtimeSeed: WALLET_SEED } as never,
  IDENTITY_CHALLENGE,
);
const RUNTIME_ID = SIGNED_SERVER_IDENTITY.runtimeId;
const SERVER_FINGERPRINT = verifyRuntimeAdapterServerIdentity(
  SIGNED_SERVER_IDENTITY,
  IDENTITY_CHALLENGE,
  RUNTIME_ID,
).identityFingerprint;
const OTHER_SERVER_FINGERPRINT = `0x${'ef'.repeat(32)}`;
const browserFailures = new Map<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') failures.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  const failures = browserFailures.get(page) ?? [];
  browserFailures.delete(page);
  expect(failures).toEqual([]);
});

const deleteJournal = async (page: Page): Promise<void> => {
  await page.evaluate(async (dbName) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('TEST_JOURNAL_DELETE_FAILED'));
    request.onblocked = () => reject(new Error('TEST_JOURNAL_DELETE_BLOCKED'));
  }), DB_NAME);
};

const waitForJournalSurface = (page: Page): Promise<void> => page.waitForFunction(() =>
  Boolean((window as never as { __xln?: { commandJournal?: unknown } }).__xln?.commandJournal));

const unlockJournal = async (page: Page): Promise<void> => {
  await waitForJournalSurface(page);
  await page.evaluate(async ({ runtimeId, walletSeed }) => {
  const journal = (window as never as { __xln?: { commandJournal?: { installKeys: (id: string, seed: string) => Promise<void> } } }).__xln?.commandJournal;
  if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
  await journal.installKeys(runtimeId, walletSeed);
  }, { runtimeId: RUNTIME_ID, walletSeed: WALLET_SEED });
};

const loadJournal = (
  page: Page,
  runtimeId = RUNTIME_ID,
  serverFingerprint = SERVER_FINGERPRINT,
) => waitForJournalSurface(page).then(() => page.evaluate(async ({ id, fingerprint }) => {
    const journal = (window as never as { __xln?: { commandJournal?: { list: (runtimeId: string, serverFingerprint: string) => Promise<unknown[]> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    return journal.list(id, fingerprint);
  }, { id: runtimeId, fingerprint: serverFingerprint }));

test('remote command journal survives reload with encrypted exact payload and the same intent ID', { tag: '@resilience' }, async ({ page }) => {
  await page.goto('/app');
  await deleteJournal(page);
  await unlockJournal(page);
  const input = {
    runtimeTxs: [{ type: 'importReplica', entityId: 'sensitive-journal-payload', amount: 17n }],
    entityInputs: [],
    jInputs: [],
  };
  const commandIds = await page.evaluate(async ({ runtimeInput, runtimeId, serverFingerprint }) => {
    const journal = (window as never as { __xln?: { commandJournal?: { resolveId: (options: unknown) => Promise<string> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    const first = await journal.resolveId({
      input: runtimeInput as never,
      runtimeId,
      serverFingerprint,
    });
    const second = await journal.resolveId({
      input: structuredClone(runtimeInput) as never,
      runtimeId,
      serverFingerprint,
    });
    return [first, second];
  }, { runtimeInput: input, runtimeId: RUNTIME_ID, serverFingerprint: SERVER_FINGERPRINT });
  expect(commandIds[0]).not.toBe(commandIds[1]);

  const raw = await page.evaluate(async ({ dbName, dbVersion, intentStore }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, dbVersion);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('TEST_JOURNAL_OPEN_FAILED'));
    });
    try {
      const transaction = db.transaction(intentStore, 'readonly');
      const read = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('TEST_JOURNAL_READ_FAILED'));
      });
      const records = await read(transaction.objectStore(intentStore).getAll());
      return {
        records: (records as Array<Record<string, unknown>>).map(record => ({
          ...record,
          rawKeys: Object.keys(record).sort(),
          ivBytes: (record['iv'] as ArrayBuffer).byteLength,
          ciphertextBytes: (record['ciphertext'] as ArrayBuffer).byteLength,
          iv: undefined,
          ciphertext: undefined,
        })),
        stores: Array.from(db.objectStoreNames),
        localStorage: Object.fromEntries(Object.keys(localStorage).map(storageKey => [storageKey, localStorage.getItem(storageKey)])),
      };
    } finally {
      db.close();
    }
  }, { dbName: DB_NAME, dbVersion: DB_VERSION, intentStore: INTENT_STORE });
  expect(raw.records).toHaveLength(2);
  expect(raw.stores).toEqual(['intents']);
  expect(raw.records.every(record => record.version === 3)).toBe(true);
  expect(raw.records.every(record => record.runtimeId === RUNTIME_ID)).toBe(true);
  expect(raw.records.every(record => record.serverFingerprint === SERVER_FINGERPRINT)).toBe(true);
  expect(raw.records.every(record => /^0x[0-9a-f]{64}$/.test(String(record.inputHmac)))).toBe(true);
  expect(raw.records.every(record => !('input' in record))).toBe(true);
  expect(raw.records.every(record => !('inputHash' in record))).toBe(true);
  expect(raw.records.every(record => !('status' in record))).toBe(true);
  expect(raw.records.every(record => record.rawKeys.join(',') === [
    'ciphertext',
    'commandId',
    'inputHmac',
    'iv',
    'payloadBytes',
    'runtimeId',
    'serverFingerprint',
    'version',
  ].join(','))).toBe(true);
  expect(JSON.stringify(raw)).not.toContain('sensitive-journal-payload');
  expect(raw.records.every(record => record.ivBytes === 12 && Number(record.ciphertextBytes) > 16)).toBe(true);
  expect(JSON.stringify(raw.localStorage)).not.toContain('runtime-command');

  await page.reload();
  await expect(loadJournal(page)).rejects.toThrow(`RUNTIME_COMMAND_JOURNAL_LOCKED:${RUNTIME_ID}`);
  await unlockJournal(page);
  expect(await loadJournal(page)).toMatchObject([
    { commandId: commandIds[0], status: 'pending', input },
    { commandId: commandIds[1], status: 'pending', input },
  ]);
  const retriedCommandId = await page.evaluate(async ({ commandId, runtimeId, serverFingerprint, exactInput }) => {
    const journal = (window as never as { __xln?: { commandJournal?: { resolveId: (options: unknown) => Promise<string> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    return journal.resolveId({
      commandId,
      runtimeId,
      serverFingerprint,
      input: exactInput as never,
    });
  }, {
    commandId: commandIds[0],
    runtimeId: RUNTIME_ID,
    serverFingerprint: SERVER_FINGERPRINT,
    exactInput: input,
  });
  expect(retriedCommandId).toBe(commandIds[0]);
  await expect(page.evaluate(async ({ commandId, runtimeId, serverFingerprint }) => {
    const journal = (window as never as { __xln?: { commandJournal?: { resolveId: (options: unknown) => Promise<string> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    return journal.resolveId({
      commandId,
      runtimeId,
      serverFingerprint,
      input: { runtimeTxs: [{ type: 'changed-payload' }], entityInputs: [], jInputs: [] } as never,
    });
  }, { commandId: commandIds[0], runtimeId: RUNTIME_ID, serverFingerprint: SERVER_FINGERPRINT }))
    .rejects.toThrow('RUNTIME_COMMAND_ID_PAYLOAD_MISMATCH');

  await page.evaluate(async (commandId) => {
    const journal = (window as never as { __xln?: { commandJournal?: { markAccepted: (id: string, upstream: unknown) => Promise<void> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    await journal.markAccepted(commandId, {
      receiptId: 'browser-receipt',
      statusUrl: '/receipt/browser-receipt',
    });
  }, commandIds[0]);
  await page.reload();
  await expect(loadJournal(page)).rejects.toThrow(`RUNTIME_COMMAND_JOURNAL_LOCKED:${RUNTIME_ID}`);
  await unlockJournal(page);
  expect(await loadJournal(page)).toMatchObject([
    {
      commandId: commandIds[0],
      status: 'accepted',
      upstreamReceiptId: 'browser-receipt',
      statusUrl: '/receipt/browser-receipt',
      input,
    },
    { commandId: commandIds[1], status: 'pending', input },
  ]);

  await page.evaluate(async (commandIdsToSettle) => {
    const journal = (window as never as { __xln?: { commandJournal?: { settle: (id: string) => Promise<void> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    for (const commandId of commandIdsToSettle) await journal.settle(commandId);
  }, commandIds);
  expect(await loadJournal(page)).toEqual([]);
});

test('remote command journal fails loud on payload mutation and oversized persisted metadata', { tag: '@resilience' }, async ({ page }) => {
  await page.goto('/app');
  await deleteJournal(page);
  await unlockJournal(page);
  const commandId = await page.evaluate(async ({ runtimeId, serverFingerprint }) => {
    const journal = (window as never as { __xln?: { commandJournal?: { resolveId: (options: unknown) => Promise<string> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    return journal.resolveId({
      input: { runtimeTxs: [], entityInputs: [], jInputs: [] },
      runtimeId,
      serverFingerprint,
    });
  }, { runtimeId: RUNTIME_ID, serverFingerprint: SERVER_FINGERPRINT });

  await expect(loadJournal(page, RUNTIME_ID, OTHER_SERVER_FINGERPRINT))
    .rejects.toThrow(`RUNTIME_COMMAND_SERVER_IDENTITY_MISMATCH:${RUNTIME_ID}`);

  const mutateRecord = async (id: string, mutation: 'ciphertext' | 'oversized'): Promise<void> => {
    await page.evaluate(async ({ dbName, dbVersion, storeName, id, mutationKind }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, dbVersion);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('TEST_JOURNAL_OPEN_FAILED'));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(storeName, 'readwrite');
          const store = transaction.objectStore(storeName);
          const read = store.get(id);
          read.onsuccess = () => {
            const record = read.result as Record<string, unknown>;
            if (mutationKind === 'ciphertext') {
              const bytes = new Uint8Array((record['ciphertext'] as ArrayBuffer).slice(0));
              bytes[0] = (bytes[0] ?? 0) ^ 0xff;
              record['ciphertext'] = bytes.buffer;
            } else {
              record['payloadBytes'] = 16 * 1024 * 1024 + 16 * 1024 + 1;
            }
            store.put(record);
          };
          read.onerror = () => reject(read.error ?? new Error('TEST_JOURNAL_READ_FAILED'));
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error('TEST_JOURNAL_WRITE_FAILED'));
          transaction.onabort = () => reject(transaction.error ?? new Error('TEST_JOURNAL_WRITE_ABORTED'));
        });
      } finally {
        db.close();
      }
    }, { dbName: DB_NAME, dbVersion: DB_VERSION, storeName: INTENT_STORE, id, mutationKind: mutation });
  };

  await mutateRecord(commandId, 'ciphertext');
  await expect(loadJournal(page)).rejects.toThrow('RUNTIME_COMMAND_INTENT_DECRYPT_FAILED');

  await page.reload();
  await deleteJournal(page);
  await unlockJournal(page);
  const oversizedId = await page.evaluate(async ({ runtimeId, serverFingerprint }) => {
    const journal = (window as never as { __xln?: { commandJournal?: { resolveId: (options: unknown) => Promise<string> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    return journal.resolveId({
      input: { runtimeTxs: [], entityInputs: [], jInputs: [] },
      runtimeId,
      serverFingerprint,
    });
  }, { runtimeId: RUNTIME_ID, serverFingerprint: SERVER_FINGERPRINT });
  expect(oversizedId).toMatch(/^runtime-command:/);
  await mutateRecord(oversizedId, 'oversized');
  await expect(loadJournal(page)).rejects.toThrow('RUNTIME_COMMAND_INTENT_STORAGE_LIMIT_EXCEEDED');
});

test('remote command replay lease has exactly one browser-tab owner', { tag: '@resilience' }, async ({ page, context }) => {
  const contender = await context.newPage();
  await Promise.all([page.goto('/app'), contender.goto('/app')]);
  await Promise.all([waitForJournalSurface(page), waitForJournalSurface(contender)]);
  const owner = page.evaluate(async (runtimeId) => {
    const journal = (window as never as { __xln?: { commandJournal?: { withReplayLease: <T>(id: string, operation: () => Promise<T>) => Promise<T> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    return journal.withReplayLease(runtimeId, () =>
      new Promise<string>((resolve) => {
        (window as typeof window & { __releaseRuntimeReplay?: () => void }).__releaseRuntimeReplay = () => resolve('released');
      }));
  }, RUNTIME_ID);
  await page.waitForFunction(() =>
    typeof (window as typeof window & { __releaseRuntimeReplay?: unknown }).__releaseRuntimeReplay === 'function');

  await expect(contender.evaluate(async (runtimeId) => {
    const journal = (window as never as { __xln?: { commandJournal?: { withReplayLease: <T>(id: string, operation: () => Promise<T>) => Promise<T> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    return journal.withReplayLease(runtimeId, async () => 'wrong-owner');
  }, RUNTIME_ID)).rejects.toThrow('RUNTIME_COMMAND_REPLAY_LEASE_BUSY');

  await page.evaluate(() => {
    const target = window as typeof window & { __releaseRuntimeReplay?: () => void };
    target.__releaseRuntimeReplay?.();
  });
  expect(await owner).toBe('released');
  await contender.close();
});

test('cross-tab terminal settlement cannot be resurrected by a stale accepted write', { tag: '@resilience' }, async ({ page, context }) => {
  const settler = await context.newPage();
  const staleWriter = await context.newPage();
  await Promise.all([page.goto('/app'), settler.goto('/app'), staleWriter.goto('/app')]);
  await deleteJournal(page);
  await Promise.all([unlockJournal(page), unlockJournal(settler), unlockJournal(staleWriter)]);
  const commandId = await page.evaluate(async ({ runtimeId, serverFingerprint }) => {
    const journal = (window as never as { __xln?: { commandJournal?: { resolveId: (options: unknown) => Promise<string> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    return journal.resolveId({
      runtimeId,
      serverFingerprint,
      input: { runtimeTxs: [], entityInputs: [], jInputs: [] },
    });
  }, { runtimeId: RUNTIME_ID, serverFingerprint: SERVER_FINGERPRINT });

  const lockOwner = page.evaluate(async () => navigator.locks.request(
    'xln-runtime-command-journal-mutation-v1',
    { mode: 'exclusive' },
    () => new Promise<string>(resolve => {
      (window as typeof window & { __releaseJournalMutation?: () => void }).__releaseJournalMutation = () => resolve('released');
    }),
  ));
  await page.waitForFunction(() =>
    typeof (window as typeof window & { __releaseJournalMutation?: unknown }).__releaseJournalMutation === 'function');

  await settler.evaluate(async (id) => {
    const target = window as typeof window & { __journalSettleState?: string };
    target.__journalSettleState = 'waiting';
    const journal = (window as never as { __xln?: { commandJournal?: { settle: (commandId: string) => Promise<void> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    void journal.settle(id).then(
      () => { target.__journalSettleState = 'done'; },
      error => { target.__journalSettleState = `error:${error instanceof Error ? error.message : String(error)}`; },
    );
  }, commandId);
  await staleWriter.evaluate(async (id) => {
    const target = window as typeof window & { __journalAcceptedState?: string };
    target.__journalAcceptedState = 'waiting';
    const journal = (window as never as { __xln?: { commandJournal?: { markAccepted: (commandId: string, upstream: unknown) => Promise<void> } } }).__xln?.commandJournal;
    if (!journal) throw new Error('TEST_COMMAND_JOURNAL_DEBUG_SURFACE_MISSING');
    void journal.markAccepted(id, { receiptId: 'stale-receipt' }).then(
      () => { target.__journalAcceptedState = 'done'; },
      error => { target.__journalAcceptedState = `error:${error instanceof Error ? error.message : String(error)}`; },
    );
  }, commandId);

  await page.waitForTimeout(100);
  expect(await settler.evaluate(() =>
    (window as typeof window & { __journalSettleState?: string }).__journalSettleState)).toBe('waiting');
  expect(await staleWriter.evaluate(() =>
    (window as typeof window & { __journalAcceptedState?: string }).__journalAcceptedState)).toBe('waiting');

  await page.evaluate(() => {
    (window as typeof window & { __releaseJournalMutation?: () => void }).__releaseJournalMutation?.();
  });
  expect(await lockOwner).toBe('released');
  await expect.poll(() => settler.evaluate(() =>
    (window as typeof window & { __journalSettleState?: string }).__journalSettleState)).toBe('done');
  await expect.poll(() => staleWriter.evaluate(() =>
    (window as typeof window & { __journalAcceptedState?: string }).__journalAcceptedState))
    .toContain('RUNTIME_COMMAND_INTENT_NOT_FOUND');
  expect(await loadJournal(page)).toEqual([]);
  await Promise.all([settler.close(), staleWriter.close()]);
});
