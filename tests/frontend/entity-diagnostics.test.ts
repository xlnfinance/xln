import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const diagnosticFiles = [
  {
    path: 'frontend/src/lib/components/Entity/ActivityHistoryPanel.svelte',
    importLine: "import { errorLog } from '$lib/stores/errorLogStore';",
    logLine: "errorLog.log('Activity history projection read failed', 'Activity History'",
  },
  {
    path: 'frontend/src/lib/components/Entity/CollateralForm.svelte',
    importLine: "import { errorLog } from '../../stores/errorLogStore';",
    logLine: "errorLog.log('Collateral request failed', 'Collateral Form'",
  },
  {
    path: 'frontend/src/lib/components/Entity/CreditForm.svelte',
    importLine: "import { errorLog } from '../../stores/errorLogStore';",
    logLine: "errorLog.log('Credit action failed', 'Credit Form'",
  },
  {
    path: 'frontend/src/lib/components/Entity/EntitySettingsProjectionPanel.svelte',
    importLine: "import { errorLog } from '$lib/stores/errorLogStore';",
    logLine: "errorLog.log('Entity profile update failed', 'Entity Settings'",
  },
  {
    path: 'frontend/src/lib/components/Entity/FormationPanel.svelte',
    importLine: "import { errorLog } from '../../stores/errorLogStore';",
    logLine: "errorLog.log('Entity creation failed', 'Formation Panel'",
  },
  {
    path: 'frontend/src/lib/components/Entity/HubDiscoveryPanel.svelte',
    importLine: "import { errorLog } from '../../stores/errorLogStore';",
    logLine: "errorLog.log('Hub discovery failed', 'Hub Discovery'",
  },
  {
    path: 'frontend/src/lib/components/Entity/PaymentPanel.svelte',
    importLine: "import { errorLog } from '../../stores/errorLogStore';",
    logLine: "errorLog.log(message, 'Payment Panel'",
  },
  {
    path: 'frontend/src/lib/components/Entity/SettlementPanel.svelte',
    importLine: "import { errorLog } from '../../stores/errorLogStore';",
    logLine: "errorLog.log(message, 'Settlement Panel'",
  },
  {
    path: 'frontend/src/lib/components/Entity/SwapPanel.svelte',
    importLine: "import { errorLog } from '../../stores/errorLogStore';",
    logLine: "errorLog.log(message, 'Swap Panel'",
  },
] as const;

test('entity action surfaces persist diagnostics instead of raw console output', () => {
  for (const file of diagnosticFiles) {
    const source = readFileSync(file.path, 'utf8');
    expect(source).toContain(file.importLine);
    expect(source).toContain(file.logLine);
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('console.warn');
    expect(source).not.toContain('console.info');
    expect(source).not.toContain('alert(');
  }
});

test('payment and settlement panels persist every critical action failure path', () => {
  const paymentSource = readFileSync('frontend/src/lib/components/Entity/PaymentPanel.svelte', 'utf8');
  expect(paymentSource).toContain("'Payment runtime graph route lookup failed'");
  expect(paymentSource).toContain("'Payment route finding failed'");
  expect(paymentSource).toContain("'Payment submission failed'");

  const settlementSource = readFileSync('frontend/src/lib/components/Entity/SettlementPanel.svelte', 'utf8');
  expect(settlementSource).toContain("'Settlement batch clear failed'");
  expect(settlementSource).toContain("'On-J batch broadcast failed'");
  expect(settlementSource).toContain("'On-J batch rebroadcast failed'");
  expect(settlementSource).toContain("'On-J transfer action failed'");
  expect(settlementSource).toContain("'Settlement auto execute into draft failed'");
});

test('swap panel persists every critical action failure path', () => {
  const swapSource = readFileSync('frontend/src/lib/components/Entity/SwapPanel.svelte', 'utf8');
  expect(swapSource).toContain("'Swap offer placement failed'");
  expect(swapSource).toContain("'Swap cancel request failed'");
  expect(swapSource).toContain("'Cross-j swap clear request failed'");
});
