import type { OrderbookExtState } from './orderbook';
import type { SwapKey } from './swap-keys';
import type { Level } from 'level';
import type { RuntimeP2P } from './networking/p2p';
import type { CrossJurisdictionBookAdmission, CrossJurisdictionSwapRoute } from './types/cross-jurisdiction';
import type { DebtEntry } from './types/debt';
import type {
  JBlockFinalized,
  JBlockObservation,
} from './types/jurisdiction-events';
import type { HankoString } from './types/hanko';
import type {
  AccountInput,
  AccountMachine,
  AccountTx,
  HtlcNoteKey,
  HtlcRoute,
  RuntimeFrameDbRecord,
  RuntimeOverlayRecord,
} from './types/account';
import type { HubRebalanceConfig } from './types/rebalance';
import type { EntityTx } from './types/entity-tx';
import type { FrameLogEntry, LogCategory } from './types/logging';
import type { JReplica, JTx } from './types/jurisdiction-runtime';
export type {
  CrossJurisdictionBookAdmission,
  CrossJurisdictionBookAdmissionReceipt,
  CrossJurisdictionBookLeg,
  CrossJurisdictionBookStatus,
  CrossJurisdictionPendingFill,
  CrossJurisdictionPullBinding,
  CrossJurisdictionPullLeg,
  CrossJurisdictionSwapLeg,
  CrossJurisdictionSwapRoute,
  CrossJurisdictionSwapStatus,
} from './types/cross-jurisdiction';
export type {
  DebtEntry,
  DebtEventType,
  DebtStatus,
  DebtUpdate,
} from './types/debt';
export type {
  DisputeFinalizationEvidence,
  JBlockFinalized,
  JBlockObservation,
  JurisdictionEvent,
  JurisdictionEventData,
} from './types/jurisdiction-events';
export type {
  FrameLogEntry,
  LogCategory,
  LogLevel,
} from './types/logging';
export type { JReplica, JTx } from './types/jurisdiction-runtime';
export type {
  HankoBytes,
  HankoClaim,
  HankoContext,
  HankoMergeResult,
  HankoString,
  HankoVerificationResult,
} from './types/hanko';
export type {
  AccountDelta,
  AccountEvent,
  AccountFrame,
  AccountInput,
  AccountMachine,
  AccountSettleAction,
  AccountSnapshot,
  AccountStatus,
  AccountTx,
  AssetBalance,
  CrossJurisdictionSecretRelay,
  Delta,
  DerivedDelta,
  HtlcLock,
  HtlcNoteKey,
  HtlcRoute,
  PullCommitment,
  RuntimeFrameDbRecord,
  RuntimeOverlayRecord,
  SettlementDiff,
  SettlementOp,
  SettlementWorkspace,
  SwapOffer,
  SwapOrderHistoryEntry,
  SwapOrderResolveHistoryEntry,
} from './types/account';
export {
  DEFAULT_HARD_LIMIT,
  DEFAULT_MAX_FEE,
  DEFAULT_SOFT_LIMIT,
  QUOTE_EXPIRY_MS,
  REFERENCE_TOKEN_ID,
} from './types/rebalance';
export type {
  HubRebalanceConfig,
  RebalancePolicy,
  RebalanceQuote,
  RebalanceRequestFeeState,
} from './types/rebalance';

/**
 * Shared XLN wire/state type barrel.
 *
 * Keep new domain-specific types under runtime/types/* and re-export them here
 * only when older call sites still import from ./types. The runtime architecture
 * narrative lives in docs/architecture/runtime-reaj.md.
 */

import type { GossipLayer, Profile } from './networking/gossip';
import type { CompletedBatch, JBatchState } from './j-batch';
import type { CrontabState } from './crontab-types';

export type { Profile } from './networking/gossip';

export type RuntimeP2PConfigLike = {
  relayUrls?: string[];
  wsUrl?: string | null;
  seedRuntimeIds?: string[];
  runtimeId?: string;
  signerId?: string;
  advertiseEntityIds?: string[];
  isHub?: boolean;
  gossipPollMs?: number;
};

export type RuntimeP2PSurface = {
  close(): void;
  connect(): void;
  isConnected(): boolean;
  matchesIdentity(runtimeId: string, signerId?: string): boolean;
  updateConfig(config: RuntimeP2PConfigLike): void;
  refreshGossip(mode?: unknown): void;
  ensureProfiles(entityIds: string[]): Promise<boolean>;
  sendDebugEvent(payload: unknown): boolean;
  syncProfiles(): Promise<boolean>;
  announceProfilesForEntities(entityIds: string[], reason?: string): void;
  announceProfilesForEntitiesNow(entityIds: string[], reason?: string): Promise<void>;
};

export interface JurisdictionConfig {
  address: string;
  name: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  chainId?: number;
  blockTimeMs?: number;
  // Optional per-jurisdiction onboarding defaults (USD whole units).
  rebalancePolicyUsd?: {
    r2cRequestSoftLimit: number;
    hardLimit: number;
    maxFee: number;
  };
}

export interface ConsensusConfig {
  mode: 'proposer-based' | 'gossip-based';
  threshold: bigint;
  validators: string[];
  shares: { [validatorId: string]: bigint };
  jurisdiction?: JurisdictionConfig;
}

export interface RuntimeInput {
  runtimeTxs: RuntimeTx[];
  entityInputs: EntityInput[];
  jInputs?: JInput[]; // J-layer inputs (queue to J-mempool)
  timestamp?: number | undefined; // External ingress timestamp seed (ms) for this runtime input batch
  queuedAt?: number | undefined; // When first queued into runtime mempool (ms)
}

/** J-layer input - queues JTx to jurisdiction mempool */
export interface JInput {
  jurisdictionName: string; // Which J-machine to queue to
  jTxs: JTx[]; // Transactions to queue
}

export type RuntimeTx =
  | {
      type: 'importReplica';
      entityId: string;
      signerId: string;
      data: {
        config: ConsensusConfig;
        isProposer: boolean;
        profileName?: string;
        position?: { x: number; y: number; z: number; jurisdiction?: string; xlnomy?: string };
      };
    }
  | {
      type: 'importJ';
      data: {
        name: string;           // Unique J-machine name (key in jReplicas Map)
        chainId: number;        // 1=ETH, 8453=Base, 1001+=BrowserVM
        ticker: string;         // "ETH", "MATIC", "SIM"
        rpcs: string[];         // [] = BrowserVM, [...urls] = RPC
        blockTimeMs?: number;   // Expected settlement-chain block time for wall-clock safety windows
        rpcPolicy?: 'single' | 'failover' | { mode: 'quorum'; min: number };
        contracts?: {
          depository?: string;
          entityProvider?: string;
          account?: string;
          deltaTransformer?: string;
        };
        tokens?: Array<{      // Auto-deploy for BrowserVM only
          symbol: string;
          decimals: number;
          initialSupply?: bigint;
        }>;
      };
    };

export interface EntityInput {
  entityId: string;
  /**
   * Exact local signer/replica that must process this input.
   *
   * Do not "resolve later" from entityId alone. Entity ids can have imported
   * read-only replicas, sibling jurisdiction replicas, or several validators.
   * Late proposer guessing previously let a proposal be applied to whichever
   * local replica looked convenient after routing. In financial state machines
   * the route is part of the command: entity + signer +, for network delivery,
   * runtime.
   */
  signerId: string;
  runtimeId?: string;
  from?: string;
  entityTxs?: EntityTx[];
  proposedFrame?: ProposedEntityFrame;

  // HANKO PRECOMMITS: signerId -> array of EOA sigs (one per proposedFrame.hashesToSign[])
  // Validators sign ALL hashes, proposer collects and merges into hankos after threshold
  hashPrecommits?: Map<string, string[]>;
}

/**
 * Transport envelope for REA-bound entity inputs.
 *
 * signerId is mandatory once an input enters runtime queues/outbox/network. The
 * older "entityId only, resolve later" shape can silently route to a stale
 * read-only replica or the wrong validator; raw EntityInput is the only place
 * where shorthand is allowed.
 */
export interface RoutedEntityInput extends EntityInput {
  signerId: string;
  runtimeId?: string;
}

/**
 * Network-deliverable entity input.
 * By the time an input leaves the local runtime, target runtime resolution must
 * already be complete and runtimeId becomes mandatory.
 */
export interface DeliverableEntityInput extends RoutedEntityInput {
  runtimeId: string;
}

/** Entity output - can include both E→E messages AND J-layer outputs */
export interface EntityOutput {
  entityInputs: RoutedEntityInput[];  // E→E messages
  jInputs: JInput[];             // E→J messages (batches to queue)
}

export interface Proposal {
  id: string; // hash of the proposal
  proposer: string;
  action: ProposalAction;
  // Votes: signerId → vote (string for simple votes, object for commented votes)
  // Future: Create VoteData interface for type-safe vote objects
  votes: Map<string, 'yes' | 'no' | 'abstain' | { choice: 'yes' | 'no' | 'abstain'; comment: string }>;
  status: 'pending' | 'executed' | 'rejected';
  created: number; // entity timestamp when proposal was created (deterministic)
}

export interface ProposalAction {
  type: 'collective_message';
  data: {
    message: string;
  };
}

export interface VoteData {
  proposalId: string;
  voter: string;
  choice: 'yes' | 'no' | 'abstain';
  comment?: string;
}

export interface AccountTxInput {
  fromEntityId: string;
  toEntityId: string;
  accountTx: AccountTx; // The actual account transaction to process
  metadata?: {
    purpose?: string;
    description?: string;
  };
}

export type { EntityTx } from './types/entity-tx';

export interface EntitySwapPair {
  baseTokenId: number;
  quoteTokenId: number;
  pairId: string; // canonical sorted token key used by orderbook books map
}

export interface PendingCrossJurisdictionFillAck {
  accountId: string;
  tx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;
  storedAt: number;
  reason?: string;
}

/**
 * Liveness sync - empty block observation to prove chain is alive.
 * Required every JBLOCK_LIVENESS_INTERVAL blocks even if no events.
 */
export const JBLOCK_LIVENESS_INTERVAL = 100;

export interface EntityState {
  entityId: string; // The entity ID this state belongs to
  height: number;
  timestamp: number;
  nonces: Map<string, number>;
  messages: string[];
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;
  prevFrameHash?: string; // Chain linkage for BFT consensus (keccak256 of previous frame)

  // 💰 Financial state
  // Financial invariant: entity reserves are always keyed by numeric tokenId.
  // Never persist or pass string token keys through live state.
  reserves: Map<number, bigint>; // tokenId -> amount only, metadata from TOKEN_REGISTRY
  accounts: Map<string, AccountMachine>; // canonicalKey "left:right" -> account state
  // Account frame scheduling (accounts blocked by pendingFrame, retried on next ACK)
  deferredAccountProposals?: Map<string, true>;
  // 🔭 J-machine tracking (JBlock consensus)
  lastFinalizedJHeight: number;           // Last finalized J-block height
  jBlockObservations: JBlockObservation[]; // Pending observations from signers
  jBlockChain: JBlockFinalized[];          // Finalized J-blocks (prunable)

  // 🔗 Account machine integration
  accountInputQueue?: AccountInput[]; // Queue of settlement events to be processed by a-machine

  // ⏰ Declarative entity-local schedule. Persisted as pure data and rebound to handlers at runtime.
  crontabState?: CrontabState;

  // 📦 J-Batch system - accumulates operations for on-chain submission (typed in j-batch.ts)
  jBatchState?: JBatchState;
  batchHistory?: CompletedBatch[]; // Last completed batch records for UI + replay diagnostics


  // 🔐 Deterministic entity-scoped X25519 keys for HTLC envelope encryption.
  // These are derived exactly once at entity creation/import and are required
  // for every locally-owned entity. Missing keys are a hard invariant failure.
  entityEncPubKey: string;
  entityEncPrivKey: string;

  // Public entity-owned profile fields.
  // These are part of consensus state and are the source of truth for gossip.
  profile: {
    name: string;
    isHub: boolean;
    avatar: string;
    bio: string;
    website: string;
  };

  // 🔒 HTLC Routing - Multi-hop payment tracking (like 2024 hashlockMap)
  htlcRoutes: Map<string, HtlcRoute>; // hashlock → routing context
  htlcFeesEarned: bigint; // Running total of HTLC routing fees collected
  htlcNotes?: Map<HtlcNoteKey, string>; // local UI notes; recipient note comes from final encrypted envelope only

  // 💳 Debt ledger — mirrored on both debtor and creditor sides from canonical j-events.
  outDebtsByToken?: Map<number, Map<string, DebtEntry>>;
  inDebtsByToken?: Map<number, Map<string, DebtEntry>>;

  // 📊 Orderbook Extension - Hub matching engine (typed in orderbook/types.ts)
  orderbookExt?: OrderbookExtState;

  lockBook: Map<string, LockBookEntry>;  // lockId → entry

  // 💱 Swap market config
  // Kept in entity state so UI and runtime use one source of truth.
  swapTradingPairs?: EntitySwapPair[];

  // 📈 Pending swap fill ratios (orderbook → dispute arguments)
  pendingSwapFillRatios?: Map<SwapKey, number>; // key = "accountId:offerId"
  // Cross-jurisdiction swap routes are duplicated into sibling entities so
  // target-side dispute salvage does not depend on relay/profile gossip.
  crossJurisdictionSwaps?: Map<string, CrossJurisdictionSwapRoute>;
  // Fill notices can outrun the local account frame that materializes the
  // source-side offer. Keep the ack durably in entity state until the account
  // offer is visible instead of throwing every runtime loop.
  pendingCrossJurisdictionFillAcks?: Map<string, PendingCrossJurisdictionFillAck>;
  // Cross-jurisdiction book admission is local hub gate state. A cross order
  // can enter the shared matcher only after source and target account frames
  // both committed their pull_lock receipts.
  crossJurisdictionBookAdmissions?: Map<string, CrossJurisdictionBookAdmission>;

  // 🔄 Rebalance Configuration - Hub-level matching strategy
  hubRebalanceConfig?: HubRebalanceConfig;
}

/** Derived open swap order entry for UI/debug projections */
export interface SwapBookEntry {
  offerId: string;
  accountId: string;        // counterparty entity ID where order lives
  giveTokenId: number;
  giveAmount: bigint;       // remaining amount
  wantTokenId: number;
  wantAmount: bigint;       // remaining want
  minFillRatio: number;
  createdHeight: number;
  priceTicks: bigint;
  crossJurisdiction?: CrossJurisdictionSwapRoute;
}

/** Aggregated HTLC lock entry at E-Machine level */
export interface LockBookEntry {
  lockId: string;
  accountId: string;        // counterparty entity ID where lock lives
  tokenId: number;
  amount: bigint;
  hashlock: string;
  timelock: bigint;
  direction: 'outgoing' | 'incoming';
  createdAt: bigint;
}

/** Hash type for entity-level signing */
export type HashType = 'entityFrame' | 'accountFrame' | 'dispute' | 'settlement' | 'profile' | 'jBatch';

/** Hash with type info for entity-level signing */
export interface HashToSign {
  hash: string;
  type: HashType;
  context: string;  // e.g., "account:0002:frame:1" or "account:0002:dispute"
}

export interface ProposedEntityFrame {
  height: number;
  txs: EntityTx[];
  hash: string;
  newState: EntityState;

  // DETERMINISTIC OUTPUTS: Stored at proposal time, used at commit time
  // CRITICAL: Cannot re-apply frame at commit because proposal.newState already
  // has mutations applied (e.g., openAccount creates account). Store once,
  // attach hankos at commit.
  outputs?: EntityInput[];
  jOutputs?: JInput[];

  // HANKO SYSTEM:
  // 1. During frame creation: proposer collects hashes that need signing
  hashesToSign?: HashToSign[];  // Entity frame hash + account-level hashes with types

  // 2. During precommit: validators send EOA signatures (one per hash)
  // signerId -> array of EOA signatures (indexes match hashesToSign[])
  collectedSigs?: Map<string, string[]>;

  // 3. After threshold: merged quorum hankos (one per hash, indexes match hashesToSign[])
  hankos?: HankoString[];
}

export interface EntityReplica {
  entityId: string;
  signerId: string;
  state: EntityState;
  mempool: EntityTx[];
  proposal?: ProposedEntityFrame;
  lockedFrame?: ProposedEntityFrame; // Frame this validator is locked/precommitted to
  // SECURITY: Validator's own computed state from applying proposer's txs
  // Used at commit time instead of proposer's newState to prevent state injection
  validatorComputedState?: EntityState;
  isProposer: boolean;
  // Position is RELATIVE to j-machine (jurisdiction)
  // Frontend calculates: worldPos = jMachine.position + relativePosition
  position?: {
    x: number;      // Relative X offset from j-machine center
    y: number;      // Relative Y offset from j-machine center
    z: number;      // Relative Z offset from j-machine center
    jurisdiction?: string; // Which j-machine this entity belongs to (defaults to activeJurisdiction)
    xlnomy?: string; // DEPRECATED: Use jurisdiction instead
  };

  // HANKO WITNESS STORAGE (NOT part of state hash - stored alongside, not inside)
  // Persists finalized hankos for on-chain disputes, settlements, batch submissions
  hankoWitness?: Map<string, {
    hanko: HankoString;
    type: 'accountFrame' | 'dispute' | 'profile' | 'settlement' | 'jBatch';
    entityHeight: number;  // Height when created
    createdAt: number;     // Timestamp
  }>;
}

export interface BrowserVMState {
  stateRoot: string;
  trieData: Array<[string, string]>;
  nonce: string;
  addresses: { depository: string; entityProvider: string };
}

export interface Env {
  eReplicas: Map<string, EntityReplica>;  // Entity replicas (E-layer state machines)
  jReplicas: Map<string, JReplica>;       // Jurisdiction replicas (J-layer EVM state)
  height: number;
  timestamp: number;
  runtimeSeed?: string | undefined; // BrainVault seed backing this runtime (plaintext, dev mode)
  runtimeId?: string | undefined; // Runtime identity (usually signer1 address)
  lastProcessEnteredAt?: number; // Wall-clock timestamp of most recent process() entry
  dbNamespace?: string; // DB namespace for per-runtime persistence (defaults to runtimeId)
  // Runtime mempool (runtime-level queue; WAL-like). runtimeInput is the persisted frame input field.
  runtimeMempool?: RuntimeInput | undefined;
  runtimeInput: RuntimeInput;
  overlay?: RuntimeOverlayRecord[];
  runtimeConfig?: {
    minFrameDelayMs?: number; // Minimum delay between runtime frames
    loopIntervalMs?: number;  // Loop interval for runtime processing
    snapshotIntervalFrames?: number;
    advertiseProfileMirrors?: boolean; // Opt-in only; otherwise profiles do not correlate sibling entities.
    storage?: {
      enabled?: boolean;
      snapshotPeriodFrames?: number;
      retainSnapshots?: number;
      epochMaxBytes?: number;
      frameDbMaxBytes?: number;
      frameDbRetainFrames?: number;
      materializePeriodFrames?: number;
      canonicalHashPeriodFrames?: number;
      accountMerkleRadix?: 16 | 256;
    };
  } | undefined;
	  runtimeState?: {
	    loopActive?: boolean;
	    halted?: boolean;
	    fatalDebugPayload?: {
	      message: string;
	      stack?: string;
	      height?: number;
	      timestamp?: number;
	    };
	    loopPromise?: Promise<void> | null;
    stopLoop?: (() => void) | null;
    wakeLoop?: (() => void) | null;
    wakeRequested?: boolean;
    clockPrimed?: boolean;
    persistencePaused?: boolean;
    lastFrameAt?: number; // Wall-clock timestamp of the most recent processed runtime cycle
    processingPromise?: Promise<void> | null;
    p2p?: RuntimeP2P | null | undefined;
    pendingP2PConfig?: RuntimeP2PConfigLike | null;
    lastP2PConfig?: RuntimeP2PConfigLike | null;
    envChangeCallbacks?: Set<(env: Env) => void>;
    db?: Level<Buffer, Buffer> | null | undefined;
    dbOpenPromise?: Promise<boolean> | null | undefined;
    storageDb?: Level<Buffer, Buffer> | null | undefined;
    storageDbOpenPromise?: Promise<boolean> | null | undefined;
    storagePreviousDb?: Level<Buffer, Buffer> | null | undefined;
    storagePreviousDbOpenPromise?: Promise<boolean> | null | undefined;
    storageVerifiedCurrentHeight?: number;
    storageVerifiedPreviousHeight?: number;
    storageVerifiedHistoryHeight?: number;
    storageEpochRotatePromise?: Promise<void> | null;
    storageEntityHashDocs?: unknown;
    currentStorageOverlayMarks?: RuntimeOverlayRecord[];
    frameDb?: Level<Buffer, Buffer> | null | undefined;
    frameDbOpenPromise?: Promise<boolean> | null | undefined;
    infraDb?: Level<Buffer, Buffer> | null | undefined;
    infraDbOpenPromise?: Promise<boolean> | null | undefined;
    logState?: {
      nextId: number;
      mirrorToConsole?: boolean;
    };
    pendingAuditEvents?: Array<Record<string, unknown>>;
    quarantinedRuntimeInputs?: Array<{
      id: string;
      height: number;
      timestamp: number;
      reason: string;
      message: string;
      action: 'halted';
      counts: {
        runtimeTxs: number;
        entityInputs: number;
        jInputs: number;
      };
      entityInputs: Array<{
        entityId: string;
        signerId: string;
        txTypes: string[];
      }>;
      runtimeTxTypes: string[];
      jInputs: Array<{
        jurisdictionName: string;
        jTxCount: number;
      }>;
    }>;
    pendingFrameDbRecords?: RuntimeFrameDbRecord[];
    cleanLogs?: string[];
    routeDeferState?: Map<string, {
      warnAt: number;
      gossipAt: number;
      deferredCount: number;
      escalated: boolean;
    }>;
    deferredNetworkMeta?: Map<string, {
      attempts: number;
      nextRetryAt: number;
    }>;
    entityRuntimeHints?: Map<string, {
      runtimeId: string;
      seenAt: number;
    }>;
    watcherDedupCounter?: import('./jadapter/watcher').EventBatchCounter;
    directEntityInputDispatch?: ((targetRuntimeId: string, input: DeliverableEntityInput, ingressTimestamp?: number) => boolean) | null;
    /**
     * True only when the target runtime is already attached to this same
     * server/relay process with a cached encryption key. This is local socket
     * delivery capability, not permission to queue arbitrary public relay hops.
     */
    canUseConnectedRelayFallback?: ((targetRuntimeId: string) => boolean) | null;
    /**
     * Optional post-commit backup barrier. If present, runtime holds remote
     * side effects until this callback confirms external recovery storage for
     * the just-committed state.
     */
    recoveryBackupBarrier?: ((
      env: Env,
      info: {
        height: number;
        remoteOutputCount: number;
        jInputCount: number;
      },
    ) => Promise<void>) | null;
    /**
     * J-side effects that were intentionally deferred after the frame was
     * committed because the recovery backup barrier did not complete yet.
     */
    pendingCommittedJOutbox?: JInput[];
  } | undefined;
  history: EnvSnapshot[]; // Time machine snapshots - single source of truth
  gossip: GossipLayer;

  // Isolated BrowserVM instance per runtime (prevents cross-runtime state leakage)
  browserVM?: import('./jadapter/types').BrowserVMProvider | null; // BrowserVMProvider instance for this runtime (DEPRECATED: use jAdapter)
  browserVMState?: BrowserVMState; // Serialized BrowserVM state for time travel

  // Unified J-Machine adapter (preferred over browserVM or evms)
  // Use: const jAdapter = env.jAdapter ?? await createJAdapter({ mode: 'browservm', chainId: 31337 })
  jAdapter?: import('./jadapter/types').JAdapter;

  // EVM instances - DEPRECATED, use env.jAdapter or createJAdapter() from jadapter
  evms: Map<string, unknown>;

  // Active jurisdiction
  activeJurisdiction?: string | undefined; // Currently active J-replica name

  // Scenario mode: deterministic time control (scenarios set env.timestamp manually)
  scenarioMode?: boolean; // When true, runtime doesn't auto-update timestamp
  quietRuntimeLogs?: boolean; // When true, suppress noisy runtime console logs
  debugJWatcherBatches?: boolean; // Enables verbose J watcher batch routing diagnostics
  scenarioLogLevel?: 'debug' | 'info' | 'warn' | 'error'; // Scenario log verbosity
  strictScenario?: boolean; // When true, runtime asserts invariants per frame
  strictScenarioLabel?: string; // Optional label for strict scenario errors

  // Frame stepping: stop at specific frame for debugging
  stopAtFrame?: number | undefined; // When set, process() stops at this frame and dumps state

  // Frame display duration hint (for time-travel visualization)
  frameDisplayMs?: number | undefined; // How long to display this frame (default: 100ms)

  // Snapshot extras for scenarios (set before process(), consumed by captureSnapshot)
  extra?: {
    subtitle?: {
      title: string;
      what?: string;
      why?: string;
      tradfiParallel?: string;
      keyMetrics?: string[];
    };
    expectedSolvency?: bigint;
    description?: string;
  } | undefined;

  // E→E message queue (always spans ticks - no same-tick cascade)
  pendingOutputs?: RoutedEntityInput[]; // Outputs queued for next tick
  skipPendingForward?: boolean;   // Temp flag to defer forwarding to next frame
  networkInbox?: RoutedEntityInput[];   // Inbound network messages queued for next tick
  pendingNetworkOutputs?: RoutedEntityInput[]; // Legacy persisted queue; live runtime treats non-empty values as fatal.
  lockRuntimeSeed?: boolean;      // Prevent runtime seed updates during scenarios

  // Frame-scoped structured logs (captured into snapshot, then reset)
  frameLogs: FrameLogEntry[];

  // Event emission methods (EVM-style - like Ethereum block logs)
  log: (message: string) => void;
  info: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => void;
  warn: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => void;
  error: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => void;
  emit: (eventName: string, data: Record<string, unknown>) => void; // Generic event emission
}

export interface RuntimeSnapshot {
  height: number;
  entities: Record<string, EntityState>;
  gossip: {
    profiles: Record<string, Profile>;
  };
}

export interface EnvSnapshot {
  height: number;
  timestamp: number;
  runtimeSeed?: string;
  runtimeId?: string;
  dbNamespace?: string;
  eReplicas: Map<string, EntityReplica>;  // E-layer state
  jReplicas: Map<string, JReplica>;        // J-layer state snapshot (same shape as live env)
  browserVMState?: BrowserVMState;
  runtimeInput: RuntimeInput;
  runtimeOutputs: RoutedEntityInput[];
  description: string;
  gossip?: {
    profiles: Profile[];
  };
  meta?: {
    title?: string; // Short headline (e.g., "Bank Run Begins")
    subtitle?: {
      title: string;           // Technical summary (e.g., "Reserve-to-Reserve Transfer")
      what?: string;           // What's happening (optional)
      why?: string;            // Why it matters (optional)
      tradfiParallel?: string; // Traditional finance equivalent (optional)
      keyMetrics?: string[];   // Bullet points of key numbers
    };
    displayMs?: number; // Display duration hint for time-travel visualization
  };
  // Interactive storytelling narrative
  narrative?: string; // Detailed explanation of what's happening in this frame
  // Cinematic view state for scenario playback
  viewState?: {
    camera?: 'orbital' | 'overview' | 'follow' | 'free';
    zoom?: number;
    focus?: string; // Entity ID to center on
    panel?: 'accounts' | 'transactions' | 'consensus' | 'network';
    speed?: number; // Playback speed multiplier
    position?: { x: number; y: number; z: number }; // Camera position
    rotation?: { x: number; y: number; z: number }; // Camera rotation
  };
  // Frame-specific structured logs
  logs?: FrameLogEntry[];
}

// Entity types - canonical definition in ids.ts
export { type EntityType } from './ids';

// Constants
export const ENC = 'hex' as const;

export type { EntityProfile, NameIndex, NameSearchResult, ProfileUpdateTx } from './types/profile';

export type {
  ConnectionRules,
  JurisdictionEVM,
  TopologyLayer,
  TopologyType,
  Xlnomy,
  XlnomySnapshot,
  XlnomyTopology,
} from './types/xlnomy';
