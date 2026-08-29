import type { WalletAppView } from '../apps/wallet/src/app-shell-model';

export type WalletFlowAuditEntry = Readonly<{
  id: string;
  pathname: '/app' | '/testnet';
  search: string;
  page: 'app' | 'testnet';
  view: WalletAppView | null;
  sources: readonly string[];
  tests: readonly string[];
}>;

export type WalletFlowDeferral = Readonly<{
  id: string;
  destination: 'WP5' | 'WP8' | 'WP9' | 'WP10';
  evidenceSource: string;
  evidenceMarker: string;
  reason: string;
}>;

export type WalletRequirementAudit = Readonly<{
  id: string;
  group: 1 | 2 | 3 | 4;
  disposition: 'implemented' | 'deferred';
  evidenceId: string;
}>;

export const WALLET_FLOW_AUDIT = [
  {
    id: 'testnet-launcher',
    pathname: '/testnet',
    search: '',
    page: 'testnet',
    view: null,
    sources: [
      'frontend/apps/wallet/src/testnet-model.ts',
      'frontend/apps/wallet/src/testnet-page.tsx',
    ],
    tests: ['tests/frontend/tooling/frontend-testnet-pilot.test.ts'],
  },
  {
    id: 'runtime-overview-shell',
    pathname: '/app',
    search: '',
    page: 'app',
    view: 'overview',
    sources: [
      'frontend/apps/wallet/src/app-shell-model.ts',
      'frontend/apps/wallet/src/app-shell.tsx',
    ],
    tests: ['tests/frontend/runtime/frontend-wallet-app-shell.test.ts'],
  },
  {
    id: 'identity-entry-and-rehearsal',
    pathname: '/app',
    search: '?setup=1',
    page: 'app',
    view: 'identity',
    sources: [
      'frontend/apps/wallet/src/identity-onboarding-model.ts',
      'frontend/apps/wallet/src/identity-onboarding.tsx',
      'frontend/apps/wallet/src/identity-recovery.tsx',
    ],
    tests: [
      'tests/frontend/onboarding/frontend-wallet-identity-onboarding.test.ts',
      'tests/frontend/onboarding/frontend-wallet-recovery-rehearsal.test.ts',
    ],
  },
  {
    id: 'preferences',
    pathname: '/app',
    search: '?settings=1',
    page: 'app',
    view: 'settings',
    sources: [
      'frontend/apps/wallet/src/wallet-settings-model.ts',
      'frontend/apps/wallet/src/wallet-settings.tsx',
    ],
    tests: ['tests/frontend/onboarding/frontend-wallet-preferences.test.ts'],
  },
  {
    id: 'diagnostics',
    pathname: '/app',
    search: '?diagnostics=1',
    page: 'app',
    view: 'diagnostics',
    sources: [
      'frontend/apps/wallet/src/wallet-diagnostics-model.ts',
      'frontend/apps/wallet/src/wallet-diagnostics.tsx',
    ],
    tests: ['tests/frontend/diagnostics/frontend-wallet-diagnostics.test.ts'],
  },
  {
    id: 'assets-and-accounts',
    pathname: '/app',
    search: '?portfolio=1',
    page: 'app',
    view: 'portfolio',
    sources: [
      'frontend/apps/wallet/src/wallet-portfolio-model.ts',
      'frontend/apps/wallet/src/wallet-portfolio-source.ts',
      'frontend/apps/wallet/src/wallet-portfolio.tsx',
    ],
    tests: ['tests/frontend/runtime/frontend-wallet-portfolio.test.ts'],
  },
  {
    id: 'financial-health',
    pathname: '/app',
    search: '?health=1',
    page: 'app',
    view: 'health',
    sources: [
      'frontend/apps/wallet/src/wallet-financial-health-model.ts',
      'frontend/apps/wallet/src/wallet-financial-health-source.ts',
      'frontend/apps/wallet/src/wallet-financial-health.tsx',
    ],
    tests: ['tests/frontend/runtime/frontend-wallet-financial-health.test.ts'],
  },
  {
    id: 'payments',
    pathname: '/app',
    search: '?payments=1',
    page: 'app',
    view: 'payments',
    sources: [
      'frontend/apps/wallet/src/wallet-payment-model.ts',
      'frontend/apps/wallet/src/wallet-payment-source.ts',
      'frontend/apps/wallet/src/wallet-payments.tsx',
    ],
    tests: ['tests/frontend/payments/frontend-wallet-payments.test.ts'],
  },
  {
    id: 'markets-and-activity',
    pathname: '/app',
    search: '?markets=1',
    page: 'app',
    view: 'markets',
    sources: [
      'frontend/apps/wallet/src/wallet-market-model.ts',
      'frontend/apps/wallet/src/wallet-market-source.ts',
      'frontend/apps/wallet/src/wallet-markets.tsx',
    ],
    tests: ['tests/frontend/markets/frontend-wallet-markets.test.ts'],
  },
] as const satisfies readonly WalletFlowAuditEntry[];

export const WALLET_FLOW_DEFERRALS = [
  {
    id: 'embedded-runtime-boot',
    destination: 'WP5',
    evidenceSource: 'frontend/apps/wallet/src/wallet-payment-source.ts',
    evidenceMarker: 'The React embedded Runtime boot flow is not active yet.',
    reason: 'The canonical browser Runtime bundle must be restored before React can own embedded activation.',
  },
  {
    id: 'wallet-creation-and-onboarding',
    destination: 'WP9',
    evidenceSource: 'frontend/apps/wallet/src/identity-recovery.tsx',
    evidenceMarker: 'No wallet has been created and no secret has left this form.',
    reason: 'WP6 owns validated entry and rehearsal, not irreversible creation or persistence.',
  },
  {
    id: 'full-recovery',
    destination: 'WP9',
    evidenceSource: 'frontend/apps/wallet/src/identity-recovery.tsx',
    evidenceMarker: 'No wallet has been created or persisted by this rehearsal.',
    reason: 'Tower and durable recovery remain canonical until complete React parity is proven.',
  },
  {
    id: 'address-route',
    destination: 'WP9',
    evidenceSource: 'frontend/apps/wallet/src/wallet-app.tsx',
    evidenceMarker: 'remains on the canonical Svelte wallet while its React flow is migrated',
    reason: 'The retained public address route still needs a React owner before parity can close.',
  },
  {
    id: 'external-wallet-provider',
    destination: 'WP8',
    evidenceSource: 'frontend/apps/wallet/src/wallet-payments.tsx',
    evidenceMarker: 'External-wallet moves are excluded until the React provider boundary is live',
    reason: 'Provider, native, and offline authority must be integrated with artifact consumers.',
  },
  {
    id: 'canonical-cutover',
    destination: 'WP10',
    evidenceSource: 'frontend/apps/wallet/src/wallet-app.tsx',
    evidenceMarker: 'canonical Svelte wallet',
    reason: 'Production framework cutover remains an explicit owner-authorized operation.',
  },
] as const satisfies readonly WalletFlowDeferral[];

export const WALLET_REQUIREMENT_AUDIT = [
  { id: 'boot', group: 1, disposition: 'deferred', evidenceId: 'embedded-runtime-boot' },
  { id: 'shell', group: 1, disposition: 'implemented', evidenceId: 'runtime-overview-shell' },
  { id: 'identity', group: 1, disposition: 'implemented', evidenceId: 'identity-entry-and-rehearsal' },
  { id: 'onboarding', group: 1, disposition: 'deferred', evidenceId: 'wallet-creation-and-onboarding' },
  { id: 'recovery', group: 1, disposition: 'deferred', evidenceId: 'full-recovery' },
  { id: 'settings', group: 1, disposition: 'implemented', evidenceId: 'preferences' },
  { id: 'diagnostics', group: 1, disposition: 'implemented', evidenceId: 'diagnostics' },
  ...['assets', 'accounts', 'credit', 'collateral'].map((id) => ({
    id, group: 2 as const, disposition: 'implemented' as const, evidenceId: 'assets-and-accounts',
  })),
  ...['debt', 'solvency', 'disputes', 'history'].map((id) => ({
    id, group: 2 as const, disposition: 'implemented' as const, evidenceId: 'financial-health',
  })),
  ...['payments', 'receive', 'invoices', 'moves', 'lending', 'settlement', 'reconnect', 'failures', 'quotes', 'routing'].map((id) => ({
    id, group: id === 'quotes' || id === 'routing' ? 4 as const : 3 as const,
    disposition: 'implemented' as const, evidenceId: 'payments',
  })),
  ...['orders', 'orderbook', 'cancel-fill', 'cross-j', 'activity'].map((id) => ({
    id, group: 4 as const, disposition: 'implemented' as const, evidenceId: 'markets-and-activity',
  })),
] as const satisfies readonly WalletRequirementAudit[];
