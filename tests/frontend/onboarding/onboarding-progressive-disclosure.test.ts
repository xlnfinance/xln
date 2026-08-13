import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('frontend/src/lib/components/Entity/onboarding/OnboardingPanel.svelte', 'utf8');

test('onboarding keeps identity and default credit limits primary', () => {
  const advancedStart = source.indexOf('<details class="setup-advanced">');
  expect(source.indexOf('for="display-name"')).toBeLessThan(advancedStart);
  expect(source.indexOf('<h3>Default limits</h3>')).toBeLessThan(advancedStart);
  expect(source.indexOf('Initial hub join')).toBeGreaterThan(advancedStart);
  expect(source.indexOf('<h3>Jurisdictions</h3>')).toBeGreaterThan(advancedStart);
  expect(source.indexOf('Encrypted backup and last-resort dispute protection')).toBeGreaterThan(advancedStart);
});

test('Brain Vault onboarding does not expose or require mnemonic backup controls', () => {
  expect(source).not.toContain('Download sheet');
  expect(source).not.toContain('Show seed');
  expect(source).not.toContain('Copy seed');
  expect(source).not.toContain('Save the offline recovery sheet');
});
