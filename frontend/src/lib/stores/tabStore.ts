import { writable, get } from 'svelte/store';
import type { Tab } from '$lib/types/ui';

// Tab System State
export const tabs = writable<Tab[]>([]);
export const activeTabId = writable<string | null>(null);
export const nextTabId = writable<number>(1);

// Storage key for persistence
const STORAGE_KEY = 'xln-entity-tabs';

// Tab Operations
const tabOperations = {
  // Load tabs from localStorage
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const tabData = JSON.parse(saved);
        tabs.set(tabData.tabs || []);
        activeTabId.set(tabData.activeTabId || null);
        nextTabId.set(tabData.nextTabId || 1);
        console.log('📁 Tabs loaded from localStorage:', tabData);
      }
    } catch (error) {
      console.error('❌ Failed to load tabs:', error);
      // Initialize with empty tab system on error
      tabs.set([]);
      activeTabId.set(null);
      nextTabId.set(1);
    }
  },

  // Save tabs to localStorage
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      
      const tabData = {
        tabs: get(tabs),
        activeTabId: get(activeTabId),
        nextTabId: get(nextTabId)
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tabData));
      console.log('💾 Tabs saved to localStorage:', tabData);
    } catch (error) {
      console.error('❌ Failed to save tabs:', error);
    }
  },

  // Generate unique tab ID
  generateTabId(): string {
    const current = get(nextTabId);
    nextTabId.set(current + 1);
    return `tab-${current}`;
  },

  // Add new tab
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

    console.log('➕ Added new panel:', newTab);
    return newTab;
  },

  // Close tab
  closeTab(tabId: string) {
    const currentTabs = get(tabs);
    console.log('❌ Closing tab:', tabId);
    
    if (currentTabs.length <= 1) {
      console.log('⚠️ Cannot close last tab');
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

  // Set active tab
  setActiveTab(tabId: string) {
    console.log('🎯 Setting active tab:', tabId);
    
    tabs.update(currentTabs => 
      currentTabs.map(tab => ({
        ...tab,
        isActive: tab.id === tabId
      }))
    );
    
    activeTabId.set(tabId);
    this.saveToStorage();
  },

  // Get active tab
  getActiveTab(): Tab | null {
    const currentTabs = get(tabs);
    const currentActiveId = get(activeTabId);
    return currentTabs.find(tab => tab.id === currentActiveId) || null;
  },

  // Update tab data
  updateTab(tabId: string, updates: Partial<Omit<Tab, 'id'>>) {
    tabs.update(currentTabs => 
      currentTabs.map(tab => 
        tab.id === tabId ? { ...tab, ...updates } : tab
      )
    );
    this.saveToStorage();
  },

  // Get tab by ID
  getTab(tabId: string): Tab | null {
    const currentTabs = get(tabs);
    return currentTabs.find(tab => tab.id === tabId) || null;
  },

  // Initialize with default tabs
  initializeDefaultTabs() {
    // Start with 0 panels - user creates entities to get panels
    console.log('📋 Starting with 0 panels by default');
  },

  // Clear all tabs and reset
  clearAllTabs() {
    tabs.set([]);
    activeTabId.set(null);
    nextTabId.set(1);
    this.saveToStorage();
  }
};

// Export stores and operations
export { tabOperations };
