/**
 * An unavailable database is not an empty database.
 *
 * Empty results are valid only after a handle opened successfully and the
 * requested key/range was absent. Collapsing open failure into `null` or `[]`
 * makes operators and callers accept unknown durable state as confirmed empty.
 */
export const requireStorageDbOpen = async (
  tryOpen: () => Promise<boolean>,
  operation: string,
): Promise<void> => {
  if (!(await tryOpen())) throw new Error(`STORAGE_DB_UNAVAILABLE:${operation}`);
};
