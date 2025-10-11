/**
 * Layout Manager
 * Save/load/share panel layouts
 */

export interface LayoutConfig {
  name: string;
  version: string;
  description?: string;
  grid: any; // Dockview grid structure
  panels?: Record<string, any>;
  activeGroup?: string;
  timeMachine?: {
    docked: boolean;
    position: 'top' | 'bottom' | 'left' | 'right';
    visible: boolean;
  };
}

export class LayoutManager {
  private readonly STORAGE_KEY = 'xln-layout';
  private readonly STORAGE_VERSION = '4.0';

  /** Save layout to localStorage */
  saveLayout(layout: LayoutConfig) {
    try {
      const data = {
        version: this.STORAGE_VERSION,
        timestamp: Date.now(),
        layout,
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save layout:', error);
    }
  }

  /** Load layout from localStorage or preset */
  async loadLayout(name: string = 'default'): Promise<LayoutConfig> {
    // Try localStorage first
    if (name === 'default') {
      try {
        const saved = localStorage.getItem(this.STORAGE_KEY);
        if (saved) {
          const data = JSON.parse(saved);
          if (data.version === this.STORAGE_VERSION) {
            return data.layout;
          }
        }
      } catch (error) {
        console.warn('Failed to load saved layout, falling back to preset:', error);
      }
    }

    // Fall back to preset
    return this.loadPreset(name);
  }

  /** Load preset layout from JSON file */
  async loadPreset(name: string): Promise<LayoutConfig> {
    try {
      const response = await fetch(`/view/layouts/${name}.json`);
      if (!response.ok) {
        throw new Error(`Layout ${name} not found`);
      }
      return await response.json();
    } catch (error) {
      console.error(`Failed to load preset ${name}, falling back to default:`, error);
      if (name !== 'default') {
        return this.loadPreset('default');
      }
      throw error;
    }
  }

  /** Export layout as JSON string */
  exportLayout(layout: LayoutConfig): string {
    return JSON.stringify(layout, null, 2);
  }

  /** Generate shareable URL with embedded layout */
  shareLayout(layout: LayoutConfig): string {
    const json = JSON.stringify(layout);
    const encoded = btoa(json);
    return `${window.location.origin}/view?layout=${encoded}`;
  }

  /** Import layout from URL parameter */
  importLayoutFromURL(): LayoutConfig | null {
    try {
      const params = new URLSearchParams(window.location.search);
      const encoded = params.get('layout');
      if (!encoded) return null;

      const json = atob(encoded);
      return JSON.parse(json);
    } catch (error) {
      console.error('Failed to import layout from URL:', error);
      return null;
    }
  }

  /** Clear saved layout */
  clearLayout() {
    localStorage.removeItem(this.STORAGE_KEY);
  }

  /** List available presets */
  getAvailablePresets(): string[] {
    return ['default', 'analyst', 'builder', 'embed'];
  }
}

export const layoutManager = new LayoutManager();
