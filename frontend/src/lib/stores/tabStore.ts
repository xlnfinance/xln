import { writable, get } from 'svelte/store';
import type { Tab } from '$lib/types/ui';

export const tabs = writable<Tab[]>([]);
export const activeTabId = writable<string | null>(null);
export const nextTabId = writable<number>(1);

const STORAGE_KEY = 'xln-entity-tabs';

const tabOperations = {
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const tabData = JSON.parse(saved);
        tabs.set(tabData.tabs || []);
        activeTabId.set(tabData.activeTabId || null);
        nextTabId.set(tabData.nextTabId || 1);
      }
    } catch (error) {
      console.error('❌ Failed to load tabs (clearing corrupted storage):', error);
      localStorage.removeItem(STORAGE_KEY);
      tabs.set([]);
      activeTabId.set(null);
      nextTabId.set(1);
    }
  },

  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      
      const tabData = {
        tabs: get(tabs),
        activeTabId: get(activeTabId),
        nextTabId: get(nextTabId)
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tabData));
    } catch (error) {
      console.error('❌ Failed to save tabs:', error);
    }
  },

  generateTabId(): string {
    const current = get(nextTabId);
    nextTabId.set(current + 1);
    return `tab-${current}`;
  },

  addTab(entityId?: string, signerId?: string, jurisdiction?: string): Tab {
    const currentTabs = get(tabs);
    const panelNumber = currentTabs.length + 1;
    
    const newTab: Tab = {
      id: this.generateTabId(),
      title: `Entity Panel ${panelNumber}`,
      jurisdiction: jurisdiction || 'Ethereum',
      signerId: signerId || '',
      entityId: entityId || '',
      isActive: false
    };

    tabs.update(currentTabs => [...currentTabs, newTab]);
    this.setActiveTab(newTab.id);
    this.saveToStorage();

    return newTab;
  },

  closeTab(tabId: string) {
    const currentTabs = get(tabs);
    
    if (currentTabs.length <= 1) {
      return; // Keep at least one tab
    }

    const tabIndex = currentTabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const updatedTabs = currentTabs.filter(t => t.id !== tabId);
    tabs.set(updatedTabs);

    // If closed tab was active, switch to first remaining tab
    const currentActiveId = get(activeTabId);
    if (currentActiveId === tabId && updatedTabs.length > 0 && updatedTabs[0]) {
      this.setActiveTab(updatedTabs[0].id);
    }

    this.saveToStorage();
  },

  setActiveTab(tabId: string) {
    tabs.update(currentTabs => 
      currentTabs.map(tab => ({
        ...tab,
        isActive: tab.id === tabId
      }))
    );
    
    activeTabId.set(tabId);
    this.saveToStorage();
  },

  getActiveTab(): Tab | null {
    const currentTabs = get(tabs);
    const currentActiveId = get(activeTabId);
    return currentTabs.find(tab => tab.id === currentActiveId) || null;
  },

  updateTab(tabId: string, updates: Partial<Omit<Tab, 'id'>>) {
    tabs.update(currentTabs => 
      currentTabs.map(tab => 
        tab.id === tabId ? { ...tab, ...updates } : tab
      )
    );
    this.saveToStorage();
  },

  getTab(tabId: string): Tab | null {
    const currentTabs = get(tabs);
    return currentTabs.find(tab => tab.id === tabId) || null;
  },

  initializeDefaultTabs() {
  },

  clearAllTabs() {
    tabs.set([]);
    activeTabId.set(null);
    nextTabId.set(1);
    this.saveToStorage();
  }
};

export { tabOperations };
