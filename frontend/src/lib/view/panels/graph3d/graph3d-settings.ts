import { parseJsonUnknown } from '$lib/utils/boundary';

export type BirdViewBarsMode = 'close' | 'spread';
export type BirdViewMode = '2d' | '3d';
export type BirdViewEntityMode = 'sphere' | 'identicon';

export type BirdViewCameraState = {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  zoom: number;
};

export type BirdViewSettings = {
  barsMode: BirdViewBarsMode;
  selectedTokenId: number;
  viewMode: BirdViewMode;
  entityMode: BirdViewEntityMode;
  wasLastOpened: boolean;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  camera?: BirdViewCameraState | undefined;
};

export type BirdViewSettingsInput = Omit<BirdViewSettings, 'camera'> & {
  camera?: BirdViewCameraState | undefined;
};

export type BirdViewSettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const BIRD_VIEW_SETTINGS_STORAGE_KEY = 'xln-bird-view-settings';

export const DEFAULT_BIRD_VIEW_SETTINGS: BirdViewSettings = {
  barsMode: 'close',
  selectedTokenId: 1,
  viewMode: '3d',
  entityMode: 'sphere',
  wasLastOpened: false,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  camera: undefined,
};

function cloneDefaultBirdViewSettings(): BirdViewSettings {
  return { ...DEFAULT_BIRD_VIEW_SETTINGS };
}

export function normalizeBirdViewSettings(value: unknown): BirdViewSettings {
  if (!value || typeof value !== 'object') throw new Error('BIRD_VIEW_SETTINGS_INVALID');
  const parsed = value as Record<string, unknown>;
  if ((parsed['barsMode'] !== 'close' && parsed['barsMode'] !== 'spread') ||
    !Number.isSafeInteger(parsed['selectedTokenId']) || Number(parsed['selectedTokenId']) <= 0 ||
    (parsed['viewMode'] !== '2d' && parsed['viewMode'] !== '3d') ||
    (parsed['entityMode'] !== 'sphere' && parsed['entityMode'] !== 'identicon') ||
    typeof parsed['wasLastOpened'] !== 'boolean' ||
    !Number.isFinite(parsed['rotationX']) ||
    !Number.isFinite(parsed['rotationY']) ||
    !Number.isFinite(parsed['rotationZ'])) {
    throw new Error('BIRD_VIEW_SETTINGS_INVALID');
  }
  const vector = (candidate: unknown): { x: number; y: number; z: number } | null => {
    if (!candidate || typeof candidate !== 'object') return null;
    const point = candidate as Record<string, unknown>;
    return typeof point['x'] === 'number' && Number.isFinite(point['x']) &&
      typeof point['y'] === 'number' && Number.isFinite(point['y']) &&
      typeof point['z'] === 'number' && Number.isFinite(point['z'])
      ? { x: point['x'], y: point['y'], z: point['z'] }
      : null;
  };
  const cameraRecord = parsed['camera'];
  const camera = cameraRecord && typeof cameraRecord === 'object'
    ? (() => {
        const record = cameraRecord as Record<string, unknown>;
        const position = vector(record['position']);
        const target = vector(record['target']);
        return position && target && typeof record['zoom'] === 'number' && Number.isFinite(record['zoom'])
          ? { position, target, zoom: record['zoom'] }
          : null;
      })()
    : undefined;
  if (cameraRecord !== undefined && !camera) throw new Error('BIRD_VIEW_SETTINGS_INVALID');
  return {
    barsMode: parsed['barsMode'],
    selectedTokenId: Number(parsed['selectedTokenId']),
    viewMode: parsed['viewMode'],
    entityMode: parsed['entityMode'],
    wasLastOpened: parsed['wasLastOpened'],
    rotationX: Number(parsed['rotationX']),
    rotationY: Number(parsed['rotationY']),
    rotationZ: Number(parsed['rotationZ']),
    ...(camera ? { camera } : {}),
  };
}

export function readBirdViewSettings(storage: BirdViewSettingsStorage | null | undefined): BirdViewSettings {
  const saved = storage?.getItem(BIRD_VIEW_SETTINGS_STORAGE_KEY);
  return saved ? normalizeBirdViewSettings(parseJsonUnknown(saved, 'BIRD_VIEW_SETTINGS_JSON_INVALID')) : cloneDefaultBirdViewSettings();
}

export function buildBirdViewSettings(input: BirdViewSettingsInput): BirdViewSettings {
  return {
    barsMode: input.barsMode,
    selectedTokenId: input.selectedTokenId,
    viewMode: input.viewMode,
    entityMode: input.entityMode,
    wasLastOpened: input.wasLastOpened,
    rotationX: input.rotationX,
    rotationY: input.rotationY,
    rotationZ: input.rotationZ,
    camera: input.camera,
  };
}

export function writeBirdViewSettings(
  storage: BirdViewSettingsStorage | null | undefined,
  settings: BirdViewSettings,
): void {
  storage?.setItem(BIRD_VIEW_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
