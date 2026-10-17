type ClearableDatabase = {
  clear: () => Promise<void> | void;
};

/** Clear only the exact database handle owned by the caller. */
export const clearDatabase = async (database: ClearableDatabase): Promise<void> => {
  await database.clear();
  if (typeof process !== 'undefined' && process.env?.['XLN_DB_CLEAR_DEBUG'] === '1') {
    console.log('Database cleared via provided instance');
  }
};
