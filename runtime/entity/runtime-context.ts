import type { AccountJClaimNodeStore } from '../types/account-j-claims';
import type { CertifiedBoardNodeStore } from '../types/entity-board-registry';
import type { JReplica } from '../types/jurisdiction-runtime';
import type { LogCategory } from '../types/logging';
import type { Profile } from './profile';
import type {
  ConsumptionNodeStore,
} from './consumption-accumulator-types';
import type { EntityReplica } from './types';

type EntityRoute = Readonly<{ path: string[] }>;

/**
 * Runtime-owned capabilities visible during one Entity transition.
 *
 * This is deliberately structural: Entity never imports RuntimeState and
 * cannot inspect Runtime mempools, WAL handles, transport state, or lifecycle
 * machinery. RuntimeState satisfies this contract at the call boundary.
 *
 * The remaining fields are the measured legacy transition surface. Shrink
 * this interface when a dependency becomes an explicit input; never widen it
 * merely to avoid threading a value through the owning composition root.
 */
export interface EntityRuntimeContext {
  eReplicas: Map<string, EntityReplica>;
  jReplicas: Map<string, JReplica>;
  height: number;
  timestamp: number;
  runtimeSeed?: string | undefined;
  runtimeId?: string | undefined;
  activeJurisdiction?: string | undefined;
  quietRuntimeLogs?: boolean | undefined;
  runtimeConfig?: {
    entityConsensusStateWarningBytes?: number;
  } | undefined;
  runtimeState?: {
    consumptionNodes?: ConsumptionNodeStore;
    pendingConsumptionNodes?: ConsumptionNodeStore;
    pendingConsumptionNodeDeletes?: Set<string>;
    accountJClaimNodes?: AccountJClaimNodeStore;
    pendingAccountJClaimNodes?: AccountJClaimNodeStore;
    pendingAccountJClaimNodeDeletes?: Set<string>;
    certifiedBoardNodes?: CertifiedBoardNodeStore;
    pendingCertifiedBoardNodes?: CertifiedBoardNodeStore;
  } | undefined;
  gossip: {
    getProfiles: () => Profile[];
    getNetworkGraph: () => {
      findPaths: (
        source: string,
        target: string,
        amount?: bigint,
        tokenId?: number,
      ) => Promise<EntityRoute[]>;
    };
  };
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
