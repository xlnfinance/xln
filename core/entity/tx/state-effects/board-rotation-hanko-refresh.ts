import type { AccountBoardHankoRefreshMigration, AccountDisputeHanko, AccountReplica } from '../../../types/account';
import type { EntityInput, EntityState, HashToSign } from '../../types';
import type { CertifiedBoardNodeStore } from '../../../types/entity-board-registry';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import { resolveObserverCertifiedAccountCounterpartyProposer } from '../../account/account-counterparty-route';
import { HankoValidationError } from '../../../hanko/codec';
import { buildAccountEntityOutput } from '../j-events-htlc/cross-j-outputs';
import { createStructuredLogger } from '../../../support/logger';
import { EntityAccountCandidateMap, getEntityAccountForWrite } from '../../state/persistent-account-map';
import {
  copyAccountDisputeConfig,
  copyAccountStateDomain,
} from '../../../protocol/state/account-input-clone';

type BoardActivatedEvent = Extract<JurisdictionEvent, { type: 'BoardActivated' }>;

export type BoardHankoRefreshActivation = {
  entityId: string;
  jHeight: number;
  logIndex: number;
};

export type BoardRotationHankoRefreshDrafts = {
  outputs: EntityInput[];
  hashesToSign: HashToSign[];
  accountMigrations: BoardRotationAccountMigration[];
  hasMore: boolean;
  retryRequired: boolean;
  nextAfterCounterpartyId: string;
};

export type BoardRotationAccountMigration = {
  counterpartyId: string;
  marker: AccountBoardHankoRefreshMigration | null;
};

type AccountHankoRefreshDraft = {
  output?: EntityInput;
  hashesToSign: HashToSign[];
  migration: BoardRotationAccountMigration;
};

type ActivationPosition = readonly [jHeight: number, logIndex: number];

const MAX_BOARD_HANKO_REFRESHES_PER_FRAME = 32;
export const BOARD_HANKO_REFRESH_HOOK_ID = 'board-hanko-refresh';
export const BOARD_HANKO_REFRESH_RETRY_MS = 60_000;
const boardHankoRefreshLog = createStructuredLogger('entity.board-hanko-refresh');

const bytes32 = (value: string): boolean => /^0x[0-9a-f]{64}$/.test(value.toLowerCase());

const hasAnyDisputeHankoEvidence = (account: AccountReplica): boolean => Boolean(
  account.currentDisputeProofHanko ||
  account.counterpartyDisputeProofHanko ||
  account.currentDisputeHash ||
  account.counterpartyDisputeHash ||
  account.currentDisputeProofBodyHash ||
  account.counterpartyDisputeProofBodyHash ||
  account.currentDisputeProofNonce !== undefined ||
  account.counterpartyDisputeProofNonce !== undefined ||
  account.currentDisputeProofProposerIsLeft !== undefined ||
  account.counterpartyDisputeProofProposerIsLeft !== undefined
);

type DisputeHankoDraft = {
  hanko?: AccountDisputeHanko;
  issue?: AccountBoardHankoRefreshMigration['reason'];
};

const exactBilateralDisputeHanko = (account: AccountReplica): DisputeHankoDraft => {
  if (!hasAnyDisputeHankoEvidence(account)) return {};
  const localHash = account.currentDisputeHash?.toLowerCase();
  const remoteHash = account.counterpartyDisputeHash?.toLowerCase();
  const localBody = account.currentDisputeProofBodyHash?.toLowerCase();
  const remoteBody = account.counterpartyDisputeProofBodyHash?.toLowerCase();
  const localNonce = account.currentDisputeProofNonce;
  const remoteNonce = account.counterpartyDisputeProofNonce;
  const localProposerIsLeft = account.currentDisputeProofProposerIsLeft;
  const remoteProposerIsLeft = account.counterpartyDisputeProofProposerIsLeft;
  if (
    !account.currentDisputeProofHanko ||
    !account.counterpartyDisputeProofHanko ||
    !localHash ||
    !localBody ||
    localHash !== remoteHash ||
    localBody !== remoteBody ||
    localNonce !== remoteNonce ||
    localProposerIsLeft !== remoteProposerIsLeft ||
    typeof localProposerIsLeft !== 'boolean'
  ) return { issue: 'bilateral-dispute-uncertified' };
  if (!bytes32(localHash) || !bytes32(localBody) || !Number.isSafeInteger(localNonce) || localNonce! < 0) {
    return { issue: 'certified-dispute-invalid' };
  }
  return {
    hanko: {
      hash: localHash,
      proofBodyHash: localBody,
      proofNonce: localNonce!,
      proposerIsLeft: localProposerIsLeft,
    },
  };
};

const accountFrameIssue = (
  state: EntityState,
  counterpartyId: string,
  account: AccountReplica,
): AccountBoardHankoRefreshMigration['reason'] | undefined => {
  if (
    account.proofHeader.fromEntity.toLowerCase() !== state.entityId.toLowerCase() ||
    account.proofHeader.toEntity.toLowerCase() !== counterpartyId
  ) {
    return 'account-identity-invalid';
  }
  if (!account.currentFrameHanko || !account.counterpartyFrameHanko) {
    return 'bilateral-frame-uncertified';
  }
  const height = Number(account.currentHeight);
  const frameHash = String(account.currentFrame.stateHash || '').toLowerCase();
  if (!Number.isSafeInteger(height) || height !== Number(account.currentFrame.height) || !bytes32(frameHash)) {
    return 'certified-frame-invalid';
  }
  return undefined;
};

const migration = (
  counterpartyId: string,
  activationJHeight: number,
  activationLogIndex: number,
  reason: AccountBoardHankoRefreshMigration['reason'] | null,
  issued?: { height: number; frameHash: string },
): BoardRotationAccountMigration => ({
  counterpartyId,
  marker: reason ? {
    activationJHeight,
    activationLogIndex,
    reason,
    ...(issued ? {
      issuedFrameHeight: issued.height,
      issuedFrameHash: issued.frameHash,
    } : {}),
  } : null,
});

export const accountNeedsBoardHankoRefreshForActivation = (
  account: AccountReplica,
  activation: Pick<BoardHankoRefreshActivation, 'jHeight' | 'logIndex'>,
): boolean => {
  const marker = account.boardHankoRefreshMigration;
  if (
    !marker ||
    marker.activationJHeight !== activation.jHeight ||
    marker.activationLogIndex !== activation.logIndex
  ) return false;
  if (marker.reason !== 'issued') return true;
  return marker.issuedFrameHeight !== Number(account.currentHeight) ||
    marker.issuedFrameHash?.toLowerCase() !== String(account.currentFrame.stateHash || '').toLowerCase();
};

type BoardHankoRefreshEvidence = ReadonlyArray<string | number | bigint | boolean | undefined>;

const boardHankoRefreshEvidence = (
  account: AccountReplica,
): BoardHankoRefreshEvidence => [
  account.currentHeight,
  account.currentFrame.height,
  account.currentFrame.stateHash,
  account.currentFrameHanko,
  account.counterpartyFrameHanko,
  account.currentDisputeProofHanko,
  account.counterpartyDisputeProofHanko,
  account.currentDisputeHash,
  account.counterpartyDisputeHash,
  account.currentDisputeProofBodyHash,
  account.counterpartyDisputeProofBodyHash,
  account.currentDisputeProofNonce,
  account.counterpartyDisputeProofNonce,
  account.currentDisputeProofProposerIsLeft,
  account.counterpartyDisputeProofProposerIsLeft,
];

/** Capture only Account bytes whose change can make a fresh board Hanko refresh possible. */
export const captureAccountBoardHankoRefreshEvidence = (
  state: Pick<EntityState, 'accounts'>,
  accountIds: ReadonlySet<string>,
): ReadonlyMap<string, BoardHankoRefreshEvidence> => {
  const evidence = new Map<string, BoardHankoRefreshEvidence>();
  for (const rawAccountId of accountIds) {
    const accountId = rawAccountId.toLowerCase();
    const account = state.accounts instanceof EntityAccountCandidateMap
      ? state.accounts.getCertifiedBase(accountId)
      : state.accounts.get(accountId);
    if (account) evidence.set(accountId, boardHankoRefreshEvidence(account));
  }
  return evidence;
};

/** A marker-only mutation must never schedule another consensus frame. */
export const accountBoardHankoRefreshEvidenceChanged = (
  previous: BoardHankoRefreshEvidence | undefined,
  current: AccountReplica,
): boolean => {
  if (!previous) return true;
  return boardHankoRefreshEvidence(current).some((value, index) => value !== previous[index]);
};

const activationPosition = (event: BoardActivatedEvent): ActivationPosition => {
  const jHeight = Number(event.blockNumber);
  if (!Number.isSafeInteger(jHeight) || jHeight < 1) {
    throw new Error(`BOARD_HANKO_REFRESH_ACTIVATION_HEIGHT_INVALID:${String(event.blockNumber)}`);
  }
  const logIndex = Number(event.logIndex);
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) {
    throw new Error(`BOARD_HANKO_REFRESH_ACTIVATION_LOG_INDEX_INVALID:${String(event.logIndex)}`);
  }
  return [jHeight, logIndex];
};

const boardHankoRefreshActivation = (event: BoardActivatedEvent): BoardHankoRefreshActivation => {
  const [jHeight, logIndex] = activationPosition(event);
  return {
    entityId: event.data.entityId.toLowerCase(),
    jHeight,
    logIndex,
  };
};

export const markBoardRotationHankoRefreshesPending = (
  state: EntityState,
  event: BoardActivatedEvent,
): { activation: BoardHankoRefreshActivation; dirtyAccounts: string[] } => {
  const activation = boardHankoRefreshActivation(event);
  if (activation.entityId !== state.entityId.toLowerCase()) return { activation, dirtyAccounts: [] };
  const dirtyAccounts: string[] = [];
  for (const rawCounterpartyId of state.accounts.keys()) {
    const account = getEntityAccountForWrite(state.accounts, rawCounterpartyId);
    if (!account) continue;
    const counterpartyId = rawCounterpartyId.toLowerCase();
    if (Number(account.currentHeight) < 1) {
      if (account.boardHankoRefreshMigration) {
        delete account.boardHankoRefreshMigration;
        dirtyAccounts.push(counterpartyId);
      }
      continue;
    }
    account.boardHankoRefreshMigration = {
      activationJHeight: activation.jHeight,
      activationLogIndex: activation.logIndex,
      reason: 'pending',
    };
    dirtyAccounts.push(counterpartyId);
  }
  return { activation, dirtyAccounts: dirtyAccounts.sort() };
};

const buildHankoRefreshOutput = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  counterpartyId: string,
  account: AccountReplica,
  input: NonNullable<EntityInput['entityTxs']>,
): EntityInput | undefined => {
  try {
    const signerId = resolveObserverCertifiedAccountCounterpartyProposer(
      store,
      state,
      account,
      counterpartyId,
    );
    if (!signerId) {
      boardHankoRefreshLog.warn('route.unavailable', {
        counterpartyId,
        reason: account.counterpartyFrameHanko ? 'proposer-unresolved' : 'counterparty-frame-hanko-missing',
      });
      return undefined;
    }
    return buildAccountEntityOutput(counterpartyId, signerId, input);
  } catch (error) {
    // An absent/non-authoritative bilateral witness is retryable. Corrupt
    // Account identity, frame hashes, or certified Patricia nodes remain loud.
    if (error instanceof HankoValidationError) {
      boardHankoRefreshLog.warn('route.unavailable', {
        counterpartyId,
        reason: error.message,
      });
      return undefined;
    }
    throw error;
  }
};

const buildCertifiedAccountHankoRefreshDraft = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  activation: BoardHankoRefreshActivation,
  counterpartyId: string,
  account: AccountReplica,
  position: ActivationPosition,
): AccountHankoRefreshDraft => {
  const frameHash = account.currentFrame.stateHash.toLowerCase();
  const dispute = exactBilateralDisputeHanko(account);
  if (dispute.issue) {
    return {
      hashesToSign: [],
      migration: migration(counterpartyId, ...position, dispute.issue),
    };
  }
  const boardHankoRefresh = {
    height: account.currentHeight,
    frameHash,
    boardActivationJHeight: position[0],
    boardActivationLogIndex: position[1],
    ...(dispute.hanko ? { disputeHanko: dispute.hanko } : {}),
  };
  const output = buildHankoRefreshOutput(state, store, counterpartyId, account, [{
    type: 'accountInput',
    data: {
      kind: 'board_hanko_refresh',
      fromEntityId: state.entityId,
      toEntityId: counterpartyId,
      domain: copyAccountStateDomain(account.state.domain),
      disputeConfig: copyAccountDisputeConfig(account.state.disputeConfig),
      boardHankoRefresh,
    },
  }]);
  const issue = output ? 'issued' : 'output-route-unavailable';
  const context = `board-hanko-refresh:${activation.jHeight}:${activation.logIndex}:${counterpartyId}`;
  const hashesToSign: HashToSign[] = output
    ? [{ hash: frameHash, type: 'accountFrame', context: `${context}:frame` }]
    : [];
  if (output && dispute.hanko) {
    hashesToSign.push({ hash: dispute.hanko.hash, type: 'dispute', context: `${context}:dispute` });
  }
  return {
    ...(output ? { output } : {}),
    hashesToSign,
    migration: migration(
      counterpartyId,
      ...position,
      issue,
      output ? { height: account.currentHeight, frameHash } : undefined,
    ),
  };
};

const buildAccountHankoRefreshDraft = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  activation: BoardHankoRefreshActivation,
  counterpartyId: string,
  account: AccountReplica,
  position: ActivationPosition,
): AccountHankoRefreshDraft => {
  if (Number(account.currentHeight) < 1) {
    return { hashesToSign: [], migration: migration(counterpartyId, ...position, null) };
  }
  const issue = accountFrameIssue(state, counterpartyId, account);
  if (issue) return { hashesToSign: [], migration: migration(counterpartyId, ...position, issue) };
  return buildCertifiedAccountHankoRefreshDraft(state, store, activation, counterpartyId, account, position);
};

export const applyBoardRotationHankoRefreshMigrations = (
  state: EntityState,
  updates: readonly BoardRotationAccountMigration[],
): void => {
  if (!(state.accounts instanceof EntityAccountCandidateMap)) {
    throw new Error('BOARD_HANKO_REFRESH_MIGRATION_CANDIDATE_REQUIRED');
  }
  for (const update of updates) {
    const account = getEntityAccountForWrite(state.accounts, update.counterpartyId);
    if (!account) throw new Error(`BOARD_HANKO_REFRESH_MIGRATION_ACCOUNT_MISSING:${update.counterpartyId}`);
    if (update.marker) account.boardHankoRefreshMigration = { ...update.marker };
    else delete account.boardHankoRefreshMigration;
  }
};

const buildBoardRotationHankoRefreshDraftsForActivation = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  activation: BoardHankoRefreshActivation,
  options: {
    afterCounterpartyId?: string;
    pendingOnly?: boolean;
  } = {},
): BoardRotationHankoRefreshDrafts => {
  if (activation.entityId !== state.entityId.toLowerCase()) {
    return {
      outputs: [],
      hashesToSign: [],
      accountMigrations: [],
      hasMore: false,
      retryRequired: false,
      nextAfterCounterpartyId: '',
    };
  }
  const position = [activation.jHeight, activation.logIndex] as const;
  const outputs: EntityInput[] = [];
  const hashesToSign: HashToSign[] = [];
  const accountMigrations: BoardRotationAccountMigration[] = [];
  const orderedAccounts = [...state.accounts.entries()]
    .map(([counterpartyId, account]) => [counterpartyId.toLowerCase(), account] as const)
    .filter(([counterpartyId, account]) => {
      if (counterpartyId <= String(options.afterCounterpartyId ?? '').toLowerCase()) return false;
      if (!options.pendingOnly) return true;
      return accountNeedsBoardHankoRefreshForActivation(account, activation);
    })
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

  const batch = orderedAccounts.slice(0, MAX_BOARD_HANKO_REFRESHES_PER_FRAME);

  for (const [counterpartyId, account] of batch) {
    const draft = buildAccountHankoRefreshDraft(state, store, activation, counterpartyId, account, position);
    if (draft.output) outputs.push(draft.output);
    hashesToSign.push(...draft.hashesToSign);
    accountMigrations.push(draft.migration);
  }
  return {
    outputs,
    hashesToSign,
    accountMigrations,
    hasMore: orderedAccounts.length > batch.length,
    // Only transport discovery can improve without an Account transition.
    // Structural/certification issues remain visible in the bounded marker
    // and are re-armed by scheduleChangedAccountBoardHankoRefreshes when that Account
    // actually changes. Polling them every second creates an infinite wake
    // loop while adding no new evidence.
    retryRequired: accountMigrations.some(update =>
      update.marker?.reason === 'output-route-unavailable'),
    nextAfterCounterpartyId: batch.at(-1)?.[0] ?? String(options.afterCounterpartyId ?? '').toLowerCase(),
  };
};

/** Build at most one bounded frame of Account hashes already certified by both parties. */
export const buildBoardRotationHankoRefreshDrafts = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  event: BoardActivatedEvent,
  options: {
    afterCounterpartyId?: string;
    pendingOnly?: boolean;
  } = {},
): BoardRotationHankoRefreshDrafts => buildBoardRotationHankoRefreshDraftsForActivation(
  state,
  store,
  boardHankoRefreshActivation(event),
  options,
);

export const buildPendingBoardRotationHankoRefreshDrafts = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  activation: BoardHankoRefreshActivation,
  afterCounterpartyId = '',
): BoardRotationHankoRefreshDrafts => buildBoardRotationHankoRefreshDraftsForActivation(state, store, activation, {
  afterCounterpartyId,
  pendingOnly: true,
});
