// XLN Server Integration - Direct import of real server (no mocks)
// Mirrors the approach from legacy index.html

let XLNModule: any = null;

// Load the real XLN server module
async function loadXLNModule() {
  if (XLNModule) return XLNModule;
  
  try {
    console.log('🔧 Loading real XLN server module...');
    
    // Use dynamic import with URL constructor for runtime loading
    const serverUrl = new URL('/xln/server.js', window.location.origin).href;
    XLNModule = await import(/* @vite-ignore */ serverUrl);
    
    console.log('✅ Real XLN server loaded');
    return XLNModule;
  } catch (error) {
    console.error('❌ Failed to load XLN server:', error);
    throw new Error(`Cannot load XLN server: ${error.message}`);
  }
}

// Get XLN module 
export async function getXLNModule() {
  return await loadXLNModule();
}

// Direct wrapper functions that match legacy index.html usage
export const XLNServer = {
  async main() {
    const XLN = await getXLNModule();
    return XLN.main();
  },

  async createEmptyEnv() {
    const XLN = await getXLNModule();
    return XLN.createEmptyEnv();
  },

  async applyServerInput(env: any, input: any) {
    const XLN = await getXLNModule();
    return XLN.applyServerInput(env, input);
  },

  async processUntilEmpty(env: any) {
    const XLN = await getXLNModule();
    return XLN.processUntilEmpty(env);
  },

  async runDemo(env: any) {
    const XLN = await getXLNModule();
    return XLN.runDemo(env);
  },

  async clearDatabase() {
    const XLN = await getXLNModule();
    return XLN.clearDatabase();
  },

  async getHistory() {
    const XLN = await getXLNModule();
    return XLN.getHistory ? XLN.getHistory() : [];
  },

  async getSnapshot(index: number) {
    const XLN = await getXLNModule();
    return XLN.getSnapshot ? XLN.getSnapshot(index) : null;
  },

  // Entity creation functions
  async generateLazyEntityId() {
    const XLN = await getXLNModule();
    return XLN.generateLazyEntityId();
  },

  async generateNumberedEntityId(num: number) {
    const XLN = await getXLNModule();
    return XLN.generateNumberedEntityId(num);
  },

  async generateNamedEntityId(name: string) {
    const XLN = await getXLNModule();
    return XLN.generateNamedEntityId(name);
  },

  async createLazyEntity(config: any) {
    const XLN = await getXLNModule();
    return XLN.createLazyEntity(config);
  },

  async createNumberedEntity(config: any) {
    const XLN = await getXLNModule();
    return XLN.createNumberedEntity(config);
  },

  async requestNamedEntity(name: string, config: any) {
    const XLN = await getXLNModule();
    return XLN.requestNamedEntity(name, config);
  },

  // Display functions
  async formatEntityDisplay(entityId: string) {
    const XLN = await getXLNModule();
    return XLN.formatEntityDisplay(entityId);
  },

  async formatSignerDisplay(signerId: string) {
    const XLN = await getXLNModule();
    return XLN.formatSignerDisplay(signerId);
  },

  async generateEntityAvatar(entityId: string) {
    const XLN = await getXLNModule();
    return XLN.generateEntityAvatar(entityId);
  },

  async generateSignerAvatar(signerId: string) {
    const XLN = await getXLNModule();
    return XLN.generateSignerAvatar(signerId);
  },

  async getEntityDisplayInfo(entityId: string) {
    const XLN = await getXLNModule();
    return XLN.getEntityDisplayInfo(entityId);
  },

  async getSignerDisplayInfo(signerId: string) {
    const XLN = await getXLNModule();
    return XLN.getSignerDisplayInfo(signerId);
  },

  // Jurisdiction functions
  async getJurisdictions() {
    const XLN = await getXLNModule();
    return XLN.getJurisdictions();
  },

  async connectToEthereum() {
    const XLN = await getXLNModule();
    return XLN.connectToEthereum();
  }
};

// Simple HTML escape function (was missing from import)
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}