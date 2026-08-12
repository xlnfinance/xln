#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

type CoverageRequirement = {
  area: 'pay' | 'swap' | 'cross-j' | 'frontend' | 'recovery';
  file: string;
  patterns: string[];
};

const readText = (path: string): string => {
  if (path !== 'runtime/__tests__/cross-jurisdiction-swap.test.ts') return readFileSync(path, 'utf8');
  return [
    'runtime/__tests__/cross-j/swap/cross-jurisdiction-swap-part-1.test.ts',
    'runtime/__tests__/cross-j/swap/cross-jurisdiction-swap-part-2a.test.ts',
    'runtime/__tests__/cross-j/swap/cross-jurisdiction-swap-part-2b.test.ts',
    'runtime/__tests__/cross-j/swap/cross-jurisdiction-swap-part-3.test.ts',
    'runtime/__tests__/cross-j/swap/cross-jurisdiction-swap-part-4.test.ts',
    'runtime/__tests__/cross-j/swap/cross-jurisdiction-swap-part-5.test.ts',
    'runtime/__tests__/audit-failfast-regressions-part-6.test.ts',
  ].map(file => readFileSync(file, 'utf8')).join('\n');
};

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
      'real MM full fill auto-closes and partial fill closes manually on both legs',
    ],
  },
  {
    area: 'cross-j',
    file: 'tests/e2e-cross-j-swap-helpers-a.ts',
    patterns: [
      'swap-ticket-to-network',
      'cross route selection must remain selected after the reactive UI update',
    ],
  },
  {
    area: 'cross-j',
    file: 'tests/e2e-cross-j-swap-helpers-b.ts',
    patterns: [
      'requestCrossJurisdictionClear',
      'waitForCrossRouteMaterialized',
      '.toMatchObject({ present: true, targetPull: true })',
    ],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/AccountWorkspaceView.svelte',
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
      '<SwapTicket',
      '{placeSwapOffer}',
      '<SwapOrderList',
      '{requestCrossClear}',
      'submitActiveCrossJurisdictionIntent',
      'submitRuntimeInput(commandPlan.targetSetupInput)',
      'submitRuntimeInput(commandPlan.runtimeInput)',
    ],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/SwapTicket.svelte',
    patterns: [
      'data-testid="swap-ticket-from-network"',
      'data-testid="swap-ticket-to-network"',
      'data-testid="swap-ticket-submit"',
      'placeSwapOffer',
    ],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/swap-panel-helpers.ts',
    patterns: [
      'buildCrossSwapSetupSteps',
      "CrossSwapSetupStepId = 'target-account' | 'target-credit'",
    ],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/SwapOrderList.svelte',
    patterns: [
      'export let requestCrossClear',
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
      'cross-j close proposals are accepted only as one exact source+target cohort',
      'clear request reveals one source pull binary and can cancel remainder',
      'target cross_pull_close rejects user-authored economics before target binding has fill progress',
      'cross-j orderbook sweep closes expired unfilled route instead of being a no-op',
      'production API exposes only the hashledger orderbook flow',
      'disputeStart treats pending cross_pull_close as foldable dispute evidence',
    ],
  },
];

const coreGatePath = 'runtime/scripts/e2e/runners/run-e2e-core.ts';
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
