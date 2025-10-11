/**
 * Panel Registry
 * Maps panel types to Svelte component constructors
 */

import type { SvelteComponent } from 'svelte';

export interface PanelDefinition {
  id: string;
  type: string;
  title: string;
  icon: string;
  component: typeof SvelteComponent;
}

class PanelRegistry {
  private panels = new Map<string, PanelDefinition>();

  register(def: PanelDefinition) {
    this.panels.set(def.type, def);
  }

  get(type: string): PanelDefinition | undefined {
    return this.panels.get(type);
  }

  getAll(): PanelDefinition[] {
    return Array.from(this.panels.values());
  }

  getAllTypes(): string[] {
    return Array.from(this.panels.keys());
  }
}

export const panelRegistry = new PanelRegistry();

// Register core panels (will be imported dynamically)
export function registerCorePanels() {
  // Panels will be registered when they're loaded
  // This avoids circular dependencies
}
