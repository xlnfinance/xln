import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_VIEW_SETTINGS,
  ENTITY_OPEN_MODE_STORAGE_KEY,
  VIEW_SETTINGS_STORAGE_KEY,
  createDefaultViewSettings,
  formatSettingsPanelError,
  mergeSettingsCameraState,
  normalizeViewSettings,
  parseViewSettings,
  resolveEntityOpenMode,
  serializeViewSettings,
} from '../../../frontend/packages/runtime-client/src/settings-panel-view';

describe('Settings panel view model', () => {
  test('creates independent defaults that preserve the canonical Graph3D baseline', () => {
    const first = createDefaultViewSettings();
    const second = createDefaultViewSettings();

    expect(first).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(first.rendererMode).toBe('webgl');
    expect(first.gridSize).toBe(2000);
    expect(first.cameraDistance).toBe(500);
    first.cameraTarget.x = 42;
    expect(second.cameraTarget.x).toBe(0);
    expect(DEFAULT_VIEW_SETTINGS.cameraTarget.x).toBe(0);
  });

  test('normalizes partial persisted settings over defaults and ignores retired keys', () => {
    const settings = normalizeViewSettings({
      gridOpacity: 0.75,
      rendererMode: 'webgpu',
      cameraTarget: { x: 1, y: 2, z: 3 },
      retiredSetting: true,
    });

    expect(settings.gridOpacity).toBe(0.75);
    expect(settings.rendererMode).toBe('webgpu');
    expect(settings.cameraTarget).toEqual({ x: 1, y: 2, z: 3 });
    expect(settings.gridColor).toBe('#ffffff');
    expect(settings.broadcastStyle).toBe('raycast');
    expect(Object.hasOwn(settings, 'retiredSetting')).toBe(false);
  });

  test('rejects malformed JSON and invalid persisted fields at the storage boundary', () => {
    expect(() => parseViewSettings('{bad-json')).toThrow('VIEW_SETTINGS_JSON_INVALID');
    expect(() => normalizeViewSettings(null)).toThrow('VIEW_SETTINGS_INVALID');
    expect(() => normalizeViewSettings({ fov: Number.NaN })).toThrow('VIEW_SETTINGS_INVALID:fov');
    expect(() => normalizeViewSettings({ antiAlias: 'yes' })).toThrow('VIEW_SETTINGS_INVALID:antiAlias');
    expect(() => normalizeViewSettings({ broadcastStyle: 'flash' })).toThrow('VIEW_SETTINGS_INVALID:broadcastStyle');
    expect(() => normalizeViewSettings({ cameraTarget: { x: 1, y: 2 } })).toThrow('VIEW_SETTINGS_INVALID:cameraTarget');
  });

  test('serializes a normalized snapshot without changing its values', () => {
    const settings = normalizeViewSettings({
      autoRotate: true,
      autoRotateSpeed: 2.5,
      cameraPreset: 'orbit',
      vrScaleMultiplier: 1.5,
    });

    expect(parseViewSettings(serializeViewSettings(settings))).toEqual(settings);
    expect(VIEW_SETTINGS_STORAGE_KEY).toBe('xln-view-settings');
    expect(ENTITY_OPEN_MODE_STORAGE_KEY).toBe('xln-dock-entity-open-mode');
  });

  test('preserves camera update and entity-open-mode behavior', () => {
    const current = {
      position: { x: 0, y: 0, z: 0 },
      target: { x: 1, y: 1, z: 1 },
      distance: 15,
    };
    expect(mergeSettingsCameraState(current, {
      position: { x: 2, y: 3, z: 4 },
      target: { x: 5, y: 6, z: 7 },
      distance: 20,
    })).toEqual({
      position: { x: 2, y: 3, z: 4 },
      target: { x: 5, y: 6, z: 7 },
      distance: 20,
    });
    expect(mergeSettingsCameraState(current, {
      position: current.position,
      target: current.target,
      distance: 0,
    }).distance).toBe(15);
    expect(resolveEntityOpenMode('new-tab')).toBe('new-tab');
    expect(resolveEntityOpenMode('replace')).toBe('replace');
    expect(resolveEntityOpenMode('unexpected')).toBe('replace');
    expect(resolveEntityOpenMode(null)).toBe('replace');
  });

  test('keeps browser, Dockview, NetworkMachine, and event effects in Svelte', () => {
    const source = readFileSync('frontend/src/lib/view/panels/SettingsPanel.svelte', 'utf8');
    const shared = readFileSync('frontend/packages/runtime-client/src/settings-panel-view.ts', 'utf8');

    expect(formatSettingsPanelError('load', new Error('denied'))).toBe('Settings load failed: denied');
    expect(formatSettingsPanelError('save', 'quota')).toBe('Settings save failed: quota');
    expect(source).toContain("from '../../../../packages/runtime-client/src/settings-panel-view'");
    expect(source).toContain('localStorage.getItem(VIEW_SETTINGS_STORAGE_KEY)');
    expect(source).toContain("panelBridge.emit('settings:update'");
    expect(source).toContain('window.__dockview_instance');
    expect(source).toContain('networkMachineOperations.importJson');
    expect(source).not.toContain('interface ViewSettings');
    expect(shared).not.toContain('localStorage');
    expect(shared).not.toContain('panelBridge');
    expect(shared).not.toContain('__dockview_instance');
    expect(shared).not.toContain('networkMachineOperations');
  });
});
