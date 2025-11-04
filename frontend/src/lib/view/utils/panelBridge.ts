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
  'broadcast:toggle': { enabled: boolean };
  'broadcast:style': { style: 'raycast' | 'wave' | 'particles' };
  'settings:update': { key: string; value: any };
  'settings:reset': {};
  'camera:focus': { target: { x: number; y: number; z: number } };
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
