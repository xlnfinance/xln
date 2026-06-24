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
  if (!value || typeof value !== 'object') return cloneDefaultBirdViewSettings();

  const parsed = { ...(value as Partial<BirdViewSettings> & { selectedTokenId?: unknown }) } as BirdViewSettings & {
    selectedTokenId?: unknown;
  };
  if (typeof parsed.selectedTokenId === 'string') parsed.selectedTokenId = Number(parsed.selectedTokenId);
  if (parsed.rotationX === undefined) parsed.rotationX = 0;
  if (parsed.rotationY === undefined) parsed.rotationY = 0;
  if (parsed.rotationZ === undefined) parsed.rotationZ = 0;
  if (parsed.barsMode === undefined) parsed.barsMode = 'close';
  return parsed as BirdViewSettings;
}

export function readBirdViewSettings(storage: BirdViewSettingsStorage | null | undefined): BirdViewSettings {
  try {
    const saved = storage?.getItem(BIRD_VIEW_SETTINGS_STORAGE_KEY);
    return saved ? normalizeBirdViewSettings(JSON.parse(saved)) : cloneDefaultBirdViewSettings();
  } catch {
    return cloneDefaultBirdViewSettings();
  }
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
