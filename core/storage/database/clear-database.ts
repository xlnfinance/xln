type ClearableDatabase = {
  clear: () => Promise<void> | void;
};

const shouldLogDatabaseClear = (): boolean =>
  typeof process !== 'undefined' && process.env?.['XLN_DB_CLEAR_DEBUG'] === '1';

const deleteIndexedDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error(`INDEXEDDB_CLEAR_FAILED:${name}`));
    request.onblocked = () => reject(new Error(`INDEXEDDB_DELETE_BLOCKED:${name}`));
  });

/** Clear an explicitly supplied database or the browser runtime databases. */
export const clearDatabase = async (database?: ClearableDatabase): Promise<void> => {
  const debug = shouldLogDatabaseClear();
  if (database) {
    await database.clear();
    if (debug) console.log('Database cleared via provided instance');
    return;
  }
  if (typeof indexedDB === 'undefined') return;

  try {
    const names = ['db', 'level-js-db', 'level-db'];
    await Promise.all(names.map(deleteIndexedDatabase));
    if (debug) console.log('Browser runtime databases cleared');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CLEAR_DATABASE_INDEXEDDB_FAILED:${message}`);
  }
};
