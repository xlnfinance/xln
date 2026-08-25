import type { AccountJClaimNodeStore } from '../types/finance/account-j-claims';
import type { CertifiedBoardNodeStore } from '../types/entity-board-registry';
import type { JReplica } from '../types/jurisdiction-runtime';
import type { LogCategory } from '../types/logging';
import type {
  ConsumptionNodeStore,
} from './consumption/consumption-accumulator-types';
import type { EntityReplica } from './types';
import type { EntityInfraContext } from '../types/entity/infra-context';
import type { EntityProposalReplayOracleEntry } from './consensus/proposal/replay-oracle';

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
  activeJurisdiction?: string | undefined;
  quietRuntimeLogs?: boolean | undefined;
  runtimeConfig?: {
    entityConsensusStateWarningBytes?: number;
  } | undefined;
  infrastructure?: {
    /** Entity-wide encryption secrets keyed by canonical entityId. */
    entityEncryptionPrivateKeys?: Map<string, string>;
    entityEncryptionSeeds?: Map<string, string>;
    /** Proposer-only snapshot of unverified socket liveness; never used implicitly. */
    observeOnlineEntityIds?: (entityIds: readonly string[]) => ReadonlySet<string>;
    /** Exact WAL-committed contexts installed only while replaying one Runtime frame. */
    replayEntityContexts?: Map<string, EntityInfraContext>;
    /** HLT-only exact certified proposal boundaries; absent for production and old recordings. */
    replayEntityProposalOracle?: Map<string, EntityProposalReplayOracleEntry>;
    consumptionNodes?: ConsumptionNodeStore;
    pendingConsumptionNodes?: ConsumptionNodeStore;
    pendingConsumptionNodeDeletes?: Set<string>;
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
