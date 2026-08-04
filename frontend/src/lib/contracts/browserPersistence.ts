export const VAULT_STORAGE_KEY = 'xln-vaults';

export const VAULT_KEY_DATABASE = Object.freeze({
  name: 'xln-vault-keys-v1',
  version: 1,
  stores: Object.freeze(['keys'] as const),
});

export const RUNTIME_COMMAND_JOURNAL_DATABASE = Object.freeze({
  name: 'xln-runtime-command-journal-v1',
  version: 2,
  stores: Object.freeze(['intents'] as const),
  retiredStores: Object.freeze(['meta'] as const),
});

export const WEB_APP_MANIFEST = Object.freeze({
  path: '/site.webmanifest',
  startUrl: '/app',
  scope: '/',
});

export const PUSH_WAKE_SERVICE_WORKER = Object.freeze({
  path: '/push-wake-sw.js',
  scope: '/',
  defaultOpenPath: '/app',
});

export const NATIVE_WEB_ENTRY = Object.freeze({
  rootPath: '/',
  redirectPath: '/app',
  webDir: '.native-wallet-build',
});

export const BROWSER_PERSISTENCE_CONTRACT = Object.freeze({
  originPolicy: 'same-origin-required',
  localStorage: Object.freeze({
    vaultState: VAULT_STORAGE_KEY,
  }),
  indexedDb: Object.freeze({
    vaultKeys: VAULT_KEY_DATABASE,
    runtimeCommandJournal: RUNTIME_COMMAND_JOURNAL_DATABASE,
  }),
  pwa: WEB_APP_MANIFEST,
  pushWake: PUSH_WAKE_SERVICE_WORKER,
  native: NATIVE_WEB_ENTRY,
});

export type BrowserPersistenceContract = typeof BROWSER_PERSISTENCE_CONTRACT;
