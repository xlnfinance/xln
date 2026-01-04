import { writable, derived, get } from 'svelte/store';

export interface NavigationSelection {
  runtime: string | null;      // Runtime ID
  jurisdiction: string | null;  // Jurisdiction name
  signer: string | null;        // Signer address
  entity: string | null;        // Entity ID
  account: string | null;       // Account key (bilateral)
}

// Current selection state
export const navSelection = writable<NavigationSelection>({
  runtime: 'local',
  jurisdiction: null,
  signer: null,
  entity: null,
  account: null
});

// Navigation operations
export const navigationOperations = {
  // Navigate to a specific level
  navigate(level: keyof NavigationSelection, id: string | null) {
    navSelection.update(sel => {
      const newSel = { ...sel };
      newSel[level] = id;

      // Clear downstream selections when changing upstream
      const hierarchy: (keyof NavigationSelection)[] = ['runtime', 'jurisdiction', 'signer', 'entity', 'account'];
      const currentIndex = hierarchy.indexOf(level);
      for (let i = currentIndex + 1; i < hierarchy.length; i++) {
        newSel[hierarchy[i]!] = null;
      }

      return newSel;
    });
  },

  // Reset all selections
  reset() {
    navSelection.set({
      runtime: 'local',
      jurisdiction: null,
      signer: null,
      entity: null,
      account: null
    });
  },

  // Get current selection
  getSelection(): NavigationSelection {
    return get(navSelection);
  }
};
