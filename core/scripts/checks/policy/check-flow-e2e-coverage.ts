#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

type CoverageRequirement = {
  area: 'pay' | 'swap' | 'cross-j' | 'frontend' | 'recovery' | 'credit' | 'lending';
  file: string;
  patterns: string[];
};

const readText = (path: string): string => {
  if (path !== 'core/__tests__/cross-jurisdiction-swap.test.ts') return readFileSync(path, 'utf8');
  return [
    'core/__tests__/cross-j/swap/cross-jurisdiction-swap-part-1.test.ts',
    'core/__tests__/cross-j/swap/cross-jurisdiction-swap-part-2a.test.ts',
    'core/__tests__/cross-j/swap/cross-jurisdiction-swap-part-2b.test.ts',
    'core/__tests__/cross-j/swap/cross-jurisdiction-swap-part-3.test.ts',
    'core/__tests__/cross-j/swap/cross-jurisdiction-swap-part-4.test.ts',
    'core/__tests__/cross-j/swap/cross-jurisdiction-swap-part-5.test.ts',
    'core/__tests__/cross-j/swap/lifecycle/cross-jurisdiction-expiry.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-6.test.ts',
  ]
    .map(file => readFileSync(file, 'utf8'))
    .join('\n');
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
    area: 'credit',
    file: 'ui/tests/e2e-direct-credit.spec.ts',
    patterns: ["signed: '-20000000'", "signed: '20000000'", 'reopenStack'],
  },
  {
    area: 'credit',
    file: 'ui/tests/e2e-collateral.spec.ts',
    patterns: [
      'Manage credit tab asks the hub for a credit line and the committed line shows on the account',
      'expect(credited.signed).toBe(before.signed)',
      'expect(credited.collateral).toBe(before.collateral)',
      'expect(credited.ourCreditToThem).toBe(before.ourCreditToThem)',
    ],
  },
  {
    area: 'lending',
    file: 'ui/tests/lending/e2e-principal.spec.ts',
    patterns: ['term loan spends principal, repays partially then fully, and keeps saver money independent'],
  },
  {
    area: 'lending',
    file: 'ui/tests/lending/e2e-demand.spec.ts',
    patterns: ['demand savings preserve the claim through a rate update, reload and withdrawal'],
  },
  {
    area: 'lending',
    file: 'ui/tests/lending/e2e-bank-policy.spec.ts',
    patterns: ['bank officer publishes prices, approves and revokes a real borrower facility'],
  },
  {
    area: 'lending',
    file: 'ui/tests/lending/e2e-unfunded.spec.ts',
    patterns: ['an unapproved loan request leaves the bank serving real payments'],
  },
  {
    area: 'pay',
    file: 'tests/e2e/payments/e2e-payment-smoke.spec.ts',
    patterns: [
      'fresh runtimes can open accounts, faucet, pay, and reload persisted state',
      'submitUiPayment',
      'waitForPersistedFrameEventMatch',
    ],
  },
  {
    area: 'pay',
    file: 'tests/e2e/runtime/e2e-ahb-isolated.spec.ts',
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
    file: 'tests/e2e/payments/e2e-pay-deeplink.spec.ts',
    patterns: [
      'restores runtime and opens the pay screen from hash params',
      "getByTestId('pay-to')).toHaveValue(bob.entityId)",
      "getByTestId('pay-amount')).toHaveValue('5')",
      "getByTestId('pay-note')).toHaveValue('E2E direct pay deep link')",
    ],
  },
  {
    area: 'recovery',
    file: 'tests/e2e/recovery/e2e-watchtower-recovery.spec.ts',
    patterns: [
      'restores a wiped runtime from standalone tower backup',
      'deriveRuntimeRecoveryLookupKey',
      '/api/tower/receipt/',
      'expect((await context.storageState()).origins).toEqual([])',
      "getByTestId('restore-from-tower').check()",
      'expect(backedUpBalance).toBe(100)',
      "expect(after.usdcOffdelta, 'tower restore must preserve the exact funded Account delta').toBe(",
    ],
  },
  {
    area: 'swap',
    file: 'tests/e2e/swap/e2e-swap-isolated.spec.ts',
    patterns: [
      'two isolated users trade against each other through one hub orderbook without market maker liquidity',
      'resting maker order can fill partially, stay open, then cancel remainder',
      'one resting maker order can be matched by two isolated takers until fully closed',
      'swap round-trip both directions clears holds and updates closed history on both peers',
    ],
  },
  {
    area: 'swap',
    file: 'tests/e2e/swap/e2e-swap.spec.ts',
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
      "page.getByTestId('swap-cross-mode').click()",
      "hasText: 'Your other account'",
      'await expect(routeSelect).toHaveValue(targetEntityId.toLowerCase());',
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
    file: 'frontend/src/lib/components/Entity/workspace/AccountWorkspaceView.svelte',
    patterns: ["label: 'Pay'", '<PaymentPanel', '<SwapPanel'],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/swap/SwapPanel.svelte',
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
    file: 'frontend/src/lib/components/Entity/swap/SwapTicket.svelte',
    patterns: [
      'data-testid="swap-ticket-from-network"',
      'data-testid="swap-ticket-to-network"',
      'data-testid="swap-ticket-submit"',
      'placeSwapOffer',
    ],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/swap/swap-panel-helpers.ts',
    patterns: ['buildCrossSwapSetupSteps', "CrossSwapSetupStepId = 'target-account' | 'target-credit'"],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/swap/SwapOrderList.svelte',
    patterns: ['export let requestCrossClear', 'data-testid="cross-swap-clear"'],
  },
  {
    area: 'frontend',
    file: 'frontend/src/lib/components/Entity/payments/PaymentPanel.svelte',
    patterns: ['data-testid="payment-amount-input"', 'await submitRuntimeInput(buildPaymentRuntimeInput({', 'Pay now'],
  },
  {
    area: 'pay',
    file: 'core/api/payments/command.ts',
    patterns: [
      'export const buildPaymentRuntimeInput',
      "type: 'htlcPayment'",
      "type: 'directPayment'",
      'maxSenderDebit: input.route.senderAmount',
    ],
  },
  {
    area: 'cross-j',
    file: 'core/__tests__/cross-jurisdiction-swap.test.ts',
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

const coreGatePath = 'core/scripts/e2e/runners/run-e2e-core.ts';
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
const releaseGatePath = 'core/scripts/release/run-release-gate.ts';
missing.push(
  ...includesAll(
    readText(releaseGatePath),
    [
      'e2e-direct-credit.spec.ts',
      'e2e-collateral.spec.ts',
      'e2e-lending.spec.ts',
      'lending/e2e-principal.spec.ts',
      'lending/e2e-demand.spec.ts',
      'lending/e2e-bank-policy.spec.ts',
      'lending/e2e-unfunded.spec.ts',
    ],
    releaseGatePath,
  ),
);

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
