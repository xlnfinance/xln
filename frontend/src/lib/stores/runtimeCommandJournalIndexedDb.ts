const DB_NAME = 'xln-runtime-command-journal-v1';
const DB_VERSION = 2;
const INTENT_STORE = 'intents';
const LEGACY_META_STORE = 'meta';
let journalDbPromise: Promise<IDBDatabase> | null = null;

export const isBrowserCommandJournal = (): boolean => typeof window !== 'undefined';

const openJournalDb = (): Promise<IDBDatabase> => {
  if (typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle) {
    throw new Error('RUNTIME_COMMAND_JOURNAL_PROTECTION_UNAVAILABLE');
  }
  if (journalDbPromise) return journalDbPromise;
  journalDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(LEGACY_META_STORE)) {
        db.deleteObjectStore(LEGACY_META_STORE);
      }
      if (!db.objectStoreNames.contains(INTENT_STORE)) {
        db.createObjectStore(INTENT_STORE, { keyPath: 'commandId' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        journalDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      journalDbPromise = null;
      reject(request.error ?? new Error('RUNTIME_COMMAND_JOURNAL_DB_OPEN_FAILED'));
    };
    request.onblocked = () => reject(new Error('RUNTIME_COMMAND_JOURNAL_DB_OPEN_BLOCKED'));
  });
  return journalDbPromise;
};

const transactionRequest = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await openJournalDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(INTENT_STORE, mode);
    const request = operation(transaction.objectStore(INTENT_STORE));
    let result: T;
    let requestComplete = false;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.onsuccess = () => {
      result = request.result;
      requestComplete = true;
    };
    request.onerror = () => fail(request.error ?? new Error('RUNTIME_COMMAND_JOURNAL_REQUEST_FAILED'));
    transaction.onerror = () => fail(transaction.error ?? new Error('RUNTIME_COMMAND_JOURNAL_TRANSACTION_FAILED'));
    transaction.onabort = () => fail(transaction.error ?? new Error('RUNTIME_COMMAND_JOURNAL_TRANSACTION_ABORTED'));
    transaction.oncomplete = () => {
      if (!requestComplete) return fail(new Error('RUNTIME_COMMAND_JOURNAL_TRANSACTION_INCOMPLETE'));
      if (!settled) {
        settled = true;
        resolve(result!);
      }
    };
  });
};

export const readRuntimeCommandJournalRecords = (limit: number): Promise<unknown[]> =>
  transactionRequest('readonly', store => store.getAll(undefined, limit));

export const readRuntimeCommandJournalRecord = (commandId: string): Promise<unknown> =>
  transactionRequest('readonly', store => store.get(commandId));

export const countRuntimeCommandJournalRecords = (): Promise<number> =>
  transactionRequest('readonly', store => store.count());

export const addRuntimeCommandJournalRecord = (record: unknown): Promise<IDBValidKey> =>
  transactionRequest('readwrite', store => store.add(record));

export const writeRuntimeCommandJournalRecord = (record: unknown): Promise<IDBValidKey> =>
  transactionRequest('readwrite', store => store.put(record));

export const deleteRuntimeCommandJournalRecord = (commandId: string): Promise<undefined> =>
  transactionRequest('readwrite', store => store.delete(commandId));
