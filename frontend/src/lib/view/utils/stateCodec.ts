/**
 * Universal State Codec
 * Serializes/deserializes XLN state for persistence + URL sharing
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

export interface XLNPersistedState {
  v: number; // Schema version
  t: number; // Timestamp

  // Core data (always included)
  x: any[]; // Xlnomies (serialized)
  e: any[]; // Entities (serialized replicas)
  a: string; // Active xlnomy name

  // UI preferences (optional)
  ui?: {
    s: any; // Settings
    l: any; // Dockview layout
    c: { x: number; y: number; z: number }; // Camera position
    ti: number; // Time index
  } | undefined;
}

/**
 * Serialize Map to array (Maps don't JSON.stringify cleanly)
 */
function serializeMap<K, V>(map: Map<K, V>): Array<[K, V]> {
  return Array.from(map.entries());
}

/**
 * Deserialize array back to Map
 */
function deserializeMap<K, V>(arr: Array<[K, V]>): Map<K, V> {
  return new Map(arr);
}

/**
 * Export current state to base64 string (for URL hash or localStorage)
 */
export function exportState(
  env: any,
  options?: {
    includeUI?: boolean;
    settings?: any;
    layout?: any;
    cameraPosition?: { x: number; y: number; z: number };
    timeIndex?: number;
  }
): string {
  try {
    const state: XLNPersistedState = {
      v: 1, // Schema version
      t: Date.now(),

      // Core data
      x: env.xlnomies ? serializeMap(env.xlnomies) : [],
      e: env.replicas ? serializeMap(env.replicas) : [],
      a: env.activeXlnomy || '',

      // Optional UI
      ui: options?.includeUI ? {
        s: options.settings,
        l: options.layout,
        c: options.cameraPosition || { x: 0, y: 0, z: 0 },
        ti: options.timeIndex || 0
      } : undefined
    };

    // Serialize to JSON
    const json = JSON.stringify(state, (key, value) => {
      // Handle BigInt serialization
      if (typeof value === 'bigint') {
        return value.toString() + 'n';
      }
      return value;
    });

    // Base64 encode (no gzip for simplicity)
    return btoa(encodeURIComponent(json));
  } catch (err) {
    console.error('[StateCodec] Export failed:', err);
    throw new Error(`Failed to export state: ${err}`);
  }
}

/**
 * Import state from base64 string
 */
export function importState(encoded: string): XLNPersistedState {
  try {
    // Decode base64
    const json = decodeURIComponent(atob(encoded));

    // Parse JSON
    const state = JSON.parse(json, (key, value) => {
      // Handle BigInt deserialization
      if (typeof value === 'string' && value.endsWith('n')) {
        return BigInt(value.slice(0, -1));
      }
      return value;
    });

    // Validate schema version
    if (state.v !== 1) {
      throw new Error(`Unsupported schema version: ${state.v}`);
    }

    // Deserialize Maps
    state.x = deserializeMap(state.x);
    state.e = deserializeMap(state.e);

    console.log('[StateCodec] Imported state:', {
      version: state.v,
      timestamp: new Date(state.t).toISOString(),
      xlnomies: state.x.size,
      entities: state.e.size,
      hasUI: !!state.ui
    });

    return state as XLNPersistedState;
  } catch (err) {
    console.error('[StateCodec] Import failed:', err);
    throw new Error(`Failed to import state: ${err}`);
  }
}

/**
 * Save state to localStorage
 */
export function saveToLocalStorage(key: string, state: any) {
  try {
    const encoded = exportState(state, { includeUI: true });
    localStorage.setItem(key, encoded);
    console.log(`[StateCodec] Saved to localStorage: ${key}`);
  } catch (err) {
    console.error(`[StateCodec] Failed to save ${key}:`, err);
  }
}

/**
 * Load state from localStorage
 */
export function loadFromLocalStorage(key: string): XLNPersistedState | null {
  try {
    const encoded = localStorage.getItem(key);
    if (!encoded) return null;

    return importState(encoded);
  } catch (err) {
    console.error(`[StateCodec] Failed to load ${key}:`, err);
    return null;
  }
}

/**
 * Generate shareable URL with state in hash
 */
export function generateShareURL(
  env: any,
  includeUI: boolean = false
): string {
  const encoded = exportState(env, { includeUI });
  const baseURL = window.location.origin + window.location.pathname;
  return `${baseURL}#s=${encoded}${includeUI ? '&ui=1' : ''}`;
}

/**
 * Parse state from URL hash
 */
export function parseURLHash(): { state: XLNPersistedState; includeUI: boolean } | null {
  try {
    const hash = window.location.hash.slice(1); // Remove '#'
    const params = new URLSearchParams(hash);
    const encoded = params.get('s');

    if (!encoded) return null;

    const state = importState(encoded);
    const includeUI = params.get('ui') === '1';

    return { state, includeUI };
  } catch (err) {
    console.error('[StateCodec] Failed to parse URL hash:', err);
    return null;
  }
}
