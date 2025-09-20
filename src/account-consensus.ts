/**
 * XLN Account Consensus System
 *
 * Implements bilateral consensus between two entities for off-chain account settlement.
 * Based on old_src Channel.ts but adapted for entity-deterministic architecture.
 *
 * Key Concepts:
 * - AccountMachine: Bilateral state machine between two entities
 * - Giant Per-Token Table: Map<tokenId, Delta> like old_src channels
 * - Global Credit Limits: USD-denominated credit limits (simplified)
 * - Frame-Based Consensus: Bilateral agreement on account state changes
 * - Event Bubbling: Account events bubble up to E-Machine for entity messages
 */

import { AccountMachine, AccountFrame, AccountTx, AccountInput, Delta } from './types';
import { cloneAccountMachine } from './state-helpers';
import { deriveDelta } from './account-utils';
import { signAccountFrame, verifyAccountSignature } from './account-tx/crypto';

// === CONSTANTS ===
const MEMPOOL_LIMIT = 1000;
const MAX_ROLLBACKS = 3;
const MAX_MESSAGE_COUNTER = 1000000;

// === VALIDATION ===

/**
 * Validate account frame (frame-level validation)
 */
export function validateAccountFrame(frame: AccountFrame): boolean {
  if (frame.frameId < 0) return false;
  if (frame.accountTxs.length > 100) return false;
  if (frame.tokenIds.length !== frame.deltas.length) return false;

  const now = Date.now();
  if (Math.abs(frame.timestamp - now) > 300000) return false; // 5 min drift

  return true;
}

/**
 * Validate message counter (strict replay protection)
 */
export function validateMessageCounter(accountMachine: AccountMachine, counter: number): boolean {
  if (counter <= 0 || counter > MAX_MESSAGE_COUNTER) return false;

  // Strict counter validation: must be greater than last acked
  if (counter <= accountMachine.ackedTransitions) {
    console.log(`❌ Counter replay: ${counter} <= ${accountMachine.ackedTransitions}`);
    return false;
  }

  // Counter must be reasonable (not too far in future)
  const now = Date.now();
  if (counter > now + 60000) { // Max 1 minute in future
    console.log(`❌ Counter too far in future: ${counter} vs ${now}`);
    return false;
  }

  return true;
}

// === FRAME HASH COMPUTATION ===

function createFrameHash(frame: AccountFrame): string {
  // Use crypto.createHash like old_src for proper deterministic hashing
  const { createHash } = require('crypto');

  const txsContent = frame.accountTxs.map(tx =>
    `${tx.type}:${JSON.stringify(tx.data, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`
  ).join('|');

  const content = `${frame.frameId}-${frame.timestamp}-${txsContent}-${frame.tokenIds.join(',')}-${frame.deltas.map(d => d.toString()).join(',')}`;

  const hash = createHash('sha256').update(content).digest('hex');
  return `0x${hash.slice(0, 40)}`; // Return first 20 bytes like old_src
}

// === TRANSACTION PROCESSING ===


/**
 * Process AccountTx with proper direction handling (like old_src Channel)
 */
export function processAccountTx(
  accountMachine: AccountMachine,
  accountTx: AccountTx,
  isOurFrame: boolean = true
): { success: boolean; events: string[]; error?: string } {
  console.log(`🔄 Processing ${accountTx.type} for ${accountMachine.counterpartyEntityId.slice(-4)} (ourFrame: ${isOurFrame})`);

  const events: string[] = [];

  switch (accountTx.type) {
    case 'initial_ack':
      events.push(`🤝 Account initialized with Entity ${accountMachine.counterpartyEntityId.slice(-4)}`);
      return { success: true, events };

    case 'direct_payment': {
      const { tokenId, amount, description } = accountTx.data;

      // Get or create delta
      let delta = accountMachine.deltas.get(tokenId);
      if (!delta) {
        delta = {
          tokenId,
          collateral: 0n,
          ondelta: 0n,
          offdelta: 0n,
          leftCreditLimit: 1000000n, // 1M USD per-token limit
          rightCreditLimit: 1000000n,
          leftAllowence: 0n,
          rightAllowence: 0n,
        };
        accountMachine.deltas.set(tokenId, delta);
      }

      // Determine direction: our frame = outgoing payment, their frame = incoming payment
      const isOutgoing = isOurFrame;

      if (isOutgoing) {
        // Check capacity using deriveDelta
        const derived = deriveDelta(delta, accountMachine.isProposer);
        if (amount > derived.outCapacity) {
          return {
            success: false,
            error: `Insufficient capacity: need ${amount.toString()}, available ${derived.outCapacity.toString()}`,
            events,
          };
        }

        // Check global credit limits for USDC (token 3)
        const newDelta = delta.ondelta + delta.offdelta + amount;
        if (tokenId === 3 && newDelta > accountMachine.globalCreditLimits.peerLimit) {
          return {
            success: false,
            error: `Exceeds global credit limit: ${newDelta.toString()} > ${accountMachine.globalCreditLimits.peerLimit.toString()}`,
            events,
          };
        }

        // Apply outgoing payment (positive = we owe them)
        delta.offdelta += amount;
        events.push(`💸 Sent ${amount.toString()} token ${tokenId} to Entity ${accountMachine.counterpartyEntityId.slice(-4)} ${description ? '(' + description + ')' : ''}`);
      } else {
        // Apply incoming payment (negative = they owe us)
        delta.offdelta -= amount;
        events.push(`💰 Received ${amount.toString()} token ${tokenId} from Entity ${accountMachine.counterpartyEntityId.slice(-4)} ${description ? '(' + description + ')' : ''}`);
      }

      // Update current frame
      const tokenIndex = accountMachine.currentFrame.tokenIds.indexOf(tokenId);
      const totalDelta = delta.ondelta + delta.offdelta;

      if (tokenIndex >= 0) {
        accountMachine.currentFrame.deltas[tokenIndex] = totalDelta;
      } else {
        accountMachine.currentFrame.tokenIds.push(tokenId);
        accountMachine.currentFrame.deltas.push(totalDelta);
      }

      return { success: true, events };
    }

    default:
      return { success: false, error: `Unknown accountTx type: ${(accountTx as any).type}`, events };
  }
}

// === FRAME CONSENSUS ===

/**
 * Propose account frame (like old_src Channel consensus)
 */
export function proposeAccountFrame(
  accountMachine: AccountMachine
): { success: boolean; accountInput?: AccountInput; events: string[]; error?: string } {
  console.log(`🚀 E-MACHINE: Proposing account frame for ${accountMachine.counterpartyEntityId.slice(-4)}`);

  const events: string[] = [];

  // Mempool size validation
  if (accountMachine.mempool.length > MEMPOOL_LIMIT) {
    return { success: false, error: `Mempool overflow: ${accountMachine.mempool.length} > ${MEMPOOL_LIMIT}`, events };
  }

  if (accountMachine.mempool.length === 0) {
    return { success: false, error: 'No transactions to propose', events };
  }

  if (accountMachine.sentTransitions > 0) {
    return { success: false, error: 'Already have pending transactions', events };
  }

  // Clone account machine for validation
  const clonedMachine = cloneAccountMachine(accountMachine);

  // Process all transactions on the clone
  const allEvents: string[] = [];
  for (const accountTx of accountMachine.mempool) {
    const result = processAccountTx(clonedMachine, accountTx, true); // Processing our own transactions

    if (!result.success) {
      return { success: false, error: `Tx validation failed: ${result.error}`, events: allEvents };
    }

    allEvents.push(...result.events);
  }

  // Create account frame
  const newFrame: AccountFrame = {
    frameId: accountMachine.currentFrameId + 1,
    timestamp: Date.now(),
    accountTxs: [...accountMachine.mempool],
    previousStateHash: accountMachine.currentFrameId === 0 ? 'genesis' : createFrameHash({
      frameId: accountMachine.currentFrameId,
      timestamp: accountMachine.currentFrame.timestamp,
      accountTxs: [],
      previousStateHash: '',
      stateHash: '',
      isProposer: accountMachine.isProposer,
      tokenIds: accountMachine.currentFrame.tokenIds,
      deltas: accountMachine.currentFrame.deltas,
    }),
    stateHash: '',
    isProposer: accountMachine.isProposer,
    tokenIds: clonedMachine.currentFrame.tokenIds,
    deltas: clonedMachine.currentFrame.deltas,
  };

  newFrame.stateHash = createFrameHash(newFrame);

  // Generate signature
  const signature = signAccountFrame(accountMachine.proofHeader.fromEntity, newFrame.stateHash);

  // Set pending state
  accountMachine.pendingFrame = newFrame;
  accountMachine.sentTransitions = accountMachine.mempool.length;
  accountMachine.clonedForValidation = clonedMachine;

  // Clear mempool
  accountMachine.mempool = [];

  events.push(`🚀 Proposed frame ${newFrame.frameId} with ${newFrame.accountTxs.length} transactions`);

  const accountInput: AccountInput = {
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: accountMachine.proofHeader.toEntity,
    frameId: newFrame.frameId,
    newAccountFrame: newFrame,
    newSignatures: [signature],
    counter: Date.now(),
    accountFrame: newFrame,
  };

  return { success: true, accountInput, events };
}

/**
 * Handle received AccountInput (bilateral consensus)
 */
export function handleAccountInput(
  accountMachine: AccountMachine,
  input: AccountInput
): { success: boolean; response?: AccountInput; events: string[]; error?: string } {
  console.log(`📨 A-MACHINE: Received AccountInput from ${input.fromEntityId.slice(-4)}`);

  const events: string[] = [];

  // Counter validation (replay protection) - only for established channels
  if (input.counter && accountMachine.currentFrameId > 0) {
    const counterValid = validateMessageCounter(accountMachine, input.counter);
    console.log(`🔍 Counter validation: ${input.counter} vs acked=${accountMachine.ackedTransitions}, frameId=${accountMachine.currentFrameId}, valid=${counterValid}`);

    if (!counterValid) {
      return { success: false, error: `Invalid message counter: ${input.counter} vs ${accountMachine.ackedTransitions}`, events };
    }
  } else if (input.counter) {
    console.log(`🔍 Initial frame - accepting counter ${input.counter} without strict validation`);
  }

  // Update acked counter
  if (input.counter) {
    accountMachine.ackedTransitions = Math.max(accountMachine.ackedTransitions, input.counter);
  }

  // Handle pending frame confirmation
  if (accountMachine.pendingFrame && input.frameId === accountMachine.pendingFrame.frameId && input.prevSignatures) {
    console.log(`✅ Received confirmation for pending frame ${input.frameId}`);

    const frameHash = accountMachine.pendingFrame.stateHash;
    const expectedSigner = accountMachine.proofHeader.toEntity;

    if (input.prevSignatures.length > 0 && verifyAccountSignature(expectedSigner, frameHash, input.prevSignatures[0])) {
      // Commit using cloned state
      if (accountMachine.clonedForValidation) {
        accountMachine.deltas = accountMachine.clonedForValidation.deltas;
        accountMachine.currentFrame = {
          frameId: accountMachine.pendingFrame.frameId,
          timestamp: accountMachine.pendingFrame.timestamp,
          tokenIds: accountMachine.pendingFrame.tokenIds,
          deltas: accountMachine.pendingFrame.deltas,
        };
        accountMachine.currentFrameId = accountMachine.pendingFrame.frameId;
      }

      // Clear pending state
      accountMachine.pendingFrame = undefined;
      accountMachine.sentTransitions = 0;
      accountMachine.clonedForValidation = undefined;
      accountMachine.rollbackCount = Math.max(0, accountMachine.rollbackCount - 1); // Successful confirmation reduces rollback

      events.push(`✅ Frame ${input.frameId} confirmed and committed`);
      return { success: true, events };
    } else {
      return { success: false, error: 'Invalid confirmation signature', events };
    }
  }

  // Handle new frame proposal
  if (input.newAccountFrame) {
    const receivedFrame = input.newAccountFrame;

    if (!validateAccountFrame(receivedFrame)) {
      return { success: false, error: 'Invalid frame structure', events };
    }

    // Handle frame conflicts with rollback logic
    if (receivedFrame.frameId === accountMachine.currentFrameId && accountMachine.pendingFrame) {
      console.log(`⚠️ Frame conflict detected`);

      if (accountMachine.isProposer) {
        console.log(`🔒 Proposer ignoring conflicting frame (right must rollback)`);
        return { success: false, error: 'Frame conflict - proposer ignores', events };
      } else {
        if (accountMachine.rollbackCount < MAX_ROLLBACKS) {
          console.log(`🔄 Non-proposer rolling back (rollback #${accountMachine.rollbackCount + 1})`);
          accountMachine.rollbackCount++;
          accountMachine.pendingFrame = undefined;
          accountMachine.sentTransitions = 0;
          accountMachine.clonedForValidation = undefined;
          // Continue to accept the received frame
        } else {
          return { success: false, error: 'Too many rollbacks', events };
        }
      }
    }

    // Verify frame sequence
    if (receivedFrame.frameId !== accountMachine.currentFrameId + 1) {
      return { success: false, error: 'Frame sequence mismatch', events };
    }

    // Verify signatures
    if (input.newSignatures && input.newSignatures.length > 0) {
      const isValid = verifyAccountSignature(input.fromEntityId, receivedFrame.stateHash, input.newSignatures[0]);
      if (!isValid) {
        return { success: false, error: 'Invalid frame signature', events };
      }
    }

    // Apply frame transactions to clone (as receiver)
    const clonedMachine = cloneAccountMachine(accountMachine);
    const processEvents: string[] = [];

    for (const accountTx of receivedFrame.accountTxs) {
      // When receiving a frame, we process transactions from counterparty's perspective (incoming)
      const result = processAccountTx(clonedMachine, accountTx, false); // Processing their transactions = incoming
      if (!result.success) {
        return { success: false, error: `Frame application failed: ${result.error}`, events };
      }
      processEvents.push(...result.events);
    }

    // Commit frame
    accountMachine.deltas = clonedMachine.deltas;
    accountMachine.currentFrame = {
      frameId: receivedFrame.frameId,
      timestamp: receivedFrame.timestamp,
      tokenIds: receivedFrame.tokenIds,
      deltas: receivedFrame.deltas,
    };
    accountMachine.currentFrameId = receivedFrame.frameId;

    events.push(...processEvents);
    events.push(`🤝 Accepted frame ${receivedFrame.frameId} from Entity ${input.fromEntityId.slice(-4)}`);

    // Send confirmation
    const confirmationSig = signAccountFrame(accountMachine.proofHeader.fromEntity, receivedFrame.stateHash);
    const response: AccountInput = {
      fromEntityId: accountMachine.proofHeader.fromEntity,
      toEntityId: input.fromEntityId,
      frameId: receivedFrame.frameId,
      prevSignatures: [confirmationSig],
      counter: Date.now(),
    };

    return { success: true, response, events };
  }

  return { success: true, events };
}

// === E-MACHINE INTEGRATION ===

/**
 * Add transaction to account mempool with limits
 */
export function addToAccountMempool(accountMachine: AccountMachine, accountTx: AccountTx): boolean {
  if (accountMachine.mempool.length >= MEMPOOL_LIMIT) {
    console.log(`❌ Mempool full: ${accountMachine.mempool.length} >= ${MEMPOOL_LIMIT}`);
    return false;
  }

  accountMachine.mempool.push(accountTx);
  console.log(`📥 Added ${accountTx.type} to mempool (${accountMachine.mempool.length}/${MEMPOOL_LIMIT})`);
  return true;
}

/**
 * Check if account should auto-propose frame
 */
export function shouldProposeFrame(accountMachine: AccountMachine): boolean {
  const should = accountMachine.mempool.length > 0 &&
         accountMachine.sentTransitions === 0 &&
         !accountMachine.pendingFrame;

  if (should) {
    console.log(`🔍 SHOULD-PROPOSE: YES - mempool=${accountMachine.mempool.length}, sent=${accountMachine.sentTransitions}, pending=${!!accountMachine.pendingFrame}`);
  }

  return should;
}

/**
 * Get accounts that should propose frames (for E-Machine auto-propose)
 */
export function getAccountsToProposeFrames(entityState: any): string[] {
  const accountsToProposeFrames: string[] = [];

  // Check if accounts exists and is iterable
  if (!entityState.accounts || !(entityState.accounts instanceof Map)) {
    console.log(`⚠️ No accounts or accounts not a Map: ${typeof entityState.accounts}`);
    return accountsToProposeFrames;
  }

  for (const [counterpartyEntityId, accountMachine] of entityState.accounts) {
    if (shouldProposeFrame(accountMachine)) {
      accountsToProposeFrames.push(counterpartyEntityId);
    }
  }

  return accountsToProposeFrames;
}

// === PROOF GENERATION (for future J-Machine integration) ===

/**
 * Generate account proof for dispute resolution (like old_src Channel.getSubchannelProofs)
 * Must be ABI-compatible with Depository contract
 */
export function generateAccountProof(accountMachine: AccountMachine): { proofHash: string; signature: string } {
  // Update proofBody with current state (like old_src does before signing)
  accountMachine.proofBody = {
    tokenIds: Array.from(accountMachine.deltas.keys()).sort((a, b) => a - b), // Deterministic order
    deltas: Array.from(accountMachine.deltas.keys())
      .sort((a, b) => a - b)
      .map(tokenId => {
        const delta = accountMachine.deltas.get(tokenId)!;
        return delta.ondelta + delta.offdelta; // Total delta for each token
      }),
  };

  // Create proof structure compatible with Depository.sol
  const proofData = {
    fromEntity: accountMachine.proofHeader.fromEntity,
    toEntity: accountMachine.proofHeader.toEntity,
    cooperativeNonce: accountMachine.proofHeader.cooperativeNonce,
    disputeNonce: accountMachine.proofHeader.disputeNonce,
    tokenIds: accountMachine.proofBody.tokenIds,
    deltas: accountMachine.proofBody.deltas.map(d => d.toString()), // Convert BigInt for JSON
  };

  // Create deterministic proof hash
  const { createHash } = require('crypto');
  const proofContent = JSON.stringify(proofData);
  const proofHash = createHash('sha256').update(proofContent).digest('hex');

  // Generate hanko signature (like old_src does)
  const signature = signAccountFrame(accountMachine.proofHeader.fromEntity, `0x${proofHash}`);

  // Store signature for later use
  accountMachine.hankoSignature = signature;

  console.log(`🔐 Generated account proof: ${accountMachine.proofBody.tokenIds.length} tokens, hash: 0x${proofHash.slice(0, 20)}...`);
  console.log(`🔐 ProofBody tokens: [${accountMachine.proofBody.tokenIds.join(',')}]`);
  console.log(`🔐 ProofBody deltas: [${accountMachine.proofBody.deltas.map(d => d.toString()).join(',')}]`);

  return { proofHash: `0x${proofHash}`, signature };
}