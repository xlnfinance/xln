/**
 * XLN Scenario Executor
 *
 * Executes parsed scenarios by feeding events to the XLN server
 */

import type { Env, ServerTx, ConsensusConfig } from '../types.js';
import type {
  Scenario,
  ScenarioEvent,
  ScenarioAction,
  ScenarioExecutionContext,
  ScenarioExecutionResult,
  ViewState,
} from './types.js';
import { mergeAndSortEvents } from './parser.js';
import { namedParamsToObject, getPositionalParams } from './types.js';
import { createNumberedEntity } from '../entity-factory.js';
import { getAvailableJurisdictions } from '../evm.js';

/**
 * Execute a scenario and generate server frames
 */
export async function executeScenario(
  env: Env,
  scenario: Scenario,
  options: {
    maxTimestamp?: number;
    tickInterval?: number; // Milliseconds per tick
  } = {}
): Promise<ScenarioExecutionResult> {
  const { maxTimestamp = 1000 } = options;

  // Merge explicit events + repeat blocks
  const allEvents = mergeAndSortEvents(scenario, maxTimestamp);

  const context: ScenarioExecutionContext = {
    scenario,
    currentFrameIndex: 0,
    totalFrames: 0,
    elapsedTime: 0,
    entityMapping: new Map(), // scenario entity ID -> actual address
    viewStateHistory: new Map(),
  };

  const errors: any[] = [];

  console.log(`🎬 SCENARIO: Starting execution with seed="${scenario.seed}"`);
  console.log(`📋 SCENARIO: ${allEvents.length} events to execute`);

  // Group events by timestamp
  const eventsByTimestamp = new Map<number, ScenarioEvent[]>();
  for (const event of allEvents) {
    if (!eventsByTimestamp.has(event.timestamp)) {
      eventsByTimestamp.set(event.timestamp, []);
    }
    eventsByTimestamp.get(event.timestamp)!.push(event);
  }

  // Sort timestamps
  const timestamps = Array.from(eventsByTimestamp.keys()).sort((a, b) => a - b);

  // Execute events at each timestamp
  for (const timestamp of timestamps) {
    const events = eventsByTimestamp.get(timestamp)!;

    console.log(`\n⏱️  t=${timestamp}s: ${events.length} event(s)`);

    for (const event of events) {
      if (event.title) {
        console.log(`  📌 ${event.title}`);
      }
      if (event.description) {
        console.log(`     ${event.description}`);
      }

      try {
        await executeEvent(env, event, context);
      } catch (error) {
        console.error(`❌ Error executing event at t=${timestamp}:`, error);
        errors.push({
          timestamp,
          event,
          error: (error as Error).message,
        });
      }
    }

    context.elapsedTime = timestamp;
    context.totalFrames++;
  }

  return {
    success: errors.length === 0,
    framesGenerated: context.totalFrames,
    finalTimestamp: context.elapsedTime,
    errors,
    context,
  };
}

/**
 * Execute a single scenario event
 */
async function executeEvent(
  env: Env,
  event: ScenarioEvent,
  context: ScenarioExecutionContext
): Promise<void> {
  for (const action of event.actions) {
    await executeAction(env, action, context);
  }

  // Apply narrative metadata to latest snapshot
  if (env.history && env.history.length > 0) {
    const latestSnapshot = env.history[env.history.length - 1];
    if (latestSnapshot) {
      if (event.title) {
        latestSnapshot.title = event.title;
      }
      if (event.description) {
        latestSnapshot.narrative = event.description;
      }
    }
  }

  // Apply view state if present
  if (event.viewState) {
    applyViewState(env, event.viewState, context);
  }
}

/**
 * Execute a single action
 */
async function executeAction(
  env: Env,
  action: ScenarioAction,
  context: ScenarioExecutionContext
): Promise<void> {
  const { type, entityId, params } = action;

  switch (type) {
    case 'import':
      await handleImport(params, context, env);
      break;

    case 'grid':
      await handleGrid(params, context, env);
      break;

    case 'payRandom':
      await handlePayRandom(params, context, env);
      break;

    case 'openAccount':
      await handleOpenAccount(entityId!, params, context, env);
      break;

    case 'deposit':
      await handleDeposit(entityId!, params, context);
      break;

    case 'withdraw':
      await handleWithdraw(entityId!, params, context);
      break;

    case 'transfer':
      await handleTransfer(entityId!, params, context);
      break;

    case 'chat':
      await handleChat(entityId!, params, context);
      break;

    case 'VIEW':
      // VIEW is handled at event level, not action level
      break;

    default:
      console.warn(`⚠️  Unknown action type: ${type}`);
  }
}

/**
 * Import entities (create numbered entities)
 *
 * This is the critical function that:
 * 1. Gets current max entity number
 * 2. Creates NEW entities continuing from that number
 * 3. Imports them into EXISTING server state (additive, not replacement)
 * 4. Creates snapshots with narrative metadata
 */
async function handleImport(
  params: any[],
  context: ScenarioExecutionContext,
  env: Env
): Promise<void> {
  const jurisdictions = await getAvailableJurisdictions();
  if (!jurisdictions || jurisdictions.length === 0) {
    throw new Error('No jurisdictions available');
  }

  const ethereum = jurisdictions.find(j => j.name.toLowerCase() === 'ethereum');
  if (!ethereum) {
    throw new Error('Ethereum jurisdiction not found');
  }

  // CRITICAL: Get current max entity number from blockchain
  const { getNextEntityNumber } = await import('../evm.js');
  const currentMaxNumber = await getNextEntityNumber(ethereum);

  console.log(`  🔢 Current max entity number: ${currentMaxNumber - 1}, next will be: ${currentMaxNumber}`);

  // Separate entity IDs from position metadata
  const entityIds: string[] = [];
  let positionData: Record<string, string> | null = null;

  for (const param of params) {
    if (typeof param === 'object' && !Array.isArray(param)) {
      positionData = param as Record<string, string>;
    } else {
      entityIds.push(String(param));
    }
  }

  const serverTxs: ServerTx[] = [];
  const scenarioIdToGlobalId = new Map<string, number>();

  // Map scenario IDs (1,2,3...) to global entity numbers
  for (let i = 0; i < entityIds.length; i++) {
    const scenarioId = entityIds[i];
    if (!scenarioId) continue;
    const globalEntityNumber = currentMaxNumber + i;
    scenarioIdToGlobalId.set(scenarioId, globalEntityNumber);
  }

  // Filter entities that need registration
  const entitiesToRegister = entityIds.filter(id => id && !context.entityMapping.has(id));

  if (entitiesToRegister.length === 0) {
    console.log('  ⏭️  All entities already imported');
    return;
  }

  // OPTIMIZATION: Use batch registration for large imports (>= 10 entities)
  let results: Array<{ config: ConsensusConfig; entityNumber: number; entityId: string }>;

  if (entitiesToRegister.length >= 10) {
    console.log(`  🚀 Batch registering ${entitiesToRegister.length} entities in ONE transaction...`);

    const { createNumberedEntitiesBatch } = await import('../entity-factory.js');
    results = await createNumberedEntitiesBatch(
      entitiesToRegister.map(scenarioId => ({
        name: `Entity-${scenarioId}`,
        validators: [`s${scenarioId}`],
        threshold: 1n,
      })),
      ethereum
    );

    console.log(`  ✅ Batch registered ${results.length} entities in single block!`);
  } else {
    console.log(`  🚀 Registering ${entitiesToRegister.length} entities (parallel)...`);

    // For small batches, use parallel individual registration
    const registrationPromises = entitiesToRegister.map(scenarioId =>
      createNumberedEntity(
        `Entity-${scenarioId}`,
        [`s${scenarioId}`],
        1n,
        ethereum
      )
    );

    results = await Promise.all(registrationPromises);
    console.log(`  ✅ All ${results.length} entities registered`);
  }

  // Process results and build serverTxs
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const scenarioId = entitiesToRegister[i];
    if (!result || !scenarioId) continue;

    context.entityMapping.set(scenarioId, result.entityId);
    console.log(`  ✅ import scenario=${scenarioId} → entity#${result.entityNumber} (${result.entityId.slice(0, 10)}...)`);

    // Store position in gossip profile if provided
    if (positionData && ('x' in positionData || 'y' in positionData || 'z' in positionData)) {
      const position = {
        x: parseFloat(positionData['x'] || '0'),
        y: parseFloat(positionData['y'] || '0'),
        z: parseFloat(positionData['z'] || '0'),
      };

      // Store in gossip layer for visualization (persisted in snapshots)
      env.gossip?.announce({
        entityId: result.entityId,
        capabilities: [],
        hubs: [],
        metadata: {
          name: `Entity-${scenarioId}`,
          avatar: '',
          position,
        }
      });

      console.log(`  📍 Positioned at (${position.x}, ${position.y}, ${position.z})`);
    }

    // Add to batch for server import
    serverTxs.push({
      type: 'importReplica',
      entityId: result.entityId,
      signerId: `s${scenarioId}`,
      data: {
        config: result.config,
        isProposer: true,
      },
    });
  }

  // Import all entities into EXISTING server state (additive!)
  if (serverTxs.length > 0) {
    const { applyServerInput } = await import('../server.js');
    await applyServerInput(env, {
      serverTxs,
      entityInputs: [],
    });

    console.log(`  📦 Added ${serverTxs.length} entities to existing server state`);
    console.log(`  🌐 Total entities now: ${env.replicas.size}`);
  }
}

/**
 * Create 3D grid of entities with automatic connections
 * Syntax: grid X Y Z spacing=40 token=1
 */
async function handleGrid(
  params: any[],
  context: ScenarioExecutionContext,
  env: Env
): Promise<void> {
  const positional = getPositionalParams(params);
  const named = namedParamsToObject(params);

  const X = parseInt(String(positional[0] || '2'));
  const Y = parseInt(String(positional[1] || '2'));
  const Z = parseInt(String(positional[2] || '2'));
  const spacing = parseFloat(String(named['spacing'] || '400'));

  const total = X * Y * Z;
  if (total > 1000) {
    throw new Error(`Grid too large: ${X}x${Y}x${Z} = ${total} entities (max 1000)`);
  }

  console.log(`  🎲 Creating ${X}x${Y}x${Z} grid (${total} entities, ${spacing}px spacing)`);

  const jurisdictions = await getAvailableJurisdictions();
  const ethereum = jurisdictions.find(j => j.name.toLowerCase() === 'ethereum');
  if (!ethereum) throw new Error('Ethereum jurisdiction not found');

  // Helper to compute entity ID from grid coordinates
  const gridId = (x: number, y: number, z: number) => `${x}_${y}_${z}`;

  // Phase 1: Create all entities with positions
  const entities: Array<{ name: string; validators: string[]; threshold: bigint }> = [];
  const positions = new Map<string, {x: number, y: number, z: number}>();

  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        const id = gridId(x, y, z);
        entities.push({
          name: `Grid-${id}`,
          validators: [`g${id}`],
          threshold: 1n
        });

        const pos = {
          x: x * spacing,
          y: y * spacing,
          z: z * spacing
        };
        positions.set(id, pos);
        console.log(`📍 GRID-POS-A: Entity ${id} generated at (${pos.x}, ${pos.y}, ${pos.z})`);
      }
    }
  }

  // Batch create all entities
  const { createNumberedEntitiesBatch } = await import('../entity-factory.js');
  const results = await createNumberedEntitiesBatch(entities, ethereum);

  // Store mappings and build serverTxs with positions
  const serverTxs: ServerTx[] = [];

  results.forEach((result, i) => {
    const entityDef = entities[i];
    if (!entityDef) return;
    const gridCoord = entityDef.name.replace('Grid-', '');
    context.entityMapping.set(gridCoord, result.entityId);

    const pos = positions.get(gridCoord);

    // Store in gossip for profile display
    if (pos) {
      env.gossip?.announce({
        entityId: result.entityId,
        capabilities: [],
        hubs: [],
        metadata: {
          name: entityDef.name,
          avatar: '',
          position: pos,
        }
      });
    }

    // Include position in serverTx for replica state
    const txData: any = {
      config: result.config,
      isProposer: true,
    };
    if (pos) {
      txData.position = pos;
      console.log(`📍 GRID-POS-B: ServerTx for ${result.entityId.slice(0,10)} has position:`, pos);
    }

    serverTxs.push({
      type: 'importReplica' as const,
      entityId: result.entityId,
      signerId: entityDef.validators[0]!,
      data: txData,
    });
  });

  // Import into server state
  const { applyServerInput } = await import('../server.js');
  await applyServerInput(env, {
    serverTxs,
    entityInputs: [],
  });

  console.log(`  ✅ Created ${results.length} entities in grid formation`);

  // Phase 2: Create connections along each axis
  const { processUntilEmpty } = await import('../server.js');
  const connectionInputs: any[] = [];

  // X-axis connections (horizontal)
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X - 1; x++) {
        const id1 = gridId(x, y, z);
        const id2 = gridId(x + 1, y, z);
        const entityId1 = context.entityMapping.get(id1);
        const entityId2 = context.entityMapping.get(id2);

        if (entityId1 && entityId2) {
          connectionInputs.push({
            entityId: entityId1,
            signerId: `g${id1}`,
            entityTxs: [{
              type: 'openAccount',
              data: { targetEntityId: entityId2 }
            }]
          });
        }
      }
    }
  }

  // Y-axis connections (vertical)
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y - 1; y++) {
      for (let x = 0; x < X; x++) {
        const id1 = gridId(x, y, z);
        const id2 = gridId(x, y + 1, z);
        const entityId1 = context.entityMapping.get(id1);
        const entityId2 = context.entityMapping.get(id2);

        if (entityId1 && entityId2) {
          connectionInputs.push({
            entityId: entityId1,
            signerId: `g${id1}`,
            entityTxs: [{
              type: 'openAccount',
              data: { targetEntityId: entityId2 }
            }]
          });
        }
      }
    }
  }

  // Z-axis connections (depth)
  for (let z = 0; z < Z - 1; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        const id1 = gridId(x, y, z);
        const id2 = gridId(x, y, z + 1);
        const entityId1 = context.entityMapping.get(id1);
        const entityId2 = context.entityMapping.get(id2);

        if (entityId1 && entityId2) {
          connectionInputs.push({
            entityId: entityId1,
            signerId: `g${id1}`,
            entityTxs: [{
              type: 'openAccount',
              data: { targetEntityId: entityId2 }
            }]
          });
        }
      }
    }
  }

  console.log(`  🔗 Creating ${connectionInputs.length} grid connections...`);
  await processUntilEmpty(env, connectionInputs);
  console.log(`  ✅ Grid complete: ${total} entities, ${connectionInputs.length} connections`);
}

/**
 * Execute random payments across the network
 * Syntax: payRandom count=10 minHops=0 maxHops=5 minAmount=1000 maxAmount=100000 token=1
 */
async function handlePayRandom(
  params: any[],
  context: ScenarioExecutionContext,
  env: Env
): Promise<void> {
  const named = namedParamsToObject(params);

  const count = parseInt(String(named['count'] || '1'));
  const minHops = parseInt(String(named['minHops'] || '0'));
  const maxHops = parseInt(String(named['maxHops'] || '99'));
  const minAmount = BigInt(named['minAmount'] || '1000');
  const maxAmount = BigInt(named['maxAmount'] || '100000');
  const token = parseInt(String(named['token'] || '1'));

  console.log(`  🎲 Executing ${count} random payments (${minHops}-${maxHops} hops, ${minAmount}-${maxAmount} amount)`);

  const entities = Array.from(context.entityMapping.values());
  if (entities.length < 2) {
    console.warn('  ⚠️  Need at least 2 entities for random payments');
    return;
  }

  const { processUntilEmpty } = await import('../server.js');
  const paymentInputs: any[] = [];

  for (let i = 0; i < count; i++) {
    // Random source and destination
    const sourceIdx = Math.floor(Math.random() * entities.length);
    let destIdx = Math.floor(Math.random() * entities.length);

    // Ensure source !== dest
    while (destIdx === sourceIdx && entities.length > 1) {
      destIdx = Math.floor(Math.random() * entities.length);
    }

    const sourceEntityId = entities[sourceIdx];
    const destEntityId = entities[destIdx];
    if (!sourceEntityId || !destEntityId) continue;

    // Random amount
    const amountRange = maxAmount - minAmount;
    const randomOffset = BigInt(Math.floor(Math.random() * Number(amountRange)));
    const amount = minAmount + randomOffset;

    // Find scenario ID for signer
    const sourceScenarioId = Array.from(context.entityMapping.entries())
      .find(([, addr]) => addr === sourceEntityId)?.[0];
    if (!sourceScenarioId) continue;

    paymentInputs.push({
      entityId: sourceEntityId,
      signerId: `g${sourceScenarioId}`,
      entityTxs: [{
        type: 'accountInput',
        data: {
          fromEntityId: sourceEntityId,
          toEntityId: destEntityId,
          accountTx: {
            type: 'direct-payment',
            data: {
              tokenId: token,
              amount: amount,
              description: `Random payment #${i + 1}`
            }
          }
        }
      }]
    });
  }

  console.log(`  💸 Sending ${paymentInputs.length} random payments...`);
  await processUntilEmpty(env, paymentInputs);
  console.log(`  ✅ Random payments complete`);
}

/**
 * Open bilateral account between entities
 */
async function handleOpenAccount(
  entityId: string,
  params: any[],
  context: ScenarioExecutionContext,
  env: Env
): Promise<void> {
  const counterpartyScenarioId = String(params[0]);

  const fromAddress = context.entityMapping.get(entityId);
  const toAddress = context.entityMapping.get(counterpartyScenarioId);

  if (!fromAddress || !toAddress) {
    throw new Error(
      `Entity mapping not found: ${entityId}→${fromAddress}, ${counterpartyScenarioId}→${toAddress}`
    );
  }

  console.log(`  🔗 ${entityId} openAccount ${counterpartyScenarioId}`);

  // Execute openAccount transaction through XLN
  const { processUntilEmpty } = await import('../server.js');

  await processUntilEmpty(env, [
    {
      entityId: fromAddress,
      signerId: `s${entityId}`,
      entityTxs: [
        {
          type: 'openAccount',
          data: { targetEntityId: toAddress },
        },
      ],
    },
  ]);
}

/**
 * Handle deposit action
 */
async function handleDeposit(
  entityId: string,
  params: any[],
  context: ScenarioExecutionContext
): Promise<void> {
  const counterpartyScenarioId = String(params[0]);
  const amount = BigInt(params[1]);

  const fromAddress = context.entityMapping.get(entityId);
  const toAddress = context.entityMapping.get(counterpartyScenarioId);

  if (!fromAddress || !toAddress) {
    throw new Error(`Entity mapping not found: ${entityId}, ${counterpartyScenarioId}`);
  }

  console.log(`  💰 ${entityId} deposit ${counterpartyScenarioId} ${amount}`);

  // TODO: Implement actual deposit logic via entity transactions
}

/**
 * Handle withdraw action
 */
async function handleWithdraw(
  entityId: string,
  params: any[],
  context: ScenarioExecutionContext
): Promise<void> {
  const counterpartyScenarioId = String(params[0]);
  const amount = BigInt(params[1]);

  const fromAddress = context.entityMapping.get(entityId);
  const toAddress = context.entityMapping.get(counterpartyScenarioId);

  if (!fromAddress || !toAddress) {
    throw new Error(`Entity mapping not found: ${entityId}, ${counterpartyScenarioId}`);
  }

  console.log(`  💸 ${entityId} withdraw ${counterpartyScenarioId} ${amount}`);

  // TODO: Implement actual withdraw logic
}

/**
 * Handle transfer action
 */
async function handleTransfer(
  entityId: string,
  params: any[],
  context: ScenarioExecutionContext
): Promise<void> {
  const counterpartyScenarioId = String(params[0]);
  const amount = BigInt(params[1]);

  const fromAddress = context.entityMapping.get(entityId);
  const toAddress = context.entityMapping.get(counterpartyScenarioId);

  if (!fromAddress || !toAddress) {
    throw new Error(`Entity mapping not found: ${entityId}, ${counterpartyScenarioId}`);
  }

  console.log(`  🔄 ${entityId} transfer ${counterpartyScenarioId} ${amount}`);

  // TODO: Implement actual transfer logic
}

/**
 * Handle chat message
 */
async function handleChat(
  entityId: string,
  params: any[],
  context: ScenarioExecutionContext
): Promise<void> {
  const message = String(params[0]);

  const fromAddress = context.entityMapping.get(entityId);
  if (!fromAddress) {
    throw new Error(`Entity mapping not found: ${entityId}`);
  }

  console.log(`  💬 ${entityId}: "${message}"`);

  // TODO: Implement chat via entity transactions
}

/**
 * Apply view state to the current frame
 */
function applyViewState(
  env: Env,
  viewState: ViewState,
  context: ScenarioExecutionContext
): void {
  // Store in context for later application to EnvSnapshot
  context.viewStateHistory.set(context.currentFrameIndex, viewState);

  // If env has history, apply to latest snapshot
  if (env.history && env.history.length > 0) {
    const latestSnapshot = env.history[env.history.length - 1];
    if (latestSnapshot) {
      // Map scenario entity IDs to actual addresses in viewState
      const mappedViewState: typeof viewState = { ...viewState };
      if (viewState.focus && context.entityMapping.has(viewState.focus)) {
        const mappedFocus = context.entityMapping.get(viewState.focus);
        if (mappedFocus) {
          mappedViewState.focus = mappedFocus;
        }
      }

      latestSnapshot.viewState = mappedViewState;

      console.log(`  🎥 VIEW: ${JSON.stringify(mappedViewState)}`);
    }
  }
}

/**
 * Helper to convert scenario entity ID to actual address
 */
export function resolveEntityAddress(
  scenarioId: string,
  context: ScenarioExecutionContext
): string | undefined {
  return context.entityMapping.get(scenarioId);
}
