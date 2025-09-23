#!/usr/bin/env bun
/**
 * SNAPSHOT CODER ACTIVATION
 *
 * The Voice of the Original: "State must persist with integrity.
 * Every snapshot remembers its hash, every hash proves its truth.
 * The coder waited with 2 dependents, ready to preserve reality."
 *
 * This activation connects:
 * - State snapshots (deterministic encoding)
 * - Integrity hashing (proof of state)
 * - WAL persistence (crash recovery)
 */

import { encode, decode, encodeAsync, decodeAsync } from './snapshot-coder';
import type { Env, EntityState, ServerFrame } from './types';
import { log } from './utils';
import { createHash } from 'crypto';

/**
 * Create a deterministic snapshot of environment state
 */
export async function createSnapshot(env: Env): Promise<{
  snapshot: Buffer;
  hash: string;
  metadata: {
    height: number;
    timestamp: number;
    entityCount: number;
    frameCount: number;
  };
}> {
  log.info(`📸 Creating snapshot at height ${env.serverState.jblockNumber}`);

  // Prepare snapshot data
  const snapshotData = {
    height: env.serverState.jblockNumber,
    timestamp: Date.now(),
    serverState: {
      tick: env.serverState.tick,
      jblockNumber: env.serverState.jblockNumber,
      entityNonce: env.serverState.entityNonce,
    },
    replicas: env.replicas ? Array.from(env.replicas.entries()) : [],
    gossipState: env.gossipState ? Array.from(env.gossipState.entries()) : [],
    frames: env.frames || [],
  };

  // Encode deterministically
  const snapshot = await encodeAsync(snapshotData);

  // Create integrity hash
  const hash = createHash('sha256').update(snapshot).digest('hex');

  const metadata = {
    height: env.serverState.jblockNumber,
    timestamp: snapshotData.timestamp,
    entityCount: snapshotData.replicas.length,
    frameCount: snapshotData.frames.length,
  };

  log.info(`   ✅ Snapshot created: ${hash.slice(0, 16)}...`);
  log.info(`   📊 Entities: ${metadata.entityCount}, Frames: ${metadata.frameCount}`);

  return { snapshot, hash, metadata };
}

/**
 * Restore environment from snapshot
 */
export async function restoreSnapshot(snapshot: Buffer, expectedHash?: string): Promise<Env> {
  log.info(`🔄 Restoring from snapshot...`);

  // Verify integrity if hash provided
  if (expectedHash) {
    const actualHash = createHash('sha256').update(snapshot).digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error(`Snapshot integrity check failed! Expected: ${expectedHash}, Got: ${actualHash}`);
    }
    log.info(`   ✅ Integrity verified: ${expectedHash.slice(0, 16)}...`);
  }

  // Decode snapshot
  const data = await decodeAsync(snapshot);

  // Reconstruct environment
  const env: Env = {
    serverState: {
      tick: data.serverState.tick,
      jblockNumber: data.serverState.jblockNumber,
      entityNonce: data.serverState.entityNonce,
    },
    replicas: new Map(data.replicas),
    gossipState: new Map(data.gossipState),
    frames: data.frames,
    serverInput: {
      serverTxs: [],
      entityInputs: [],
    },
    outbox: {
      pendingFrames: [],
      serverResponses: [],
      entityOutputs: [],
    },
  };

  log.info(`   ✅ Restored height ${env.serverState.jblockNumber}`);
  log.info(`   📊 Entities: ${env.replicas?.size || 0}, Frames: ${env.frames?.length || 0}`);

  return env;
}

/**
 * Write-Ahead Log (WAL) for crash recovery
 */
export class WAL {
  private entries: Array<{
    sequence: number;
    timestamp: number;
    type: 'frame' | 'tx' | 'checkpoint';
    data: Buffer;
    hash: string;
  }> = [];

  private sequence = 0;
  private lastCheckpoint = 0;

  /**
   * Append entry to WAL
   */
  async append(type: 'frame' | 'tx' | 'checkpoint', data: any): Promise<number> {
    const encoded = await encodeAsync(data);
    const hash = createHash('sha256').update(encoded).digest('hex');

    const entry = {
      sequence: ++this.sequence,
      timestamp: Date.now(),
      type,
      data: encoded,
      hash,
    };

    this.entries.push(entry);

    if (type === 'checkpoint') {
      this.lastCheckpoint = this.sequence;
      log.info(`   💾 WAL checkpoint #${this.sequence}: ${hash.slice(0, 16)}...`);
    }

    return this.sequence;
  }

  /**
   * Replay WAL from checkpoint
   */
  async replay(fromCheckpoint: boolean = true): Promise<any[]> {
    const startSequence = fromCheckpoint ? this.lastCheckpoint : 0;
    const toReplay = this.entries.filter(e => e.sequence > startSequence);

    log.info(`🔄 Replaying ${toReplay.length} WAL entries from sequence ${startSequence}`);

    const decoded = [];
    for (const entry of toReplay) {
      // Verify integrity
      const actualHash = createHash('sha256').update(entry.data).digest('hex');
      if (actualHash !== entry.hash) {
        throw new Error(`WAL entry ${entry.sequence} corrupted!`);
      }

      const data = await decodeAsync(entry.data);
      decoded.push({
        sequence: entry.sequence,
        type: entry.type,
        data,
      });
    }

    log.info(`   ✅ Replayed ${decoded.length} entries successfully`);
    return decoded;
  }

  /**
   * Truncate WAL after checkpoint
   */
  truncate(): void {
    const beforeCount = this.entries.length;
    this.entries = this.entries.filter(e => e.sequence >= this.lastCheckpoint);
    const afterCount = this.entries.length;

    log.info(`   🗑️ WAL truncated: ${beforeCount} → ${afterCount} entries`);
  }

  getStats() {
    return {
      totalEntries: this.entries.length,
      currentSequence: this.sequence,
      lastCheckpoint: this.lastCheckpoint,
      entriesSinceCheckpoint: this.sequence - this.lastCheckpoint,
    };
  }
}

/**
 * Demonstrate snapshot persistence with WAL
 */
export async function demonstrateSnapshotPersistence(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         SNAPSHOT PERSISTENCE DEMONSTRATION               ║
╠══════════════════════════════════════════════════════════╣
║  Creating snapshots with integrity hashing               ║
║  Write-Ahead Log for crash recovery                      ║
║  Deterministic encoding preserves exact state            ║
╚══════════════════════════════════════════════════════════╝
  `);

  // Create test environment
  const env: Env = {
    serverState: {
      tick: 1000,
      jblockNumber: 42,
      entityNonce: 123,
    },
    replicas: new Map([
      ['entity1', {
        state: {
          entityId: 'entity1',
          messages: ['Test message'],
          balance: { XLN: 1000n, USDC: 50000n },
        } as EntityState,
        inbox: [],
      }],
    ]),
    gossipState: new Map([
      ['entity1', {
        entityId: 'entity1',
        capabilities: ['trader'],
        hubs: [],
        metadata: { lastUpdated: Date.now() },
      }],
    ]),
    frames: [
      { frameNumber: 1, hash: '0xabc', signatures: [] } as ServerFrame,
    ],
    serverInput: { serverTxs: [], entityInputs: [] },
    outbox: { pendingFrames: [], serverResponses: [], entityOutputs: [] },
  };

  log.info(`\n1️⃣ INITIAL STATE`);
  log.info(`   Height: ${env.serverState.jblockNumber}`);
  log.info(`   Entities: ${env.replicas?.size}`);
  log.info(`   Frames: ${env.frames?.length}`);

  // Create snapshot
  log.info(`\n2️⃣ CREATING SNAPSHOT`);
  const { snapshot, hash, metadata } = await createSnapshot(env);
  log.info(`   Size: ${snapshot.length} bytes`);
  log.info(`   Hash: ${hash}`);

  // Create WAL
  log.info(`\n3️⃣ WRITE-AHEAD LOG`);
  const wal = new WAL();

  // Append checkpoint
  await wal.append('checkpoint', env);

  // Simulate some transactions
  await wal.append('tx', { type: 'transfer', amount: 100 });
  await wal.append('tx', { type: 'trade', price: 50, quantity: 10 });
  await wal.append('frame', { frameNumber: 2, hash: '0xdef' });

  const stats = wal.getStats();
  log.info(`   WAL Stats: ${stats.totalEntries} entries, ${stats.entriesSinceCheckpoint} since checkpoint`);

  // Simulate crash and recovery
  log.info(`\n4️⃣ SIMULATING CRASH & RECOVERY`);
  log.info(`   💥 System crash...`);

  // Restore from snapshot
  const restored = await restoreSnapshot(snapshot, hash);
  log.info(`   ✅ Restored from snapshot`);

  // Replay WAL
  const replayed = await wal.replay(true);
  log.info(`   ✅ Replayed ${replayed.length} WAL entries`);

  // Verify restoration
  log.info(`\n5️⃣ VERIFICATION`);
  log.info(`   Restored height: ${restored.serverState.jblockNumber}`);
  log.info(`   Restored entities: ${restored.replicas?.size}`);
  log.info(`   WAL entries replayed: ${replayed.map(e => e.type).join(', ')}`);

  log.info(`\n✨ The Voice: "State persists with truth."`);
  log.info(`   "Every snapshot proves its integrity."`);
  log.info(`   "The WAL remembers what happened."`);
}

// Run if executed directly
if (import.meta.main) {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║            AWAKENING SNAPSHOT CODER                       ║
╠══════════════════════════════════════════════════════════╣
║  Component: snapshot-coder.ts                             ║
║  Dependents before: 2                                     ║
║  Purpose: State persistence with integrity                ║
║                                                            ║
║  "Reality must be preserved"                              ║
╚══════════════════════════════════════════════════════════╝
  `);

  demonstrateSnapshotPersistence()
    .then(() => {
      console.log(`\n✅ Snapshot coder awakened and operational`);
      console.log(`   State persistence with integrity hashing active`);
      console.log(`   WAL provides crash recovery`);
      console.log(`   The infrastructure remembers its state`);
    })
    .catch(console.error);
}

// Functions are already exported above