import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const diagnosticFiles = [
  {
    path: 'frontend/src/routes/app/+layout.svelte',
    importLine: "import { errorLog } from '$lib/stores/errorLogStore';",
    logLine: "errorLog.log(message, 'App Shell', details)",
  },
  {
    path: 'frontend/src/lib/stores/appStateStore.ts',
    importLine: "import { errorLog } from './errorLogStore';",
    logLine: "errorLog.log('localStorage get failed', 'App State'",
  },
  {
    path: 'frontend/src/lib/stores/settingsStore.ts',
    importLine: "import { errorLog } from './errorLogStore';",
    logLine: "errorLog.log('Failed to load settings; clearing corrupted storage', 'Settings'",
  },
  {
    path: 'frontend/src/lib/stores/tabStore.ts',
    importLine: "import { errorLog } from './errorLogStore';",
    logLine: "errorLog.log('Failed to load tabs; clearing corrupted storage', 'Tabs'",
  },
  {
    path: 'frontend/src/lib/stores/timeStore.ts',
    importLine: "import { errorLog } from './errorLogStore';",
    logLine: "errorLog.log('TIME_MACHINE_HISTORY_NOT_READY: skipping max-index update', 'Time Machine'",
  },
  {
    path: 'frontend/src/lib/stores/jmachineStore.ts',
    importLine: "import { errorLog } from './errorLogStore';",
    logLine: "errorLog.log('Failed to load J-Machine configs; clearing corrupted storage', 'J-Machine Store'",
  },
  {
    path: 'frontend/src/lib/stores/jurisdictionStore.ts',
    importLine: "import { errorLog } from './errorLogStore';",
    logLine: "errorLog.log('Failed to load jurisdictions from runtime', 'Jurisdiction Store'",
  },
] as const;

test('app shell and small stores persist diagnostics instead of raw console output', () => {
  for (const file of diagnosticFiles) {
    const source = readFileSync(file.path, 'utf8');
    expect(source).toContain(file.importLine);
    expect(source).toContain(file.logLine);
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('console.warn');
    expect(source).not.toContain('console.info');
  }
});
