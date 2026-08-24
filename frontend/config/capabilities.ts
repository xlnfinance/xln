import type { SurfaceId } from './surfaces';

export type CapabilityStatus = 'unstarted' | 'in_progress' | 'implemented' | 'verified' | 'blocked';

export type CapabilityDefinition = Readonly<{
  id: string;
  owner: SurfaceId;
  routes: readonly `/${string}`[];
  currentSources: readonly string[];
  behavior: readonly string[];
  status: CapabilityStatus;
}>;

export const CAPABILITIES = [
  {
    id: 'site-public-information',
    owner: 'site',
    routes: ['/', '/install', '/rcpan', '/releases', '/reviews', '/unicast', '/market-cap'],
    currentSources: [
      'frontend/src/routes/+page.svelte',
      'frontend/src/routes/install/+page.svelte',
      'frontend/apps/site/src/landing-page.tsx',
      'frontend/apps/site/src/install-page.tsx',
      'frontend/apps/site/src/rcpan-page.tsx',
    ],
    behavior: ['public navigation', 'install detection', 'deterministic RCPAN dispute microscope', 'live market-cap data'],
    status: 'in_progress',
  },
  {
    id: 'docs-reader',
    owner: 'docs',
    routes: ['/docs'],
    currentSources: ['frontend/src/routes/docs/+page.svelte', 'frontend/docs-catalog.js'],
    behavior: ['catalog navigation', 'safe Markdown rendering', 'deep links and anchors'],
    status: 'unstarted',
  },
  {
    id: 'wallet-shell-and-identity',
    owner: 'wallet',
    routes: ['/app', '/address'],
    currentSources: ['frontend/src/routes/app/+page.svelte', 'frontend/src/routes/address/+page.svelte'],
    behavior: ['boot and shell', 'identity selection', 'onboarding and settings'],
    status: 'unstarted',
  },
  {
    id: 'wallet-runtime-discovery',
    owner: 'wallet',
    routes: ['/app'],
    currentSources: ['frontend/src/lib/utils/runtime/runtimeConnection.ts'],
    behavior: ['Runtime discovery', 'remote attachment', 'reconnect and failure states'],
    status: 'unstarted',
  },
  {
    id: 'wallet-recovery',
    owner: 'wallet',
    routes: ['/app'],
    currentSources: ['frontend/src/lib/utils/recovery'],
    behavior: ['tower onboarding', 'recovery', 'push wake'],
    status: 'unstarted',
  },
  {
    id: 'wallet-finance',
    owner: 'wallet',
    routes: ['/app', '/address'],
    currentSources: ['frontend/src/lib/components/Entity'],
    behavior: ['assets and accounts', 'credit and collateral', 'debt, solvency, and disputes'],
    status: 'unstarted',
  },
  {
    id: 'wallet-payments-and-markets',
    owner: 'wallet',
    routes: ['/app'],
    currentSources: ['frontend/src/lib/components/Entity/swap'],
    behavior: ['pay and receive', 'invoices and moves', 'orders, routing, and settlement'],
    status: 'unstarted',
  },
  {
    id: 'wallet-native-and-offline',
    owner: 'wallet',
    routes: ['/app'],
    currentSources: ['frontend/src/lib/native', 'frontend/capacitor.config.ts'],
    behavior: ['deep links', 'PWA and offline lifecycle', 'mobile, desktop, and extension packaging'],
    status: 'unstarted',
  },
  {
    id: 'ops-health-and-qa',
    owner: 'ops',
    routes: ['/health', '/qa', '/qa/hlt'],
    currentSources: ['frontend/src/routes/health/+page.svelte', 'frontend/src/routes/qa/+page.svelte'],
    behavior: ['health state', 'QA evidence', 'HLT controls and results'],
    status: 'unstarted',
  },
  {
    id: 'ops-runs-scenarios-and-ai',
    owner: 'ops',
    routes: ['/runs', '/scenarios', '/ai', '/embed'],
    currentSources: ['frontend/src/routes/runs/+page.svelte', 'frontend/src/routes/scenarios/+page.svelte'],
    behavior: ['run inspection', 'scenario execution', 'AI sessions and embed mode'],
    status: 'unstarted',
  },
  {
    id: 'ops-workspace',
    owner: 'ops',
    routes: ['/embed'],
    currentSources: ['frontend/src/lib/components/Workspace'],
    behavior: ['Dockview layout', 'Graph3D and Architect', 'Runtime I/O, console, and Time Machine'],
    status: 'unstarted',
  },
] as const satisfies readonly CapabilityDefinition[];
