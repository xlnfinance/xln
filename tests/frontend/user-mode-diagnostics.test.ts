import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('UserModePanel persists wallet-shell diagnostics instead of raw console output', () => {
  const source = readFileSync('frontend/src/lib/view/UserModePanel.svelte', 'utf8');

  expect(source).toContain("import { errorLog } from '$lib/stores/errorLogStore';");
  expect(source).toContain("errorLog.log(message, 'User Mode', details)");
  expect(source).toContain("logUserModeDiagnostic('Failed to add signer: no active vault'");
  expect(source).toContain("logUserModeDiagnostic('J-Machine import failed'");
  expect(source).not.toContain('console.error');
  expect(source).not.toContain('console.warn');
  expect(source).not.toContain('console.info');
});
