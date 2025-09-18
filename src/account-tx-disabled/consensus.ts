/**
 * Bidirectional Account Consensus
 * Based on old_src channel consensus patterns
 */

import { AccountMachine, AccountTx, EntityState } from '../types';
import { keccak256, solidityPackedKeccak256 } from 'ethers';
import { createRLPEncoder } from '../utils';

export interface AccountProposal {
  fromEntityId: string;
  toEntityId: string;
  cooperativeNonce: number;
  transactions: AccountTx[];
  proposedFrame: {
    frameId: number;
    timestamp: number;
    tokenIds: number[];
    deltas: bigint[];
  };
  signature?: string;
}

export interface AccountAgreement {
  proposal: AccountProposal;
  counterSignature: string;
  agreedAt: number;
}

/**
 * Create a cooperative account proposal
 */
export function createAccountProposal(
  accountMachine: AccountMachine,
  fromEntityId: string,
  toEntityId: string,
  transactions: AccountTx[]
): AccountProposal {
  
  // Increment cooperative nonce for this proposal
  const cooperativeNonce = accountMachine.proofHeader.cooperativeNonce + 1;
  
  // Create proposed frame with current deltas
  const tokenIds = Array.from(accountMachine.deltas.keys());
  const deltas = tokenIds.map(tokenId => {
    const delta = accountMachine.deltas.get(tokenId)!;
    return delta.ondelta + delta.offdelta;
  });
  
  const proposal: AccountProposal = {
    fromEntityId,
    toEntityId,
    cooperativeNonce,
    transactions,
    proposedFrame: {
      frameId: accountMachine.currentFrame.frameId + 1,
      timestamp: Date.now(),
      tokenIds,
      deltas,
    },
  };

  console.log(`📋 Created account proposal #${cooperativeNonce} from ${fromEntityId.slice(-4)} to ${toEntityId.slice(-4)}`);
  console.log(`📋 Proposal includes ${transactions.length} transactions`);
  
  return proposal;
}

/**
 * Sign an account proposal
 */
export function signAccountProposal(
  proposal: AccountProposal,
  privateKey?: string // TODO: Get from entity signing context
): string {
  // Create deterministic hash of proposal
  const proposalHash = hashAccountProposal(proposal);
  
  // TODO: Implement actual cryptographic signing
  // For now, return a mock signature based on proposal hash
  const mockSignature = `sig_${proposalHash.slice(0, 16)}_${proposal.fromEntityId.slice(-4)}`;
  
  console.log(`✍️ Signed account proposal with mock signature: ${mockSignature}`);
  return mockSignature;
}

/**
 * Verify account proposal signature
 */
export function verifyAccountProposalSignature(
  proposal: AccountProposal,
  signature: string,
  expectedSigner: string
): boolean {
  // TODO: Implement actual signature verification
  // For now, verify mock signature format
  const proposalHash = hashAccountProposal(proposal);
  const expectedSignature = `sig_${proposalHash.slice(0, 16)}_${expectedSigner.slice(-4)}`;
  
  const isValid = signature === expectedSignature;
  console.log(`🔍 Verifying signature for ${expectedSigner.slice(-4)}: ${isValid ? '✅' : '❌'}`);
  
  return isValid;
}

/**
 * Create deterministic hash of account proposal for signing
 */
export function hashAccountProposal(proposal: AccountProposal): string {
  // Create deterministic representation for hashing
  const encodableData = {
    fromEntityId: proposal.fromEntityId,
    toEntityId: proposal.toEntityId,
    cooperativeNonce: proposal.cooperativeNonce,
    proposedFrame: {
      frameId: proposal.proposedFrame.frameId,
      timestamp: proposal.proposedFrame.timestamp,
      tokenIds: proposal.proposedFrame.tokenIds,
      deltas: proposal.proposedFrame.deltas.map(d => d.toString()),
    },
    transactions: proposal.transactions.map(tx => ({
      type: tx.type,
      data: tx.data
    })),
  };
  
  const dataString = JSON.stringify(encodableData);
  const hash = keccak256(new TextEncoder().encode(dataString));
  
  console.log(`🔷 Hashed account proposal: ${hash.slice(0, 16)}...`);
  return hash;
}

/**
 * Apply agreed account proposal to account machine
 */
export function applyAccountAgreement(
  accountMachine: AccountMachine,
  agreement: AccountAgreement
): { success: boolean; error?: string } {
  
  const proposal = agreement.proposal;
  
  console.log(`🤝 Applying account agreement #${proposal.cooperativeNonce}`);
  
  // Update proof header with new nonce
  accountMachine.proofHeader.cooperativeNonce = proposal.cooperativeNonce;
  
  // Apply the proposed frame
  accountMachine.currentFrame = proposal.proposedFrame;
  
  // Update proof body to match current state
  accountMachine.proofBody = {
    tokenIds: proposal.proposedFrame.tokenIds,
    deltas: proposal.proposedFrame.deltas,
  };
  
  console.log(`✅ Applied account agreement with frame #${proposal.proposedFrame.frameId}`);
  console.log(`✅ New cooperative nonce: ${proposal.cooperativeNonce}`);
  
  return { success: true };
}

/**
 * Check if account machines are in sync
 */
export function areAccountMachinesInSync(
  machine1: AccountMachine,
  machine2: AccountMachine
): boolean {
  // Check cooperative nonces match
  if (machine1.proofHeader.cooperativeNonce !== machine2.proofHeader.cooperativeNonce) {
    return false;
  }
  
  // Check frame IDs match
  if (machine1.currentFrame.frameId !== machine2.currentFrame.frameId) {
    return false;
  }
  
  // Check delta arrays match
  const deltas1 = machine1.currentFrame.deltas.map(d => d.toString()).sort();
  const deltas2 = machine2.currentFrame.deltas.map(d => d.toString()).sort();
  
  if (deltas1.length !== deltas2.length) {
    return false;
  }
  
  for (let i = 0; i < deltas1.length; i++) {
    if (deltas1[i] !== deltas2[i]) {
      return false;
    }
  }
  
  return true;
}

/**
 * Get account machine consensus status
 */
export function getAccountConsensusStatus(accountMachine: AccountMachine) {
  return {
    cooperativeNonce: accountMachine.proofHeader.cooperativeNonce,
    disputeNonce: accountMachine.proofHeader.disputeNonce,
    frameId: accountMachine.currentFrame.frameId,
    mempoolSize: accountMachine.mempool.length,
    tokenCount: accountMachine.deltas.size,
    lastUpdate: accountMachine.currentFrame.timestamp,
    isClean: accountMachine.mempool.length === 0,
  };
}