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
      'frontend/packages/browser/src/runtime-command-intent.ts',
      'frontend/packages/browser/src/runtime-command-intent-codec.ts',
      'frontend/packages/browser/src/runtime-command-journal-indexed-db.ts',
      'frontend/packages/browser/src/runtime-command-journal-keyring.ts',
      'frontend/packages/browser/src/runtime-command-journal-storage.ts',
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
      'frontend/packages/runtime-client/src/admin-health.ts',
      'frontend/packages/runtime-client/src/rpc-health.ts',
      'frontend/packages/runtime-client/src/boundary.ts',
      'frontend/apps/ops/src/ops-health-source.ts',
      'frontend/apps/ops/src/ops-health-runtime.ts',
    ],
    consumers: ['frontend/apps/ops/src/ops-health.tsx'],
    evidence: ['tests/frontend/ops/frontend-ops-health.test.ts'],
  },
  {
    id: 'ops-hlt-browser-boundary',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'implemented',
    interfaces: ['route'],
    sources: [
      'frontend/packages/runtime-client/src/qa-hlt.ts',
      'frontend/apps/ops/src/ops-hlt-model.ts',
      'frontend/apps/ops/src/ops-hlt-source.ts',
      'frontend/apps/ops/src/ops-hlt-runtime.ts',
    ],
    consumers: [
      'frontend/apps/ops/src/ops-hlt-controls.tsx',
      'frontend/apps/ops/src/ops-hlt-progress.tsx',
      'frontend/apps/ops/src/ops-hlt.tsx',
    ],
    evidence: ['tests/frontend/ops/frontend-ops-hlt.test.ts'],
  },
  {
    id: 'ops-qa-browser-boundary',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'implemented',
    interfaces: ['route', 'session-storage'],
    sources: [
      'core/config/qa.ts',
      'frontend/packages/browser/src/qa-api-client.ts',
      'frontend/packages/runtime-client/src/qa-admin-evidence.ts',
      'frontend/packages/runtime-client/src/qa-boundary.ts',
      'frontend/packages/runtime-client/src/qa-cockpit-helpers.ts',
      'frontend/packages/runtime-client/src/qa-performance-trend.ts',
      'frontend/packages/runtime-client/src/qa-scenario-player.ts',
      'frontend/packages/runtime-client/src/qa-test-ledger.ts',
      'frontend/packages/runtime-client/src/qa-types.ts',
      'frontend/apps/ops/src/ops-qa-model.ts',
      'frontend/apps/ops/src/ops-qa-source.ts',
      'frontend/apps/ops/src/ops-qa-actions.ts',
      'frontend/apps/ops/src/ops-qa-runtime.ts',
    ],
    consumers: [
      'frontend/apps/ops/src/ops-qa.tsx',
      'frontend/apps/ops/src/ops-qa-run.tsx',
      'frontend/apps/ops/src/ops-qa-gallery.tsx',
      'frontend/apps/ops/src/ops-qa-history.tsx',
    ],
    evidence: [
      'tests/frontend/ops/frontend-ops-qa.test.ts',
      'tests/frontend/qa/boundary.test.ts',
      'tests/frontend/qa/qa-test-ledger.test.ts',
    ],
  },
  {
    id: 'ops-runs-scenarios-browser-boundary',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'implemented',
    interfaces: ['route'],
    sources: [
      'frontend/packages/browser/src/runtime-scenario-source.ts',
      'frontend/packages/runtime-client/src/scenario-player-model.ts',
      'frontend/packages/runtime-client/src/scenario-runtime.ts',
      'frontend/apps/ops/src/ops-runs-model.ts',
      'frontend/apps/ops/src/ops-runs-source.ts',
      'frontend/apps/ops/src/ops-runs-runtime.ts',
      'frontend/apps/ops/src/ops-scenarios-runtime.ts',
      'frontend/apps/wallet/src/wallet-scenario-preview-runtime.ts',
    ],
    consumers: [
      'frontend/apps/ops/src/ops-runs.tsx',
      'frontend/apps/ops/src/ops-scenarios.tsx',
      'frontend/apps/wallet/src/wallet-scenario-preview.tsx',
    ],
    evidence: [
      'core/__tests__/scenarios/browser-api.test.ts',
      'tests/frontend/ops/frontend-ops-runs.test.ts',
      'tests/frontend/ops/frontend-ops-scenarios.test.ts',
      'tests/frontend/runtime/runtime-scenario-source.test.ts',
    ],
  },
  {
    id: 'ops-ai-browser-boundary',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'implemented',
    interfaces: ['route'],
    sources: [
      'frontend/apps/ops/src/ops-ai-decode.ts',
      'frontend/apps/ops/src/ops-ai-model.ts',
      'frontend/apps/ops/src/ops-ai-source.ts',
      'frontend/apps/ops/src/ops-ai-runtime.ts',
      'frontend/packages/ui/src/stable-compare.ts',
    ],
    consumers: [
      'frontend/apps/ops/src/ops-ai.tsx',
      'frontend/apps/ops/src/ops-ai-header.tsx',
      'frontend/apps/ops/src/ops-ai-messages.tsx',
      'frontend/apps/ops/src/ops-ai-sidebar.tsx',
    ],
    evidence: [
      'tests/frontend/ops/frontend-ops-ai.test.ts',
    ],
  },
  {
    id: 'ops-workspace-boot-boundary',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'implemented',
    interfaces: ['route'],
    sources: [
      'frontend/packages/runtime-client/src/embed-boot-model.ts',
      'frontend/packages/runtime-client/src/demo-playback-intent.ts',
    ],
    consumers: [
      'frontend/src/routes/embed/+page.svelte',
      'frontend/src/lib/stores/network/networkMachineDemoStore.ts',
    ],
    evidence: [
      'tests/frontend/runtime/embed-boot-model.test.ts',
      'tests/frontend/graph/network-machine-demo.test.ts',
    ],
  },
  {
    id: 'ops-workspace-panel-projections',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'implemented',
    interfaces: ['route'],
    sources: [
      'frontend/packages/runtime-client/src/console-panel-view.ts',
      'frontend/packages/runtime-client/src/runtime-io-panel-view.ts',
      'frontend/packages/runtime-client/src/solvency-panel-view.ts',
      'frontend/packages/runtime-client/src/runtime-diagnostics-panel-view.ts',
      'frontend/packages/runtime-client/src/gossip-panel-view.ts',
      'frontend/packages/runtime-client/src/time-machine-transport.ts',
      'frontend/packages/runtime-client/src/jurisdiction-panel-view.ts',
      'frontend/packages/runtime-client/src/settings-panel-view.ts',
      'frontend/packages/runtime-client/src/architect-panel-view.ts',
      'frontend/packages/runtime-client/src/graph3d-entity-panel-view.ts',
      'frontend/packages/runtime-client/src/graph3d-viewport-view.ts',
      'frontend/packages/runtime-client/src/graph3d-scene-input.ts',
    ],
    consumers: [
      'frontend/src/lib/view/panels/ConsolePanel.svelte',
      'frontend/src/lib/view/panels/RuntimeIOPanel.svelte',
      'frontend/src/lib/view/panels/solvency/solvency-panel-view.ts',
      'frontend/src/lib/view/panels/solvency/SolvencyPanel.svelte',
      'frontend/src/lib/view/panels/RuntimeDiagnosticsPanel.svelte',
      'frontend/src/lib/view/panels/GossipPanel.svelte',
      'frontend/src/lib/components/Entity/activity/gossip-directory-view.ts',
      'frontend/src/lib/stores/runtimeHistoryStore.ts',
      'frontend/src/lib/view/panels/JurisdictionPanel.svelte',
      'frontend/src/lib/view/panels/SettingsPanel.svelte',
      'frontend/src/lib/view/panels/ArchitectPanel.svelte',
      'frontend/src/lib/view/components/EntityMiniPanel.svelte',
      'frontend/src/lib/view/components/Graph3DViewport.svelte',
      'frontend/src/lib/view/components/Graph3DFpsOverlay.svelte',
      'frontend/src/lib/view/components/VRControlsHUD.svelte',
      'frontend/src/lib/network3d/runtimeGraphProjection.ts',
      'frontend/src/lib/stores/network/runtimeGraphControlStore.ts',
    ],
    evidence: [
      'tests/frontend/runtime/console-panel-view.test.ts',
      'tests/frontend/runtime/runtime-io-panel-view.test.ts',
      'tests/frontend/runtime/solvency-panel-view.test.ts',
      'tests/frontend/runtime/runtime-diagnostics-panel-view.test.ts',
      'tests/frontend/runtime/gossip-panel-view.test.ts',
      'tests/frontend/runtime/time-machine-transport.test.ts',
      'tests/frontend/runtime/jurisdiction-panel-view.test.ts',
      'tests/frontend/runtime/settings-panel-view.test.ts',
      'tests/frontend/runtime/architect-panel-view.test.ts',
      'tests/frontend/graph/graph3d-entity-panel-view.test.ts',
      'tests/frontend/graph/graph3d-viewport-view.test.ts',
      'tests/frontend/graph/graph3d-scene-input.test.ts',
    ],
  },
  {
    id: 'ops-entity-workspace-navigation',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'implemented',
    interfaces: ['route', 'registry', 'session-storage', 'ui'],
    sources: [
      'frontend/packages/runtime-client/src/entity-workspace-navigation.ts',
      'frontend/packages/runtime-client/src/entity-workspace-context.ts',
      'frontend/packages/runtime-client/src/entity-workspace-accounts.ts',
      'frontend/packages/runtime-client/src/entity-workspace-ownership.ts',
      'frontend/packages/ui/src/entity-workspace-display.ts',
      'frontend/packages/ui/src/entity-workspace-accounts-panel.tsx',
      'frontend/packages/ui/src/entity-workspace-accounts-panel.css',
      'frontend/packages/ui/src/entity-workspace-shell.tsx',
      'frontend/packages/ui/src/entity-workspace-shell.css',
      'frontend/apps/ops/src/ops-entity-workspace.tsx',
      'frontend/apps/ops/src/ops-entity-workspace-source.ts',
      'frontend/apps/ops/src/ops-entity-workspace-runtime.ts',
    ],
    consumers: [
      'frontend/src/lib/components/Entity/workspace/entity-panel-routing.ts',
      'frontend/src/lib/components/Entity/workspace/entity-panel-display.ts',
      'frontend/src/lib/components/Entity/workspace/shell/EntityPanelTabs.svelte',
      'frontend/apps/ops/src/ops-app.tsx',
      'frontend/apps/ops/src/main.tsx',
      'frontend/apps/ops/src/ops-model.ts',
    ],
    evidence: [
      'tests/frontend/workspace/entity-panel-routing.test.ts',
      'tests/frontend/workspace/entity-panel-display.test.ts',
      'tests/frontend/workspace/entity-workspace-context.test.ts',
      'tests/frontend/workspace/entity-workspace-accounts.test.ts',
      'tests/frontend/workspace/entity-workspace-ownership.test.ts',
      'tests/frontend/ops/frontend-ops-entity-workspace.test.ts',
      'tests/frontend/ops/frontend-ops-entity-runtime-read.test.ts',
      'tests/e2e/runtime/e2e-react-entity-workspace.spec.ts',
      'frontend/tests/react-candidate/surfaces.spec.ts',
    ],
  },
  {
    id: 'ops-workspace-dock-layout',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'implemented',
    interfaces: ['local-storage', 'registry'],
    sources: ['frontend/packages/runtime-client/src/workspace-dock-layout.ts'],
    consumers: [
      'frontend/packages/ui/src/workspace-dock.tsx',
      'frontend/src/lib/view/DockRoot.svelte',
    ],
    evidence: ['tests/frontend/workspace/workspace-dock-layout.test.ts'],
  },
  {
    id: 'ops-workspace-graph3d-lifecycle',
    owner: 'ops',
    workPackage: 'WP7',
    status: 'implemented',
    interfaces: ['registry'],
    sources: [
      'frontend/packages/ui/src/graph3d-lifecycle.ts',
      'frontend/packages/ui/src/graph3d-renderer.ts',
      'frontend/packages/ui/src/graph3d-scene-primitives.ts',
      'frontend/packages/ui/src/graph3d-visual-effects.ts',
      'frontend/packages/ui/src/graph3d-entity-visuals.ts',
      'frontend/packages/ui/src/graph3d-account-visuals.ts',
      'frontend/packages/ui/src/graph3d-camera.ts',
      'frontend/packages/ui/src/graph3d-hover.ts',
      'frontend/packages/ui/src/graph3d-interaction.ts',
      'frontend/src/lib/utils/runtime/debugSurface.ts',
    ],
    consumers: [
      'frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte',
      'frontend/src/lib/view/panels/graph3d/graph3d-visuals.ts',
    ],
    evidence: [
      'tests/frontend/graph/graph3d-lifecycle.test.ts',
      'tests/frontend/graph/graph3d-renderer.test.ts',
      'tests/frontend/graph/graph3d-scene-primitives.test.ts',
      'tests/frontend/graph/graph3d-visual-effects.test.ts',
      'tests/frontend/graph/graph3d-entity-visuals.test.ts',
      'tests/frontend/graph/graph3d-account-visuals.test.ts',
      'tests/frontend/graph/graph3d-camera.test.ts',
      'tests/frontend/graph/graph3d-hover.test.ts',
      'tests/frontend/graph/graph3d-interaction.test.ts',
    ],
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
