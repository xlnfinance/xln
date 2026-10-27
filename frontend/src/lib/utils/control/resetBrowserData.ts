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

const deleteIndexedDb = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`RESET_INDEXED_DB_DELETE_FAILED:${name}`));
    request.onblocked = () => reject(new Error(`RESET_INDEXED_DB_DELETE_BLOCKED:${name}`));
  });

function clearOwnedStorage(storage: Storage): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (key !== null && (STORAGE_KEYS.has(key) || STORAGE_PREFIXES.some(prefix => key.startsWith(prefix)))) {
      storage.removeItem(key);
    }
  }
}

export async function clearBrowserRuntimeData(confirmation: string): Promise<void> {
  if (confirmation !== RESET_CONFIRMATION) throw new Error('RESET_CONFIRMATION_REQUIRED');
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error('RESET_INDEXED_DB_ENUMERATION_UNAVAILABLE');
  }
  const databases = await indexedDB.databases();
  const names = databases.flatMap(({ name }) =>
    name && (DATABASE_NAMES.has(name) || RUNTIME_DATABASE.test(name)) ? [name] : [],
  );
  await Promise.all(names.map(deleteIndexedDb));
  clearOwnedStorage(localStorage);
  clearOwnedStorage(sessionStorage);
}
