import type { OrderbookExtState } from '../orderbook';
import type { CrossJurisdictionBookAdmission, CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { DebtEntry } from '../types/finance/debt';
import type { JBlockFinalized, JHistoryFinality, JPrefixAttestation, JPrefixCertificate, JPrefixRound, ValidatorJHistory } from '../types/jurisdiction-events';
import type { HankoString } from '../types/hanko';
import type { AccountFrame, AccountOutput, AccountReplica, AccountTx, AccountHistoryRecord, HtlcNoteKey, HtlcRoute, RuntimeOverlayRecord } from '../types/account';
import type { HubRebalanceConfig } from '../types/finance/rebalance';
import type { LendingState } from '../types/finance/lending';
import type {
  ConsensusOutputOrigin,
  EntityCommandNonceState,
  EntityTx,
  PendingSettlementContinuation,
} from '../types/entity-tx';
import type { JAdapterFailure } from '../types/jurisdiction-runtime';
import type { RuntimeFailureSignal } from '../protocol/errors/failure-taxonomy';
import type { CertifiedBoardRegistryState } from '../types/entity-board-registry';
import type { ConsumptionAccumulatorState, ConsumptionNodeEntry } from './consumption/consumption-accumulator-types';
import type { AccountJClaimNodeChanges } from '../types/finance/account-j-claims';
import type { EntityProviderActionState, EntityProviderActionSubmitState } from '../types/entity-provider-actions';
import type { JBatchState } from '../jurisdiction/machine/batch';
import type { JInput } from '../jurisdiction/machine/input';
import type { RuntimeSecurityIncidentIdentity } from '../protocol/errors/security-incident';
import type { JurisdictionConfig } from '../protocol/config/jurisdiction-config';
import type { CrontabState } from './scheduler/types';
import type { EntityInfraContext } from '../types/entity/infra-context';
export type { JurisdictionConfig } from '../protocol/config/jurisdiction-config';

export interface ConsensusConfig {
  mode: 'proposer-based' | 'gossip-based';
  threshold: bigint;
  validators: string[];
  shares: { [validatorId: string]: bigint };
  jurisdiction?: JurisdictionConfig;
}


export interface EntityLeaderState {
  activeValidatorId: string;
  view: number;
  changedAtHeight: number;
}


export interface EntityLeaderTimeoutVoteBody {
  entityId: string;
  targetHeight: number;
  previousFrameHash: string;
  fromView: number;
  toView: number;
  previousLeaderId: string;
  nextLeaderId: string;
}


export interface EntityLeaderTimeoutVote extends EntityLeaderTimeoutVoteBody {
  voterId: string;
  signature: string;
  /** Exact locally locked frame, including every precommit observed so far. */
  preparedFrame?: EntityFrame;
}


export interface EntityLeaderCertificate extends EntityLeaderTimeoutVoteBody {
  /** Compact signatures for certificates whose votes carry no lock evidence. */
  votes: Map<string, string>;
  /** Individual signed votes when prepared evidence differs per voter. */
  preparedVotes?: Map<string, EntityLeaderTimeoutVote>;
  /** Set only after exact prepared evidence reaches the Entity threshold. */
  preparedFrameHash?: string;
}


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
  /** Validator-derived source identity, removed from the routed envelope. */
  certifiedOutputIdentity?: {
    lane: ConsensusOutputOrigin['lane'];
    sequence: bigint;
    semanticHash: string;
  };
  /** Transient pre-commit marker; removed when wrapped as siblingOutput. */
  localRuntimeProtocol?: 'cross-j';
  entityTxs?: EntityTx[];
  proposedFrame?: EntityFrame;

  // HANKO PRECOMMITS: signerId -> array of EOA sigs (one per proposedFrame.hashesToSign[])
  // Validators sign ALL hashes, proposer collects and merges into hankos after threshold
  hashPrecommitFrame?: {
    height: number;
    frameHash: string;
  };
  hashPrecommits?: Map<string, string[]>;
  /** Dedicated reliable lane for validator-local signed J-prefix evidence. */
  jPrefixAttestations?: Map<string, JPrefixAttestation>;
  leaderTimeoutVote?: EntityLeaderTimeoutVote;
}


/**
 * A committed Entity may address an application message to another Entity
 * without choosing that Entity's validator replica.
 *
 * The destination Entity and payload are consensus bytes. The validator and
 * Runtime route are local delivery decisions made by the parent Runtime before
 * its frame is committed. Keeping those fields unrepresentable here prevents
 * validator topology from leaking into Entity consensus.
 */
type EntityAddressedOutput = Omit<
  EntityInput,
  'signerId' | 'runtimeId' | 'from'
> & {
  signerId?: never;
  runtimeId?: never;
  from?: never;
};


/**
 * Entity consensus emits either an exact validator-to-validator protocol
 * message or an application message addressed only to its destination Entity.
 */
export type EntityOutput = EntityInput | EntityAddressedOutput;


export interface Proposal {
  id: string; // hash of the proposal
  proposer: string;
  /** Board hash in the exact authority epoch that created and may finish this proposal. */
  boardHash: string;
  /** Exact certified activation epoch; prevents A0 proposals reviving after A0 → B1 → A2. */
  boardEpoch: number;
  action: ProposalAction;
  /** Full canonical commitment to action.data, independently recomputed. */
  actionHash: string;
  // Votes: signerId → vote (string for simple votes, object for commented votes)
  votes: Map<string, 'yes' | 'no' | 'abstain' | { choice: 'yes' | 'no' | 'abstain'; comment: string }>;
  status: 'pending' | 'executed' | 'rejected';
  created: number; // entity timestamp when proposal was created (deterministic)
}


export type ProposalAction =
  | {
      type: 'collective_message';
      data: { message: string };
    }
  | {
      type: 'entity_transaction';
      data: {
        version: 1;
        actionHash: string;
        txs: EntityTx[];
      };
    };


export interface EntitySwapPair {
  baseTokenId: number;
  quoteTokenId: number;
  pairId: string; // canonical sorted token key used by orderbook books map
}


interface PendingCrossJurisdictionFillAck {
  accountId: string;
  tx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;
  storedAt: number;
  ttlExpiredAt?: number;
  reason?: string;
}


type ExternalWalletBalanceRecord = {
  tokenAddress: string;
  tokenId?: number;
  balance: bigint;
  jHeight: number;
  transactionHash?: string;
};


type ExternalWalletAllowanceRecord = {
  tokenAddress: string;
  spender: string;
  allowance: bigint;
  jHeight: number;
  transactionHash?: string;
};


export type ExternalWalletState = {
  balances: Map<string, Map<string, ExternalWalletBalanceRecord>>;
  allowances: Map<string, Map<string, ExternalWalletAllowanceRecord>>;
};


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
  /** Bounded exact-once namespace for independently signed board-member commands. */
  entityCommandNonces?: EntityCommandNonceState;
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;
  prevFrameHash?: string; // Chain linkage for BFT consensus (keccak256 of previous frame)
  leaderState?: EntityLeaderState;

  // 💰 Financial state
  // Financial invariant: entity reserves are always keyed by numeric tokenId.
  // Never persist or pass string token keys through live state.
  reserves: Map<number, bigint>; // tokenId -> amount only, metadata from TOKEN_REGISTRY
  // The Entity commits the deterministic Account replica envelope; the nested
  // Account frame commits only AccountState through accountStateRoot.
  accounts: Map<string, AccountReplica>; // canonicalKey "left:right" -> replica
  // External EOA balances/allowances observed through finalized J snapshots.
  // Keyed by owner EOA, then token/spender keys, so multi-validator entities
  // keep one deterministic map instead of signer-local side-channel state.
  externalWallet?: ExternalWalletState;
  // Exact settlement approvals waiting for Account mempool + ACK quiescence.
  // Bounded one-per-account; value is the governance-approved workspace hash.
  deferredAccountProposals?: Map<string, string>;
  // Exact Entity-owned continuations waiting for their bilateral Account
  // workspace to collect both Hankos. The workspace hash prevents a same-height
  // collision from executing work authorized for a different settlement.
  settlementContinuations?: Map<string, PendingSettlementContinuation>;
  // 🔭 J-machine tracking (JBlock consensus)
  lastFinalizedJHeight: number;           // Last finalized J-block height
  // Bounded display/audit cache only. Finalized effects plus jHistoryFinality
  // are authoritative; deleting these bodies must not change consensus.
  jBlockChain: JBlockFinalized[];
  jHistoryFinality?: JHistoryFinality;
  /** Entity-finalized active board authority for this exact jurisdiction stack. */
  certifiedBoardState?: CertifiedBoardRegistryState;

  // ⏰ Declarative entity-local schedule. Persisted as pure data and rebound to handlers at runtime.
  crontabState?: CrontabState;

  // 📦 J-Batch system - accumulates operations for on-chain submission (typed in j-batch.ts)
  jBatchState?: JBatchState;
  /** Bounded current EntityProvider nonce plus at most one committed action. */
  entityProviderActionState?: EntityProviderActionState;
  /** One Entity-wide X25519 public key. The private key is Runtime infrastructure only. */
  entityEncryptionPublicKey: string;

  // Public entity-owned profile fields.
  // These are part of consensus state and are the source of truth for gossip.
  profile: {
    name: string;
    isHub: boolean;
    entityKind?: import('./profile').ProfileEntityKind;
    sectors?: import('./profile').ProfileEntitySector[];
    avatar: string;
    bio: string;
    website: string;
  };

  // 🔒 HTLC Routing - Multi-hop payment tracking (like 2024 hashlockMap)
  htlcRoutes: Map<string, HtlcRoute>; // hashlock → routing context
  htlcFeesEarned: bigint; // Running total of HTLC routing fees collected

  // 💳 Debt ledger — mirrored on both debtor and creditor sides from canonical j-events.
  outDebtsByToken?: Map<number, Map<string, DebtEntry>>;
  inDebtsByToken?: Map<number, Map<string, DebtEntry>>;

  // 📊 Orderbook Extension - Hub matching engine (typed in orderbook/types.ts)
  orderbookExt?: OrderbookExtState;

  lockBook: Map<string, LockBookEntry>;  // lockId → entry

  // 💱 Swap market config
  // Kept in entity state so UI and runtime use one source of truth.
  swapTradingPairs?: EntitySwapPair[];

  // Cross-jurisdiction swap routes are duplicated into sibling entities so
  // target-side dispute salvage does not depend on relay/profile gossip.
  crossJurisdictionSwaps?: Map<string, CrossJurisdictionSwapRoute>;
  // Exact one-shot user authorization. Both user sibling Entities record the
  // same immutable intent before either prepared Account leg is admissible.
  crossJurisdictionAuthorizations?: Map<string, CrossJurisdictionSwapRoute>;
  // Fill notices can outrun the local account frame that materializes the
  // source-side offer. Keep the ack durably in entity state until the account
  // offer is visible instead of throwing every runtime loop.
  pendingCrossJurisdictionFillAcks?: Map<string, PendingCrossJurisdictionFillAck>;
  // Cross-jurisdiction book admission is local hub gate state. A cross order
  // can enter the shared matcher only after source and target account frames
  // both committed their cross_pull_lock receipts.
  crossJurisdictionBookAdmissions?: Map<string, CrossJurisdictionBookAdmission>;

  // 🔄 Rebalance Configuration - Hub-level matching strategy
  hubRebalanceConfig?: HubRebalanceConfig;

  // 🏦 Hub lending pools and term loans. This is hub-local consensus state:
  // borrowers receive ordinary bilateral credit, while the hub records term,
  // rate, and maturity here.
  lending?: LendingState;

  /**
   * Exact-once certified-output commitment. The root is consensus authority;
   * content-addressed nodes are validator-local witnesses and never authority.
   */
  consumptionAccumulator?: ConsumptionAccumulatorState;
  /** Generic source-output lifetime frontier. Account-frame outputs use Account height instead. */
  certifiedOutputSequences?: Map<string, {
    lastSequence: bigint;
    lastSemanticHash: string;
  }>;
}


/** Derived open swap order entry for UI/debug projections */
export interface SwapBookEntry {
  offerId: string;
  accountId: string;        // counterparty entity ID where order lives
  giveTokenId: number;
  giveAmount: bigint;       // remaining amount
  wantTokenId: number;
  wantAmount: bigint;       // remaining want
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
export type HashType =
  | 'entityFrame'
  | 'entityOutput'
  | 'accountFrame'
  | 'dispute'
  | 'settlement'
  | 'profile'
  | 'jBatch'
  | 'entityProviderAction';


/** Hash with type info for entity-level signing */
export interface HashToSign {
  hash: string;
  type: HashType;
  context: string;  // e.g., "account:0002:frame:1" or "account:0002:dispute"
}


export interface EntityFrame {
  height: number;
  /** Exact predecessor committed by this frame hash. Never inferred from transport order. */
  parentFrameHash: string;
  /** Exact post-replay consensus root signed by every validator. */
  stateRoot: string;
  /** Signed compact post-state authority commitment for durable lineage verification. */
  authorityRoot: string;
  /** Proposer-chosen deterministic frame time; validators replay with this value. */
  timestamp: number;
  /** Exact proposer-observed public infrastructure used for deterministic replay. */
  entityContext: EntityInfraContext;
  txs: EntityTx[];
  /**
   * Deterministic activity produced while replaying `txs`.
   *
   * Events belong to the signed frame and durable history, never to the
   * ever-growing EntityState. This keeps replay auditable without making every
   * future state transition carry all past presentation data.
   */
  events: EntityFrameEvent[];
  hash: string;
  leader: {
    proposerSignerId: string;
    view: number;
    certificate?: EntityLeaderCertificate;
    /** View-change authorization to relay this exact already-prepared frame. */
    relayCertificate?: EntityLeaderCertificate;
  };

  /** Independent board authorization for the exact J prefix, when one is due. */
  jPrefixCertificate?: JPrefixCertificate;

  // HANKO SYSTEM:
  // 1. During frame creation: proposer collects hashes that need signing
  hashesToSign: HashToSign[];  // Entity frame hash + account-level hashes with types

  // 2. During precommit: validators send EOA signatures (one per hash)
  // signerId -> array of EOA signatures (indexes match hashesToSign[])
  collectedSigs?: Map<string, string[]>;

  // 3. After threshold: merged quorum hankos (one per hash, indexes match hashesToSign[])
  hankos?: HankoString[];
}


export type EntityFrameEvent =
  | {
      type: 'status';
      message: string;
    }
  | {
      type: 'text';
      /** Validator whose signed Entity command authored this text event. */
      validatorId: string;
      message: string;
    };


/**
 * Durable quorum certificate for one Entity state transition.
 *
 * The full frame carries one validator signature bundle variant, while
 * `postAuthority` exposes only the compact authority fields committed by the
 * signed `authorityRoot`. Storage validates and deterministically selects one
 * individually valid certificate variant for each immutable frame body.
 */
export interface EntityFrameAuthority {
  config: ConsensusConfig;
  leaderState: EntityLeaderState;
}


export interface CertifiedEntityFrameLink {
  frame: EntityFrame;
  postAuthority: EntityFrameAuthority;
}


/** Locally trusted genesis/checkpoint root published by the authoritative R-frame WAL. */
export interface CertifiedEntityLineageAnchor {
  entityId: string;
  height: number;
  frameHash: string;
  stateRoot: string;
  authority: EntityFrameAuthority;
  /** Required for non-self-certifying (numbered/named) H0 authorities. */
  authorityEvidenceHash?: string;
  /**
   * Validator-local trust boundary created only by an atomic Runtime WAL commit.
   * This is recovery metadata, never an Entity/peer certificate.
   */
  runtimeCheckpoint?: {
    runtimeHeight: number;
    replicaSetRoot: string;
  };
}


export type EntityCandidateEffect =
  | AccountOutput
  | {
      kind: 'entityFrameHistory';
      entityId: string;
      signerId: string;
      link: CertifiedEntityFrameLink;
    }
  | {
      kind: 'accountFrameHistory';
      entityId: string;
      counterpartyId: string;
      accountHeight: number;
      source: Extract<AccountHistoryRecord, { kind: 'accountFrame' }>['source'];
      frame: AccountFrame;
    }
  | {
      kind: 'runtimeEvent';
      eventName: string;
      data: Record<string, unknown>;
    }
  | {
      kind: 'securityIncidentRecord';
      identity: RuntimeSecurityIncidentIdentity;
    }
  | {
      kind: 'securityIncidentResolve';
      identity: RuntimeSecurityIncidentIdentity;
    }
  | {
      kind: 'debug';
      payload: Record<string, unknown>;
    };


/**
 * Validator-private candidate for one exact proposed Entity frame.
 *
 * Certified `EntityReplica.state` remains unchanged until the matching Hanko
 * commits this bundle. The frame hash and height make its speculative state,
 * outputs and storage delta indivisible: restore must never combine pieces
 * from different proposals. This is durable local metadata, not protocol
 * payload and never a second certified State.
 */
export interface EntityCandidate {
  frameHash: string;
  height: number;
  state: EntityState;
  outputs: EntityOutput[];
  jOutputs: JInput[];
  hashesToSign: HashToSign[];
  /** Notifications interpreted only after this exact frame commits. */
  candidateEffects: EntityCandidateEffect[];
  /** Storage invalidations interpreted only after this exact frame commits. */
  storageChanges: RuntimeOverlayRecord[];
  /** Validator-computed CAS delta, published only when this exact frame commits. */
  consumptionNodeChanges?: {
    newNodes: readonly ConsumptionNodeEntry[];
    replacedNodeHashes: readonly string[];
  };
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
}


export interface EntityReplica {
  entityId: string;
  signerId: string;
  state: EntityState;
  mempool: EntityTx[];
  proposal?: EntityFrame;
  lockedFrame?: EntityFrame; // Frame this validator is locked/precommitted to
  /** One validator-local speculative frame; commits never trust proposer-supplied post-state. */
  candidate?: EntityCandidate;
  /** Latest finalized certificate only; historical certificates live in the Runtime WAL and history views. */
  certifiedFrameLineage?: CertifiedEntityFrameLink[];
  certifiedFrameAnchor?: CertifiedEntityLineageAnchor;
  isProposer: boolean;
  leaderVotes?: Map<string, EntityLeaderTimeoutVote>;
  pendingLeaderCertificate?: EntityLeaderCertificate;
  lastConsensusProgressAt?: number;
  /** Validator-private durable J-chain evidence; never part of EntityState. */
  jHistory?: ValidatorJHistory;
  /** Signed validator heads for the current Entity-height J-prefix round. */
  jPrefixRound?: JPrefixRound;
  /** Validator-private J submission receipt; never part of EntityState consensus. */
  jSubmitState?: {
    jurisdictionName: string;
    batchHash: string;
    entityNonce: number;
    batchGeneration: number;
    submitAttempts: number;
    lastSubmittedAt: number;
    txHash?: string;
    lastFailure?: {
      message: string;
      failedAt: number;
      failure: RuntimeFailureSignal;
      adapterFailure?: JAdapterFailure;
    };
    terminalFailure?: {
      message: string;
      failedAt: number;
      failure: RuntimeFailureSignal;
      adapterFailure?: JAdapterFailure;
    };
    lastResultAttemptId?: string;
    lastResultAt?: number;
    lastResultOutcome?: 'submitted' | 'eventBarrier' | 'transientFailure' | 'terminalFailure' | 'reconciled';
    /** Canonical full payload of lastResultAttemptId; detects conflicting WAL duplicates. */
    lastResultFingerprint?: string;
    /** Bounded durable fingerprints for recent processed attempt IDs. */
    resultFingerprints?: Record<string, string>;
    /** Oldest-to-newest deterministic order for the bounded dedupe journal. */
    resultFingerprintOrder?: string[];
  };
  /** Validator-local EntityProvider submit receipt; never part of Entity consensus. */
  entityProviderActionSubmitState?: EntityProviderActionSubmitState;
  /**
   * Bounded presentation index rebuilt from certified Entity frames.
   * Descriptions never enter EntityState or an Account frame.
   */
  htlcNotes?: Map<HtlcNoteKey, string>;
  // Position is RELATIVE to j-machine (jurisdiction)
  // Frontend calculates: worldPos = jMachine.position + relativePosition
  position?: {
    x: number;      // Relative X offset from j-machine center
    y: number;      // Relative Y offset from j-machine center
    z: number;      // Relative Z offset from j-machine center
    jurisdiction?: string; // Which j-machine this entity belongs to (defaults to activeJurisdiction)
  };

  // HANKO WITNESS STORAGE (NOT part of state hash - stored alongside, not inside)
  // Persists finalized hankos for on-chain disputes, settlements, batch submissions
  hankoWitness?: Map<string, {
    hanko: HankoString;
    type: 'accountFrame' | 'dispute' | 'profile' | 'settlement' | 'jBatch' | 'entityProviderAction';
    entityHeight: number;  // Height when created
    createdAt: number;     // Timestamp
  }>;
}
