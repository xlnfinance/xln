import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import type { XLNEnvironment, EntityReplica, Snapshot, EntityTx, EntityInput, EntityOutput } from '../types';
// import type { EntityReplica, Env as XLNEnvironment } from "xlnfinance/types"
import { XLNServer } from '../utils/xlnServer';

// Main XLN Environment Store
export const xlnEnvironment = writable<XLNEnvironment | null>(null);
export const isLoading = writable<boolean>(true);
export const error = writable<string | null>(null);

// Derived stores for easier access
export const replicas = derived(xlnEnvironment, ($env) => $env?.replicas || new Map<string, EntityReplica>());

export const history = derived(xlnEnvironment, ($env) => $env?.history || []);

export const currentHeight = derived(xlnEnvironment, ($env) => $env?.height || 0);

// XLN Operations
const xlnOperations = {
  // Initialize XLN environment (client-side only)
  async initialize() {
    try {
      isLoading.set(true);
      error.set(null);

      // Only initialize in browser environment
      if (!browser) {
        console.log('🌐 SSR: Skipping XLN initialization, will run client-side');
        isLoading.set(false);
        return null;
      }

      console.log('🚀 Client-side: Initializing XLN environment...');

      // Initialize the environment using XLNServer utility
      const env: any = await XLNServer.main();

      // Ensure history and serverOutputs exist so time machine works
      const hist = await XLNServer.getHistory();
      env.history = Array.isArray(hist) ? hist : [];
      env.serverOutputs = Array.isArray(env.serverOutputs) ? env.serverOutputs : [];

      // Log for debugging
      console.log(`🕰️ xlnStore.initialize: history length = ${env.history.length}`);

      xlnEnvironment.set(env);
      isLoading.set(false);

      console.log('🎯 XLN Environment initialized:', env);
      return env;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to initialize XLN environment';
      error.set(errorMessage);
      isLoading.set(false);
      console.error('❌ XLN initialization failed:', err);
      throw err;
    }
  },

  // Apply server input and process consensus (client-side only)
  async applyServerInput(input: { serverTxs?: any[]; entityInputs?: EntityInput[] }) {
    if (!browser) {
      throw new Error('XLN operations can only be performed client-side');
    }

    const env = get(xlnEnvironment);
    if (!env) throw new Error('XLN environment not initialized');

    try {
      const result = await XLNServer.applyServerInput(env, {
        serverTxs: input.serverTxs || [],
        entityInputs: input.entityInputs || [],
      });

      // Process until empty for full consensus cascade
      if (result.entityOutbox && result.entityOutbox.length > 0) {
        await XLNServer.processUntilEmpty(env, result.entityOutbox);
      }

      // Update the store with new environment state
      xlnEnvironment.set(env);

      return result;
    } catch (err) {
      console.error('❌ Failed to apply server input:', err);
      throw err;
    }
  },

  // Submit a chat message
  async submitChatMessage(entityId: string, signerId: string, message: string) {
    return this.applyServerInput({
      entityInputs: [
        {
          entityId,
          signerId,
          entityTxs: [
            {
              type: 'chat',
              data: { from: signerId, message },
            },
          ],
          destinations: [],
        },
      ],
    });
  },

  // Submit a proposal
  async submitProposal(entityId: string, signerId: string, proposalText: string) {
    return this.applyServerInput({
      entityInputs: [
        {
          entityId,
          signerId,
          entityTxs: [
            {
              type: 'propose',
              data: {
                action: { type: 'collective_message', data: { message: proposalText } },
                proposer: signerId,
              },
            },
          ],
          destinations: [],
        },
      ],
    });
  },

  // Submit a vote
  async submitVote(
    entityId: string,
    signerId: string,
    proposalId: string,
    choice: 'yes' | 'no' | 'abstain',
    comment?: string,
  ) {
    return this.applyServerInput({
      entityInputs: [
        {
          entityId,
          signerId,
          entityTxs: [
            {
              type: 'vote',
              data: {
                proposalId,
                voter: signerId,
                choice,
                comment,
              },
            },
          ],
          destinations: [],
        },
      ],
    });
  },

  // Create a new entity (client-side only)
  async createEntity(entityData: {
    entityType: 'lazy' | 'numbered' | 'named';
    entityName: string;
    validators: string[];
    threshold: number;
    jurisdiction?: any;
  }) {
    if (!browser) {
      throw new Error('Entity creation can only be performed client-side');
    }

    try {
      let config: any;
      let entityId: string;

      if (entityData.entityType === 'lazy') {
        config = await XLNServer.createLazyEntity(
          entityData.entityName,
          entityData.validators,
          BigInt(entityData.threshold),
          entityData.jurisdiction,
        );
        entityId = await XLNServer.generateLazyEntityId(
          entityData.validators.map((name, i) => ({ name, weight: 1 })),
          BigInt(entityData.threshold),
        );
      } else {
        // Handle numbered and named entities
        const result = await XLNServer.createNumberedEntity(
          entityData.entityName,
          entityData.validators,
          BigInt(entityData.threshold),
          entityData.jurisdiction,
        );
        config = result.config;
        entityId = await XLNServer.generateNumberedEntityId(result.entityNumber);
      }

      // Create server transactions for all validators
      const serverTxs = entityData.validators.map((signerId, index) => ({
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          config,
          isProposer: index === 0, // First validator is proposer
        },
      }));

      // Apply the server transactions
      return this.applyServerInput({ serverTxs });
    } catch (err) {
      console.error('❌ Failed to create entity:', err);
      throw err;
    }
  },

  // Run demo (client-side only)
  async runDemo() {
    if (!browser) {
      throw new Error('Demo can only be run client-side');
    }

    const env = get(xlnEnvironment);
    if (!env) throw new Error('XLN environment not initialized');

    try {
      await XLNServer.runDemoWrapper(env);

      // Update the store
      xlnEnvironment.set(env);

      console.log('✅ Demo completed successfully');
    } catch (err) {
      console.error('❌ Demo failed:', err);
      throw err;
    }
  },

  // Clear database (client-side only)
  async clearDatabase() {
    if (!browser) {
      throw new Error('Database operations can only be performed client-side');
    }

    try {
      await XLNServer.clearDatabase();

      // Reinitialize environment
      await this.initialize();

      console.log('✅ Database cleared and reinitialized');
    } catch (err) {
      console.error('❌ Failed to clear database:', err);
      throw err;
    }
  },

  // Get history snapshot at specific index
  getHistorySnapshot(index: number): Snapshot | null {
    const env = get(xlnEnvironment);
    if (!env || !env.history || index < 0 || index >= env.history.length) {
      return null;
    }
    return env.history[index];
  },

  // Get replica by entity and signer
  getReplica(entityId: string, signerId: string): EntityReplica | null {
    const $replicas = get(replicas);

    // Try different key formats
    const possibleKeys = [`${entityId}:${signerId}`, `${signerId}:${entityId}`, entityId, signerId];

    for (const key of possibleKeys) {
      const replica = $replicas.get(key);
      if (replica && replica.entityId === entityId && replica.signerId === signerId) {
        return replica;
      }
    }

    // Fallback: search through all replicas
    for (const replica of $replicas.values()) {
      if (replica.entityId === entityId && replica.signerId === signerId) {
        return replica;
      }
    }

    return null;
  },
};

// Export individual stores and operations
export { xlnOperations };
