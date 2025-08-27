// XLN Server Integration Utilities
// CLIENT-SIDE ONLY - This module should only be used in browser environment
// Designed for progressive loading after SSR completes

import { browser } from '$app/environment';

let XLN: any = null;
let loadingPromise: Promise<any> | null = null;

// Client-side only import of xlnfinance
const getXLNModule = async () => {
  // Prevent any SSR execution
  if (!browser) {
    throw new Error('XLN module can only be used in browser environment');
  }

  // Return cached module if already loaded
  if (XLN) return XLN;
  
  // Return existing loading promise if already in progress
  if (loadingPromise) return loadingPromise;
  
  // Start loading the module
  loadingPromise = (async () => {
    try {
      console.log('🔄 Loading XLN module client-side...');
      const module = await import('xlnfinance');
      XLN = module;
      console.log('✅ XLN module loaded successfully');
      return XLN;
    } catch (error) {
      console.error('❌ Failed to load xlnfinance module:', error);
      loadingPromise = null; // Reset to allow retry
      throw error;
    }
  })();
  
  return loadingPromise;
};

// Interface for XLN module methods
interface XLNModule {
  main(): Promise<any>;
  applyServerInput(env: any, input: any): Promise<any>;
  processUntilEmpty(env: any, outputs: any[]): Promise<any>;
  createLazyEntity(name: string, validators: string[], threshold: bigint, jurisdiction?: any): Promise<any>;
  generateLazyEntityId(validators: any[], threshold: bigint): Promise<any>;
  createNumberedEntity(name: string, validators: string[], threshold: bigint, jurisdiction?: any): Promise<any>;
  generateNumberedEntityId(entityNumber: number): Promise<any>;
  runDemoWrapper(env: any): Promise<any>;
  clearDatabase(): Promise<any>;
  getHistory(): Promise<any>;
  getSnapshot(index: number): Promise<any>;
  generateSignerAvatar?(signerId: string): Promise<any>;
  generateEntityAvatar?(entityId: string): Promise<any>;
  formatEntityDisplay?(entityId: string): Promise<string>;
  formatSignerDisplay?(signerId: string): Promise<string>;
}

// Proxy that automatically loads XLN module and delegates all method calls
export const XLNServer: XLNModule = new Proxy({} as XLNModule, {
  get: (target, prop: string) => {
    return async (...args: any[]) => {
      const XLN = await getXLNModule();
      const method = XLN[prop];
      if (typeof method === 'function') {
        return method(...args);
      }
      return method;
    };
  }
});

// Utility functions for safe type conversion
export function toNumber(value: any): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value;
}

export function safeStringify(obj: any, maxLength?: number): string {
  try {
    const result = JSON.stringify(obj, (key, value) => (typeof value === 'bigint' ? value.toString() : value));
    return maxLength ? result.slice(0, maxLength) + (result.length > maxLength ? '...' : '') : result;
  } catch (error) {
    return '[Serialization Error]';
  }
}

export function escapeHtml(text: string): string {
  // SSR-safe HTML escaping
  if (typeof window === 'undefined') {
    // Server-side implementation
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  
  // Browser implementation
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
