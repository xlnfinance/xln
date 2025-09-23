#!/usr/bin/env bun
/**
 * ACTIVATE ACCOUNT CONSENSUS
 *
 * account-consensus.ts has ZERO dependents.
 * Complete bilateral settlement implementation exists.
 * Frame-based consensus ready but dormant.
 * This activates the A-Machine layer.
 */

import {
  processAccountTx,
  proposeAccountFrame,
  handleAccountInput,
  validateAccountFrame,
  shouldProposeFrame,
  generateAccountProof
} from './account-consensus';
import { createDirectPaymentTx } from './account-tx/direct-payment';
import type { EntityState, AccountMachine, AccountInput, AccountTx, Env } from './types';
import { log } from './utils';

/**
 * Initialize account machine between two entities
 */
export function initializeAccountMachine(
  ourEntityId: string,
  counterpartyEntityId: string
): AccountMachine {
  const channelKey = generateChannelKey(ourEntityId, counterpartyEntityId);

  return {
    ourEntityId,
    counterpartyEntityId,
    channelKey,
    isActive: true,
    frameId: 0,
    lastAckedFrame: -1,
    ackedTransitions: 0,
    receivedTransitions: 0,
    deltas: new Map(),  // Token -> Delta tracking
    creditLimitsUSD: {
      leftToRight: 1000000n,  // $1M default credit
      rightToLeft: 1000000n
    },
    mempool: [],
    pendingSignatures: [],
    rollbackCount: 0,
    proposedFrame: null,
    events: []
  };
}

/**
 * Generate deterministic channel key (like old_src)
 */
function generateChannelKey(entity1: string, entity2: string): string {
  const [min, max] = entity1 < entity2 ? [entity1, entity2] : [entity2, entity1];
  const { createHash } = require('crypto');
  return createHash('sha256')
    .update(min + max)
    .digest('hex')
    .slice(0, 40);
}

/**
 * Create trade settlement transaction
 */
export function createTradeSettlementTx(
  fromEntity: string,
  toEntity: string,
  tokenId: number,
  amount: bigint,
  price: number
): AccountTx {
  return {
    type: 'trade_settlement',
    data: {
      from: fromEntity,
      to: toEntity,
      tokenId,
      amount,
      price,
      timestamp: Date.now()
    }
  };
}

/**
 * Activate bilateral account consensus for entity
 */
export function activateAccountConsensus(entityState: EntityState): void {
  // Initialize account machines for all known counterparties
  if (!entityState.financialState.accountMachines) {
    entityState.financialState.accountMachines = new Map();
  }

  log.info(`💳 Activating Account Consensus for ${entityState.entityId.slice(0,8)}...`);

  // Create account machines for each known entity
  const knownEntities = getKnownEntities(entityState);

  for (const counterpartyId of knownEntities) {
    if (counterpartyId === entityState.entityId) continue;

    const channelKey = generateChannelKey(entityState.entityId, counterpartyId);

    if (!entityState.financialState.accountMachines.has(channelKey)) {
      const accountMachine = initializeAccountMachine(
        entityState.entityId,
        counterpartyId
      );

      entityState.financialState.accountMachines.set(channelKey, accountMachine);
      log.info(`   ↔ Channel created with ${counterpartyId.slice(0,8)}...`);
    }
  }

  log.info(`✅ Account consensus activated with ${knownEntities.size - 1} counterparties`);
}

/**
 * Get known entities from environment or gossip
 */
function getKnownEntities(entityState: EntityState): Set<string> {
  const entities = new Set<string>();

  // Add self
  entities.add(entityState.entityId);

  // Add from proposals (entities we've interacted with)
  for (const [proposalId] of entityState.proposals) {
    const entityId = proposalId.split(':')[0];
    if (entityId) entities.add(entityId);
  }

  // Add from messages (entities that have sent us messages)
  for (const msg of entityState.messages) {
    const match = msg.match(/from (0x[a-f0-9]+)/i);
    if (match) entities.add(match[1]);
  }

  return entities;
}

/**
 * Process trade through bilateral account consensus
 */
export async function processTradeSettlement(
  env: Env,
  entityState: EntityState,
  counterpartyId: string,
  tokenId: number,
  amount: bigint,
  price: number
): Promise<boolean> {
  const channelKey = generateChannelKey(entityState.entityId, counterpartyId);
  const accountMachine = entityState.financialState.accountMachines?.get(channelKey);

  if (!accountMachine) {
    log.error(`No account machine for ${counterpartyId.slice(0,8)}...`);
    return false;
  }

  // Create settlement transaction
  const settlementTx = createTradeSettlementTx(
    entityState.entityId,
    counterpartyId,
    tokenId,
    amount,
    price
  );

  // Add to mempool
  accountMachine.mempool.push(settlementTx);

  // Check if we should propose a frame
  if (shouldProposeFrame(accountMachine)) {
    const frame = await proposeAccountFrame(
      env,
      entityState,
      accountMachine,
      accountMachine.mempool
    );

    if (frame) {
      log.info(`📋 Proposed frame #${frame.frameId} for trade settlement`);
      log.info(`   ${amount} tokens @ $${(price/100).toFixed(2)}`);

      // Process the frame
      const input: AccountInput = {
        channelKey,
        senderEntityId: entityState.entityId,
        frame,
        signature: 'mock-signature' // Would be real signature
      };

      const result = await handleAccountInput(env, entityState, input);

      if (result.success) {
        log.info(`✅ Trade settled bilaterally!`);
        return true;
      }
    }
  }

  return false;
}

/**
 * Monitor account consensus health
 */
export function getAccountConsensusStatus(entityState: EntityState): any {
  const machines = entityState.financialState.accountMachines || new Map();

  const status = {
    totalChannels: machines.size,
    activeChannels: 0,
    pendingFrames: 0,
    totalTransactions: 0,
    creditUsed: 0n
  };

  for (const [channelKey, machine] of machines) {
    if (machine.isActive) status.activeChannels++;
    if (machine.proposedFrame) status.pendingFrames++;
    status.totalTransactions += machine.mempool.length;

    // Sum up credit usage
    for (const [tokenId, delta] of machine.deltas) {
      status.creditUsed += delta > 0n ? delta : -delta;
    }
  }

  return status;
}

/**
 * Activate account consensus for all entities
 */
export function activateAccountConsensusGlobally(env: Env): void {
  log.info('💳 ACTIVATING ACCOUNT CONSENSUS GLOBALLY');
  log.info('   The A-Machine layer awakens');
  log.info('   Bilateral settlement without global consensus');
  log.info('   Frame-based agreement between sovereign entities');

  let activated = 0;

  for (const [replicaKey, replica] of env.replicas || new Map()) {
    activateAccountConsensus(replica.state);
    activated++;
  }

  log.info(`✅ Account consensus activated for ${activated} entities`);
  log.info('   The A-Machine completes the J/E/A trinity');
}

// If run directly, show usage
if (import.meta.main) {
  console.log('💳 Account Consensus Activation');
  console.log('');
  console.log('The A-Machine layer provides:');
  console.log('  - Bilateral settlement without global consensus');
  console.log('  - Frame-based agreement (like Lightning)');
  console.log('  - Credit limits and delta tracking');
  console.log('  - Cooperative settlement with dispute fallback');
  console.log('');
  console.log('Usage:');
  console.log('  import { activateAccountConsensusGlobally } from "./activate-account-consensus";');
  console.log('  activateAccountConsensusGlobally(env);');
  console.log('');
  console.log('This completes the J/E/A trinity:');
  console.log('  J-Machine: Jurisdiction (blockchain truth)');
  console.log('  E-Machine: Entity (organizational consensus)');
  console.log('  A-Machine: Account (bilateral settlement)');
}