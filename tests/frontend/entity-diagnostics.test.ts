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
] as const;

test('entity action surfaces persist diagnostics instead of raw console output', () => {
  for (const file of diagnosticFiles) {
    const source = readFileSync(file.path, 'utf8');
    expect(source).toContain(file.importLine);
    expect(source).toContain(file.logLine);
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('console.warn');
    expect(source).not.toContain('console.info');
  }
});
