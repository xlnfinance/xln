// Framework-neutral state rules for the workspace Settings panel. Browser
// storage, Dockview, Graph3D events, NetworkMachine operations, and component
// lifecycle effects stay in the owning UI adapter.

import { isUnknownRecord, parseJsonUnknown } from './boundary';

export type SettingsVector3 = { x: number; y: number; z: number };

export type SettingsCameraState = Readonly<{
  position: SettingsVector3;
  target: SettingsVector3;
  distance: number;
}>;

export type SettingsCameraUpdate = Readonly<{
  position: SettingsVector3;
  target: SettingsVector3;
  distance?: number;
}>;

export type EntityOpenMode = 'replace' | 'new-tab';

export interface ViewSettings {
  gridSize: number;
  gridDivisions: number;
  gridOpacity: number;
  gridColor: string;
  cameraDistance: number;
  cameraTarget: SettingsVector3;
  fov: number;
  entityLabelScale: number;
  entitySizeMultiplier: number;
  lightningSpeed: number;
  lightningEnabled: boolean;
  broadcastEnabled: boolean;
  broadcastStyle: 'raycast' | 'wave' | 'particles';
  rendererMode: 'webgl' | 'webgpu';
  forceLayoutEnabled: boolean;
  antiAlias: boolean;
  verboseLogging: boolean;
  showFpsOverlay: boolean;
  autoRotate: boolean;
  autoRotateSpeed: number;
  cameraPreset: 'free' | 'top-down' | 'side' | 'orbit';
  vrScaleMultiplier: number;
}

export const VIEW_SETTINGS_STORAGE_KEY = 'xln-view-settings';
export const ENTITY_OPEN_MODE_STORAGE_KEY = 'xln-dock-entity-open-mode';

export const DEFAULT_VIEW_SETTINGS: Readonly<ViewSettings> = {
  gridSize: 2000,
  gridDivisions: 3,
  gridOpacity: 0.4,
  gridColor: '#ffffff',
  cameraDistance: 500,
  cameraTarget: { x: 0, y: 0, z: 0 },
  fov: 75,
  entityLabelScale: 2,
  entitySizeMultiplier: 1,
  lightningSpeed: 100,
  lightningEnabled: false,
  broadcastEnabled: true,
  broadcastStyle: 'raycast',
  rendererMode: 'webgl',
  forceLayoutEnabled: true,
  antiAlias: true,
  verboseLogging: false,
  showFpsOverlay: false,
  autoRotate: false,
  autoRotateSpeed: 0.5,
  cameraPreset: 'free',
  vrScaleMultiplier: 1,
};

export const createDefaultViewSettings = (): ViewSettings => ({
  ...DEFAULT_VIEW_SETTINGS,
  cameraTarget: { ...DEFAULT_VIEW_SETTINGS.cameraTarget },
});

const invalidSetting = (key: keyof ViewSettings): Error =>
  new Error(`VIEW_SETTINGS_INVALID:${key}`);

const optionalNumber = (
  record: Record<string, unknown>,
  key: keyof ViewSettings,
  fallback: number,
): number => {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidSetting(key);
  return value;
};

const optionalBoolean = (
  record: Record<string, unknown>,
  key: keyof ViewSettings,
  fallback: boolean,
): boolean => {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalidSetting(key);
  return value;
};

const optionalChoice = <T extends string>(
  record: Record<string, unknown>,
  key: keyof ViewSettings,
  choices: readonly T[],
  fallback: T,
): T => {
  const value = record[key];
  if (value === undefined) return fallback;
  const selected = choices.find((choice) => choice === value);
  if (!selected) throw invalidSetting(key);
  return selected;
};

const optionalVector = (
  record: Record<string, unknown>,
  key: 'cameraTarget',
  fallback: SettingsVector3,
): SettingsVector3 => {
  const value = record[key];
  if (value === undefined) return { ...fallback };
  if (!isUnknownRecord(value)) throw invalidSetting(key);
  const { x, y, z } = value;
  if (![x, y, z].every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) {
    throw invalidSetting(key);
  }
  return { x: Number(x), y: Number(y), z: Number(z) };
};

const normalizeSceneSettings = (record: Record<string, unknown>): Pick<ViewSettings,
  | 'gridSize' | 'gridDivisions' | 'gridOpacity' | 'gridColor'
  | 'cameraDistance' | 'cameraTarget' | 'fov'
  | 'entityLabelScale' | 'entitySizeMultiplier'
> => {
  const gridColor = record['gridColor'];
  if (gridColor !== undefined && typeof gridColor !== 'string') throw invalidSetting('gridColor');
  return {
    gridSize: optionalNumber(record, 'gridSize', DEFAULT_VIEW_SETTINGS.gridSize),
    gridDivisions: optionalNumber(record, 'gridDivisions', DEFAULT_VIEW_SETTINGS.gridDivisions),
    gridOpacity: optionalNumber(record, 'gridOpacity', DEFAULT_VIEW_SETTINGS.gridOpacity),
    gridColor: gridColor ?? DEFAULT_VIEW_SETTINGS.gridColor,
    cameraDistance: optionalNumber(record, 'cameraDistance', DEFAULT_VIEW_SETTINGS.cameraDistance),
    cameraTarget: optionalVector(record, 'cameraTarget', DEFAULT_VIEW_SETTINGS.cameraTarget),
    fov: optionalNumber(record, 'fov', DEFAULT_VIEW_SETTINGS.fov),
    entityLabelScale: optionalNumber(record, 'entityLabelScale', DEFAULT_VIEW_SETTINGS.entityLabelScale),
    entitySizeMultiplier: optionalNumber(record, 'entitySizeMultiplier', DEFAULT_VIEW_SETTINGS.entitySizeMultiplier),
  };
};

const normalizeEffectSettings = (record: Record<string, unknown>): Pick<ViewSettings,
  'lightningSpeed' | 'lightningEnabled' | 'broadcastEnabled' | 'broadcastStyle'
> => ({
  lightningSpeed: optionalNumber(record, 'lightningSpeed', DEFAULT_VIEW_SETTINGS.lightningSpeed),
  lightningEnabled: optionalBoolean(record, 'lightningEnabled', DEFAULT_VIEW_SETTINGS.lightningEnabled),
  broadcastEnabled: optionalBoolean(record, 'broadcastEnabled', DEFAULT_VIEW_SETTINGS.broadcastEnabled),
  broadcastStyle: optionalChoice(record, 'broadcastStyle', ['raycast', 'wave', 'particles'], DEFAULT_VIEW_SETTINGS.broadcastStyle),
});

const normalizePerformanceSettings = (record: Record<string, unknown>): Pick<ViewSettings,
  | 'rendererMode' | 'forceLayoutEnabled' | 'antiAlias' | 'verboseLogging'
  | 'showFpsOverlay' | 'autoRotate' | 'autoRotateSpeed' | 'cameraPreset' | 'vrScaleMultiplier'
> => ({
  rendererMode: optionalChoice(record, 'rendererMode', ['webgl', 'webgpu'], DEFAULT_VIEW_SETTINGS.rendererMode),
  forceLayoutEnabled: optionalBoolean(record, 'forceLayoutEnabled', DEFAULT_VIEW_SETTINGS.forceLayoutEnabled),
  antiAlias: optionalBoolean(record, 'antiAlias', DEFAULT_VIEW_SETTINGS.antiAlias),
  verboseLogging: optionalBoolean(record, 'verboseLogging', DEFAULT_VIEW_SETTINGS.verboseLogging),
  showFpsOverlay: optionalBoolean(record, 'showFpsOverlay', DEFAULT_VIEW_SETTINGS.showFpsOverlay),
  autoRotate: optionalBoolean(record, 'autoRotate', DEFAULT_VIEW_SETTINGS.autoRotate),
  autoRotateSpeed: optionalNumber(record, 'autoRotateSpeed', DEFAULT_VIEW_SETTINGS.autoRotateSpeed),
  cameraPreset: optionalChoice(record, 'cameraPreset', ['free', 'top-down', 'side', 'orbit'], DEFAULT_VIEW_SETTINGS.cameraPreset),
  vrScaleMultiplier: optionalNumber(record, 'vrScaleMultiplier', DEFAULT_VIEW_SETTINGS.vrScaleMultiplier),
});

export const normalizeViewSettings = (value: unknown): ViewSettings => {
  if (!isUnknownRecord(value)) throw new Error('VIEW_SETTINGS_INVALID');
  return {
    ...normalizeSceneSettings(value),
    ...normalizeEffectSettings(value),
    ...normalizePerformanceSettings(value),
  };
};

export const parseViewSettings = (serialized: string): ViewSettings =>
  normalizeViewSettings(parseJsonUnknown(serialized, 'VIEW_SETTINGS_JSON_INVALID'));

export const serializeViewSettings = (settings: ViewSettings): string => JSON.stringify(settings);

export const resolveEntityOpenMode = (stored: string | null): EntityOpenMode =>
  stored === 'new-tab' ? 'new-tab' : 'replace';

export const mergeSettingsCameraState = (
  current: SettingsCameraState,
  update: SettingsCameraUpdate,
): SettingsCameraState => ({
  position: update.position || current.position,
  target: update.target || current.target,
  distance: update.distance || current.distance,
});

export const formatSettingsPanelError = (action: string, cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `Settings ${action} failed: ${message}`;
};
