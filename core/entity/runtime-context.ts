import type { AccountJClaimNodeStore } from '../types/finance/account-j-claims';
import type { CertifiedBoardNodeStore } from '../types/entity-board-registry';
import type { JReplica } from '../types/jurisdiction-runtime';
import type { LogCategory } from '../types/logging';
import type { EntityReplica, EntityState } from './types';
import type { EntityInfraContext } from '../types/entity/infra-context';
import type { AccountAuthorityExecutionScope } from '../account/consensus/context';
import type { AccountInput, AccountReplica } from '../types/account';
import type { EntityTx } from '../types/entity-tx';
import type { HankoString } from '../types/hanko';

export type AccountAuthorityFrameBeginRequest = Readonly<{
  ownerEntityId: string;
  /** Parent Account root reconciles a held Rust candidate without Commit/Abort RPCs. */
  expectedAccountsRoot: string;
  entityState: EntityState;
  entityContext: EntityInfraContext;
  entityTxs: readonly EntityTx[];
  accounts: ReadonlyMap<string, AccountReplica>;
  accountForWrite(accountId: string): AccountReplica | undefined;
  createInboundAccount(input: AccountInput): Readonly<{
    account: AccountReplica;
    deltaTransformer: string;
  }>;
  entityTimestamp: number;
  finalizedJHeight: number;
}>;

export type AccountAuthorityFrameOutboundRequest = Readonly<{
  entityState: EntityState;
  entityHeight: number;
  accounts: ReadonlyMap<string, AccountReplica>;
  accountForWrite(accountId: string): AccountReplica | undefined;
  proposalAccountIds: readonly string[];
  timestamp: number;
  jHeight: number;
}>;

export type AccountAuthorityCommittedHanko = Readonly<{
  hash: string;
  hanko: HankoString;
  type: 'accountFrame' | 'dispute' | 'settlement';
  entityHeight: number;
  createdAt: number;
}>;

export type AccountAuthorityCommittedHankosRequest = Readonly<{
  ownerEntityId: string;
  entityState: EntityState;
  entityHeight: number;
  touchedAccountIds: readonly string[];
  hankos: ReadonlyMap<string, AccountAuthorityCommittedHanko>;
}>;

/** Narrow child-machine capability; lifecycle ownership remains in Runtime. */
export interface AccountAuthorityEntityStageCapability extends AccountAuthorityExecutionScope {
  beginEntityAccountFrame(request: AccountAuthorityFrameBeginRequest): Promise<void>;
  prepareEntityAccountOutbound(request: AccountAuthorityFrameOutboundRequest): Promise<void>;
  finishEntityAccountFrame(): void;
  installCommittedAccountHankos(request: AccountAuthorityCommittedHankosRequest): Promise<void>;
}

/**
 * Runtime-owned capabilities visible during one Entity transition.
 *
 * This is deliberately structural: Entity never imports RuntimeReplica and
 * cannot inspect Runtime mempools, WAL handles, transport state, or lifecycle
 * machinery. RuntimeReplica satisfies this contract at the call boundary.
 *
 * The remaining fields are the measured transition surface. Shrink this
 * interface when a dependency becomes an explicit input; never widen it
 * merely to avoid threading a value through the owning composition root.
 */
export interface EntityRuntimeContext {
  /** The exact committed parent State visible to this Entity transition. */
  state: {
    eReplicas: Map<string, EntityReplica>;
    jReplicas: Map<string, JReplica>;
    height: number;
    timestamp: number;
  };
  runtimeSeed?: string | undefined;
  runtimeId?: string | undefined;
  /** Ephemeral Runtime-envelope identity, never committed Entity state. */
  accountAuthorityFrameId?: string | null | undefined;
  /** Active only during one EntityInput; never State, WAL, or recovery data. */
  accountAuthorityEntityStage?: AccountAuthorityEntityStageCapability | undefined;
  activeJurisdiction?: string | undefined;
  quietRuntimeLogs?: boolean | undefined;
  runtimeConfig?: {
    entityConsensusStateWarningBytes?: number;
  } | undefined;
  infrastructure?: {
    /** Current process-local Runtime frame phase; diagnostics only. */
    runtimeFramePhase?: string | null;
    /** Entity-wide encryption secrets keyed by canonical entityId. */
    entityEncryptionPrivateKeys?: Map<string, string>;
    entityEncryptionSeeds?: Map<string, string>;
    /** Proposer-only snapshot of unverified socket liveness; never used implicitly. */
    observeOnlineEntityIds?: (entityIds: readonly string[]) => ReadonlySet<string>;
    /** Exact WAL-committed contexts installed only while replaying one Runtime frame. */
    replayEntityContexts?: Map<string, EntityInfraContext>;
    accountJClaimNodes?: AccountJClaimNodeStore;
    pendingAccountJClaimNodes?: AccountJClaimNodeStore;
    pendingAccountJClaimNodeDeletes?: Set<string>;
    certifiedBoardNodes?: CertifiedBoardNodeStore;
    pendingCertifiedBoardNodes?: CertifiedBoardNodeStore;
  } | undefined;
  error: (
    category: LogCategory,
    message: string,
    data?: Record<string, unknown>,
    entityId?: string,
  ) => void;
  info: (
    category: LogCategory,
    message: string,
    data?: Record<string, unknown>,
    entityId?: string,
  ) => void;
}
