import { writable, get } from 'svelte/store';
import type { Tab } from '$lib/types/ui';
import { errorLog } from '../errorLogStore';
import { parseJsonUnknown, rejectExtraKeys, requireUnknownRecord } from '$lib/utils/boundary';

export const tabs = writable<Tab[]>([]);
export const activeTabId = writable<string | null>(null);
export const nextTabId = writable<number>(1);

const STORAGE_KEY = 'xln-entity-tabs';

const decodePersistedTab = (value: unknown): Tab => {
  const record = requireUnknownRecord(value, 'TAB_STORAGE_TAB_INVALID');
  rejectExtraKeys(record, ['id', 'title', 'jurisdiction', 'signerId', 'entityId', 'accountId', 'isActive'], 'TAB_STORAGE_TAB_EXTRA_FIELD');
  if (typeof record['id'] !== 'string' || typeof record['title'] !== 'string' || typeof record['jurisdiction'] !== 'string' ||
    typeof record['signerId'] !== 'string' || typeof record['entityId'] !== 'string' || typeof record['isActive'] !== 'boolean' ||
    (record['accountId'] !== undefined && typeof record['accountId'] !== 'string')) throw new Error('TAB_STORAGE_TAB_FIELD_INVALID');
  return {
    id: record['id'], title: record['title'], jurisdiction: record['jurisdiction'], signerId: record['signerId'], entityId: record['entityId'], isActive: record['isActive'],
    ...(record['accountId'] === undefined ? {} : { accountId: record['accountId'] }),
  };
};

const decodePersistedTabs = (value: unknown): { tabs: Tab[]; activeTabId: string | null; nextTabId: number } => {
  const record = requireUnknownRecord(value, 'TAB_STORAGE_INVALID');
  rejectExtraKeys(record, ['tabs', 'activeTabId', 'nextTabId'], 'TAB_STORAGE_EXTRA_FIELD');
  if (!Array.isArray(record['tabs']) || (record['activeTabId'] !== null && typeof record['activeTabId'] !== 'string') ||
    typeof record['nextTabId'] !== 'number' || !Number.isSafeInteger(record['nextTabId']) || record['nextTabId'] < 1) throw new Error('TAB_STORAGE_FIELD_INVALID');
  return { tabs: record['tabs'].map(decodePersistedTab), activeTabId: record['activeTabId'], nextTabId: record['nextTabId'] };
};

const tabOperations = {
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const tabData = decodePersistedTabs(parseJsonUnknown(saved, 'TAB_STORAGE_JSON_INVALID'));
        tabs.set(tabData.tabs);
        activeTabId.set(tabData.activeTabId);
        nextTabId.set(tabData.nextTabId);
      }
    } catch (error) {
      errorLog.log('Failed to load tabs; clearing corrupted storage', 'Tabs', error);
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
      errorLog.log('Failed to save tabs', 'Tabs', error);
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
