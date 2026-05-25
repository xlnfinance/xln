#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

type CoverageRequirement = {
  area: 'pay' | 'swap' | 'cross-j' | 'frontend' | 'recovery';
  file: string;
  patterns: string[];
};

const readText = (path: string): string => readFileSync(path, 'utf8');

const includesAll = (text: string, patterns: string[], file: string): string[] => {
  const missing: string[] = [];
  for (const pattern of patterns) {
    if (!text.includes(pattern)) missing.push(`${file} missing "${pattern}"`);
  }
  return missing;
};

const requirements: CoverageRequirement[] = [
  {
    area: 'pay',
    file: 'tests/e2e-payment-smoke.spec.ts',
    patterns: [
      'fresh runtimes can open accounts, faucet, pay, and reload persisted state',
      'submitUiPayment',
      'waitForPersistedFrameEventMatch',
    ],
  },
  {
    area: 'pay',
    file: 'tests/e2e-ahb-isolated.spec.ts',
    patterns: [
      'bidirectional payments survive across two isolated browser contexts',
      'overspend rejection',
      'HtlcFinalized',
      'HtlcReceived',
      'balance must survive reload',
    ],
  },
  {
    area: 'pay',
    file: 'tests/e2e-pay-deeplink.spec.ts',
    patterns: [
      'restores runtime and opens the pay screen from hash params',
      '#payment-amount-input',
    ],
  },
  {
    area: 'recovery',
    file: 'tests/e2e-watchtower-recovery.spec.ts',
    patterns: [
      'restores a wiped runtime from standalone tower backup',
      'deriveRuntimeRecoveryLookupKey',
      '/api/tower/receipt/',
      '/resetdb?returnTo=/app',
    ],
  },
  {
    area: 'swap',
    file: 'tests/e2e-swap-isolated.spec.ts',
    patterns: [
      'two isolated users trade against each other through one hub orderbook without market maker liquidity',
      'resting maker order can fill partially, stay open, then cancel remainder',
      'one resting maker order can be matched by two isolated takers until fully closed',
      'swap round-trip both directions clears holds and updates closed history on both peers',
    ],
  },
  {
    area: 'swap',
    file: 'tests/e2e-swap.spec.ts',
    patterns: [
      'swap rejects price beyond 30% from current orderbook',
      'swap rejects sell price beyond 30% from current orderbook',
      'swap manual price override after book click uses the edited limit price',
    ],
  },
  {
    area: 'cross-j',
    file: 'tests/e2e-cross-j-swap.spec.ts',
    patterns: [
      'two users can place full, partial, and disputed cross-j swaps through the shared swap builder',
      'swap-route-select',
      'requestCrossJurisdictionClear',
      'Cross-j salvage queued',
      'Dispute started',
    ],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/EntityPanelTabs.svelte',
    patterns: [
      "label: 'Pay'",
      '<PaymentPanel',
      '<SwapPanel',
    ],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/SwapPanel.svelte',
    patterns: [
      'data-testid="swap-any-builder"',
      'data-testid="swap-route-select"',
      "swapRouteMode === 'cross'",
      "type: 'requestCrossJurisdictionSwap'",
      "type: 'placeSwapOffer'",
      'data-testid="cross-swap-clear"',
    ],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/PaymentPanel.svelte',
    patterns: [
      'data-testid="payment-amount-input"',
      "type: 'htlcPayment'",
      'Pay now',
    ],
  },
  {
    area: 'cross-j',
    file: 'runtime/__tests__/cross-jurisdiction-swap.test.ts',
    patterns: [
      'direct cancelPull cannot release a committed cross-j partial fill',
      'account-layer pull_cancel cannot release a committed cross-j partial fill',
      'target pull resolve verifies relay binary and enters clearing before account commit',
      'production cross-j API exposes only hashledger orderbook flow',
    ],
  },
];

const coreGatePath = 'runtime/scripts/run-e2e-core.ts';
const coreGate = readText(coreGatePath);
const coreTitles = [
  'fresh runtimes can open accounts, faucet, pay, and reload persisted state',
  'bidirectional payments survive across two isolated browser contexts',
  'restores a wiped runtime from standalone tower backup',
  'two isolated users trade against each other through one hub orderbook without market maker liquidity',
  'resting maker order can fill partially, stay open, then cancel remainder',
  'one resting maker order can be matched by two isolated takers until fully closed',
  'swap round-trip both directions clears holds and updates closed history on both peers',
  'two users can place full, partial, and disputed cross-j swaps through the shared swap builder',
  'restores runtime and opens the pay screen from hash params',
];

const missing: string[] = [];
for (const requirement of requirements) {
  missing.push(...includesAll(readText(requirement.file), requirement.patterns, requirement.file));
}
missing.push(...includesAll(coreGate, coreTitles, coreGatePath));

if (missing.length > 0) {
  console.error('Flow E2E coverage contract failed:');
  for (const item of missing) console.error(` - ${item}`);
  process.exit(1);
}

const grouped = requirements.reduce<Record<string, number>>((acc, requirement) => {
  acc[requirement.area] = (acc[requirement.area] ?? 0) + requirement.patterns.length;
  return acc;
}, {});

console.log('✅ flow E2E coverage contract passed');
for (const [area, count] of Object.entries(grouped)) {
  console.log(`   ${area}: ${count} required markers`);
}
