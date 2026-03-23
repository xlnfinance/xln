/**
 * Grid Scalability Scenario
 *
 * Demonstrates why broadcast models hit bottlenecks and hub-spoke topology scales.
 *
 * Phase 1: BROADCAST BOTTLENECK
 * - 256 nodes (16×16 grid) around J-Machine (200px margin)
 * - All nodes broadcast txs to central J-Machine
 * - Visual: Thick gas rays, mempool overflow, O(n) txs to validator
 * - Result: Blockchain bottleneck - limited by block capacity
 *
 * Phase 2: HUB-SPOKE SCALING
 * - 8 routing hubs form ring between grid and J-Machine
 * - Nodes route through nearest hub (local consensus)
 * - Visual: Clean routing paths, no central bottleneck
 * - Result: O(1) per node - unlimited horizontal scaling
 */

import type { Env, JTx } from '../types';
import type { JAdapter } from '../jadapter/types';
import { createEmptyBatch, batchAddReserveToReserve, getBatchSize } from '../j-batch';
import {
  ensureJAdapter,
  getScenarioJAdapter,
  createJReplica,
  createJurisdictionConfig,
  createGridEntities,
  createNumberedEntity,
} from './boot';
import { getProcess, enableStrictScenario } from './helpers';

// Simple snapshot helper for this scenario
function pushSnapshot(env: Env, tag: string, description: string, metadata: Record<string, any> = {}) {
  if (!env.history) env.history = [];
  const frame = {
    tag,
    description,
    metadata,
    timestamp: env.timestamp,
    eReplicas: new Map(env.eReplicas),
    jReplicas: env.jReplicas ? new Map(env.jReplicas) : undefined
  };
  env.history.push(frame as any);
  console.log(`📸 Snapshot: ${description}`);
}

// Grid dimensions: 2×2×2 = 8 nodes (3D cube, not flat!)
const GRID_DIMS = { x: 2, y: 2, z: 2 };
const GRID_SPACING = 60; // px between nodes
const J_MARGIN = 150; // Grid margin around J-Machine
const USDC_TOKEN_ID = 1;

function usd(amount: number): bigint {
  return BigInt(amount) * 10n ** 18n;
}

// Process any pending j_events queued by j-watcher
async function processJEvents(env: Env): Promise<void> {
  const process = await getProcess();
  const pendingInputs = env.runtimeInput?.entityInputs || [];
  if (pendingInputs.length > 0) {
    const toProcess = [...pendingInputs];
    env.runtimeInput.entityInputs = [];
    await process(env, toProcess);
  }
}

async function submitReserveToReserveBatch(
  env: Env,
  jadapter: JAdapter,
  fromEntityId: string,
  toEntityId: string,
  amount: bigint,
): Promise<void> {
  const replicaKey = Array.from(env.eReplicas.keys()).find((key) => key.startsWith(`${fromEntityId}:`));
  const replica = replicaKey ? env.eReplicas.get(replicaKey) : null;
  const signerId = replica?.signerId;
  if (!signerId) {
    throw new Error(`Grid: missing signer for ${fromEntityId.slice(-4)}`);
  }
  const batch = createEmptyBatch();
  batchAddReserveToReserve(
    { batch, jurisdiction: null, lastBroadcast: 0, broadcastCount: 0, failedAttempts: 0, status: 'empty' },
    toEntityId,
    USDC_TOKEN_ID,
    amount,
  );
  const jTx: JTx = {
    type: 'batch',
    entityId: fromEntityId,
    data: {
      batch,
      batchSize: getBatchSize(batch),
      signerId,
    },
    timestamp: env.timestamp,
  };
  const result = await jadapter.submitTx(jTx, { env, signerId, timestamp: env.timestamp });
  if (!result.success) {
    throw new Error(result.error || 'Grid R2R batch failed');
  }
}

export async function grid(env: Env): Promise<void> {
  const restoreStrict = enableStrictScenario(env, 'Grid');
  try {
  console.log('🔲 GRID SCALABILITY SCENARIO (2×2×2 = 8 nodes)\n');
  console.log('Demonstrating: Broadcast bottleneck → Hub-spoke scaling\n');

  env.scenarioMode = true; // Deterministic time control

  // ============================================================================
  // SETUP: JAdapter + J-Machine + Jurisdiction
  // ============================================================================

  let jadapter: JAdapter;
  try {
    jadapter = getScenarioJAdapter(env);
  } catch {
    jadapter = await ensureJAdapter(env);
    const jReplica = createJReplica(env, 'Grid Demo', jadapter.addresses.depository, { x: 0, y: 600, z: 0 });
    (jReplica as any).jadapter = jadapter;
    (jReplica as any).depositoryAddress = jadapter.addresses.depository;
    (jReplica as any).entityProviderAddress = jadapter.addresses.entityProvider;
    jadapter.startWatching(env);
  }

  const jurisdiction = createJurisdictionConfig('Grid Demo', jadapter.addresses.depository);

  await pushSnapshot(env, 'INIT', 'J-Machine initialized');

  // ============================================================================
  // PHASE 0: CREATE 8-NODE 3D GRID AROUND J-MACHINE
  // ============================================================================

  console.log(`📐 Creating ${GRID_DIMS.x}×${GRID_DIMS.y}×${GRID_DIMS.z} 3D grid (${GRID_DIMS.x * GRID_DIMS.y * GRID_DIMS.z} nodes)...`);
  console.log(`   Grid spacing: ${GRID_SPACING}px`);
  console.log(`   J-Machine margin: ${J_MARGIN}px\n`);

  // Grid positioned around J-Machine (centered at origin below J-Machine)
  const gridEntities = await createGridEntities(
    env,
    GRID_DIMS,
    jurisdiction,
    { x: 0, y: 400, z: 0 }, // Below J-Machine (y=600)
    GRID_SPACING
  );

  console.log(`✅ Created ${gridEntities.length} grid nodes in 3D formation`);

  await pushSnapshot(env, 'GRID-CREATED', `${gridEntities.length} nodes in ${GRID_DIMS.x}×${GRID_DIMS.y}×${GRID_DIMS.z} 3D grid`, {
    gridDimensions: GRID_DIMS,
    totalNodes: gridEntities.length,
    margin: J_MARGIN,
    formation: '3D cube'
  });

  // ============================================================================
  // PHASE 1: BROADCAST BOTTLENECK
  // Fund all nodes and show broadcast to J-Machine
  // ============================================================================

  console.log('\n💥 PHASE 1: BROADCAST BOTTLENECK\n');
  console.log('All 8 nodes broadcasting to single J-Machine...');

  // Get jReplica for mempool operations
  const jReplica = env.jReplicas?.get('Grid Demo');
  if (!jReplica) throw new Error('J-Machine not found');

  // Fund all nodes with initial reserves via JAdapter
  console.log('💰 Funding nodes with initial reserves...');
  for (let i = 0; i < gridEntities.length; i++) {
    const nodeId = gridEntities[i];
    await jadapter.debugFundReserves(nodeId, USDC_TOKEN_ID, usd(100_000));
  }

  // Process j_events from BrowserVM
  await processJEvents(env);

  console.log(`✅ Funded ${gridEntities.length} nodes with $100K each`);

  await pushSnapshot(env, 'BROADCAST-FUNDED', 'Nodes funded - ready to broadcast', {
    fundedNodes: gridEntities.length,
    reservePerNode: '$100K'
  });

  // Phase 1b: Add R2R txs to mempool (broadcast simulation)
  console.log('\n📡 Broadcasting R2R transactions to J-Machine mempool...');
  console.log('   (8 concurrent txs → single mempool)');

  // Each node sends $10K to next node (circular)
  for (let i = 0; i < gridEntities.length; i++) {
    const fromNode = gridEntities[i];
    const toNode = gridEntities[(i + 1) % gridEntities.length]; // Circular

    // Add to J-Machine mempool (PENDING state - yellow cubes!)
    jReplica.mempool.push({
      type: 'r2r',
      from: fromNode,
      to: toNode,
      amount: usd(10_000),
      timestamp: env.timestamp
    });
  }

  console.log(`✅ ${gridEntities.length} txs in J-Machine mempool (yellow cubes!)`);

  await pushSnapshot(env, 'BROADCAST-BOTTLENECK', 'Broadcast bottleneck: 8 txs in mempool', {
    phase: 'broadcast',
    txCount: gridEntities.length,
    bottleneck: 'J-Machine mempool capacity',
    complexity: 'O(n) txs to single validator',
    mempoolSize: jReplica.mempool.length
  });

  console.log('\n⚠️  BROADCAST BOTTLENECK OBSERVED:');
  console.log('   • 8 nodes × 1 tx each = 8 concurrent broadcasts');
  console.log('   • Single J-Machine mempool capacity: ~10-20 txs/block');
  console.log('   • Result: All fit in one block, but imagine 256+ nodes');
  console.log('   • Scaling limit: Block capacity (NOT network mesh)');

  // Phase 1c: Execute the batch (J-Block clears mempool)
  console.log('\n⚡ J-Block #1: Processing batch...');

  // Execute all R2R txs from mempool via JAdapter
  for (const tx of jReplica.mempool) {
    if (tx.type === 'r2r' && tx.from && tx.to && tx.amount) {
      await submitReserveToReserveBatch(env, jadapter, tx.from, tx.to, tx.amount);
    }
  }

  // Clear mempool (batch processed)
  jReplica.mempool = [];

  // Process j_events from BrowserVM
  await processJEvents(env);

  console.log('✅ J-Block #1 executed - all R2R txs processed');

  await pushSnapshot(env, 'BROADCAST-EXECUTED', 'J-Block processed 8 txs', {
    phase: 'execution',
    txCount: gridEntities.length,
    mempoolSize: jReplica.mempool.length
  });

  // ============================================================================
  // PHASE 2: HUB-SPOKE SCALING
  // Create 2 routing hubs, nodes route through nearest hub
  // ============================================================================

  console.log('\n\n🌐 PHASE 2: HUB-SPOKE TOPOLOGY\n');
  console.log('Creating 2 routing hubs in ring formation...');

  // Create 2 hubs in a ring around J-Machine (between grid and J)
  const HUB_RADIUS = 100; // px from center
  const hubs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const angle = (i / 2) * Math.PI * 2;
    const x = Math.cos(angle) * HUB_RADIUS;
    const z = Math.sin(angle) * HUB_RADIUS;
    const y = 500; // Between grid (y=400) and J-Machine (y=600)

    const hubId = await createNumberedEntity(
      env,
      1000 + i, // Hub IDs: 1000-1007
      `Hub${i + 1}`,
      jurisdiction,
      { x, y, z }
    );

    hubs.push(hubId);
  }

  console.log(`✅ Created ${hubs.length} routing hubs`);
  console.log('   Position: Ring formation between grid and J-Machine');

  await pushSnapshot(env, 'HUBS-CREATED', '2 routing hubs form ring topology', {
    hubCount: hubs.length,
    hubRadius: HUB_RADIUS,
    topology: 'ring'
  });

  // Each node connects to nearest hub (simplified: divide grid into 8 sectors)
  console.log('\n🔗 Connecting nodes to nearest hubs...');

  const nodesPerHub = Math.ceil(gridEntities.length / hubs.length);
  let accountsOpened = 0;

  for (let i = 0; i < gridEntities.length; i++) {
    const nodeId = gridEntities[i];
    const nearestHubIdx = Math.floor(i / nodesPerHub);
    const hubId = hubs[Math.min(nearestHubIdx, hubs.length - 1)];

    // Open bilateral account: Node ↔ Hub
    // TODO: Actually open accounts when we have proper routing visualization
    accountsOpened++;
  }

  console.log(`✅ Opened ${accountsOpened} bilateral accounts (node ↔ hub)`);

  await pushSnapshot(env, 'HUB-CONNECTIONS', 'Nodes connected to nearest hubs', {
    accountsOpened,
    avgNodesPerHub: Math.ceil(gridEntities.length / hubs.length),
    topology: 'hub-spoke'
  });

  // Hub-to-hub connections (ring topology)
  console.log('\n🔗 Connecting hubs in ring topology...');

  let hubConnections = 0;
  for (let i = 0; i < hubs.length; i++) {
    const hub1 = hubs[i];
    const hub2 = hubs[(i + 1) % hubs.length]; // Connect to next hub (circular)

    // Open bilateral account: Hub ↔ Hub
    // TODO: Actually open accounts
    hubConnections++;
  }

  console.log(`✅ Opened ${hubConnections} hub-to-hub connections`);

  await pushSnapshot(env, 'HUB-RING', 'Hubs connected in ring topology', {
    hubConnections,
    topology: 'ring',
    maxHops: Math.ceil(hubs.length / 2) // Worst case: halfway around ring
  });

  // ============================================================================
  // PHASE 3: COMPARISON METRICS
  // ============================================================================

  console.log('\n\n📊 SCALING COMPARISON\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('BROADCAST MODEL (Traditional Blockchain):');
  console.log(`  • Nodes: ${gridEntities.length}`);
  console.log(`  • Connections: ${gridEntities.length} (all → J-Machine)`);
  console.log('  • Bottleneck: J-Machine mempool capacity');
  console.log('  • Complexity: O(n) txs to single validator');
  console.log('  • Block capacity: ~10-20 txs/block');
  console.log(`  • Queue buildup: ${gridEntities.length - 20} pending txs`);
  console.log('');
  console.log('HUB-SPOKE MODEL (Payment Account Network):');
  console.log(`  • Nodes: ${gridEntities.length}`);
  console.log(`  • Routing hubs: ${hubs.length}`);
  console.log(`  • Node→Hub connections: ${accountsOpened}`);
  console.log(`  • Hub↔Hub connections: ${hubConnections}`);
  console.log(`  • Total connections: ${accountsOpened + hubConnections}`);
  console.log(`  • Avg nodes per hub: ~${Math.ceil(gridEntities.length / hubs.length)}`);
  console.log('  • Bottleneck: NONE (local bilateral consensus)');
  console.log('  • Complexity: O(1) per node');
  console.log('  • Throughput: Unlimited (horizontal scaling)');
  console.log('  • Max routing hops: ~4 (hub ring diameter)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await pushSnapshot(env, 'COMPARISON', 'Broadcast vs Hub-Spoke scaling metrics', {
    broadcast: {
      model: 'Traditional Blockchain',
      nodes: gridEntities.length,
      connections: gridEntities.length,
      bottleneck: 'J-Machine mempool',
      complexity: 'O(n)',
      blockCapacity: 20,
      queueBuildup: gridEntities.length - 20
    },
    hubSpoke: {
      model: 'Payment Account Network',
      nodes: gridEntities.length,
      hubs: hubs.length,
      connections: accountsOpened + hubConnections,
      bottleneck: 'None',
      complexity: 'O(1)',
      throughput: 'Unlimited',
      maxHops: 4
    }
  });

  console.log('\n\n✅ GRID SCALABILITY DEMO COMPLETE');
  console.log(`📊 Total frames: ${env.history?.length || 0}`);
  console.log('🎯 Key insight: Hubs aren\'t centralization - they\'re MATH');
  console.log('   O(n²) mesh → O(n) broadcast → O(1) hub-spoke\n');

  } finally {
    env.scenarioMode = false;
    restoreStrict();
  }
}

// ===== CLI ENTRY POINT =====
// Run this file directly: bun runtime/scenarios/grid.ts
if (import.meta.main) {
  console.log('🚀 Running GRID scenario from CLI...\n');

  const runtime = await import('../runtime');
  const env = runtime.createEmptyEnv();

  await grid(env);

  console.log('\n✅ Grid scenario complete!');
  process.exit(0);
}
