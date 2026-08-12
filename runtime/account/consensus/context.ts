import type { HankoString } from '../../types/hanko';
import type { JReplica } from '../../types/jurisdiction-runtime';
import type { AccountJClaimNodeStore } from '../../types/finance/account-j-claims';

/**
 * Read-only capabilities supplied by Entity before entering Account consensus.
 *
 * Account must be replayable without a Runtime object. Keeping this surface
 * explicit prevents a new handler from silently reading transport, WAL,
 * sibling Entity, key-store, or watchdog state.
 */
export type AccountConsensusContext = Readonly<{
  runtimeTimestamp: number;
  quietLogs: boolean;
  emitRuntimeEvents: boolean;
  jReplicas: ReadonlyMap<string, JReplica>;
  jClaimNodeStore: AccountJClaimNodeStore;
  verifyHanko(
    hanko: HankoString,
    hash: string,
    expectedEntityId: string,
    authority?: { registeredBoardHash?: string; allowPreviousBoard?: boolean },
  ): Promise<{ valid: boolean; entityId: string | null }>;
  resolveSettlementBoardAuthority(
    sourceEntityId: string,
    certifiedBoardHash?: string,
  ): Promise<string | undefined>;
}>;
