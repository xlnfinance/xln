import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('settings panel diagnostics', () => {
  test('surfaces storage failures without raw console output', () => {
    const source = readFileSync('frontend/src/lib/view/panels/SettingsPanel.svelte', 'utf8');
    const shared = readFileSync('frontend/packages/runtime-client/src/settings-panel-view.ts', 'utf8');

    expect(source).not.toContain('console.error');
    expect(source).not.toContain('console.warn');
    expect(source).toContain('data-testid="settings-storage-error"');
    expect(source).toContain('formatSettingsPanelError as formatSettingsError');
    expect(shared).toContain("Settings ${action} failed");
  });

  test('loads browser settings only from the mount path', () => {
    const source = readFileSync('frontend/src/lib/view/panels/SettingsPanel.svelte', 'utf8');
    // Call sites only — the `async function loadSettings()` declaration is excluded.
    const loadCalls = source.match(/(?<!function )loadSettings\(\)/g) ?? [];

    expect(loadCalls).toHaveLength(1);
    expect(source).not.toContain('JSON.parse(stored).rendererMode');
  });

  test('replays persisted settings to Graph3D so they survive a reload', () => {
    const source = readFileSync('frontend/src/lib/view/panels/SettingsPanel.svelte', 'utf8');

    expect(source).toContain('loadSettings().then(broadcastAllSettings)');
    expect(source).toContain("panelBridge.emit('settings:update', { key, value })");
  });

  test('keeps WebGPU opt-in because API presence does not prove adapter availability', () => {
    const source = readFileSync('frontend/src/lib/view/panels/SettingsPanel.svelte', 'utf8');
    const shared = readFileSync('frontend/packages/runtime-client/src/settings-panel-view.ts', 'utf8');

    expect(shared).toContain("rendererMode: 'webgl'");
    expect(source).not.toContain('settings.rendererMode = \'webgpu\'');
    expect(source).not.toContain('if (typeof navigator');
  });
});
