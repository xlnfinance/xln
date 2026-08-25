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
      'frontend/apps/site/src/unicast-page.tsx',
      'frontend/apps/site/src/releases-page.tsx',
      'frontend/apps/site/src/reviews-page.tsx',
      'frontend/apps/site/src/market-cap-page.tsx',
    ],
    behavior: ['public navigation', 'install detection', 'deterministic RCPAN dispute microscope', 'broadcast/unicast scale visualization', 'verified release ledger', 'AI review prompt slideshow', 'live market-cap data'],
    status: 'implemented',
  },
  {
    id: 'docs-reader',
    owner: 'docs',
    routes: ['/docs'],
    currentSources: [
      'frontend/src/routes/docs/+page.svelte',
      'frontend/src/lib/docs/docs-page-model.ts',
      'frontend/apps/docs/src/docs-app.tsx',
      'frontend/docs-catalog.js',
    ],
    behavior: ['catalog navigation and search', 'live/archive scope', 'safe Markdown rendering', 'deep links, anchors, and history', 'deterministic docs and llms outputs'],
    status: 'implemented',
  },
  {
    id: 'wallet-shell-and-identity',
    owner: 'wallet',
    routes: ['/app', '/address', '/testnet'],
    currentSources: [
      'frontend/src/routes/app/+page.svelte',
      'frontend/src/routes/address/+page.svelte',
      'frontend/src/routes/testnet/+page.svelte',
      'frontend/apps/wallet/src/testnet-page.tsx',
    ],
    behavior: ['boot and shell', 'identity selection', 'onboarding and settings', 'testnet launcher and disposable identities'],
    status: 'in_progress',
  },
  {
    id: 'wallet-browser-lifecycle',
    owner: 'wallet',
    routes: ['/app', '/testnet'],
    currentSources: [
      'frontend/packages/browser/src/browser-runtime-reset.ts',
      'frontend/packages/browser/src/hard-reset-request.ts',
      'frontend/src/lib/utils/control/resetEverything.ts',
    ],
    behavior: ['validated destructive reset', 'cross-tab reset notification', 'storage, cache, and service-worker cleanup'],
    status: 'in_progress',
  },
  {
    id: 'wallet-runtime-discovery',
    owner: 'wallet',
    routes: ['/app'],
    currentSources: [
      'frontend/packages/browser/src/runtime-adapter-session.ts',
      'frontend/packages/runtime-client/src/runtime-handle.ts',
      'frontend/packages/runtime-client/src/remote-runtime-request.ts',
      'frontend/packages/runtime-client/src/ws-url.ts',
      'frontend/src/lib/utils/runtime/runtimeConnection.ts',
    ],
    behavior: [
      'Runtime discovery',
      'validated hash bootstrap and query rejection',
      'tab-confined Runtime authority and rollback-safe adapter selection',
      'framework-neutral Runtime handle identity, permissions, and readiness',
      'explicit remote attachment consent',
      'reconnect and failure states',
    ],
    status: 'in_progress',
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
    currentSources: [
      'frontend/src/lib/native',
      'frontend/capacitor.config.ts',
      'frontend/config/generated-inputs.ts',
      'frontend/apps/wallet/index.html',
      'frontend/static/site.webmanifest',
      'frontend/static/push-wake-sw.js',
      'frontend/static/route-mode.js',
    ],
    behavior: [
      'deep links',
      'PWA and offline lifecycle',
      'mobile, desktop, and extension packaging',
      'deterministic PWA and push-wake assets',
    ],
    status: 'in_progress',
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
