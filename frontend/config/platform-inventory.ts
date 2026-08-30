import type { SurfaceId } from './surfaces';

export type PlatformInventoryOwner = SurfaceId | 'assembly';
export type PlatformInventoryStatus = 'implemented' | 'owned-for-later-wp';
export type PlatformInterface =
  | 'asset'
  | 'broadcast-channel'
  | 'cache-storage'
  | 'capacitor'
  | 'dedicated-worker'
  | 'desktop-shell'
  | 'extension-shell'
  | 'indexed-db'
  | 'local-storage'
  | 'registry'
  | 'release-artifact'
  | 'route'
  | 'service-worker'
  | 'session-storage'
  | 'verification-command'
  | 'web-locks';

export type PlatformInventoryEntry = Readonly<{
  id: string;
  owner: PlatformInventoryOwner;
  workPackage: `WP${number}`;
  status: PlatformInventoryStatus;
  interfaces: readonly PlatformInterface[];
  sources: readonly string[];
  consumers: readonly string[];
  evidence: readonly string[];
}>;

export const PLATFORM_INVENTORY = [
  {
    id: 'route-capability-ownership',
    owner: 'assembly',
    workPackage: 'WP0',
    status: 'implemented',
    interfaces: ['route', 'registry'],
    sources: [
      'frontend/config/surfaces.ts',
      'frontend/config/capabilities.ts',
      'frontend/config/development-gateway.ts',
    ],
    consumers: [
      'frontend/scripts/dev-gateway.ts',
      'frontend/scripts/candidate-release.ts',
    ],
    evidence: [
      'tests/frontend/tooling/frontend-route-ownership.test.ts',
      'tests/frontend/tooling/frontend-capability-coverage.test.ts',
      'tests/frontend/tooling/frontend-development-gateway.test.ts',
    ],
  },
  {
    id: 'frontend-verification-commands',
    owner: 'assembly',
    workPackage: 'WP0',
    status: 'implemented',
    interfaces: ['verification-command'],
    sources: ['package.json', 'frontend/package.json', 'frontend/scripts/check.ts'],
    consumers: ['frontend/scripts/build.ts', 'frontend/scripts/assemble.ts'],
    evidence: [
      'tests/frontend/tooling/frontend-check-scope.test.ts',
      'tests/frontend/tooling/frontend-build-isolation.test.ts',
    ],
  },
  {
    id: 'deterministic-generated-inputs',
    owner: 'assembly',
    workPackage: 'WP2',
    status: 'implemented',
    interfaces: ['asset', 'release-artifact', 'registry'],
    sources: [
      'frontend/config/generated-inputs.ts',
      'frontend/scripts/generated-inputs.ts',
      'frontend/scripts/generated-input-manifest.ts',
    ],
    consumers: ['frontend/scripts/prepare.ts', 'frontend/scripts/candidate-release.ts'],
    evidence: [
      'tests/frontend/tooling/frontend-input-ownership.test.ts',
      'tests/frontend/tooling/frontend-generated-inputs.test.ts',
      'tests/frontend/tooling/frontend-candidate-assembly.test.ts',
    ],
  },
  {
    id: 'runtime-adapter-session-storage',
    owner: 'wallet',
    workPackage: 'WP5',
    status: 'implemented',
    interfaces: ['local-storage', 'session-storage'],
    sources: ['frontend/packages/browser/src/runtime-adapter-session.ts'],
    consumers: [
      'frontend/src/lib/utils/runtime/runtimeConnection.ts',
      'frontend/apps/wallet/src/app-shell.tsx',
    ],
    evidence: ['tests/frontend/runtime/runtime-adapter-session.test.ts'],
  },
  {
    id: 'wallet-durable-custody-storage',
    owner: 'wallet',
    workPackage: 'WP9',
    status: 'owned-for-later-wp',
    interfaces: ['indexed-db', 'local-storage', 'web-locks'],
    sources: [
      'frontend/src/lib/security/vaultProtection.ts',
      'frontend/src/lib/stores/commands/runtimeCommandJournalIndexedDb.ts',
      'frontend/src/lib/stores/commands/runtimeCommandIntent.ts',
      'frontend/src/lib/stores/vault/vaultStore.ts',
    ],
    consumers: ['frontend/src/routes/app/+layout.svelte'],
    evidence: [
      'tests/frontend/security/vault-protection.test.ts',
      'tests/frontend/recovery/storage-schema-recovery.test.ts',
    ],
  },
  {
    id: 'runtime-tab-coordination',
    owner: 'wallet',
    workPackage: 'WP5',
    status: 'implemented',
    interfaces: ['broadcast-channel', 'session-storage', 'web-locks'],
    sources: [
      'frontend/packages/browser/src/active-tab-lock.ts',
      'frontend/packages/browser/src/active-tab-lock-support.ts',
    ],
    consumers: [
      'frontend/src/lib/utils/control/activeTabLock.ts',
      'frontend/apps/wallet/src/wallet-embedded-runtime.ts',
    ],
    evidence: [
      'tests/frontend/runtime/active-tab-lock.test.ts',
      'tests/e2e/runtime/e2e-active-tab-lock.spec.ts',
    ],
  },
  {
    id: 'embedded-runtime-browser-session',
    owner: 'wallet',
    workPackage: 'WP5',
    status: 'implemented',
    interfaces: ['asset', 'indexed-db', 'web-locks'],
    sources: [
      'frontend/packages/browser/src/runtime-module-loader.ts',
      'frontend/packages/browser/src/wallet-embedded-runtime-session.ts',
      'frontend/packages/browser/src/wallet-runtime-suspension.ts',
      'frontend/apps/wallet/src/wallet-embedded-runtime-adapter.ts',
      'frontend/apps/wallet/src/wallet-embedded-runtime-bootstrap.ts',
      'frontend/apps/wallet/src/wallet-embedded-runtime.ts',
    ],
    consumers: [
      'frontend/apps/wallet/src/app-shell.tsx',
      'frontend/apps/wallet/src/wallet-runtime-read-boundary.ts',
      'frontend/src/lib/stores/bootstrap/xlnRuntimeLoader.ts',
      'frontend/src/lib/stores/vault/vaultStore.ts',
    ],
    evidence: [
      'tests/frontend/runtime/runtime-module-loader.test.ts',
      'tests/frontend/runtime/wallet-embedded-runtime-session.test.ts',
      'tests/frontend/runtime/wallet-runtime-suspension.test.ts',
      'tests/frontend/runtime/frontend-wallet-app-shell.test.ts',
    ],
  },
  {
    id: 'browser-runtime-reset',
    owner: 'wallet',
    workPackage: 'WP5',
    status: 'implemented',
    interfaces: ['cache-storage', 'indexed-db', 'service-worker'],
    sources: [
      'frontend/packages/browser/src/browser-runtime-reset.ts',
      'frontend/packages/browser/src/hard-reset-request.ts',
    ],
    consumers: [
      'frontend/src/lib/utils/control/resetEverything.ts',
      'frontend/apps/wallet/src/testnet-page.tsx',
    ],
    evidence: [
      'tests/frontend/control/reset-everything.test.ts',
      'tests/frontend/tooling/frontend-testnet-pilot.test.ts',
    ],
  },
  {
    id: 'brainvault-worker-boundary',
    owner: 'wallet',
    workPackage: 'WP5',
    status: 'implemented',
    interfaces: ['dedicated-worker', 'local-storage'],
    sources: [
      'frontend/packages/browser/src/wallet-brainvault-worker-validation.ts',
      'frontend/packages/browser/src/wallet-brainvault-worker-scheduling.ts',
      'frontend/packages/browser/src/wallet-brainvault-worker-resilience.ts',
    ],
    consumers: [
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'frontend/apps/wallet/src/wallet-settings-model.ts',
    ],
    evidence: [
      'tests/frontend/onboarding/wallet-brainvault-worker-validation.test.ts',
      'tests/frontend/onboarding/wallet-brainvault-worker-scheduling.test.ts',
      'tests/frontend/onboarding/wallet-brainvault-worker-resilience.test.ts',
    ],
  },
  {
    id: 'push-wake-service-worker',
    owner: 'wallet',
    workPackage: 'WP8',
    status: 'owned-for-later-wp',
    interfaces: ['asset', 'local-storage', 'service-worker'],
    sources: [
      'frontend/static/push-wake-sw.js',
      'frontend/src/lib/utils/recovery/pushWakeRegistration.ts',
    ],
    consumers: ['frontend/src/lib/components/Settings/PushWakePanel.svelte'],
    evidence: ['tests/frontend/recovery/push-wake-registration.test.ts'],
  },
  {
    id: 'native-and-packaged-consumers',
    owner: 'wallet',
    workPackage: 'WP8',
    status: 'owned-for-later-wp',
    interfaces: ['capacitor', 'desktop-shell', 'extension-shell', 'release-artifact'],
    sources: [
      'frontend/capacitor.config.ts',
      'frontend/src/lib/native/capacitor.ts',
      'frontend/src/lib/native/deeplink.ts',
      'native/desktop/main.cjs',
      'native/extension/manifest.json',
    ],
    consumers: ['scripts/native/build-platforms.ts'],
    evidence: [
      'native/__tests__/capacitor-config.test.ts',
      'native/__tests__/native-deeplink.test.ts',
      'native/__tests__/desktop-security.test.ts',
      'native/__tests__/extension-security.test.ts',
    ],
  },
  {
    id: 'ops-health-browser-boundary',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'implemented',
    interfaces: ['route'],
    sources: [
      'frontend/src/lib/health/adminHealth.ts',
      'frontend/src/lib/health/rpcHealth.ts',
      'frontend/apps/ops/src/ops-health-source.ts',
      'frontend/apps/ops/src/ops-health-runtime.ts',
    ],
    consumers: ['frontend/apps/ops/src/ops-health.tsx'],
    evidence: ['tests/frontend/ops/frontend-ops-health.test.ts'],
  },
  {
    id: 'ops-workspace-registries',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'owned-for-later-wp',
    interfaces: ['local-storage', 'registry'],
    sources: [
      'frontend/src/lib/view/DockRoot.svelte',
      'frontend/src/lib/components/shared/CommandPalette.svelte',
      'frontend/src/lib/i18n/index.ts',
    ],
    consumers: ['frontend/src/lib/view/View.svelte'],
    evidence: [
      'tests/frontend/command-palette-view.test.ts',
      'tests/frontend/workspace/dockroot-runtime-projection.test.ts',
    ],
  },
  {
    id: 'candidate-release-consumers',
    owner: 'assembly',
    workPackage: 'WP8',
    status: 'owned-for-later-wp',
    interfaces: ['release-artifact'],
    sources: ['frontend/scripts/candidate-release.ts'],
    consumers: [
      'scripts/release/build-xlnfinance-package.ts',
      'scripts/native/build-platforms.ts',
      'scripts/deployment/deploy-platform.sh',
    ],
    evidence: [
      'tests/frontend/tooling/frontend-candidate-assembly.test.ts',
      'native/__tests__/native-build-options.test.ts',
    ],
  },
] as const satisfies readonly PlatformInventoryEntry[];
