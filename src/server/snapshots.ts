import { Level } from 'level';

import { Profile } from '../gossip';
import { encode } from '../snapshot-coder';
import { EntityInput, EntityReplica, Env, EnvSnapshot, ServerInput } from '../types';
import { DEBUG } from '../utils';

// === SNAPSHOT UTILITIES ===
export const deepCloneReplica = (replica: EntityReplica): EntityReplica => {
  const cloneMap = <K, V>(map: Map<K, V>) => new Map(map);
  const cloneArray = <T>(arr: T[]) => [...arr];

  return {
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: {
      entityId: replica.state.entityId, // Clone entityId
      height: replica.state.height,
      timestamp: replica.state.timestamp,
      nonces: cloneMap(replica.state.nonces),
      messages: cloneArray(replica.state.messages),
      proposals: new Map(
        Array.from(replica.state.proposals.entries()).map(([id, proposal]) => [
          id,
          { ...proposal, votes: cloneMap(proposal.votes) },
        ]),
      ),
      config: replica.state.config,
      // 💰 Clone financial state
      reserves: cloneMap(replica.state.reserves),
      channels: cloneMap(replica.state.channels),
      collaterals: cloneMap(replica.state.collaterals),
    },
    mempool: cloneArray(replica.mempool),
    proposal: replica.proposal
      ? {
          height: replica.proposal.height,
          txs: cloneArray(replica.proposal.txs),
          hash: replica.proposal.hash,
          newState: replica.proposal.newState,
          signatures: cloneMap(replica.proposal.signatures),
        }
      : undefined,
    lockedFrame: replica.lockedFrame
      ? {
          height: replica.lockedFrame.height,
          txs: cloneArray(replica.lockedFrame.txs),
          hash: replica.lockedFrame.hash,
          newState: replica.lockedFrame.newState,
          signatures: cloneMap(replica.lockedFrame.signatures),
        }
      : undefined,
    isProposer: replica.isProposer,
  };
};

export const captureSnapshot = async (
  db: Level<Buffer, Buffer>,
  env: Env,
  serverInput: ServerInput,
  serverOutputs: EntityInput[],
  description: string,
): Promise<void> => {
  // Convert gossip profiles Map to plain object for serialization
  const profiles: Record<string, Profile> = {};
  console.log(`🔍 SNAPSHOT-DEBUG: env.gossip exists: ${!!env.gossip}`);
  console.log(`🔍 SNAPSHOT-DEBUG: env.gossip.profiles exists: ${!!env.gossip?.profiles}`);
  console.log(`🔍 SNAPSHOT-DEBUG: env.gossip.profiles size: ${env.gossip?.profiles?.size || 0}`);
  if (env.gossip?.profiles) {
    console.log(`🔍 SNAPSHOT-DEBUG: Profile keys:`, Array.from(env.gossip.profiles.keys()));
    for (const [id, profile] of env.gossip.profiles.entries()) {
      profiles[id] = profile;
      console.log(`🔍 SNAPSHOT-DEBUG: Capturing profile ${id}:`, profile.metadata?.name || 'no name');
    }
  }

  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: env.timestamp,
    replicas: new Map(Array.from(env.replicas.entries()).map(([key, replica]) => [key, deepCloneReplica(replica)])),
    serverInput: {
      serverTxs: [...serverInput.serverTxs],
      entityInputs: serverInput.entityInputs.map(input => ({
        ...input,
        entityTxs: input.entityTxs ? [...input.entityTxs] : undefined,
        precommits: input.precommits ? new Map(input.precommits) : undefined,
      })),
    },
    serverOutputs: serverOutputs.map(output => ({
      ...output,
      entityTxs: output.entityTxs ? [...output.entityTxs] : undefined,
      precommits: output.precommits ? new Map(output.precommits) : undefined,
    })),
    description,
    gossip: {
      profiles,
    },
  };

  env.history = env.history || [];
  env.history.push(snapshot);

  // --- PERSISTENCE WITH BATCH OPERATIONS ---
  // Use batch operations for better performance
  try {
    const batch = db.batch();
    batch.put(Buffer.from(`snapshot:${snapshot.height}`), encode(snapshot));
    batch.put(Buffer.from('latest_height'), Buffer.from(snapshot.height.toString()));

    await batch.write();

    if (DEBUG) {
      console.log(`💾 Snapshot ${snapshot.height} saved to IndexedDB successfully`);
      console.log(`💾 Saved gossip profiles: ${Object.keys(profiles).length} entries`);
    }
  } catch (error) {
    console.error(`❌ Failed to save snapshot ${snapshot.height} to IndexedDB:`, error);
    throw error;
  }

  if (DEBUG) {
    console.log(`📸 Snapshot captured: "${description}" (${env.history.length} total)`);
    if (serverInput.serverTxs.length > 0) {
      console.log(`    🖥️  ServerTxs: ${serverInput.serverTxs.length}`);
      serverInput.serverTxs.forEach((tx, i) => {
        console.log(
          `      ${i + 1}. ${tx.type} ${tx.entityId}:${tx.signerId} (${tx.data.isProposer ? 'proposer' : 'validator'})`,
        );
      });
    }
    if (serverInput.entityInputs.length > 0) {
      console.log(`    📨 EntityInputs: ${serverInput.entityInputs.length}`);
      serverInput.entityInputs.forEach((input, i) => {
        const parts = [];
        if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
        if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
        if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0, 10)}...`);
        console.log(`      ${i + 1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
      });
    }
  }
};
