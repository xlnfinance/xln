/**
 * XLN State Management Helpers
 * Utilities for entity replica cloning, snapshots, and state persistence
 */

import { encode } from './snapshot-coder';
import type { EntityInput, EntityReplica, EntityState, Env, EnvSnapshot, RuntimeInput, AccountMachine, JReplica, LogCategory, BrowserVMState } from './types';
import type { Profile } from './networking/gossip';
import { DEBUG } from './utils';
import { validateEntityState } from './validation-utils';
import { safeStringify, safeParse } from './serialization-utils';
import { isLeftEntity } from './entity-id-utils';
import { cloneJBatch } from './j-batch';

// Message size limit for snapshot efficiency
const MESSAGE_LIMIT = 10;

/**
 * CANONICAL ACCOUNT KEY: Bilateral accounts stored in sorted form (left < right)
 * Pattern from Channel.ts - ensures both entities reference SAME account object
 */
export function canonicalAccountKey(entity1: string, entity2: string): string {
  return isLeftEntity(entity1, entity2) ? `${entity1}:${entity2}` : `${entity2}:${entity1}`;
}

/**
 * Get account perspective: Am I left or right? Derive from/to for current operation.
 */
export function getAccountPerspective(account: AccountMachine, myEntityId: string): {
  iAmLeft: boolean;
  from: string;
  to: string;
  counterparty: string;
} {
  const iAmLeft = myEntityId === account.leftEntity;
  return {
    iAmLeft,
    from: iAmLeft ? account.leftEntity : account.rightEntity,
    to: iAmLeft ? account.rightEntity : account.leftEntity,
    counterparty: iAmLeft ? account.rightEntity : account.leftEntity,
  };
}

/**
 * Add message to EntityState with automatic size limiting
 * Prevents unbounded message array growth that causes snapshot bloat
 */
export function addMessage(state: EntityState, message: string): void {
  state.messages.push(message);
  if (state.messages.length > MESSAGE_LIMIT) {
    state.messages.shift(); // Remove oldest message
  }
}

/**
 * Add multiple messages with size limiting
 */
export function addMessages(state: EntityState, messages: string[]): void {
  for (const msg of messages) {
    addMessage(state, msg);
  }
}

/**
 * Emit structured events with a scoped path for time-travel debugging.
 * This keeps per-frame logs queryable without bloating state.messages.
 */
export function emitScopedEvents(
  env: Env,
  category: LogCategory,
  scope: string,
  messages: string[],
  data: Record<string, unknown> = {},
  entityId?: string,
): void {
  if (!messages || messages.length === 0) return;

  const payload = { path: scope, ...data };
  for (const message of messages) {
    env.info(category, message, payload, entityId);
  }
}

/**
 * Resolve the proposer signerId for a given entity.
 * Prefers local proposer replica, then local config validators[0], then gossip board[0].
 * Throws if no signer can be resolved (fail early).
 */
export function resolveEntityProposerId(env: Env, entityId: string, context: string): string {
  const targetEntityId = String(entityId || '').toLowerCase();
  let fallback: string | null = null;

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const keyParts = String(replicaKey).split(':');
    const keyEntityId = String(keyParts[0] || '').toLowerCase();
    const replicaEntityId = String(replica.entityId || '').toLowerCase();
    if (replicaEntityId !== targetEntityId && keyEntityId !== targetEntityId) continue;
    if (replica.isProposer) return replica.signerId;
    if (!fallback) {
      fallback =
        replica.state.config.validators[0] ||
        replica.signerId ||
        (keyParts[1] ? String(keyParts[1]) : null);
    }
  }

  if (env.gossip?.getProfiles) {
    const profile = (env.gossip.getProfiles() as Profile[]).find(
      (p) => String(p.entityId || '').toLowerCase() === targetEntityId,
    );
    const board = profile?.metadata?.board;
    if (Array.isArray(board) && board.length > 0 && board[0]) {
      return board[0];
    }
    if (board && !Array.isArray(board) && Array.isArray(board.validators) && board.validators.length > 0) {
      const first = board.validators[0];
      if (first?.signerId) return first.signerId;
      if (first?.signer) return first.signer;
    }
  }

  if (fallback) return fallback;

  throw new Error(`SIGNER_RESOLUTION_FAILED: ${context} entityId=${entityId}`);
}

// === CLONING UTILITIES ===
export const cloneMap = <K, V>(map: Map<K, V>) => new Map(map);
export const cloneArray = <T>(arr: T[]) => [...arr];

/**
 * Creates a safe deep clone of entity state with guaranteed jBlock preservation
 * This prevents the jBlock corruption bugs that occur with manual state spreading
 */
export function cloneEntityState(entityState: EntityState, forSnapshot: boolean = false): EntityState {
  // Use structuredClone for deep cloning with fallback
  try {
    const cloned = structuredClone(entityState);

    // CRITICAL: Validate entityId was preserved correctly
    if (!cloned.entityId || cloned.entityId !== entityState.entityId) {
      cloned.entityId = entityState.entityId; // Force preserve entityId
    }

    // CRITICAL: Validate lastFinalizedJHeight was preserved correctly
    if (typeof cloned.lastFinalizedJHeight !== 'number') {
      console.error(`💥 CLONE-CORRUPTION: structuredClone corrupted lastFinalizedJHeight!`);
      console.error(`💥   Original: ${entityState.lastFinalizedJHeight} (${typeof entityState.lastFinalizedJHeight})`);
      console.error(`💥   Cloned: ${cloned.lastFinalizedJHeight} (${typeof cloned.lastFinalizedJHeight})`);
      cloned.lastFinalizedJHeight = entityState.lastFinalizedJHeight ?? 0; // Force fix
    }

    // For snapshots, remove clonedForValidation from all accounts to avoid cycles
    if (forSnapshot) {
      for (const account of cloned.accounts.values()) {
        delete (account as any).clonedForValidation;
      }
    }

    if (entityState.jBatchState && !cloned.jBatchState) {
      cloned.jBatchState = {
        ...entityState.jBatchState,
        batch: cloneJBatch(entityState.jBatchState.batch),
        sentBatch: entityState.jBatchState.sentBatch
          ? {
              ...entityState.jBatchState.sentBatch,
              batch: cloneJBatch(entityState.jBatchState.sentBatch.batch),
            }
          : undefined,
      };
    }

    // VALIDATE AT SOURCE: Guarantee type safety from this point forward
    return validateEntityState(cloned, 'cloneEntityState.structuredClone');
  } catch (error) {
    // structuredClone warning removed - browser limitation, not actionable
    const manual = manualCloneEntityState(entityState, forSnapshot);

    // VALIDATE AT SOURCE: Guarantee type safety from manual clone path too
    return validateEntityState(manual, 'cloneEntityState.manual');
  }
}

/**
 * Manual entity state cloning with explicit jBlock preservation
 * Fallback for environments that don't support structuredClone
 */
function manualCloneEntityState(entityState: EntityState, forSnapshot: boolean = false): EntityState {
  return {
    ...entityState,
    entityId: entityState.entityId, // CRITICAL: Explicitly preserve entityId
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
        cloneAccountMachine(account, forSnapshot), // forSnapshot excludes clonedForValidation
      ]),
    ),
    deferredAccountProposals: cloneMap(entityState.deferredAccountProposals || new Map()),
    accountInputQueue: cloneArray(entityState.accountInputQueue || []),
    jBatchState: entityState.jBatchState ? {
      ...entityState.jBatchState,
      batch: cloneJBatch(entityState.jBatchState.batch),
      sentBatch: entityState.jBatchState.sentBatch
        ? {
            ...entityState.jBatchState.sentBatch,
            batch: cloneJBatch(entityState.jBatchState.sentBatch.batch),
          }
        : undefined,
    } : undefined,
    // JBlock consensus state
    lastFinalizedJHeight: entityState.lastFinalizedJHeight ?? 0,
    jBlockObservations: cloneArray(entityState.jBlockObservations || []),
    jBlockChain: cloneArray(entityState.jBlockChain || []),
    // HTLC routing table (deep clone)
    htlcRoutes: new Map(
      Array.from((entityState.htlcRoutes || new Map()).entries()).map(([hashlock, route]) => [
        hashlock,
        { ...route } // Clone route object
      ])
    ),
    htlcFeesEarned: entityState.htlcFeesEarned || 0n,
    // Orderbook extension (hub-only, contains TypedArrays)
    // Must manually clone since structuredClone failed (we're in fallback path)
    ...(entityState.orderbookExt && { orderbookExt: cloneOrderbookExt(entityState.orderbookExt) }),
    // Aggregated books (E-Machine view of A-Machine positions)
    swapBook: new Map(
      Array.from((entityState.swapBook || new Map()).entries()).map(([id, entry]) => [
        id,
        { ...entry }
      ])
    ),
    lockBook: new Map(
      Array.from((entityState.lockBook || new Map()).entries()).map(([id, entry]) => [
        id,
        { ...entry }
      ])
    ),
    pendingSwapFillRatios: new Map(
      Array.from((entityState.pendingSwapFillRatios || new Map()).entries())
    ),
  };
}

/**
 * Manually clone OrderbookExtState for environments without structuredClone
 * TypedArrays must be explicitly copied via their constructors
 */
function cloneOrderbookExt(ext: EntityState['orderbookExt']): EntityState['orderbookExt'] {
  if (!ext) return undefined;

  const clonedBooks = new Map<string, any>();
  for (const [key, book] of ext.books) {
    clonedBooks.set(key, cloneBookState(book));
  }

  // Clone referrals Map
  const clonedReferrals = new Map<string, any>();
  if (ext.referrals) {
    for (const [key, referral] of ext.referrals) {
      clonedReferrals.set(key, { ...referral });
    }
  }

  // Clone hubProfile with nested arrays
  const clonedHubProfile = ext.hubProfile ? {
    ...ext.hubProfile,
    supportedPairs: ext.hubProfile.supportedPairs ? [...ext.hubProfile.supportedPairs] : [],
  } : undefined;

  return {
    books: clonedBooks,
    referrals: clonedReferrals,
    hubProfile: clonedHubProfile,
  };
}

/**
 * Clone a BookState with TypedArrays properly copied
 */
function cloneBookState(book: any): any {
  return {
    ...book,
    // Clone TypedArrays via slice() which creates new underlying ArrayBuffer
    orderPriceIdx: book.orderPriceIdx?.slice?.() ?? book.orderPriceIdx,
    orderQtyLots: book.orderQtyLots?.slice?.() ?? book.orderQtyLots,
    orderOwnerIdx: book.orderOwnerIdx?.slice?.() ?? book.orderOwnerIdx,
    orderSide: book.orderSide?.slice?.() ?? book.orderSide,
    orderPrev: book.orderPrev?.slice?.() ?? book.orderPrev,
    orderNext: book.orderNext?.slice?.() ?? book.orderNext,
    orderActive: book.orderActive?.slice?.() ?? book.orderActive,
    levelHeadBid: book.levelHeadBid?.slice?.() ?? book.levelHeadBid,
    levelTailBid: book.levelTailBid?.slice?.() ?? book.levelTailBid,
    levelHeadAsk: book.levelHeadAsk?.slice?.() ?? book.levelHeadAsk,
    levelTailAsk: book.levelTailAsk?.slice?.() ?? book.levelTailAsk,
    bitmapBid: book.bitmapBid?.slice?.() ?? book.bitmapBid,
    bitmapAsk: book.bitmapAsk?.slice?.() ?? book.bitmapAsk,
    // Clone mutable reference types
    owners: [...(book.owners || [])],
    orderIds: [...(book.orderIds || [])],
    orderIdToIdx: new Map(book.orderIdToIdx || []),
    ownerToIdx: new Map(book.ownerToIdx || []),
  };
}

/**
 * Deep clone entity replica with all nested state properly cloned
 * Uses cloneEntityState as the entry point for state cloning
 */
export const cloneEntityReplica = (replica: EntityReplica, forSnapshot: boolean = false): EntityReplica => {
  return {
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: cloneEntityState(replica.state, forSnapshot), // forSnapshot excludes clonedForValidation
    mempool: cloneArray(replica.mempool),
    ...(replica.proposal && {
      proposal: {
        height: replica.proposal.height,
        txs: cloneArray(replica.proposal.txs),
        hash: replica.proposal.hash,
        newState: replica.proposal.newState,
        // Stored outputs from proposal time (used at commit, NOT re-applied)
        ...(replica.proposal.outputs && { outputs: [...replica.proposal.outputs] }),
        ...(replica.proposal.jOutputs && { jOutputs: [...replica.proposal.jOutputs] }),
        // Deep clone HashToSign objects (hash, type, context)
        ...(replica.proposal.hashesToSign && { hashesToSign: replica.proposal.hashesToSign.map(h => ({ ...h })) }),
        ...(replica.proposal.collectedSigs && { collectedSigs: new Map(Array.from(replica.proposal.collectedSigs.entries()).map(([k, v]) => [k, [...v]])) }),
        ...(replica.proposal.hankos && { hankos: [...replica.proposal.hankos] }),
      }
    }),
    ...(replica.lockedFrame && {
      lockedFrame: {
        height: replica.lockedFrame.height,
        txs: cloneArray(replica.lockedFrame.txs),
        hash: replica.lockedFrame.hash,
        newState: replica.lockedFrame.newState,
        // Deep clone HashToSign objects (hash, type, context)
        ...(replica.lockedFrame.hashesToSign && { hashesToSign: replica.lockedFrame.hashesToSign.map(h => ({ ...h })) }),
        ...(replica.lockedFrame.collectedSigs && { collectedSigs: new Map(Array.from(replica.lockedFrame.collectedSigs.entries()).map(([k, v]) => [k, [...v]])) }),
        ...(replica.lockedFrame.hankos && { hankos: [...replica.lockedFrame.hankos] }),
      }
    }),
    isProposer: replica.isProposer,
    ...(replica.position && { position: { ...replica.position } }),
    // SECURITY: Clone validator's computed state for state injection prevention
    ...(replica.validatorComputedState && { validatorComputedState: cloneEntityState(replica.validatorComputedState) }),
  };
};

export const captureSnapshot = async (
  env: Env,
  envHistory: EnvSnapshot[],
  db: any,
  runtimeInput: RuntimeInput,
  runtimeOutputs: EntityInput[],
  description: string,
): Promise<void> => {
  // Snapshots ALWAYS happen - they're essential for time-travel debugging
  // Use env.frameDisplayMs to hint how long to display important frames

  // Solvency check if set (from scenarios)
  if (env.extra?.expectedSolvency !== undefined) {
    const { checkSolvency } = await import('./scenarios/solvency-check');
    checkSolvency(env, env.extra.expectedSolvency, `Frame ${envHistory.length}`);
  }

  const gossipProfiles = env.gossip?.getProfiles
    ? env.gossip.getProfiles().map((profile: Profile) => {
        try {
          // structuredClone keeps nested data without mutating live gossip state
          return structuredClone(profile);
        } catch (error) {
          try {
            return safeParse(safeStringify(profile));
          } catch {
            return profile;
          }
        }
      })
    : [];

  // Capture fresh stateRoot from BrowserVM for time-travel (if available)
  let freshStateRoot: Uint8Array | null = null;
  let browserVMState: BrowserVMState | null = null;
  if (env.jReplicas) {
    try {
      const { getBrowserVMInstance } = await import('./evm');
      const browserVM = getBrowserVMInstance(env);
      if (browserVM?.captureStateRoot) {
        freshStateRoot = await browserVM.captureStateRoot();
        // Update live jReplicas so next snapshot has correct base
        for (const [, jReplica] of env.jReplicas.entries()) {
          jReplica.stateRoot = freshStateRoot;
        }
      }
      if (browserVM?.serializeState) {
        browserVMState = await browserVM.serializeState() as unknown as BrowserVMState;
      }
    } catch {
      // Silent fail - stateRoot capture is optional
    }
  }

  // Clone jReplicas (J-layer state) + SYNC reserves/collaterals from eReplicas for time travel
  const jReplicas: JReplica[] = env.jReplicas
    ? Array.from(env.jReplicas.values()).map(jr => {
        // Sync reserves from eReplicas into JReplica snapshot
        const reserves = new Map<string, Map<number, bigint>>();
        const registeredEntities = new Map<string, { name: string; quorum: string[]; threshold: number }>();
        // Collaterals: accountKey → tokenId → { collateral, ondelta }
        const collaterals = new Map<string, Map<number, { collateral: bigint; ondelta: bigint }>>();

        // Aggregate reserves and collaterals from all entity replicas
        for (const [key, replica] of env.eReplicas.entries()) {
          const entityId = key.split(':')[0] || key; // fallback to full key if no separator
          if (replica.state?.reserves) {
            const tokenMap = new Map<number, bigint>();
            // Handle both Map and plain object
            if (replica.state.reserves instanceof Map) {
              replica.state.reserves.forEach((amount: bigint, tokenId: string) => {
                tokenMap.set(Number(tokenId), amount);
              });
            } else {
              for (const [tokenId, amount] of Object.entries(replica.state.reserves as Record<string, bigint>)) {
                tokenMap.set(Number(tokenId), BigInt(amount));
              }
            }
            if (tokenMap.size > 0) {
              reserves.set(entityId, tokenMap);
            }
          }

          // Extract collaterals from bilateral accounts (only for LEFT entity to avoid duplicates)
          if (replica.state?.accounts) {
            for (const [counterpartyId, account] of replica.state.accounts.entries()) {
              // Only capture from LEFT entity (smaller ID) to avoid duplicates
              if (isLeftEntity(entityId, counterpartyId) && account.deltas) {
                // Create account key: LEFT-RIGHT (canonical ordering)
                const accountKey = `${entityId.slice(-4)}-${counterpartyId.slice(-4)}`;
                const tokenMap = new Map<number, { collateral: bigint; ondelta: bigint }>();

                for (const [tokenId, delta] of account.deltas.entries()) {
                  if (delta.collateral > 0n || delta.ondelta !== 0n) {
                    tokenMap.set(Number(tokenId), {
                      collateral: delta.collateral,
                      ondelta: delta.ondelta,
                    });
                  }
                }

                if (tokenMap.size > 0) {
                  collaterals.set(accountKey, tokenMap);
                }
              }
            }
          }

          // Add entity to registeredEntities
          if (!registeredEntities.has(entityId)) {
            registeredEntities.set(entityId, {
              name: `E${entityId.slice(-4)}`,
              quorum: replica.state.config?.validators || [],
              threshold: Number(replica.state.config?.threshold || 1n),
            });
          }
        }

        return {
          name: jr.name,
          blockNumber: jr.blockNumber,
          stateRoot: freshStateRoot ? new Uint8Array(freshStateRoot) : new Uint8Array(jr.stateRoot),
          mempool: [...jr.mempool],
          blockDelayMs: jr.blockDelayMs || 300,
          lastBlockTimestamp: jr.lastBlockTimestamp || 0,
          position: { ...jr.position },
          ...(jr.rpcs && { rpcs: [...jr.rpcs] }),
          ...(jr.chainId !== undefined && { chainId: jr.chainId }),
          ...(jr.depositoryAddress && { depositoryAddress: jr.depositoryAddress }),
          ...(jr.entityProviderAddress && { entityProviderAddress: jr.entityProviderAddress }),
          ...(jr.contracts && { contracts: { ...jr.contracts } }),
          reserves,
          collaterals,  // Collateral state from bilateral accounts
          registeredEntities,
        };
      })
    : [];

  // Capture and reset frame logs
  const frameLogs = env.frameLogs ? [...env.frameLogs] : [];
  if (frameLogs.length > 0) {
    console.log(`📋 Capturing ${frameLogs.length} frame events into snapshot`);
  }
  if (env.frameLogs) {
    env.frameLogs = [];
  }

  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: env.timestamp,
    ...(env.runtimeSeed !== undefined && env.runtimeSeed !== null ? { runtimeSeed: env.runtimeSeed } : {}),
    ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
    eReplicas: new Map(Array.from(env.eReplicas.entries()).map(([key, replica]) => [key, cloneEntityReplica(replica, true)])), // forSnapshot=true excludes clonedForValidation
    jReplicas,
    ...(browserVMState ? { browserVMState } : {}),
    runtimeInput: {
      runtimeTxs: [...runtimeInput.runtimeTxs],
      entityInputs: runtimeInput.entityInputs.map(input => ({
        entityId: input.entityId,
        signerId: input.signerId,
        ...(input.entityTxs && { entityTxs: [...input.entityTxs] }),
        ...(input.hashPrecommits && { hashPrecommits: new Map(Array.from(input.hashPrecommits.entries()).map(([k, v]) => [k, [...v]])) }),
        ...(input.proposedFrame && { proposedFrame: input.proposedFrame }),
      })),
    },
    runtimeOutputs: runtimeOutputs.map(output => ({
      entityId: output.entityId,
      signerId: output.signerId,
      ...(output.entityTxs && { entityTxs: [...output.entityTxs] }),
      ...(output.hashPrecommits && { hashPrecommits: new Map(Array.from(output.hashPrecommits.entries()).map(([k, v]) => [k, [...v]])) }),
      ...(output.proposedFrame && { proposedFrame: output.proposedFrame }),
    })),
    description: env.extra?.description || description,
    gossip: { profiles: gossipProfiles },
    logs: frameLogs,
    ...(env.frameDisplayMs && { displayMs: env.frameDisplayMs }),
    ...(env.extra?.subtitle && { subtitle: { ...env.extra.subtitle } }),
  };

  // Clear consumed extras
  delete env.frameDisplayMs;
  delete env.extra;

  envHistory.push(snapshot);

  // --- SNAPSHOT SIZE MONITORING ---
  const snapshotBuffer = encode(snapshot);
  const snapshotSize = snapshotBuffer.length;
  const sizeMB = (snapshotSize / 1024 / 1024).toFixed(2);

  // Alert if snapshot exceeds 1MB threshold
  if (snapshotSize > 1_000_000) {
    console.warn(`📦 LARGE SNAPSHOT: ${sizeMB}MB at height ${snapshot.height}`);
    console.warn(`   E-Replicas: ${snapshot.eReplicas.size}, J-Replicas: ${snapshot.jReplicas.length}`);

    // Log per-entity diagnostics
    for (const [key, replica] of snapshot.eReplicas) {
      const msgCount = replica.state.messages?.length || 0;
      const accountCount = replica.state.accounts?.size || 0;
      if (msgCount > 20 || accountCount > 10) {
        console.warn(`   ${key.slice(0,25)}...: ${msgCount} msgs, ${accountCount} accounts`);
      }
    }
  }

  // --- PERSISTENCE WITH BATCH OPERATIONS ---
  // Try to save, but gracefully handle IndexedDB unavailable (incognito mode, etc)
  try {
    const batch = db.batch();
    batch.put(Buffer.from(`snapshot:${snapshot.height}`), snapshotBuffer);
    batch.put(Buffer.from('latest_height'), Buffer.from(snapshot.height.toString()));
    batch.write();
  } catch (error) {
    // Silent fail - IndexedDB unavailable (incognito) or full - continue anyway
  }

  if (DEBUG) {
    console.log(`📸 Snapshot ${snapshot.height}: ${sizeMB}MB - "${description}" (total: ${envHistory.length})`);
    if (runtimeInput.runtimeTxs.length > 0) {
      console.log(`    🖥️  RuntimeTxs: ${runtimeInput.runtimeTxs.length}`);
      runtimeInput.runtimeTxs.forEach((tx, i) => {
        if (tx.type === 'importReplica') {
          console.log(
            `      ${i + 1}. ${tx.type} ${tx.entityId}:${tx.signerId} (${tx.data.isProposer ? 'proposer' : 'validator'})`,
          );
        } else if (tx.type === 'importJ') {
          console.log(
            `      ${i + 1}. ${tx.type} ${tx.data.name} (chain ${tx.data.chainId})`,
          );
        }
      });
    }
    if (runtimeInput.entityInputs.length > 0) {
      console.log(`    📨 EntityInputs: ${runtimeInput.entityInputs.length}`);
      runtimeInput.entityInputs.forEach((input, i) => {
        const parts = [];
        if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
        if (input.hashPrecommits?.size) parts.push(`${input.hashPrecommits.size} precommits`);
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
export function cloneAccountMachine(account: AccountMachine, forSnapshot: boolean = false): AccountMachine {
  // For snapshots, exclude clonedForValidation to avoid cycles
  if (forSnapshot) {
    const { clonedForValidation, ...accountWithoutCloned } = account as any;
    try {
      return structuredClone(accountWithoutCloned) as AccountMachine;
    } catch {
      return manualCloneAccountMachine(account, true);
    }
  }

  // Normal clone - preserve clonedForValidation for consensus
  try {
    const cloned = structuredClone(account);
    return cloned;
  } catch (error) {
    console.log(`⚠️ structuredClone failed, using manual clone`);
    return manualCloneAccountMachine(account, false);
  }
}

/**
 * Manual AccountMachine cloning
 */
function manualCloneAccountMachine(account: AccountMachine, skipClonedForValidation: boolean = false): AccountMachine {
  const result: AccountMachine = {
    leftEntity: account.leftEntity,
    rightEntity: account.rightEntity,
    status: account.status ?? 'active',
    mempool: [...account.mempool],
    currentFrame: {
      ...account.currentFrame,
      tokenIds: [...account.currentFrame.tokenIds],
      deltas: [...account.currentFrame.deltas],
    },
    deltas: new Map(Array.from(account.deltas.entries()).map(([key, delta]) => [key, { ...delta }])),
    locks: new Map(Array.from(account.locks.entries()).map(([key, lock]) => [key, { ...lock }])),
    swapOffers: new Map(Array.from(account.swapOffers.entries()).map(([key, offer]) => [key, { ...offer }])),
    globalCreditLimits: { ...account.globalCreditLimits },
    currentHeight: account.currentHeight,
    pendingSignatures: [...account.pendingSignatures],
    rollbackCount: account.rollbackCount,
    ...(account.lastRollbackFrameHash !== undefined && { lastRollbackFrameHash: account.lastRollbackFrameHash }),
    frameHistory: [...account.frameHistory], // Clone frame history array
    proofHeader: { ...account.proofHeader },
    proofBody: {
      ...account.proofBody,
      tokenIds: [...account.proofBody.tokenIds],
      deltas: [...account.proofBody.deltas],
    },
    disputeConfig: { ...account.disputeConfig }, // Dispute delay configuration
    leftJObservations: account.leftJObservations.map(obs => ({
      ...obs,
      events: Array.isArray(obs.events) ? [...obs.events] : [],
    })),
    rightJObservations: account.rightJObservations.map(obs => ({
      ...obs,
      events: Array.isArray(obs.events) ? [...obs.events] : [],
    })),
    jEventChain: account.jEventChain.map(entry => ({
      ...entry,
      events: Array.isArray(entry.events) ? [...entry.events] : [],
    })),
    lastFinalizedJHeight: account.lastFinalizedJHeight,
    onChainSettlementNonce: account.onChainSettlementNonce,
    pendingWithdrawals: new Map(account.pendingWithdrawals), // Phase 2: Clone withdrawal tracking
    requestedRebalance: new Map(account.requestedRebalance), // Phase 3: Clone rebalance hints
    requestedRebalanceFeeState: new Map(
      Array.from(account.requestedRebalanceFeeState || []).map(([tokenId, feeState]) => [
        tokenId,
        { ...feeState },
      ]),
    ),
    rebalancePolicy: new Map(account.rebalancePolicy || []),
    activeRebalanceQuote: account.activeRebalanceQuote ? { ...account.activeRebalanceQuote } : undefined,
    pendingRebalanceRequest: account.pendingRebalanceRequest ? { ...account.pendingRebalanceRequest } : undefined,
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

  if (account.clonedForValidation && !skipClonedForValidation) {
    result.clonedForValidation = manualCloneAccountMachine(account.clonedForValidation, true);
  }

  if (account.hankoSignature) {
    result.hankoSignature = account.hankoSignature;
  }
  if (account.currentDisputeProofHanko) {
    result.currentDisputeProofHanko = account.currentDisputeProofHanko;
  }
  if (account.currentDisputeProofNonce !== undefined) {
    result.currentDisputeProofNonce = account.currentDisputeProofNonce;
  }
  if (account.currentDisputeProofBodyHash) {
    result.currentDisputeProofBodyHash = account.currentDisputeProofBodyHash;
  }
  if (account.counterpartyDisputeProofHanko) {
    result.counterpartyDisputeProofHanko = account.counterpartyDisputeProofHanko;
  }
  if (account.counterpartyDisputeProofNonce !== undefined) {
    result.counterpartyDisputeProofNonce = account.counterpartyDisputeProofNonce;
  }
  if (account.counterpartyDisputeProofBodyHash) {
    result.counterpartyDisputeProofBodyHash = account.counterpartyDisputeProofBodyHash;
  }
  if (account.disputeProofNoncesByHash) {
    result.disputeProofNoncesByHash = { ...account.disputeProofNoncesByHash };
  }
  if (account.disputeProofBodiesByHash) {
    result.disputeProofBodiesByHash = { ...account.disputeProofBodiesByHash };
  }
  if (account.currentFrameHanko) {
    result.currentFrameHanko = account.currentFrameHanko;
  }
  if (account.counterpartyFrameHanko) {
    result.counterpartyFrameHanko = account.counterpartyFrameHanko;
  }
  if (account.activeDispute) {
    result.activeDispute = { ...account.activeDispute };
  }
  if (account.settlementWorkspace) {
    result.settlementWorkspace = {
      ...account.settlementWorkspace,
      ops: account.settlementWorkspace.ops.map(op => ({ ...op })),
      ...(account.settlementWorkspace.compiledDiffs && {
        compiledDiffs: account.settlementWorkspace.compiledDiffs.map(d => ({ ...d })),
      }),
      ...(account.settlementWorkspace.compiledForgiveTokenIds && {
        compiledForgiveTokenIds: [...account.settlementWorkspace.compiledForgiveTokenIds],
      }),
    };
  }
  if (account.pendingForward) {
    result.pendingForward = {
      ...account.pendingForward,
      route: [...account.pendingForward.route],
    };
  }

  // ABI-encoded proofBody for on-chain disputes
  if (account.abiProofBody) {
    result.abiProofBody = { ...account.abiProofBody };
  }

  // HTLC state (deep clone locks Map)
  result.locks = new Map(
    Array.from(account.locks.entries()).map(([lockId, lock]) => [
      lockId,
      { ...lock } // Clone lock object
    ])
  );

  // Swap state (deep clone swapOffers Map)
  result.swapOffers = new Map(
    Array.from((account.swapOffers || new Map()).entries()).map(([offerId, offer]) => [
      offerId,
      { ...offer } // Clone offer object
    ])
  );

  return result;
}
