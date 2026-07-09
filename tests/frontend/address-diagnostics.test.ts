import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('address projection pages persist diagnostics instead of raw console output', () => {
  const directorySource = readFileSync('frontend/src/routes/address/+page.svelte', 'utf8');
  const explorerSource = readFileSync('frontend/src/routes/address/[entityId]/+page.svelte', 'utf8');
  const combined = `${directorySource}\n${explorerSource}`;

  expect(directorySource).toContain("import { errorLog } from '$lib/stores/errorLogStore';");
  expect(directorySource).toContain("errorLog.log('Address directory projection read failed', 'Address Directory', err)");
  expect(explorerSource).toContain("import { errorLog } from '$lib/stores/errorLogStore';");
  expect(explorerSource).toContain("errorLog.log('Entity explorer projection read failed', 'Entity Explorer'");
  expect(combined).not.toContain('console.error');
  expect(combined).not.toContain('console.warn');
  expect(combined).not.toContain('console.info');
});
