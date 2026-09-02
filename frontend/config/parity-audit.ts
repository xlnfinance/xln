import type { SurfaceId } from './surfaces';

export type ParityImplementation = 'complete' | 'partial' | 'missing';
export type ParityBrowserEvidence = 'covered' | 'partial' | 'missing';
export type ParityGapKind = 'browser' | 'implementation' | 'owner' | 'owner-decision' | 'verification';

export const PARITY_GAP_IDS = [
  'site-secondary-browser',
  'wallet-app-browser-depth',
  'wallet-irreversible-identity',
  'wallet-recovery-tower-push',
  'wallet-address-route',
  'wallet-external-provider',
  'ops-workspace-route',
  'per-surface-browser-isolation',
] as const;

export type ParityGapId = (typeof PARITY_GAP_IDS)[number];

const capabilityIds = [
  'site-public-information',
  'docs-reader',
  'wallet-shell-and-identity',
  'wallet-browser-lifecycle',
  'wallet-runtime-discovery',
  'wallet-recovery',
  'wallet-finance',
  'wallet-payments-and-markets',
  'wallet-native-and-offline',
  'ops-health-and-qa',
  'ops-runs-scenarios-and-ai',
  'ops-workspace',
] as const;

export type RetainedRouteParity = Readonly<{
  id: string;
  pathname: string;
  representativePath: `/${string}`;
  sveltePage: string;
  intendedOwner: SurfaceId;
  implementation: ParityImplementation;
  browserEvidence: ParityBrowserEvidence;
  reactSource: string | null;
  focusedTests: readonly string[];
  browserTests: readonly string[];
  gapIds: readonly ParityGapId[];
}>;

const candidateBrowser = ['frontend/tests/react-candidate/surfaces.spec.ts'] as const;

export const RETAINED_ROUTE_PARITY = [
  { id: 'home', pathname: '/', representativePath: '/', sveltePage: 'frontend/src/routes/+page.svelte', intendedOwner: 'site', implementation: 'complete', browserEvidence: 'covered', reactSource: 'frontend/apps/site/src/landing-page.tsx', focusedTests: ['tests/frontend/tooling/frontend-site-pilot.test.ts'], browserTests: candidateBrowser, gapIds: ['per-surface-browser-isolation'] },
  { id: 'install', pathname: '/install', representativePath: '/install', sveltePage: 'frontend/src/routes/install/+page.svelte', intendedOwner: 'site', implementation: 'complete', browserEvidence: 'missing', reactSource: 'frontend/apps/site/src/install-page.tsx', focusedTests: ['tests/frontend/tooling/frontend-site-pilot.test.ts'], browserTests: [], gapIds: ['site-secondary-browser', 'per-surface-browser-isolation'] },
  { id: 'rcpan', pathname: '/rcpan', representativePath: '/rcpan', sveltePage: 'frontend/src/routes/rcpan/+page.svelte', intendedOwner: 'site', implementation: 'complete', browserEvidence: 'missing', reactSource: 'frontend/apps/site/src/rcpan-page.tsx', focusedTests: ['tests/frontend/tooling/frontend-rcpan-pilot.test.ts'], browserTests: [], gapIds: ['site-secondary-browser', 'per-surface-browser-isolation'] },
  { id: 'releases', pathname: '/releases', representativePath: '/releases', sveltePage: 'frontend/src/routes/releases/+page.svelte', intendedOwner: 'site', implementation: 'complete', browserEvidence: 'missing', reactSource: 'frontend/apps/site/src/releases-page.tsx', focusedTests: ['tests/frontend/tooling/frontend-releases-pilot.test.ts'], browserTests: [], gapIds: ['site-secondary-browser', 'per-surface-browser-isolation'] },
  { id: 'reviews', pathname: '/reviews', representativePath: '/reviews', sveltePage: 'frontend/src/routes/reviews/+page.svelte', intendedOwner: 'site', implementation: 'complete', browserEvidence: 'missing', reactSource: 'frontend/apps/site/src/reviews-page.tsx', focusedTests: ['tests/frontend/tooling/frontend-reviews-pilot.test.ts'], browserTests: [], gapIds: ['site-secondary-browser', 'per-surface-browser-isolation'] },
  { id: 'unicast', pathname: '/unicast', representativePath: '/unicast', sveltePage: 'frontend/src/routes/unicast/+page.svelte', intendedOwner: 'site', implementation: 'complete', browserEvidence: 'missing', reactSource: 'frontend/apps/site/src/unicast-page.tsx', focusedTests: ['tests/frontend/tooling/frontend-unicast-pilot.test.ts'], browserTests: [], gapIds: ['site-secondary-browser', 'per-surface-browser-isolation'] },
  { id: 'market-cap', pathname: '/market-cap', representativePath: '/market-cap', sveltePage: 'frontend/src/routes/market-cap/+page.svelte', intendedOwner: 'site', implementation: 'complete', browserEvidence: 'missing', reactSource: 'frontend/apps/site/src/market-cap-page.tsx', focusedTests: ['tests/frontend/tooling/frontend-market-cap-pilot.test.ts'], browserTests: [], gapIds: ['site-secondary-browser', 'per-surface-browser-isolation'] },
  { id: 'docs', pathname: '/docs', representativePath: '/docs', sveltePage: 'frontend/src/routes/docs/+page.svelte', intendedOwner: 'docs', implementation: 'complete', browserEvidence: 'covered', reactSource: 'frontend/apps/docs/src/docs-app.tsx', focusedTests: ['tests/frontend/tooling/frontend-docs-pilot.test.ts'], browserTests: candidateBrowser, gapIds: ['per-surface-browser-isolation'] },
  { id: 'wallet-app', pathname: '/app', representativePath: '/app', sveltePage: 'frontend/src/routes/app/+page.svelte', intendedOwner: 'wallet', implementation: 'partial', browserEvidence: 'partial', reactSource: 'frontend/apps/wallet/src/app-shell.tsx', focusedTests: ['tests/frontend/runtime/frontend-wallet-app-shell.test.ts', 'tests/frontend/tooling/frontend-wallet-flow-audit.test.ts'], browserTests: candidateBrowser, gapIds: ['wallet-app-browser-depth', 'wallet-irreversible-identity', 'wallet-recovery-tower-push', 'wallet-external-provider', 'per-surface-browser-isolation'] },
  { id: 'wallet-address', pathname: '/address', representativePath: '/address', sveltePage: 'frontend/src/routes/address/+page.svelte', intendedOwner: 'wallet', implementation: 'missing', browserEvidence: 'missing', reactSource: null, focusedTests: [], browserTests: [], gapIds: ['wallet-address-route', 'per-surface-browser-isolation'] },
  { id: 'wallet-address-entity', pathname: '/address/:entityId', representativePath: '/address/0xabc', sveltePage: 'frontend/src/routes/address/[entityId]/+page.svelte', intendedOwner: 'wallet', implementation: 'missing', browserEvidence: 'missing', reactSource: null, focusedTests: [], browserTests: [], gapIds: ['wallet-address-route', 'per-surface-browser-isolation'] },
  { id: 'testnet', pathname: '/testnet', representativePath: '/testnet', sveltePage: 'frontend/src/routes/testnet/+page.svelte', intendedOwner: 'wallet', implementation: 'complete', browserEvidence: 'covered', reactSource: 'frontend/apps/wallet/src/testnet-page.tsx', focusedTests: ['tests/frontend/tooling/frontend-testnet-pilot.test.ts'], browserTests: candidateBrowser, gapIds: ['per-surface-browser-isolation'] },
  { id: 'health', pathname: '/health', representativePath: '/health', sveltePage: 'frontend/src/routes/health/+page.svelte', intendedOwner: 'ops', implementation: 'complete', browserEvidence: 'covered', reactSource: 'frontend/apps/ops/src/ops-health.tsx', focusedTests: ['tests/frontend/ops/frontend-ops-health.test.ts'], browserTests: candidateBrowser, gapIds: ['per-surface-browser-isolation'] },
  { id: 'qa', pathname: '/qa', representativePath: '/qa', sveltePage: 'frontend/src/routes/qa/+page.svelte', intendedOwner: 'ops', implementation: 'complete', browserEvidence: 'covered', reactSource: 'frontend/apps/ops/src/ops-qa.tsx', focusedTests: ['tests/frontend/ops/frontend-ops-qa.test.ts'], browserTests: candidateBrowser, gapIds: ['per-surface-browser-isolation'] },
  { id: 'qa-hlt', pathname: '/qa/hlt', representativePath: '/qa/hlt', sveltePage: 'frontend/src/routes/qa/hlt/+page.svelte', intendedOwner: 'ops', implementation: 'complete', browserEvidence: 'covered', reactSource: 'frontend/apps/ops/src/ops-hlt.tsx', focusedTests: ['tests/frontend/ops/frontend-ops-hlt.test.ts'], browserTests: candidateBrowser, gapIds: ['per-surface-browser-isolation'] },
  { id: 'qa-quorum', pathname: '/qa/quorum', representativePath: '/qa/quorum', sveltePage: 'frontend/src/routes/qa/quorum/+page.svelte', intendedOwner: 'ops', implementation: 'complete', browserEvidence: 'covered', reactSource: 'frontend/apps/ops/src/ops-quorum.tsx', focusedTests: ['tests/frontend/ops/frontend-ops-quorum.test.ts'], browserTests: candidateBrowser, gapIds: ['per-surface-browser-isolation'] },
  { id: 'runs', pathname: '/runs', representativePath: '/runs', sveltePage: 'frontend/src/routes/runs/+page.svelte', intendedOwner: 'ops', implementation: 'complete', browserEvidence: 'covered', reactSource: 'frontend/apps/ops/src/ops-runs.tsx', focusedTests: ['tests/frontend/ops/frontend-ops-runs.test.ts'], browserTests: candidateBrowser, gapIds: ['per-surface-browser-isolation'] },
  { id: 'scenarios', pathname: '/scenarios', representativePath: '/scenarios', sveltePage: 'frontend/src/routes/scenarios/+page.svelte', intendedOwner: 'ops', implementation: 'complete', browserEvidence: 'covered', reactSource: 'frontend/apps/ops/src/ops-scenarios.tsx', focusedTests: ['tests/frontend/ops/frontend-ops-scenarios.test.ts'], browserTests: candidateBrowser, gapIds: ['per-surface-browser-isolation'] },
  { id: 'ai', pathname: '/ai/:chatId?', representativePath: '/ai/audit', sveltePage: 'frontend/src/routes/ai/[[chatId]]/+page.svelte', intendedOwner: 'ops', implementation: 'complete', browserEvidence: 'covered', reactSource: 'frontend/apps/ops/src/ops-ai.tsx', focusedTests: ['tests/frontend/ops/frontend-ops-ai.test.ts'], browserTests: candidateBrowser, gapIds: ['per-surface-browser-isolation'] },
  { id: 'embed', pathname: '/embed', representativePath: '/embed', sveltePage: 'frontend/src/routes/embed/+page.svelte', intendedOwner: 'ops', implementation: 'partial', browserEvidence: 'partial', reactSource: 'frontend/apps/ops/src/ops-entity-workspace.tsx', focusedTests: ['tests/frontend/ops/frontend-ops-entity-workspace.test.ts'], browserTests: candidateBrowser, gapIds: ['ops-workspace-route', 'per-surface-browser-isolation'] },
] as const satisfies readonly RetainedRouteParity[];

export type ParityGap = Readonly<{
  id: ParityGapId;
  kind: ParityGapKind;
  capabilityIds: readonly string[];
  routeIds: readonly string[];
  evidenceSources: readonly string[];
  nextSlice: string;
}>;

export const PARITY_GAPS = [
  { id: 'site-secondary-browser', kind: 'browser', capabilityIds: ['site-public-information'], routeIds: ['install', 'rcpan', 'releases', 'reviews', 'unicast', 'market-cap'], evidenceSources: ['frontend/tests/react-candidate/surfaces.spec.ts'], nextSlice: 'Add direct three-viewport candidate flows for every secondary site route.' },
  { id: 'wallet-app-browser-depth', kind: 'browser', capabilityIds: ['wallet-shell-and-identity', 'wallet-browser-lifecycle', 'wallet-runtime-discovery', 'wallet-recovery', 'wallet-finance', 'wallet-payments-and-markets'], routeIds: ['wallet-app'], evidenceSources: ['frontend/tests/react-candidate/surfaces.spec.ts', 'frontend/tests/runtime-command-journal.spec.ts'], nextSlice: 'Exercise React wallet shell, lifecycle, finance, payment, and recovery states at all required viewports.' },
  { id: 'wallet-irreversible-identity', kind: 'implementation', capabilityIds: ['wallet-shell-and-identity'], routeIds: ['wallet-app'], evidenceSources: ['frontend/apps/wallet/src/identity-recovery.tsx', 'frontend/config/wallet-flow-audit.ts'], nextSlice: 'Connect the reviewed identity inputs to the existing canonical creation and persistence boundary.' },
  { id: 'wallet-recovery-tower-push', kind: 'implementation', capabilityIds: ['wallet-recovery'], routeIds: ['wallet-app'], evidenceSources: ['frontend/src/lib/utils/recovery', 'frontend/static/push-wake-sw.js'], nextSlice: 'Port tower onboarding, full recovery, and push-wake controls without changing persistence schemas.' },
  { id: 'wallet-address-route', kind: 'implementation', capabilityIds: ['wallet-shell-and-identity', 'wallet-finance'], routeIds: ['wallet-address', 'wallet-address-entity'], evidenceSources: ['frontend/apps/wallet/src/wallet-model.ts', 'frontend/apps/wallet/src/wallet-app.tsx'], nextSlice: 'Implement the public address index and entity detail routes in the React wallet.' },
  { id: 'wallet-external-provider', kind: 'implementation', capabilityIds: ['wallet-payments-and-markets', 'wallet-native-and-offline'], routeIds: ['wallet-app'], evidenceSources: ['frontend/apps/wallet/src/wallet-payments.tsx', 'frontend/src/lib/native'], nextSlice: 'Connect the React payment surface to the existing external-wallet provider and native authority boundary.' },
  { id: 'ops-workspace-route', kind: 'owner-decision', capabilityIds: ['ops-workspace'], routeIds: ['embed'], evidenceSources: ['frontend/apps/ops/src/ops-app.tsx', 'frontend/apps/ops/src/ops-model.ts', 'frontend/apps/ops/src/ops-entity-workspace.tsx'], nextSlice: 'Keep /embed canonical until the owner authorizes the sized Entity workspace expansion and the remaining workspace parity closes.' },
  { id: 'per-surface-browser-isolation', kind: 'verification', capabilityIds, routeIds: RETAINED_ROUTE_PARITY.map(({ id }) => id), evidenceSources: ['frontend/playwright.react.config.ts', 'frontend/package.json'], nextSlice: 'Add per-surface browser commands that do not prepare or launch unrelated applications.' },
] as const satisfies readonly ParityGap[];

export const CAPABILITY_PARITY = [
  { capabilityId: 'site-public-information', gapIds: ['site-secondary-browser', 'per-surface-browser-isolation'] },
  { capabilityId: 'docs-reader', gapIds: ['per-surface-browser-isolation'] },
  { capabilityId: 'wallet-shell-and-identity', gapIds: ['wallet-app-browser-depth', 'wallet-irreversible-identity', 'wallet-address-route', 'per-surface-browser-isolation'] },
  { capabilityId: 'wallet-browser-lifecycle', gapIds: ['wallet-app-browser-depth', 'per-surface-browser-isolation'] },
  { capabilityId: 'wallet-runtime-discovery', gapIds: ['wallet-app-browser-depth', 'per-surface-browser-isolation'] },
  { capabilityId: 'wallet-recovery', gapIds: ['wallet-app-browser-depth', 'wallet-recovery-tower-push', 'per-surface-browser-isolation'] },
  { capabilityId: 'wallet-finance', gapIds: ['wallet-app-browser-depth', 'wallet-address-route', 'per-surface-browser-isolation'] },
  { capabilityId: 'wallet-payments-and-markets', gapIds: ['wallet-app-browser-depth', 'wallet-external-provider', 'per-surface-browser-isolation'] },
  { capabilityId: 'wallet-native-and-offline', gapIds: ['wallet-external-provider', 'per-surface-browser-isolation'] },
  { capabilityId: 'ops-health-and-qa', gapIds: ['per-surface-browser-isolation'] },
  { capabilityId: 'ops-runs-scenarios-and-ai', gapIds: ['per-surface-browser-isolation'] },
  { capabilityId: 'ops-workspace', gapIds: ['ops-workspace-route', 'per-surface-browser-isolation'] },
] as const;

export const CUTOVER_CHECKLIST = [
  { id: 'retained-route-parity', status: 'blocked-by-wp9', evidence: 'frontend/config/parity-audit.ts' },
  { id: 'per-surface-browser-evidence', status: 'blocked-by-wp9', evidence: 'frontend/tests/react-candidate/surfaces.spec.ts' },
  { id: 'immutable-candidate-release', status: 'verified', evidence: 'frontend/scripts/candidate-release-verifier.ts' },
  { id: 'whole-release-rollback', status: 'verified', evidence: 'frontend/scripts/deployment-candidate.ts' },
  { id: 'canonical-commands-and-routing', status: 'owner-authorized-wp10', evidence: 'package.json' },
  { id: 'canonical-artifact-consumers', status: 'owner-authorized-wp10', evidence: 'frontend/config/platform-inventory.ts' },
  { id: 'svelte-source-dependencies-and-config', status: 'owner-authorized-wp10', evidence: 'frontend/package.json' },
  { id: 'production-activation', status: 'release-operation-wp11', evidence: 'scripts/deployment/deploy-platform.sh' },
] as const;
