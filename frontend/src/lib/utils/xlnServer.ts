// XLN Server Integration Utilities
// This module provides a mock implementation for browser compatibility
// The full XLN server functionality requires Node.js environment

let XLNModule: any = null;

// Create a mock XLN module for browser compatibility
function createMockXLNModule() {
  console.log('🌐 Creating mock XLN module for browser environment');
  
  // Create progressive snapshots for time machine functionality
  const baseTime = Date.now() - 10000; // 10 seconds ago
  const entityId = '0x0000000000000000000000000000000000000000000000000000000000000001';
  
  // Helper function to create replica state at different heights
  function createReplicaState(signerId: string, height: number, messages: string[], proposals: any = {}) {
    return {
      entityId,
      signerId,
      state: {
        height,
        timestamp: baseTime + (height * 1000),
        nonces: new Map(),
        messages: [...messages],
        proposals: new Map(Object.entries(proposals)),
        config: {
          validators: ['alice', 'bob', 'carol'],
          threshold: 2,
          shares: { alice: 1, bob: 1, carol: 1 },
          mode: 'proposer-based',
          jurisdiction: { name: 'Ethereum', chainId: 1 }
        }
      },
      mempool: [],
      isProposer: signerId === 'alice',
      blockHeight: height
    };
  }

  // Create historical snapshots showing progression
  const mockHistory = [
    {
      height: 0,
      timestamp: baseTime,
      description: 'Genesis - System initialization',
      replicas: new Map(),
      serverInput: { serverTxs: [], entityInputs: [] },
      serverOutputs: []
    },
    {
      height: 1,
      timestamp: baseTime + 1000,
      description: 'Entity created - Validators joined',
      replicas: new Map([
        [`${entityId}:alice`, createReplicaState('alice', 1, ['System initialized'], {})],
        [`${entityId}:bob`, createReplicaState('bob', 1, ['System initialized'], {})]
      ]),
      serverInput: { serverTxs: [], entityInputs: [] },
      serverOutputs: []
    },
    {
      height: 2,
      timestamp: baseTime + 2000,
      description: 'First messages - Chat activity begins',
      replicas: new Map([
        [`${entityId}:alice`, createReplicaState('alice', 2, ['System initialized', 'Hello from Alice!'], {})],
        [`${entityId}:bob`, createReplicaState('bob', 2, ['System initialized', 'Hello from Bob!'], {})]
      ]),
      serverInput: { serverTxs: [], entityInputs: [] },
      serverOutputs: []
    },
    {
      height: 3,
      timestamp: baseTime + 3000,
      description: 'Proposal submitted - Governance begins',
      replicas: new Map([
        [`${entityId}:alice`, createReplicaState('alice', 3, 
          ['System initialized', 'Hello from Alice!', 'Submitting proposal...'], 
          {
            'prop1': {
              proposer: 'alice',
              action: { type: 'collective_message', data: { message: 'Increase block size' } },
              votes: new Map([['alice', 'yes']]),
              status: 'active'
            }
          }
        )],
        [`${entityId}:bob`, createReplicaState('bob', 3, 
          ['System initialized', 'Hello from Bob!', 'Reviewing proposal...'], 
          {
            'prop1': {
              proposer: 'alice',
              action: { type: 'collective_message', data: { message: 'Increase block size' } },
              votes: new Map([['alice', 'yes']]),
              status: 'active'
            }
          }
        )]
      ]),
      serverInput: { serverTxs: [], entityInputs: [] },
      serverOutputs: []
    },
    {
      height: 4,
      timestamp: baseTime + 4000,
      description: 'Votes cast - Consensus building',
      replicas: new Map([
        [`${entityId}:alice`, createReplicaState('alice', 4, 
          ['System initialized', 'Hello from Alice!', 'Submitting proposal...', 'Waiting for votes...'], 
          {
            'prop1': {
              proposer: 'alice',
              action: { type: 'collective_message', data: { message: 'Increase block size' } },
              votes: new Map([['alice', 'yes'], ['bob', 'yes']]),
              status: 'active'
            }
          }
        )],
        [`${entityId}:bob`, createReplicaState('bob', 4, 
          ['System initialized', 'Hello from Bob!', 'Reviewing proposal...', 'Voted YES on proposal'], 
          {
            'prop1': {
              proposer: 'alice',
              action: { type: 'collective_message', data: { message: 'Increase block size' } },
              votes: new Map([['alice', 'yes'], ['bob', 'yes']]),
              status: 'active'
            }
          }
        )]
      ]),
      serverInput: { serverTxs: [], entityInputs: [] },
      serverOutputs: []
    },
    {
      height: 5,
      timestamp: baseTime + 5000,
      description: 'Current state - Proposal executed',
      replicas: new Map([
        [`${entityId}:alice`, createReplicaState('alice', 5, 
          ['System initialized', 'Hello from Alice!', 'Submitting proposal...', 'Waiting for votes...', 'Proposal passed!'], 
          {
            'prop1': {
              proposer: 'alice',
              action: { type: 'collective_message', data: { message: 'Increase block size' } },
              votes: new Map([['alice', 'yes'], ['bob', 'yes']]),
              status: 'executed'
            }
          }
        )],
        [`${entityId}:bob`, createReplicaState('bob', 5, 
          ['System initialized', 'Hello from Bob!', 'Reviewing proposal...', 'Voted YES on proposal', 'Consensus achieved!'], 
          {
            'prop1': {
              proposer: 'alice',
              action: { type: 'collective_message', data: { message: 'Increase block size' } },
              votes: new Map([['alice', 'yes'], ['bob', 'yes']]),
              status: 'executed'
            }
          }
        )]
      ]),
      serverInput: { serverTxs: [], entityInputs: [] },
      serverOutputs: []
    }
  ];

  // Current environment state (latest snapshot)
  const currentSnapshot = mockHistory[mockHistory.length - 1];
  const mockEnv = {
    replicas: currentSnapshot.replicas,
    height: currentSnapshot.height,
    timestamp: currentSnapshot.timestamp,
    history: mockHistory,
    serverInput: { serverTxs: [], entityInputs: [] },
    serverOutputs: []
  };

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
  if (!XLNModule) {
    console.log('🌐 Browser environment detected - using mock XLN module');
    console.log('💡 For full functionality, run the Node.js server separately');
    XLNModule = createMockXLNModule();
  }
  return XLNModule;
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
