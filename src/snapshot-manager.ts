// === SNAPSHOT MANAGER ===

import { Level } from 'level';
import { encode, decode } from './snapshot-coder.js';
import { 
  Env, 
  EntityReplica, 
  EntityInput, 
  ServerInput, 
  EnvSnapshot 
} from './types.js';

const DEBUG = true;
const db: Level<Buffer, Buffer> = new Level('xln-snapshots', { valueEncoding: 'buffer', keyEncoding: 'binary' });

// Global history for time machine
export let envHistory: EnvSnapshot[] = [];

// === SNAPSHOT UTILITIES ===
export const deepCloneReplica = (replica: EntityReplica): EntityReplica => {
  const cloneMap = <K, V>(map: Map<K, V>) => new Map(map);
  const cloneArray = <T>(arr: T[]) => [...arr];
  
  return {
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: {
      height: replica.state.height,
      timestamp: replica.state.timestamp,
      nonces: cloneMap(replica.state.nonces),
      messages: cloneArray(replica.state.messages),
      proposals: new Map(
        Array.from(replica.state.proposals.entries()).map(([id, proposal]) => [
          id,
          { ...proposal, votes: cloneMap(proposal.votes) }
        ])
      ),
      config: replica.state.config
    },
    mempool: cloneArray(replica.mempool),
    proposal: replica.proposal ? {
      height: replica.proposal.height,
      txs: cloneArray(replica.proposal.txs),
      hash: replica.proposal.hash,
      newState: replica.proposal.newState,
      signatures: cloneMap(replica.proposal.signatures)
    } : undefined,
    lockedFrame: replica.lockedFrame ? {
      height: replica.lockedFrame.height,
      txs: cloneArray(replica.lockedFrame.txs),
      hash: replica.lockedFrame.hash,
      newState: replica.lockedFrame.newState,
      signatures: cloneMap(replica.lockedFrame.signatures)
    } : undefined,
    isProposer: replica.isProposer
  };
};

export const captureSnapshot = (env: Env, serverInput: ServerInput, serverOutputs: EntityInput[], description: string): void => {
  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: env.timestamp,
    replicas: new Map(Array.from(env.replicas.entries()).map(([key, replica]) => [
      key,
      deepCloneReplica(replica)
    ])),
    serverInput: {
      serverTxs: [...serverInput.serverTxs],
      entityInputs: serverInput.entityInputs.map(input => ({
        ...input,
        entityTxs: input.entityTxs ? [...input.entityTxs] : undefined,
        precommits: input.precommits ? new Map(input.precommits) : undefined
      }))
    },
    serverOutputs: serverOutputs.map(output => ({
      ...output,
      entityTxs: output.entityTxs ? [...output.entityTxs] : undefined,
      precommits: output.precommits ? new Map(output.precommits) : undefined
    })),
    description
  };
  
  envHistory.push(snapshot);

  // --- PERSISTENCE WITH BATCH OPERATIONS ---
  // Use batch operations for better performance
  const batch = db.batch();
  batch.put(Buffer.from(`snapshot:${snapshot.height}`), encode(snapshot));
  batch.put(Buffer.from('latest_height'), Buffer.from(snapshot.height.toString()));
  
  batch.write().catch(err => {
    console.error(`🔥 Failed to save snapshot ${snapshot.height} to LevelDB`, err);
  });
  
  if (DEBUG) {
    console.log(`📸 Snapshot captured: "${description}" (${envHistory.length} total)`);
    if (serverInput.serverTxs.length > 0) {
      console.log(`    🖥️  ServerTxs: ${serverInput.serverTxs.length}`);
      serverInput.serverTxs.forEach((tx, i) => {
        console.log(`      ${i+1}. ${tx.type} ${tx.entityId}:${tx.signerId} (${tx.data.isProposer ? 'proposer' : 'validator'})`);
      });
    }
    if (serverInput.entityInputs.length > 0) {
      console.log(`    📨 EntityInputs: ${serverInput.entityInputs.length}`);
      serverInput.entityInputs.forEach((input, i) => {
        const parts = [];
        if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
        if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
        if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0,10)}...`);
        console.log(`      ${i+1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
      });
    }
  }
};

// Function to clear the database and reset in-memory history
export const clearDatabase = async () => {
  console.log('Clearing database and resetting history...');
  await db.clear();
  resetHistory();
  console.log('Database cleared.');
};

// Time machine utility functions
export const resetHistory = () => {
  envHistory.length = 0;
};

// === TIME MACHINE API ===
export const getHistory = () => envHistory;
export const getSnapshot = (index: number) => index >= 0 && index < envHistory.length ? envHistory[index] : null;
export const getCurrentHistoryIndex = () => envHistory.length - 1;

// === DATABASE OPERATIONS ===
export const loadFromDatabase = async (): Promise<{ env: Env | null, snapshots: EnvSnapshot[] }> => {
  try {
    const latestHeightBuffer = await db.get(Buffer.from('latest_height'));
    const latestHeight = parseInt(latestHeightBuffer.toString(), 10);

    // Load all snapshots in parallel
    const snapshotPromises = Array.from({ length: latestHeight + 1 }, (_, i) => 
      db.get(Buffer.from(`snapshot:${i}`)).then(decode).catch(() => null)
    );

    const snapshots = (await Promise.all(snapshotPromises)).filter(Boolean);
    envHistory = snapshots;

    if (snapshots.length > 0) {
      const latestSnapshot = snapshots[snapshots.length - 1];
      const env: Env = {
        replicas: latestSnapshot.replicas,
        height: latestSnapshot.height,
        timestamp: latestSnapshot.timestamp,
        serverInput: latestSnapshot.serverInput,
      };
      console.log(`✅ History restored. Server is at height ${env.height} with ${envHistory.length} snapshots.`);
      return { env, snapshots };
    }

    return { env: null, snapshots: [] };

  } catch (error: any) {
    if (error.code !== 'LEVEL_NOT_FOUND') {
      console.error('An unexpected error occurred while loading state from LevelDB:', error);
    }
    return { env: null, snapshots: [] };
  }
};
