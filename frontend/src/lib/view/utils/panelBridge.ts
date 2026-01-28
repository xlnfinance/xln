/**
 * Panel Communication Bridge
 * Event bus for inter-panel communication
 */

type EventMap = {
  'entity:selected': { entityId: string };
  'entity:created': { entityId: string; type: string };
  'account:updated': { accountId: string; balance: bigint };
  'reserves:updated': { entityId: string; tokenId: number; amount: bigint };
  'time:changed': { frame: number; block: number };
  'layout:changed': { layout: any };
  'transfer:executed': { from: string; to: string; tokenId: number; amount: bigint };
  'vr:toggle': {};
  'vr:payment': { from: string; to: string }; // VR hand gesture payment
  'vr:hand-payment': { from: string; to: string; amount?: bigint }; // Hand tracking payment
  'broadcast:toggle': { enabled: boolean };
  'broadcast:style': { style: 'raycast' | 'wave' | 'particles' };
  'settings:update': { key: string; value: any };
  'settings:reset': {};
  'camera:focus': { target: { x: number; y: number; z: number } };
  'renderFps': number; // Real-time rendering FPS from Graph3DPanel
  'auto-demo:start': {}; // Auto-start demo in VR mode
  'tutorial:action': { action: string; data?: any }; // Tutorial actions
  'openEntityOperations': { entityId: string; entityName: string; signerId?: string; action?: 'r2r' | 'r2c' }; // Open entity panel with optional action
  'openJurisdiction': { jurisdictionName: string }; // Open jurisdiction panel (J-Machine click)
  'focusPanel': { panelId: string }; // Focus any panel by ID
  'scenario:loaded': { name: string; frames: number }; // Scenario loaded successfully
  'camera:update': { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; distance?: number }; // Camera position changed
  'camera:restore': { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; distance?: number }; // Restore saved camera position
  'timeMachine:play': {}; // Time machine playback started
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
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`Error in panel bridge handler for ${event}:`, error);
        }
      });
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
