import type { AccountInput, AccountReplica } from '../../types/account';
import type { HandleAccountInputResult, ProposeAccountFrameResult } from './types';
import type { HankoString } from '../../types/hanko';
import type { JReplica } from '../../types/jurisdiction-runtime';
import type { AccountJClaimNodeStore } from '../../types/finance/account-j-claims';

/**
 * The authoritative engine's seat inside Account consensus.
 *
 * In observation mode it only counts what TypeScript is about to execute. In
 * cutover it executes instead: `executeAccountInput` and
 * `executeAccountProposal` return the transition's result and leave the live
 * replica already holding the engine's post-state, so the TypeScript
 * transition below them never runs. `null` means the scope declined this
 * operation and TypeScript remains the executor.
 */
export type AccountAuthorityExecutionScope = Readonly<{
  hasPreparedAccountProposal?(accountId: string): boolean;
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
  collectorFrameId: string;
  account: AccountReplica;
  input: AccountInput;
  entityTimestamp: number;
  finalizedJHeight: number;
}>;


export type AccountAuthorityProposalRequest = Readonly<{
  collectorFrameId: string;
  account: AccountReplica;
  timestamp: number;
  jHeight: number;
  entityTimestamp: number;
  finalizedJHeight: number;
  selectionIsWholeMempool: boolean;
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
  /**
   * The Runtime this context belongs to. One process hosts many, so anything
   * that accumulates per Runtime frame has to be told which one rather than
   * inferring it from whichever frame opened last.
   */
  runtimeId?: string;
  /** Ephemeral parent-frame identity; null explicitly suppresses observation. */
  accountAuthorityFrameId?: string | null;
  /** Ephemeral pre-TypeScript authority hook; absent on the canonical TS path. */
  accountAuthorityExecutionScope?: AccountAuthorityExecutionScope;
  /**
   * The clock of the Entity frame this Account work belongs to. Peer inputs
   * carry their own copy in their security context; a local admission carries
   * none, and one Entity input must not straddle two clocks.
   */
  entityClock?: Readonly<{ timestamp: number; finalizedJHeight: number }>;
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
