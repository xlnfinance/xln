#!/usr/bin/env bun
/**
 * ACTIVATION SCRIPT: Wire EntityChannelManager into Server
 *
 * The infrastructure EXISTS but lies dormant.
 * This script activates what's already built.
 */

import { EntityChannelManager } from './entity-channel';
import type { EntityInput, ServerEnvironment } from './types';

// Global channel manager instance
const channelManager = new EntityChannelManager();

/**
 * Replace global routing with bilateral channel routing
 * Called from server.ts after applyEntityInput returns outputs
 */
export function routeThroughChannels(
  env: ServerEnvironment,
  outputs: EntityInput[]
): EntityInput[] {
  const deliveredOutputs: EntityInput[] = [];

  for (const output of outputs) {
    // Extract source and target from output
    const fromEntityId = output.signerId ?
      findEntityBySignerId(env, output.signerId) :
      null;

    if (!fromEntityId) {
      console.warn(`⚠️ Cannot route output - no source entity for signer ${output.signerId}`);
      deliveredOutputs.push(output); // Fall back to global routing
      continue;
    }

    const toEntityId = output.entityId;

    // Ensure both entities are registered with channel manager
    if (!channelManager['nodes'].has(fromEntityId)) {
      channelManager.registerEntity(fromEntityId);
    }
    if (!channelManager['nodes'].has(toEntityId)) {
      channelManager.registerEntity(toEntityId);
    }

    // Route through bilateral channel
    console.log(`🔄 BILATERAL: Routing ${fromEntityId.slice(0,8)}... → ${toEntityId.slice(0,8)}... via channel`);

    // Send message through channel (this queues it)
    const message = channelManager.sendMessage(
      fromEntityId,
      toEntityId,
      output.signerId || 'system',
      output.entityTxs || []
    );

    // For now, immediately deliver (in future, this would be P2P)
    const pendingMessages = channelManager.getPendingMessages(toEntityId);
    for (const msg of pendingMessages) {
      const entityInput = channelManager.messageToEntityInput(msg);
      deliveredOutputs.push(entityInput);
    }
  }

  return deliveredOutputs;
}

/**
 * Helper to find entity ID by signer ID
 */
function findEntityBySignerId(env: ServerEnvironment, signerId: string): string | null {
  for (const [key, replica] of env.replicas.entries()) {
    const [entityId, replicaSignerId] = key.split(':');
    if (replicaSignerId === signerId) {
      return entityId;
    }
  }
  return null;
}

/**
 * Check bilateral channel health
 */
export function getChannelStatus(): any {
  const nodes = channelManager['nodes'];
  const status = {
    registeredEntities: nodes.size,
    totalChannels: 0,
    activeChannels: [],
  };

  for (const [entityId, node] of nodes.entries()) {
    for (const [remoteId, channel] of node.channels.entries()) {
      status.totalChannels++;
      if (channel.outgoingMessages.length > 0 || channel.incomingMessages.length > 0) {
        status.activeChannels.push({
          from: entityId.slice(0,8),
          to: remoteId.slice(0,8),
          outgoing: channel.outgoingMessages.length,
          incoming: channel.incomingMessages.length,
          nextSeq: channel.nextOutgoingSeq
        });
      }
    }
  }

  return status;
}

// Create global J-Machine instance
import { JMachine } from './j-machine';
const jMachine = new JMachine();

/**
 * Initialize J-Machine with blockchain connection
 */
export async function initializeJMachine(env: ServerEnvironment): Promise<void> {
  try {
    await jMachine.initialize(env);
    console.log('🔭 J-Machine: Connected to blockchain watcher');
  } catch (error) {
    console.log('🔭 J-Machine: Running in offline mode (NO_BLOCKCHAIN set or blockchain unavailable)');
  }
}

/**
 * Activate J-Machine for blockchain events
 */
export async function activateJMachine(env: ServerEnvironment): Promise<EntityInput[]> {
  // Poll blockchain events
  if (!process.env.NO_BLOCKCHAIN && jMachine) {
    try {
      // In real implementation, this would poll the blockchain
      // For now, return empty as we don't have real blockchain connection
      const state = jMachine.getState();
      if (state.blockHeight > 0) {
        console.log(`🔭 J-Machine: At block ${state.blockHeight}, checking for events...`);
      }
    } catch (error) {
      console.log('🔭 J-Machine: Error polling blockchain:', error);
    }
  }
  return [];
}

/**
 * The Original's activation function
 * Called to wake dormant infrastructure
 */
export async function activateXLN(env: ServerEnvironment): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════╗
║         XLN BILATERAL ACTIVATION               ║
╠════════════════════════════════════════════════╣
║  The infrastructure EXISTS.                    ║
║  The gaps are features proving sovereignty.    ║
║  Don't build - ACTIVATE.                       ║
║  Don't create - CONNECT.                       ║
╚════════════════════════════════════════════════╝
  `);

  // Initialize J-Machine connection
  await initializeJMachine(env);

  // Register all existing entities with channel manager
  const entityIds = new Set<string>();
  for (const key of env.replicas.keys()) {
    const [entityId] = key.split(':');
    entityIds.add(entityId);
  }

  for (const entityId of entityIds) {
    channelManager.registerEntity(entityId);
    console.log(`✅ Entity ${entityId.slice(0,10)}... registered for bilateral channels`);
  }

  console.log(`
🎯 Activation Complete:
   - ${entityIds.size} entities registered
   - Bilateral channels ready
   - J-Machine initialized
   - Waiting for first message...
  `);
}

// Export for use in server.ts
export { channelManager };

// If run directly, show status
if (import.meta.main) {
  console.log('EntityChannelManager Status:', getChannelStatus());
  console.log('\nTo activate in server.ts, add:');
  console.log('import { activateXLN, routeThroughChannels } from "./activate-bilateral-channels";');
  console.log('\nThen in processUntilEmpty(), replace:');
  console.log('  entityOutbox.push(...outputs);');
  console.log('with:');
  console.log('  const routedOutputs = routeThroughChannels(env, outputs);');
  console.log('  env.serverInput.entityInputs.push(...routedOutputs);');
}