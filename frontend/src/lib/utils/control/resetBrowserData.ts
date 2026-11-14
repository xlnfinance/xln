export const RESET_CONFIRMATION = 'DELETE XLN DATA';
export const RESET_WARNING = `This permanently deletes all local XLN data, including encrypted vaults and recovery keys. Make sure you have a working backup. Type ${RESET_CONFIRMATION} to continue.`;

// Only these two application databases and the named canonical Runtime stores
// belong to this reset. BrowserLevel adds "level-js-" to runtime-db-path names.
const DATABASE_NAMES = new Set(['xln-vault-keys-v1', 'xln-runtime-command-journal-v1']);
const RUNTIME_DATABASE =
  /^level-js-db-(?:default|0x[0-9a-f]{40})-(?:storage-current|storage-previous|wal|infra|history-views)$/;
const STORAGE_KEYS = new Set([
  'xln-deploy-version',
  'xln-network-machine-config-v1',
  'xln-locale',
  'xln-remote-runtime-imports',
  'xln-remote-runtime-import-last-result',
  'xln-watchtower-urls',
  'xln-vaults',
  'xln-ui-vaults',
  'xln-ui-active-vault',
  'xln-ui-recovery',
  'xln-embedded-runtime-seed-v1',
  'xln-runtime-adapter-mode',
  'xln-runtime-adapter-ws',
  'xln-runtime-adapter-access',
  'xln-runtime-adapter-key',
  'xln-entity-tabs',
  'xln-settings',
  'xlnComponentStates',
  'xln-jmachines',
  'xln-time-state',
  'xln-tab-id',
  'xln-active-tab-owned',
  'xln-inactive-tab-standby',
  'xln-hard-reset',
  'xln-reset-notice',
  'xln-push-wake-registrations-v1',
  'xln-display-name',
  'xln-collateral-policy',
  'xln-hub-join-preference',
  'xln-observer-layout',
  'xln-workspace-layout',
  'xln-view-settings',
  'xln-graph-canonicity',
  'xln-ui-theme',
  'xln-ui-density',
  'xln-ui-tour',
  'xln-ui-guide-visible',
  'xln-ui-guide-dock',
  'xln-ui-usd-per-px',
  'xln-ui-scale-mode',
  'xln-ui-places',
  'xln-ui-design',
]);
const STORAGE_PREFIXES = [
  'xln-password-vault:',
  'xln-onboarding-complete:',
  'xln-remote-runtime-accepted:',
  'xln-runtime-recovery-discovery:',
];

// A redeployed testnet retires the chain, so everything derived from it is
// disposable. Vault keys, passwords and preferences are not: the same keys
// re-derive the same Entities on the new deployment, so no confirmation is asked.
const RETIRED_DEPLOYMENT_DATABASES = new Set(['xln-runtime-command-journal-v1']);
const RETIRED_DEPLOYMENT_STORAGE_KEYS = new Set([
  'xln-deploy-version',
  'xln-network-machine-config-v1',
  'xln-remote-runtime-imports',
  'xln-remote-runtime-import-last-result',
  'xln-entity-tabs',
  'xln-jmachines',
  'xln-time-state',
  'xln-push-wake-registrations-v1',
  'xln-ui-recovery',
]);
const RETIRED_DEPLOYMENT_STORAGE_PREFIXES = [
  'xln-onboarding-complete:',
  'xln-remote-runtime-accepted:',
  'xln-runtime-recovery-discovery:',
];

const deleteIndexedDb = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`RESET_INDEXED_DB_DELETE_FAILED:${name}`));
    request.onblocked = () => reject(new Error(`RESET_INDEXED_DB_DELETE_BLOCKED:${name}`));
  });

function clearStorageKeys(storage: Storage, names: ReadonlySet<string>, prefixes: readonly string[]): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (key !== null && (names.has(key) || prefixes.some(prefix => key.startsWith(prefix)))) {
      storage.removeItem(key);
    }
  }
}

async function deleteOwnedDatabases(owned: (name: string) => boolean): Promise<void> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error('RESET_INDEXED_DB_ENUMERATION_UNAVAILABLE');
  }
  const databases = await indexedDB.databases();
  await Promise.all(databases.flatMap(({ name }) => (name && owned(name) ? [deleteIndexedDb(name)] : [])));
}

/** Drop the state of a retired testnet deployment; keys and preferences stay. */
export async function clearRetiredTestnetState(): Promise<void> {
  await deleteOwnedDatabases(name => RETIRED_DEPLOYMENT_DATABASES.has(name) || RUNTIME_DATABASE.test(name));
  for (const storage of [localStorage, sessionStorage]) {
    clearStorageKeys(storage, RETIRED_DEPLOYMENT_STORAGE_KEYS, RETIRED_DEPLOYMENT_STORAGE_PREFIXES);
  }
}

export async function clearBrowserRuntimeData(confirmation: string): Promise<void> {
  if (confirmation !== RESET_CONFIRMATION) throw new Error('RESET_CONFIRMATION_REQUIRED');
  await deleteOwnedDatabases(name => DATABASE_NAMES.has(name) || RUNTIME_DATABASE.test(name));
  for (const storage of [localStorage, sessionStorage]) clearStorageKeys(storage, STORAGE_KEYS, STORAGE_PREFIXES);
}
