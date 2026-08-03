import { createExternalStore } from '../../../packages/client-core/external-store';
import { getSvelteStoreValue as get, toSvelteReadable } from './adapters/svelteExternalStore';
import type { Tab } from '$lib/types/ui';
import { errorLog } from './errorLogStore';

const tabsBinding = createExternalStore<Tab[]>([]);
const activeTabIdBinding = createExternalStore<string | null>(null);
const nextTabIdBinding = createExternalStore<number>(1);
export const tabsExternalStore = tabsBinding.store;
export const activeTabIdExternalStore = activeTabIdBinding.store;
export const nextTabIdExternalStore = nextTabIdBinding.store;
export const tabs = toSvelteReadable(tabsBinding.store);
export const activeTabId = toSvelteReadable(activeTabIdBinding.store);
export const nextTabId = toSvelteReadable(nextTabIdBinding.store);

const STORAGE_KEY = 'xln-entity-tabs';

const tabOperations = {
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const tabData = JSON.parse(saved);
        tabsBinding.controller.set(tabData.tabs || []);
        activeTabIdBinding.controller.set(tabData.activeTabId || null);
        nextTabIdBinding.controller.set(tabData.nextTabId || 1);
      }
    } catch (error) {
      errorLog.log('Failed to load tabs; clearing corrupted storage', 'Tabs', error);
      localStorage.removeItem(STORAGE_KEY);
      tabsBinding.controller.set([]);
      activeTabIdBinding.controller.set(null);
      nextTabIdBinding.controller.set(1);
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
      errorLog.log('Failed to save tabs', 'Tabs', error);
    }
  },

  generateTabId(): string {
    const current = get(nextTabId);
    nextTabIdBinding.controller.set(current + 1);
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

    tabsBinding.controller.update(currentTabs => [...currentTabs, newTab]);
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
    tabsBinding.controller.set(updatedTabs);

    // If closed tab was active, switch to first remaining tab
    const currentActiveId = get(activeTabId);
    if (currentActiveId === tabId && updatedTabs.length > 0 && updatedTabs[0]) {
      this.setActiveTab(updatedTabs[0].id);
    }

    this.saveToStorage();
  },

  setActiveTab(tabId: string) {
    tabsBinding.controller.update(currentTabs =>
      currentTabs.map(tab => ({
        ...tab,
        isActive: tab.id === tabId
      }))
    );
    
    activeTabIdBinding.controller.set(tabId);
    this.saveToStorage();
  },

  getActiveTab(): Tab | null {
    const currentTabs = get(tabs);
    const currentActiveId = get(activeTabId);
    return currentTabs.find(tab => tab.id === currentActiveId) || null;
  },

  updateTab(tabId: string, updates: Partial<Omit<Tab, 'id'>>) {
    tabsBinding.controller.update(currentTabs =>
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
    tabsBinding.controller.set([]);
    activeTabIdBinding.controller.set(null);
    nextTabIdBinding.controller.set(1);
    this.saveToStorage();
  }
};

export { tabOperations };
