/**
 * Env types - Runtime environment, snapshots, logging
 */

import type { Profile } from '../networking/gossip';
import type { JAdapter } from '../jadapter/types';
import type { EntityReplica, RoutedEntityInput, EntityInput } from './entity';
import type { JReplica, JInput } from './jurisdiction';

// ═══════════════════════════════════════════════════════════════
// STRUCTURED LOGGING
// ═══════════════════════════════════════════════════════════════

/** Log severity levels - ordered by priority */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Log categories for filtering */
export type LogCategory =
  | 'consensus'     // BFT entity consensus
  | 'account'       // Bilateral account consensus
  | 'jurisdiction'  // J-machine events
  | 'evm'           // Blockchain interactions
  | 'network'       // Routing/messaging
  | 'ui'            // UI events
  | 'system';       // System-level

/** Single log entry attached to a frame */
export interface FrameLogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  entityId?: string;              // Associated entity (if applicable)
  data?: Record<string, unknown>; // Structured data
}

// ═══════════════════════════════════════════════════════════════
// BROWSER VM STATE
// ═══════════════════════════════════════════════════════════════

export interface BrowserVMState {
  stateRoot: string;
  trieData: Array<[string, string]>;
  nonce: string;
  addresses: { depository: string; entityProvider: string };
}

// ═══════════════════════════════════════════════════════════════
// RUNTIME INPUT & TRANSACTIONS
// ═══════════════════════════════════════════════════════════════

export interface RuntimeInput {
  runtimeTxs: RuntimeTx[];
  entityInputs: RoutedEntityInput[];
  jInputs?: JInput[]; // J-layer inputs (queue to J-mempool)
  queuedAt?: number; // When first queued into runtime mempool (ms)
}

export type RuntimeTx =
  | {
      type: 'importReplica';
      entityId: string;
      signerId: string;
      data: {
        config: import('./core').ConsensusConfig;
        isProposer: boolean;
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
        rpcPolicy?: 'single' | 'failover' | { mode: 'quorum'; min: number };
        contracts?: {
          depository?: string;
          entityProvider?: string;
        };
        tokens?: Array<{      // Auto-deploy for BrowserVM only
          symbol: string;
          decimals: number;
          initialSupply?: bigint;
        }>;
      };
    };

// ═══════════════════════════════════════════════════════════════
// ENV (Top-level runtime state)
// ═══════════════════════════════════════════════════════════════

export interface Env {
  eReplicas: Map<string, EntityReplica>;  // Entity replicas (E-layer state machines)
  jReplicas: Map<string, JReplica>;       // Jurisdiction replicas (J-layer EVM state)
  height: number;
  timestamp: number;
  runtimeSeed?: string; // BrainVault seed backing this runtime (plaintext, dev mode)
  runtimeId?: string; // Runtime identity (usually signer1 address)
  dbNamespace?: string; // DB namespace for per-runtime persistence (defaults to runtimeId)
  // Runtime mempool (runtime-level queue; WAL-like)
  // NOTE: runtimeInput is deprecated alias - both point to same object
  runtimeMempool?: RuntimeInput;
  runtimeInput: RuntimeInput; // Deprecated alias of runtimeMempool
  runtimeConfig?: {
    minFrameDelayMs?: number; // Minimum delay between runtime frames
    loopIntervalMs?: number;  // Loop interval for runtime processing
  };
  runtimeState?: {
    loopActive?: boolean;
    stopLoop?: (() => void) | null;
    lastFrameAt?: number;
    p2p?: any;
    pendingP2PConfig?: any;
    lastP2PConfig?: any;
    envChangeCallbacks?: Set<(env: Env) => void>;
    db?: any;
    dbOpenPromise?: Promise<boolean> | null;
    logState?: {
      nextId: number;
      mirrorToConsole?: boolean;
    };
    cleanLogs?: string[];
    routeDeferState?: Map<string, {
      warnAt: number;
      gossipAt: number;
      deferredCount: number;
      escalated: boolean;
    }>;
    entityRuntimeHints?: Map<string, {
      runtimeId: string;
      seenAt: number;
    }>;
  };
  history: EnvSnapshot[]; // Time machine snapshots - single source of truth
  gossip: any; // Gossip layer for network profiles

  // Isolated BrowserVM instance per runtime (prevents cross-runtime state leakage)
  browserVM?: any; // BrowserVMProvider instance for this runtime (DEPRECATED: use jAdapter)
  browserVMState?: BrowserVMState; // Serialized BrowserVM state for time travel

  // Unified J-Machine adapter (preferred over browserVM or evms)
  // Use: const jAdapter = env.jAdapter ?? await createJAdapter({ mode: 'browservm', chainId: 1337 })
  jAdapter?: import('../jadapter/types').JAdapter;

  // EVM instances - DEPRECATED, use env.jAdapter or createJAdapter() from jadapter
  evms: Map<string, any>;

  // Active jurisdiction
  activeJurisdiction?: string; // Currently active J-replica name

  // Scenario mode: deterministic time control (scenarios set env.timestamp manually)
  scenarioMode?: boolean; // When true, runtime doesn't auto-update timestamp
  quietRuntimeLogs?: boolean; // When true, suppress noisy runtime console logs
  scenarioLogLevel?: 'debug' | 'info' | 'warn' | 'error'; // Scenario log verbosity
  strictScenario?: boolean; // When true, runtime asserts invariants per frame
  strictScenarioLabel?: string; // Optional label for strict scenario errors

  // Frame stepping: stop at specific frame for debugging
  stopAtFrame?: number; // When set, process() stops at this frame and dumps state

  // Frame display duration hint (for time-travel visualization)
  frameDisplayMs?: number; // How long to display this frame (default: 100ms)

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
  };

  // E→E message queue (always spans ticks - no same-tick cascade)
  pendingOutputs?: RoutedEntityInput[]; // Outputs queued for next tick
  skipPendingForward?: boolean;   // Temp flag to defer forwarding to next frame
  networkInbox?: RoutedEntityInput[];   // Inbound network messages queued for next tick
  pendingNetworkOutputs?: RoutedEntityInput[]; // Outputs waiting for runtimeId gossip before routing
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

// ═══════════════════════════════════════════════════════════════
// SNAPSHOTS
// ═══════════════════════════════════════════════════════════════

export interface EnvSnapshot {
  height: number;
  timestamp: number;
  runtimeSeed?: string;
  runtimeId?: string;
  dbNamespace?: string;
  eReplicas: Map<string, EntityReplica>;  // E-layer state
  jReplicas: JReplica[];                   // J-layer state (with stateRoot for time travel)
  browserVMState?: BrowserVMState;
  runtimeInput: RuntimeInput;
  runtimeOutputs: RoutedEntityInput[];
  description: string;
  gossip?: {
    profiles: Profile[];
  };
  // Interactive storytelling narrative
  title?: string; // Short headline (e.g., "Bank Run Begins")
  narrative?: string; // Detailed explanation of what's happening in this frame
  // Fed Chair educational subtitles (AHB demo)
  subtitle?: {
    title: string;           // Technical summary (e.g., "Reserve-to-Reserve Transfer")
    what?: string;           // What's happening (optional)
    why?: string;            // Why it matters (optional)
    tradfiParallel?: string; // Traditional finance equivalent (optional)
    keyMetrics?: string[];   // Bullet points of key numbers
  };
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
  // Display duration hint for time-travel visualization (default: 100ms)
  displayMs?: number;
}

// RuntimeSnapshot is used by xln-api.ts for external consumers
export interface RuntimeSnapshot {
  height: number;
  entities: Record<string, import('./entity').EntityState>;
  gossip: {
    profiles: Record<string, Profile>;
  };
}
