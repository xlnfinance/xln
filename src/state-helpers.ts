/**
 * XLN State Management Helpers
 * Utilities for entity replica cloning, snapshots, and state persistence
 */

import { encode } from './snapshot-coder';
import type { EntityInput, EntityReplica, EntityState, Env, EnvSnapshot, ServerInput, AccountMachine } from './types';
import { DEBUG } from './utils';

// === CLONING UTILITIES ===
export const cloneMap = <K, V>(map: Map<K, V>) => new Map(map);
export const cloneArray = <T>(arr: T[]) => [...arr];

/**
 * Creates a safe deep clone of entity state with guaranteed jBlock preservation
 * This prevents the jBlock corruption bugs that occur with manual state spreading
 */
export function cloneEntityState(entityState: EntityState): EntityState {
  // CRITICAL: Log jBlock before and after cloning
  const originalJBlock = entityState.jBlock;
  console.log(`🔍 CLONE-TRACE: About to clone entity state, jBlock=${originalJBlock} (${typeof originalJBlock})`);

  // Use structuredClone for deep cloning with fallback
  try {
    const cloned = structuredClone(entityState);

    // CRITICAL: Validate jBlock was preserved correctly
    if (typeof cloned.jBlock !== 'number') {
      console.error(`💥 CLONE-CORRUPTION: structuredClone corrupted jBlock!`);
      console.error(`💥   Original: ${entityState.jBlock} (${typeof entityState.jBlock})`);
      console.error(`💥   Cloned: ${cloned.jBlock} (${typeof cloned.jBlock})`);
      cloned.jBlock = entityState.jBlock ?? 0; // Force fix
    }

    console.log(`✅ CLONE-SUCCESS: Cloned state, jBlock=${cloned.jBlock} (${typeof cloned.jBlock})`);
    return cloned;
  } catch (error) {
    console.warn(`⚠️ structuredClone failed, using manual clone: ${(error as Error).message}`);
    const manual = manualCloneEntityState(entityState);
    console.log(`✅ MANUAL-CLONE: Manual clone completed, jBlock=${manual.jBlock} (${typeof manual.jBlock})`);
    return manual;
  }
}

/**
 * Manual entity state cloning with explicit jBlock preservation
 * Fallback for environments that don't support structuredClone
 */
function manualCloneEntityState(entityState: EntityState): EntityState {
  return {
    ...entityState,
    nonces: cloneMap(entityState.nonces),
    messages: cloneArray(entityState.messages),
    proposals: new Map(
      Array.from(entityState.proposals.entries()).map(([id, proposal]) => [
        id,
        { ...proposal, votes: cloneMap(proposal.votes) },
      ]),
    ),
    reserves: cloneMap(entityState.reserves),
    accounts: new Map(
      Array.from(entityState.accounts.entries()).map(([id, account]) => [
        id,
        {
          ...account,
          mempool: cloneArray(account.mempool),
          deltas: cloneMap(account.deltas),
          proofHeader: { ...account.proofHeader },
          proofBody: {
            tokenIds: [...account.proofBody.tokenIds],
            deltas: [...account.proofBody.deltas],
          },
        },
      ]),
    ),
    accountInputQueue: cloneArray(entityState.accountInputQueue || []),
    // CRITICAL: Explicit jBlock preservation for financial integrity
    jBlock: entityState.jBlock ?? 0,
  };
}

/**
 * Deep clone entity replica with all nested state properly cloned
 * Uses cloneEntityState as the entry point for state cloning
 */
export const cloneEntityReplica = (replica: EntityReplica): EntityReplica => {
  return {
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: cloneEntityState(replica.state), // Use unified entity state cloning
    mempool: cloneArray(replica.mempool),
    ...(replica.proposal && {
      proposal: {
        height: replica.proposal.height,
        txs: cloneArray(replica.proposal.txs),
        hash: replica.proposal.hash,
        newState: replica.proposal.newState,
        signatures: cloneMap(replica.proposal.signatures),
      }
    }),
    ...(replica.lockedFrame && {
      lockedFrame: {
        height: replica.lockedFrame.height,
        txs: cloneArray(replica.lockedFrame.txs),
        hash: replica.lockedFrame.hash,
        newState: replica.lockedFrame.newState,
        signatures: cloneMap(replica.lockedFrame.signatures),
      }
    }),
    isProposer: replica.isProposer,
  };
};

export const captureSnapshot = (
  env: Env,
  envHistory: EnvSnapshot[],
  db: any,
  serverInput: ServerInput,
  serverOutputs: EntityInput[],
  description: string,
): void => {
  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: env.timestamp,
    replicas: new Map(Array.from(env.replicas.entries()).map(([key, replica]) => [key, cloneEntityReplica(replica)])),
    serverInput: {
      serverTxs: [...serverInput.serverTxs],
      entityInputs: serverInput.entityInputs.map(input => ({
        entityId: input.entityId,
        signerId: input.signerId,
        ...(input.entityTxs && { entityTxs: [...input.entityTxs] }),
        ...(input.precommits && { precommits: new Map(input.precommits) }),
        ...(input.proposedFrame && { proposedFrame: input.proposedFrame }),
      })),
    },
    serverOutputs: serverOutputs.map(output => ({
      entityId: output.entityId,
      signerId: output.signerId,
      ...(output.entityTxs && { entityTxs: [...output.entityTxs] }),
      ...(output.precommits && { precommits: new Map(output.precommits) }),
      ...(output.proposedFrame && { proposedFrame: output.proposedFrame }),
    })),
    description,
  };

  envHistory.push(snapshot);

  // --- PERSISTENCE WITH BATCH OPERATIONS ---
  // Use batch operations for better performance
  const batch = db.batch();
  batch.put(Buffer.from(`snapshot:${snapshot.height}`), encode(snapshot));
  batch.put(Buffer.from('latest_height'), Buffer.from(snapshot.height.toString()));

  batch.write();

  if (DEBUG) {
    console.log(`📸 Snapshot captured: "${description}" (${envHistory.length} total)`);
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

// === ACCOUNT MACHINE HELPERS ===

/**
 * Clone AccountMachine for validation (replaces dryRun pattern)
 */
export function cloneAccountMachine(account: AccountMachine): AccountMachine {
  try {
    return structuredClone(account);
  } catch (error) {
    console.warn(`⚠️ structuredClone failed for AccountMachine, using manual clone`);
    return manualCloneAccountMachine(account);
  }
}

/**
 * Manual AccountMachine cloning
 */
function manualCloneAccountMachine(account: AccountMachine): AccountMachine {
  const result: AccountMachine = {
    counterpartyEntityId: account.counterpartyEntityId,
    mempool: [...account.mempool],
    currentFrame: {
      ...account.currentFrame,
      tokenIds: [...account.currentFrame.tokenIds],
      deltas: [...account.currentFrame.deltas],
    },
    sentTransitions: account.sentTransitions,
    ackedTransitions: account.ackedTransitions,
    deltas: new Map(Array.from(account.deltas.entries()).map(([key, delta]) => [key, { ...delta }])),
    globalCreditLimits: { ...account.globalCreditLimits },
    currentFrameId: account.currentFrameId,
    pendingSignatures: [...account.pendingSignatures],
    rollbackCount: account.rollbackCount,
    sendCounter: account.sendCounter,
    receiveCounter: account.receiveCounter,
    frameHistory: [...account.frameHistory], // Clone frame history array
    proofHeader: { ...account.proofHeader },
    proofBody: {
      ...account.proofBody,
      tokenIds: [...account.proofBody.tokenIds],
      deltas: [...account.proofBody.deltas],
    },
  };

  // Add optional properties if they exist
  if (account.pendingFrame) {
    result.pendingFrame = {
      ...account.pendingFrame,
      accountTxs: [...account.pendingFrame.accountTxs],
      tokenIds: [...account.pendingFrame.tokenIds],
      deltas: [...account.pendingFrame.deltas]
    };
  }

  if (account.clonedForValidation) {
    result.clonedForValidation = manualCloneAccountMachine(account.clonedForValidation);
  }

  if (account.hankoSignature) {
    result.hankoSignature = account.hankoSignature;
  }

  return result;
}
