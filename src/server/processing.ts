import { Level } from 'level';

import { applyEntityInput, mergeEntityInputs } from '../entity-consensus';
import { createGossipLayer } from '../gossip';
import { EntityInput, Env, ServerInput } from '../types';
import { DEBUG, formatEntityDisplay, formatSignerDisplay, log } from '../utils';
import { notifyEnvChange } from './environment';
import { captureSnapshot } from './snapshots';

// === SERVER INPUT PROCESSING ===
export const applyServerInput = async (
  db: Level<Buffer, Buffer>,
  env: Env,
  serverInput: ServerInput,
): Promise<{ entityOutbox: EntityInput[]; mergedInputs: EntityInput[] }> => {
  const startTime = Date.now();

  try {
    // SECURITY: Validate server input
    if (!serverInput) {
      log.error('❌ Null server input provided');
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (!Array.isArray(serverInput.serverTxs)) {
      log.error(`❌ Invalid serverTxs: expected array, got ${typeof serverInput.serverTxs}`);
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (!Array.isArray(serverInput.entityInputs)) {
      log.error(`❌ Invalid entityInputs: expected array, got ${typeof serverInput.entityInputs}`);
      return { entityOutbox: [], mergedInputs: [] };
    }

    // SECURITY: Resource limits
    if (serverInput.serverTxs.length > 1000) {
      log.error(`❌ Too many server transactions: ${serverInput.serverTxs.length} > 1000`);
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (serverInput.entityInputs.length > 10000) {
      log.error(`❌ Too many entity inputs: ${serverInput.entityInputs.length} > 10000`);
      return { entityOutbox: [], mergedInputs: [] };
    }

    // Merge new serverInput into env.serverInput
    env.serverInput.serverTxs.push(...serverInput.serverTxs);
    env.serverInput.entityInputs.push(...serverInput.entityInputs);

    // Merge all entityInputs in env.serverInput
    const mergedInputs = mergeEntityInputs(env.serverInput.entityInputs);
    const entityOutbox: EntityInput[] = [];

    if (DEBUG) {
      console.log(`\n=== TICK ${env.height} ===`);
      console.log(
        `Server inputs: ${serverInput.serverTxs.length} new serverTxs, ${serverInput.entityInputs.length} new entityInputs`,
      );
      console.log(
        `Total in env: ${env.serverInput.serverTxs.length} serverTxs, ${env.serverInput.entityInputs.length} entityInputs (merged to ${mergedInputs.length})`,
      );
      if (mergedInputs.length > 0) {
        console.log(`🔄 Processing merged inputs:`);
        mergedInputs.forEach((input, i) => {
          const parts = [];
          if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
          if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
          if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0, 10)}...`);
          console.log(`  ${i + 1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
        });
      }
    }

    // Process server transactions (replica imports) from env.serverInput
    console.log(
      `🔍 REPLICA-DEBUG: Processing ${env.serverInput.serverTxs.length} serverTxs, current replicas: ${env.replicas.size}`,
    );
    env.serverInput.serverTxs.forEach(serverTx => {
      if (serverTx.type === 'importReplica') {
        if (DEBUG)
          console.log(
            `Importing replica Entity #${formatEntityDisplay(serverTx.entityId)}:${formatSignerDisplay(serverTx.signerId)} (proposer: ${serverTx.data.isProposer})`,
          );

        const replicaKey = `${serverTx.entityId}:${serverTx.signerId}`;
        env.replicas.set(replicaKey, {
          entityId: serverTx.entityId,
          signerId: serverTx.signerId,
          state: {
            entityId: serverTx.entityId, // Store entityId in state
            height: 0,
            timestamp: env.timestamp,
            nonces: new Map(),
            messages: [],
            proposals: new Map(),
            config: serverTx.data.config,
            // 💰 Initialize financial state
            reserves: new Map(),
            channels: new Map(),
            collaterals: new Map(),
          },
          mempool: [],
          isProposer: serverTx.data.isProposer,
        });
        console.log(`🔍 REPLICA-DEBUG: Added replica ${replicaKey}, total replicas now: ${env.replicas.size}`);
      }
    });
    console.log(`🔍 REPLICA-DEBUG: After processing serverTxs, total replicas: ${env.replicas.size}`);

    // Process entity inputs
    for (const entityInput of mergedInputs) {
      const replicaKey = `${entityInput.entityId}:${entityInput.signerId}`;
      const entityReplica = env.replicas.get(replicaKey);

      console.log(`🔍 REPLICA-LOOKUP: Key="${replicaKey}"`);
      console.log(`🔍 REPLICA-LOOKUP: Found replica: ${!!entityReplica}`);
      console.log(`🔍 REPLICA-LOOKUP: Input txs: ${entityInput.entityTxs?.length || 0}`);
      if (entityInput.entityTxs && entityInput.entityTxs.length > 0) {
        console.log(
          `🔍 REPLICA-LOOKUP: Tx types:`,
          entityInput.entityTxs.map(tx => tx.type),
        );
      }
      if (!entityReplica) {
        console.log(`🔍 REPLICA-LOOKUP: Available replica keys:`, Array.from(env.replicas.keys()));
      }

      if (entityReplica) {
        if (DEBUG) {
          console.log(`Processing input for ${replicaKey}:`);
          if (entityInput.entityTxs?.length) console.log(`  → ${entityInput.entityTxs.length} transactions`);
          if (entityInput.proposedFrame) console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
          if (entityInput.precommits?.size) console.log(`  → ${entityInput.precommits.size} precommits`);
        }

        const { newState, outputs } = await applyEntityInput(env, entityReplica, entityInput);
        // CRITICAL FIX: Update the replica in the environment with the new state
        env.replicas.set(replicaKey, { ...entityReplica, state: newState });
        entityOutbox.push(...outputs);
      }
    }

    // Update env (mutable)
    env.height++;
    env.timestamp = Date.now();

    // Capture snapshot BEFORE clearing (to show what was actually processed)
    // Use merged inputs to avoid showing intermediate gossip messages in UI
    const inputDescription = `Tick ${env.height - 1}: ${env.serverInput.serverTxs.length} serverTxs, ${mergedInputs.length} merged entityInputs → ${entityOutbox.length} outputs`;
    const processedInput = {
      serverTxs: [...env.serverInput.serverTxs],
      entityInputs: [...mergedInputs], // Use merged inputs instead of raw inputs
    };

    // Clear processed data from env.serverInput
    env.serverInput.serverTxs.length = 0;
    env.serverInput.entityInputs.length = 0;

    // Capture snapshot with the actual processed input and outputs
    await captureSnapshot(db, env, processedInput, entityOutbox, inputDescription);

    // Notify Svelte about environment changes
    console.log(`🔍 REPLICA-DEBUG: Before notifyEnvChange, total replicas: ${env.replicas.size}`);
    console.log(`🔍 REPLICA-DEBUG: Replica keys:`, Array.from(env.replicas.keys()));
    console.log(`🔍 GOSSIP-DEBUG: Environment keys before notify:`, Object.keys(env));
    console.log(`🔍 GOSSIP-DEBUG: Gossip layer exists:`, !!env.gossip);
    console.log(`🔍 GOSSIP-DEBUG: Gossip layer type:`, typeof env.gossip);
    console.log(`🔍 GOSSIP-DEBUG: Gossip announce method:`, typeof env.gossip?.announce);

    // CRITICAL FIX: Initialize gossip layer if missing
    if (!env.gossip) {
      console.log(`🚨 CRITICAL: gossip layer missing from environment, creating new one`);
      env.gossip = createGossipLayer();
      console.log(`✅ Gossip layer created and added to environment`);
    }

    // Compare old vs new entities
    const oldEntityKeys = Array.from(env.replicas.keys()).filter(
      key =>
        key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000001:') ||
        key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000002:'),
    );
    const newEntityKeys = Array.from(env.replicas.keys()).filter(
      key =>
        !key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000001:') &&
        !key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000002:') &&
        !key.startsWith('0x57e360b00f393ea6d898d6119f71db49241be80aec0fbdecf6358b0103d43a31:'),
    );

    console.log(`🔍 OLD-ENTITY-DEBUG: ${oldEntityKeys.length} old entities:`, oldEntityKeys.slice(0, 2));
    console.log(`🔍 NEW-ENTITY-DEBUG: ${newEntityKeys.length} new entities:`, newEntityKeys.slice(0, 2));

    if (oldEntityKeys.length > 0 && newEntityKeys.length > 0) {
      const oldReplica = env.replicas.get(oldEntityKeys[0]);
      const newReplica = env.replicas.get(newEntityKeys[0]);
      console.log(`🔍 OLD-REPLICA-STRUCTURE:`, {
        hasState: !!oldReplica?.state,
        hasConfig: !!oldReplica?.state?.config,
        hasJurisdiction: !!oldReplica?.state?.config?.jurisdiction,
        jurisdictionName: oldReplica?.state?.config?.jurisdiction?.name,
      });
      console.log(`🔍 NEW-REPLICA-STRUCTURE:`, {
        hasState: !!newReplica?.state,
        hasConfig: !!newReplica?.state?.config,
        hasJurisdiction: !!newReplica?.state?.config?.jurisdiction,
        jurisdictionName: newReplica?.state?.config?.jurisdiction?.name,
      });
    }

    notifyEnvChange(env);

    if (DEBUG && entityOutbox.length > 0) {
      console.log(`📤 Outputs: ${entityOutbox.length} messages`);
      entityOutbox.forEach((output, i) => {
        console.log(
          `  ${i + 1}. → ${output.signerId} (${output.entityTxs ? `${output.entityTxs.length} txs` : ''}${output.proposedFrame ? ` proposal: ${output.proposedFrame.hash.slice(0, 10)}...` : ''}${output.precommits ? ` ${output.precommits.size} precommits` : ''})`,
        );
      });
    } else if (DEBUG && entityOutbox.length === 0) {
      console.log(`📤 No outputs generated`);
    }

    if (DEBUG) {
      console.log(`Replica states:`);
      env.replicas.forEach((replica, key) => {
        const [entityId, signerId] = key.split(':');
        const entityDisplay = formatEntityDisplay(entityId);
        const signerDisplay = formatSignerDisplay(signerId);
        console.log(
          `  Entity #${entityDisplay}:${signerDisplay}: mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${replica.proposal ? '✓' : '✗'}`,
        );
      });
    }

    // Performance logging
    const endTime = Date.now();
    if (DEBUG) {
      console.log(`⏱️  Tick ${env.height - 1} completed in ${endTime - startTime}ms`);
    }

    return { entityOutbox, mergedInputs };
  } catch (error) {
    log.error(`❌ Error processing server input:`, error);
    return { entityOutbox: [], mergedInputs: [] };
  }
};

// === CONSENSUS PROCESSING UTILITIES ===
export const processUntilEmpty = async (env: Env, db: Level<Buffer, Buffer>, inputs?: EntityInput[]) => {
  let outputs = inputs || [];
  let iterationCount = 0;
  const maxIterations = 10; // Safety limit

  console.log('🔥 PROCESS-CASCADE: Starting with', outputs.length, 'initial outputs');
  console.log(
    '🔥 PROCESS-CASCADE: Initial outputs:',
    outputs.map(o => ({
      entityId: o.entityId.slice(0, 8) + '...',
      signerId: o.signerId,
      txs: o.entityTxs?.length || 0,
      precommits: o.precommits?.size || 0,
      hasFrame: !!o.proposedFrame,
    })),
  );

  // DEBUG: Log transaction details for vote transactions
  outputs.forEach((output, i) => {
    if (output.entityTxs?.some(tx => tx.type === 'vote')) {
      console.log(
        `🗳️ VOTE-DEBUG: Input ${i + 1} contains vote transactions:`,
        output.entityTxs.filter(tx => tx.type === 'vote'),
      );
    }
  });

  while (outputs.length > 0 && iterationCount < maxIterations) {
    iterationCount++;
    console.log(`🔥 PROCESS-CASCADE: Iteration ${iterationCount} - processing ${outputs.length} outputs`);

    const result = await applyServerInput(db, env, { serverTxs: [], entityInputs: outputs });
    outputs = result.entityOutbox;

    console.log(`🔥 PROCESS-CASCADE: Iteration ${iterationCount} generated ${outputs.length} new outputs`);
    if (outputs.length > 0) {
      console.log(
        '🔥 PROCESS-CASCADE: New outputs:',
        outputs.map(o => ({
          entityId: o.entityId.slice(0, 8) + '...',
          signerId: o.signerId,
          txs: o.entityTxs?.length || 0,
          precommits: o.precommits?.size || 0,
          hasFrame: !!o.proposedFrame,
        })),
      );
    }
  }

  if (iterationCount >= maxIterations) {
    console.warn('⚠️ processUntilEmpty reached maximum iterations');
  } else {
    console.log(`🔥 PROCESS-CASCADE: Completed after ${iterationCount} iterations`);
  }

  return env;
};
