import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('settings panel diagnostics', () => {
  test('surfaces storage failures without raw console output', () => {
    const source = readFileSync('frontend/src/lib/view/panels/SettingsPanel.svelte', 'utf8');

    expect(source).not.toContain('console.error');
    expect(source).not.toContain('console.warn');
    expect(source).toContain('data-testid="settings-storage-error"');
    expect(source).toContain("Settings ${action} failed");
  });

  test('loads browser settings only from the mount path', () => {
    const source = readFileSync('frontend/src/lib/view/panels/SettingsPanel.svelte', 'utf8');
    const loadCalls = source.match(/loadSettings\(\);/g) ?? [];

    expect(loadCalls).toHaveLength(1);
    expect(source).not.toContain('JSON.parse(stored).rendererMode');
  });

  test('does not clear an auto-save failure after WebGPU detection', () => {
    const source = readFileSync('frontend/src/lib/view/panels/SettingsPanel.svelte', 'utf8');
    const clearIndex = source.indexOf("settingsStorageError = '';");
    const autoDetectIndex = source.indexOf('Auto-detect WebGPU');

    expect(clearIndex).toBeGreaterThan(0);
    expect(autoDetectIndex).toBeGreaterThan(clearIndex);
    expect(source).not.toContain("saveSettings();\n        }\n      }\n      settingsStorageError = '';");
  });
});
