/**
 * XLN Scenario Executor
 *
 * Executes parsed scenarios by feeding events to the XLN server
 */

import type { Env, ServerTx } from '../types.js';
import type {
  Scenario,
  ScenarioEvent,
  ScenarioAction,
  ScenarioExecutionContext,
  ScenarioExecutionResult,
  ViewState,
} from './types.js';
import { mergeAndSortEvents } from './parser.js';
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

  const serverTxs: ServerTx[] = [];
  const scenarioIdToGlobalId = new Map<string, number>();

  // Map scenario IDs (1,2,3...) to global entity numbers
  for (let i = 0; i < params.length; i++) {
    const scenarioId = String(params[i]);
    const globalEntityNumber = currentMaxNumber + i;
    scenarioIdToGlobalId.set(scenarioId, globalEntityNumber);
  }

  for (const param of params) {
    const scenarioId = String(param);

    // Skip if already imported in THIS execution
    if (context.entityMapping.has(scenarioId)) {
      console.log(`  ⏭️  Entity ${scenarioId} already imported`);
      continue;
    }

    // Create numbered entity on-chain (blockchain auto-assigns sequential number)
    const result = await createNumberedEntity(
      `Entity-${scenarioId}`, // name
      [`s${scenarioId}`], // validators (use scenario ID as signer)
      1n, // threshold
      ethereum // jurisdiction
    );

    context.entityMapping.set(scenarioId, result.entityId);
    console.log(`  ✅ import scenario=${scenarioId} → entity#${result.entityNumber} (${result.entityId.slice(0, 10)}...)`);

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
