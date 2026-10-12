import type {
  AccountTxBatch,
  AccountInput,
  AccountReplica,
  AccountTx,
} from '../../types/account';
import type { HandleAccountInputResult, ProposeAccountFrameResult } from './types';
import type { HankoString } from '../../types/hanko';
import type { JReplica } from '../../types/jurisdiction-runtime';
import type { AccountJClaimNodeStore } from '../../types/finance/account-j-claims';

/**
 * Entity-owned TypeScript worker delegation inside Account consensus.
 *
 * A prepared worker result installs its post-state on the live replica, so
 * Account consensus consumes that result without executing the transition
 * again. `null` leaves execution with the local TypeScript transition.
 */
export type AccountAuthorityExecutionScope = Readonly<{
  hasPreparedAccountProposal?(accountId: string): boolean;
  preparedAccountProposalTxs?(accountId: string): readonly AccountTx[] | undefined;
  hasPreparedAccountInput?(accountId: string, input: AccountInput): boolean;
  /**
   * Return the authenticated H=1 Account materialized by the authority for an
   * Account that did not exist at the start of this Entity frame.
   *
   * This is a read, not a transition. The normal Entity
   * handler still publishes the Account only after it consumes the matching
   * successful verdict and proves that H=1 committed.
   */
  preparedInboundGenesis?(accountId: string, input: AccountInput): AccountReplica | null;
  beforeTypeScriptAccountExecution(
    kind: 'applyAccountInput' | 'proposeAccountFrame',
    accountId: string,
  ): Promise<void>;
  executeAccountInput(
    request: AccountAuthorityInputRequest,
  ): Promise<HandleAccountInputResult | null>;
  executeAccountProposal(
    request: AccountAuthorityProposalRequest,
  ): Promise<ProposeAccountFrameResult | null>;
}>;

export type AccountAuthorityInputRequest = Readonly<{
  account: AccountReplica;
  input: AccountInput | AccountTxBatch;
  entityTimestamp: number;
  finalizedJHeight: number;
}>;


export type AccountAuthorityProposalRequest = Readonly<{
  account: AccountReplica;
  timestamp: number;
  jHeight: number;
  entityTimestamp: number;
  finalizedJHeight: number;
  selectedMempoolTxs?: readonly AccountTx[];
}>;

/**
 * Read-only capabilities supplied by Entity before entering Account consensus.
 *
 * Account must be replayable without a Runtime object. Keeping this surface
 * explicit prevents a new handler from silently reading transport, WAL,
 * sibling Entity, key-store, or watchdog state.
 */
export type AccountConsensusContext = Readonly<{
  runtimeTimestamp: number;
  /** Ephemeral Entity stage supplying prepared TypeScript worker results. */
  accountAuthorityExecutionScope?: AccountAuthorityExecutionScope;
  /**
   * The clock of the Entity frame this Account work belongs to. Account inputs
   * carry their own copy in their security context; a local admission carries
   * none, and one Entity input must not straddle two clocks.
   */
  entityClock?: Readonly<{ timestamp: number; finalizedJHeight: number }>;
  quietLogs: boolean;
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
