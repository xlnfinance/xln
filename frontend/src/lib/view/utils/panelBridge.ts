/**
 * Panel Communication Bridge
 * Event bus for inter-panel communication
 */

export type EntityOpenAction = 'r2r' | 'r2c' | 'pay' | 'swap' | 'dispute';

/**
 * Every channel here must have a live producer AND consumer — a typed event nobody listens
 * on reads like working wiring. Dropped as fully unwired: account:updated, reserves:updated,
 * transfer:executed, layout:changed, rebalance:requested, timeMachine:play, vr:hand-payment,
 * time:changed, entity:created, renderFps (Graph3D renders its own overlay).
 *
 * KNOWN DEAD CONTROL: ArchitectPanel's broadcast-style radios emit 'broadcast:style' and
 * nothing consumes it. Kept typed until that UI is either wired or removed.
 */
type EventMap = {
  'entity:selected': { entityId: string };
  'vr:toggle': {};
  'vr:payment': { from: string; to: string }; // VR hand gesture payment
  'broadcast:toggle': { enabled: boolean };
  'broadcast:style': { style: 'raycast' | 'wave' | 'particles' };
  'settings:update': { key: string; value: any };
  'settings:reset': {};
  'camera:focus': { target: { x: number; y: number; z: number } };
  'auto-demo:start': {}; // Auto-start demo in VR mode
  'openEntityOperations': { entityId: string; entityName: string; signerId?: string; action?: EntityOpenAction }; // Open entity panel with optional action
  'dock:selectEntity': { entityId: string; entityName: string; signerId?: string; action?: EntityOpenAction };
  'openJurisdiction': { jurisdictionName: string }; // Open jurisdiction panel (J-Machine click)
  'focusPanel': { panelId: string }; // Focus any panel by ID
  'scenario:loaded': { name: string; frames: number }; // Scenario loaded successfully
  'camera:update': { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; distance?: number }; // Camera position changed
  'camera:restore': { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; distance?: number }; // Apply a saved camera preset
  'playback:speed': number; // Playback speed multiplier from TimeMachine
};

class PanelBridge {
  private listeners = new Map<keyof EventMap, Set<Function>>();

  on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.off(event, handler); // Return cleanup function
  }

  off<K extends keyof EventMap>(event: K, handler: Function) {
    this.listeners.get(event)?.delete(handler);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      const errors: unknown[] = [];
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          errors.push(error);
        }
      });
      if (errors.length > 0) {
        const details = errors.map((error) =>
          error instanceof Error ? error.message : String(error)
        ).join('; ');
        throw new Error(`PANEL_BRIDGE_HANDLER_FAILED:${String(event)}:${details}`);
      }
    }
  }

  /** Clear all listeners (for cleanup) */
  clear() {
    this.listeners.clear();
  }

  /** Get listener count for debugging */
  getListenerCount(event?: keyof EventMap): number {
    if (event) {
      return this.listeners.get(event)?.size || 0;
    }
    let total = 0;
    this.listeners.forEach(set => total += set.size);
    return total;
  }
}

export const panelBridge = new PanelBridge();
