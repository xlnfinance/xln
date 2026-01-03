/**
 * SettingsPersistence.ts - Pure localStorage persistence for Graph3DPanel
 *
 * Extracted from Graph3DPanel.svelte to provide testable, pure functions
 * for loading and saving bird view settings and entity positions.
 */

// Storage keys
const BIRD_VIEW_SETTINGS_KEY = 'xln-bird-view-settings';
const ENTITY_POSITIONS_KEY = 'xln-entity-positions';

/**
 * Camera state persisted to localStorage
 */
export interface CameraState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  zoom: number;
}

/**
 * Bird view settings stored in localStorage
 */
export interface BirdViewSettings {
  barsMode: 'close' | 'spread';
  selectedTokenId: number;
  viewMode: '2d' | '3d';
  entityMode: 'sphere' | 'identicon';
  wasLastOpened: boolean;
  rotationX: number; // 0-10000 (0 = stopped, 10000 = fast rotation)
  rotationY: number; // 0-10000
  rotationZ: number; // 0-10000
  camera?: CameraState | undefined;
}

/**
 * Entity position data for persistence
 */
export interface EntityPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * Default settings when none are saved
 */
export const DEFAULT_BIRD_VIEW_SETTINGS: BirdViewSettings = {
  barsMode: 'spread',
  selectedTokenId: 1, // Default to USDC
  viewMode: '3d',
  entityMode: 'sphere',
  wasLastOpened: false,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  camera: undefined
};

/**
 * Load bird view settings from localStorage
 * Handles backward compatibility for old settings formats
 */
export function loadBirdViewSettings(): BirdViewSettings {
  try {
    const saved = localStorage.getItem(BIRD_VIEW_SETTINGS_KEY);
    if (!saved) {
      return { ...DEFAULT_BIRD_VIEW_SETTINGS };
    }

    const parsed = JSON.parse(saved);

    // FINTECH-SAFETY: Ensure selectedTokenId is number, not string
    if (typeof parsed.selectedTokenId === 'string') {
      parsed.selectedTokenId = Number(parsed.selectedTokenId);
    }

    // Backward compatibility: convert old rotationSpeed to rotationY
    if (parsed.rotationSpeed !== undefined) {
      parsed.rotationY = parsed.rotationSpeed;
      delete parsed.rotationSpeed;
    }

    // Backward compatibility: convert old autoRotate boolean to rotationY
    if (parsed.autoRotate !== undefined && parsed.rotationY === undefined) {
      parsed.rotationY = parsed.autoRotate ? 3000 : 0;
      delete parsed.autoRotate;
    }

    // Provide defaults for new fields if missing
    return {
      barsMode: parsed.barsMode ?? DEFAULT_BIRD_VIEW_SETTINGS.barsMode,
      selectedTokenId: parsed.selectedTokenId ?? DEFAULT_BIRD_VIEW_SETTINGS.selectedTokenId,
      viewMode: parsed.viewMode ?? DEFAULT_BIRD_VIEW_SETTINGS.viewMode,
      entityMode: parsed.entityMode ?? DEFAULT_BIRD_VIEW_SETTINGS.entityMode,
      wasLastOpened: parsed.wasLastOpened ?? DEFAULT_BIRD_VIEW_SETTINGS.wasLastOpened,
      rotationX: parsed.rotationX ?? DEFAULT_BIRD_VIEW_SETTINGS.rotationX,
      rotationY: parsed.rotationY ?? DEFAULT_BIRD_VIEW_SETTINGS.rotationY,
      rotationZ: parsed.rotationZ ?? DEFAULT_BIRD_VIEW_SETTINGS.rotationZ,
      camera: parsed.camera
    };
  } catch {
    return { ...DEFAULT_BIRD_VIEW_SETTINGS };
  }
}

/**
 * Save bird view settings to localStorage
 */
export function saveBirdViewSettings(settings: BirdViewSettings): void {
  try {
    localStorage.setItem(BIRD_VIEW_SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('Failed to save bird view settings:', err);
  }
}

/**
 * Load entity positions from localStorage
 * Returns a map of entityId -> position
 */
export function loadEntityPositions(): Record<string, EntityPosition> {
  try {
    const saved = localStorage.getItem(ENTITY_POSITIONS_KEY);
    if (!saved) {
      return {};
    }
    return JSON.parse(saved);
  } catch {
    return {};
  }
}

/**
 * Save entity positions to localStorage
 * @param positions Map of entityId -> {x, y, z} position
 */
export function saveEntityPositions(positions: Record<string, EntityPosition>): void {
  try {
    localStorage.setItem(ENTITY_POSITIONS_KEY, JSON.stringify(positions));
  } catch (err) {
    console.warn('Failed to save entity positions:', err);
  }
}

/**
 * Clear all persisted settings (useful for reset)
 */
export function clearAllSettings(): void {
  try {
    localStorage.removeItem(BIRD_VIEW_SETTINGS_KEY);
    localStorage.removeItem(ENTITY_POSITIONS_KEY);
  } catch (err) {
    console.warn('Failed to clear settings:', err);
  }
}

/**
 * Helper to create a BirdViewSettings object from component state
 * Useful when saving from the Svelte component
 */
export function createBirdViewSettings(
  barsMode: 'close' | 'spread',
  selectedTokenId: number,
  viewMode: '2d' | '3d',
  entityMode: 'sphere' | 'identicon',
  wasLastOpened: boolean,
  rotationX: number,
  rotationY: number,
  rotationZ: number,
  camera?: CameraState
): BirdViewSettings {
  return {
    barsMode,
    selectedTokenId,
    viewMode,
    entityMode,
    wasLastOpened,
    rotationX,
    rotationY,
    rotationZ,
    camera
  };
}

/**
 * Helper to extract positions from an entity array
 * @param entities Array of entities with id and position properties
 */
export function extractEntityPositions(
  entities: Array<{ id: string; position: { x: number; y: number; z: number } }>
): Record<string, EntityPosition> {
  const positions: Record<string, EntityPosition> = {};
  for (const entity of entities) {
    positions[entity.id] = {
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z
    };
  }
  return positions;
}
