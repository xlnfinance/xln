// XLN Server Integration Utilities
// This module provides both real server.js and mock implementation for browser compatibility

let XLNModule: any = null;

// For now, just use mock (we'll improve this later)
async function loadXLNModule() {
  if (XLNModule) return XLNModule;
  
  console.log('🌐 Using mock XLN module for static build compatibility');
  XLNModule = createMockXLNModule();
  return XLNModule;
}

// Create a mock XLN module for browser compatibility
function createMockXLNModule() {
  console.log('🌐 Creating mock XLN module for browser environment');
  
  // Mock environment with sample data
  const mockEnv = {
    replicas: new Map([
      ['0x0000000000000000000000000000000000000000000000000000000000000001:alice', {
        entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
        signerId: 'alice',
        state: {
          height: 5,
          timestamp: Date.now(),
          nonces: new Map(),
          messages: ['Hello from Alice!', 'This is a demo message', 'Consensus is working!'],
          proposals: new Map([
            ['prop1', {
              proposer: 'alice',
              action: { type: 'collective_message', data: { message: 'Increase block size' } },
              votes: new Map([['alice', 'yes'], ['bob', 'yes']]),
              status: 'active'
            }]
          ]),
          config: {
            validators: ['alice', 'bob', 'carol'],
            threshold: 2,
            shares: { alice: 1, bob: 1, carol: 1 },
            mode: 'proposer-based',
            jurisdiction: { name: 'Ethereum', chainId: 1 }
          }
        },
        mempool: [],
        isProposer: true
      }],
      ['0x0000000000000000000000000000000000000000000000000000000000000001:bob', {
        entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
        signerId: 'bob',
        state: {
          height: 5,
          timestamp: Date.now(),
          nonces: new Map(),
          messages: ['Hello from Bob!', 'Consensus demo active'],
          proposals: new Map([
            ['prop1', {
              proposer: 'alice',
              action: { type: 'collective_message', data: { message: 'Increase block size' } },
              votes: new Map([['alice', 'yes'], ['bob', 'yes']]),
              status: 'active'
            }]
          ]),
          config: {
            validators: ['alice', 'bob', 'carol'],
            threshold: 2,
            shares: { alice: 1, bob: 1, carol: 1 },
            mode: 'proposer-based',
            jurisdiction: { name: 'Ethereum', chainId: 1 }
          }
        },
        mempool: [],
        isProposer: false
      }]
    ]),
    height: 5,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] }
  };

  const mockHistory = [
    {
      height: 1,
      timestamp: Date.now() - 4000,
      description: 'Initial setup',
      replicas: new Map(),
      serverInput: { serverTxs: [], entityInputs: [] },
      serverOutputs: []
    },
    {
      height: 2,
      timestamp: Date.now() - 3000,
      description: 'Entity creation',
      replicas: mockEnv.replicas,
      serverInput: { serverTxs: [], entityInputs: [] },
      serverOutputs: []
    }
  ];

  return {
    main: async () => {
      console.log('🎯 Mock XLN environment initialized');
      return mockEnv;
    },
    
    applyServerInput: (env: any, input: any) => {
      console.log('📨 Mock applyServerInput called');
      return { entityOutbox: [], mergedInputs: [] };
    },
    
    processUntilEmpty: (env: any, outputs: any[]) => {
      console.log('🔄 Mock processUntilEmpty called');
      return env;
    },
    
    runDemoWrapper: async (env: any) => {
      console.log('🚀 Mock demo completed');
      return env;
    },
    
    clearDatabase: async () => {
      console.log('🗑️ Mock database cleared');
    },
    
    getHistory: () => mockHistory,
    
    getSnapshot: (index: number) => mockHistory[index] || null,
    
    generateSignerAvatar: (signerId: string) => {
      // Generate a simple SVG avatar
      const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7'];
      const color = colors[signerId.charCodeAt(0) % colors.length];
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
        <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="16" r="16" fill="${color}"/>
          <text x="16" y="20" text-anchor="middle" fill="white" font-family="Arial" font-size="12" font-weight="bold">
            ${signerId.charAt(0).toUpperCase()}
          </text>
        </svg>
      `)}`;
    },
    
    generateEntityAvatar: (entityId: string) => {
      const colors = ['#6C5CE7', '#A29BFE', '#FD79A8', '#FDCB6E', '#E17055'];
      const color = colors[entityId.charCodeAt(0) % colors.length];
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
        <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
          <rect width="32" height="32" rx="4" fill="${color}"/>
          <text x="16" y="20" text-anchor="middle" fill="white" font-family="Arial" font-size="10" font-weight="bold">
            #${entityId.slice(-2)}
          </text>
        </svg>
      `)}`;
    },
    
    formatEntityDisplay: (entityId: string) => {
      if (entityId.startsWith('0x000000000000000000000000000000000000000000000000000000000000000')) {
        const num = parseInt(entityId.slice(-2), 16);
        return num.toString();
      }
      return entityId.slice(0, 8);
    },
    
    formatSignerDisplay: (signerId: string) => signerId,
    
    createLazyEntity: async () => ({ config: {} }),
    generateLazyEntityId: async () => '0x1234567890abcdef',
    createNumberedEntity: async () => ({ config: {}, entityNumber: 1 }),
    generateNumberedEntityId: async () => '0x0000000000000000000000000000000000000000000000000000000000000001'
  };
}

// Get XLN module (mock for browser)
export async function getXLNModule() {
  return await loadXLNModule();
}

// Type-safe wrapper functions for XLN operations
export const XLNServer = {
  async main() {
    const XLN = await getXLNModule();
    return XLN.main();
  },

  async applyServerInput(env: any, input: any) {
    const XLN = await getXLNModule();
    return XLN.applyServerInput(env, input);
  },

  async processUntilEmpty(env: any, outputs: any[]) {
    const XLN = await getXLNModule();
    return XLN.processUntilEmpty(env, outputs);
  },

  async createLazyEntity(name: string, validators: string[], threshold: bigint, jurisdiction?: any) {
    const XLN = await getXLNModule();
    return XLN.createLazyEntity(name, validators, threshold, jurisdiction);
  },

  async generateLazyEntityId(validators: any[], threshold: bigint) {
    const XLN = await getXLNModule();
    return XLN.generateLazyEntityId(validators, threshold);
  },

  async createNumberedEntity(name: string, validators: string[], threshold: bigint, jurisdiction?: any) {
    const XLN = await getXLNModule();
    return XLN.createNumberedEntity(name, validators, threshold, jurisdiction);
  },

  async generateNumberedEntityId(entityNumber: number) {
    const XLN = await getXLNModule();
    return XLN.generateNumberedEntityId(entityNumber);
  },

  async runDemoWrapper(env: any) {
    const XLN = await getXLNModule();
    return XLN.runDemoWrapper(env);
  },

  async clearDatabase() {
    const XLN = await getXLNModule();
    return XLN.clearDatabase();
  },

  async getHistory() {
    const XLN = await getXLNModule();
    return XLN.getHistory();
  },

  async getSnapshot(index: number) {
    const XLN = await getXLNModule();
    return XLN.getSnapshot(index);
  },

  async generateSignerAvatar(signerId: string) {
    const XLN = await getXLNModule();
    return XLN.generateSignerAvatar ? XLN.generateSignerAvatar(signerId) : null;
  },

  async generateEntityAvatar(entityId: string) {
    const XLN = await getXLNModule();
    return XLN.generateEntityAvatar ? XLN.generateEntityAvatar(entityId) : null;
  },

  async formatEntityDisplay(entityId: string) {
    const XLN = await getXLNModule();
    return XLN.formatEntityDisplay ? XLN.formatEntityDisplay(entityId) : entityId;
  },

  async formatSignerDisplay(signerId: string) {
    const XLN = await getXLNModule();
    return XLN.formatSignerDisplay ? XLN.formatSignerDisplay(signerId) : signerId;
  }
};

// Utility functions for safe type conversion
export function toNumber(value: any): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value;
}

export function safeStringify(obj: any, maxLength?: number): string {
  try {
    const result = JSON.stringify(obj, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value
    );
    return maxLength ? result.slice(0, maxLength) + (result.length > maxLength ? '...' : '') : result;
  } catch (error) {
    return '[Serialization Error]';
  }
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
