import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('JurisdictionDropdown consumes projected jurisdiction rows instead of the runtime env store', () => {
  const dropdown = readFileSync('frontend/src/lib/components/Jurisdiction/JurisdictionDropdown.svelte', 'utf8');
  const chrome = readFileSync('frontend/src/lib/components/Entity/EntityPanelChrome.svelte', 'utf8');

  expect(dropdown).toContain('export let jurisdictions: JurisdictionDropdownItem[]');
  expect(dropdown).not.toContain('xlnEnvironment');
  expect(dropdown).not.toContain('$xlnEnvironment');
  expect(dropdown).not.toContain('jReplicas');
  expect(chrome).toContain('{jurisdictions}');
  expect(chrome).toContain('<JurisdictionDropdown');
});
