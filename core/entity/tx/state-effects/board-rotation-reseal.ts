import type {
  AccountBoardResealMigration,
  AccountDisputeSeal,
  AccountPeerInput,
  AccountReplica,
} from '../../../types/account';
import type { EntityInput, EntityState, HashToSign } from '../../types';
import type { CertifiedBoardNodeStore } from '../../../types/entity-board-registry';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import { resolveObserverCertifiedAccountCounterpartyProposer } from '../../account/account-counterparty-route';
import { HankoValidationError } from '../../../hanko/codec';
import { buildCertifiedEntityOutput } from '../j-events-htlc/cross-j-outputs';
import { createStructuredLogger } from '../../../support/logger';
import { EntityAccountCandidateMap, getEntityAccountForWrite } from '../../state/persistent-account-map';
import {
  cloneIsolatedAccountInput,
  copyAccountDisputeConfig,
  copyAccountStateDomain,
} from '../../../protocol/state/account-input-clone';
import {
  accountInputAck,
  accountInputProposal,
} from '../../../account/consensus/flush';

type BoardActivatedEvent = Extract<JurisdictionEvent, { type: 'BoardActivated' }>;

export type BoardResealActivation = {
  entityId: string;
  jHeight: number;
  logIndex: number;
};

export type BoardRotationResealDrafts = {
  outputs: EntityInput[];
  hashesToSign: HashToSign[];
  accountMigrations: BoardRotationAccountMigration[];
  hasMore: boolean;
  retryRequired: boolean;
  nextAfterCounterpartyId: string;
};

export type BoardRotationAccountMigration = {
  counterpartyId: string;
  marker: AccountBoardResealMigration | null;
  reHanko?: {
    target: 'pendingAccountInput' | 'lastOutboundFrameAck';
    input: AccountPeerInput;
  };
};

type AccountResealDraft = {
  output?: EntityInput;
  hashesToSign: HashToSign[];
  migration: BoardRotationAccountMigration;
};

type ActivationPosition = readonly [jHeight: number, logIndex: number];

const MAX_BOARD_RESEALS_PER_FRAME = 32;
export const BOARD_RESEAL_HOOK_ID = 'board-reseal';
export const BOARD_RESEAL_RETRY_MS = 60_000;
const resealLog = createStructuredLogger('entity.board-reseal');

const bytes32 = (value: string): boolean => /^0x[0-9a-f]{64}$/.test(value.toLowerCase());

const hasAnyDisputeSealEvidence = (account: AccountReplica): boolean => Boolean(
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

type DisputeSealDraft = {
  seal?: AccountDisputeSeal;
  issue?: AccountBoardResealMigration['reason'];
};

const exactBilateralDisputeSeal = (account: AccountReplica): DisputeSealDraft => {
  if (!hasAnyDisputeSealEvidence(account)) return {};
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
    seal: {
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
): AccountBoardResealMigration['reason'] | undefined => {
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
  reason: AccountBoardResealMigration['reason'] | null,
  issued?: { height: number; frameHash: string },
  reHanko?: BoardRotationAccountMigration['reHanko'],
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
  ...(reHanko ? { reHanko } : {}),
});

export const accountNeedsBoardResealForActivation = (
  account: AccountReplica,
  activation: Pick<BoardResealActivation, 'jHeight' | 'logIndex'>,
): boolean => {
  const marker = account.boardResealMigration;
  if (
    !marker ||
    marker.activationJHeight !== activation.jHeight ||
    marker.activationLogIndex !== activation.logIndex
  ) return false;
  if (marker.reason !== 'issued') return true;
  return marker.issuedFrameHeight !== Number(account.currentHeight) ||
    marker.issuedFrameHash?.toLowerCase() !== String(account.currentFrame.stateHash || '').toLowerCase();
};

type BoardResealEvidence = ReadonlyArray<string | number | bigint | boolean | undefined>;

const boardResealEvidence = (
  account: AccountReplica,
): BoardResealEvidence => [
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

/** Capture only Account bytes whose change can make a fresh reseal possible. */
export const captureAccountBoardResealEvidence = (
  state: Pick<EntityState, 'accounts'>,
  accountIds: ReadonlySet<string>,
): ReadonlyMap<string, BoardResealEvidence> => {
  const evidence = new Map<string, BoardResealEvidence>();
  for (const rawAccountId of accountIds) {
    const accountId = rawAccountId.toLowerCase();
    const account = state.accounts instanceof EntityAccountCandidateMap
      ? state.accounts.getCertifiedBase(accountId)
      : state.accounts.get(accountId);
    if (account) evidence.set(accountId, boardResealEvidence(account));
  }
  return evidence;
};

/** A marker-only mutation must never schedule another consensus frame. */
export const accountBoardResealEvidenceChanged = (
  previous: BoardResealEvidence | undefined,
  current: AccountReplica,
): boolean => {
  if (!previous) return true;
  return boardResealEvidence(current).some((value, index) => value !== previous[index]);
};

const activationPosition = (event: BoardActivatedEvent): ActivationPosition => {
  const jHeight = Number(event.blockNumber);
  if (!Number.isSafeInteger(jHeight) || jHeight < 1) {
    throw new Error(`BOARD_RESEAL_ACTIVATION_HEIGHT_INVALID:${String(event.blockNumber)}`);
  }
  const logIndex = Number(event.logIndex);
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) {
    throw new Error(`BOARD_RESEAL_ACTIVATION_LOG_INDEX_INVALID:${String(event.logIndex)}`);
  }
  return [jHeight, logIndex];
};

const boardResealActivation = (event: BoardActivatedEvent): BoardResealActivation => {
  const [jHeight, logIndex] = activationPosition(event);
  return {
    entityId: event.data.entityId.toLowerCase(),
    jHeight,
    logIndex,
  };
};

export const markBoardRotationResealsPending = (
  state: EntityState,
  event: BoardActivatedEvent,
): { activation: BoardResealActivation; dirtyAccounts: string[] } => {
  const activation = boardResealActivation(event);
  if (activation.entityId !== state.entityId.toLowerCase()) return { activation, dirtyAccounts: [] };
  const dirtyAccounts: string[] = [];
  for (const rawCounterpartyId of state.accounts.keys()) {
    const account = getEntityAccountForWrite(state.accounts, rawCounterpartyId);
    if (!account) continue;
    const counterpartyId = rawCounterpartyId.toLowerCase();
    if (Number(account.currentHeight) < 1) {
      if (account.boardResealMigration) {
        delete account.boardResealMigration;
        dirtyAccounts.push(counterpartyId);
      }
      continue;
    }
    account.boardResealMigration = {
      activationJHeight: activation.jHeight,
      activationLogIndex: activation.logIndex,
      reason: 'pending',
    };
    dirtyAccounts.push(counterpartyId);
  }
  return { activation, dirtyAccounts: dirtyAccounts.sort() };
};

const buildResealOutput = (
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
      resealLog.warn('route.unavailable', {
        counterpartyId,
        reason: account.counterpartyFrameHanko ? 'proposer-unresolved' : 'counterparty-frame-hanko-missing',
      });
      return undefined;
    }
    return buildCertifiedEntityOutput(counterpartyId, signerId, input);
  } catch (error) {
    // An absent/non-authoritative bilateral witness is retryable. Corrupt
    // Account identity, frame hashes, or certified Patricia nodes remain loud.
    if (error instanceof HankoValidationError) {
      resealLog.warn('route.unavailable', {
        counterpartyId,
        reason: error.message,
      });
      return undefined;
    }
    throw error;
  }
};

type InFlightReHankoDraft = {
  input: AccountPeerInput;
  target: NonNullable<BoardRotationAccountMigration['reHanko']>['target'];
  issued: { height: number; frameHash: string };
  hashesToSign: HashToSign[];
};

const appendReHankoHash = (
  hashes: HashToSign[],
  seen: Set<string>,
  hash: string,
  type: HashToSign['type'],
  context: string,
): void => {
  const normalized = hash.toLowerCase();
  if (!bytes32(normalized)) throw new Error(`BOARD_REHANKO_HASH_INVALID:${context}:${hash}`);
  if (seen.has(normalized)) return;
  seen.add(normalized);
  hashes.push({ hash: normalized, type, context });
};

const clearLocalHankosAndCollectHashes = (
  input: AccountPeerInput,
  context: string,
): { issued: InFlightReHankoDraft['issued']; hashesToSign: HashToSign[] } => {
  const hashesToSign: HashToSign[] = [];
  const seen = new Set<string>();
  const ack = accountInputAck(input);
  if (ack) {
    appendReHankoHash(hashesToSign, seen, ack.frameHash, 'accountFrame', `${context}:ack`);
    delete ack.frameHanko;
    if (ack.disputeSeal) {
      appendReHankoHash(hashesToSign, seen, ack.disputeSeal.hash, 'dispute', `${context}:ack-dispute`);
      delete ack.disputeSeal.hanko;
    }
  }
  const proposal = accountInputProposal(input);
  if (proposal) {
    appendReHankoHash(
      hashesToSign,
      seen,
      proposal.frame.stateHash,
      'accountFrame',
      `${context}:proposal`,
    );
    delete proposal.frameHanko;
    if (proposal.disputeSeal) {
      appendReHankoHash(
        hashesToSign,
        seen,
        proposal.disputeSeal.hash,
        'dispute',
        `${context}:proposal-dispute`,
      );
      delete proposal.disputeSeal.hanko;
    }
  }
  const issued = proposal
    ? { height: Number(proposal.frame.height), frameHash: proposal.frame.stateHash.toLowerCase() }
    : ack
      ? { height: Number(ack.height), frameHash: ack.frameHash.toLowerCase() }
      : undefined;
  if (!issued || !Number.isSafeInteger(issued.height) || issued.height < 1) {
    throw new Error(`BOARD_REHANKO_FRAME_MISSING:${context}`);
  }
  return { issued, hashesToSign };
};

const buildInFlightReHankoDraft = (
  state: EntityState,
  counterpartyId: string,
  account: AccountReplica,
  activation: BoardResealActivation,
): InFlightReHankoDraft | undefined => {
  let source: AccountPeerInput | undefined;
  let target: InFlightReHankoDraft['target'] | undefined;
  if (account.pendingFrame) {
    if (!account.pendingAccountInput) {
      throw new Error(`BOARD_REHANKO_PENDING_INPUT_MISSING:${counterpartyId}:${account.pendingFrame.height}`);
    }
    const proposal = accountInputProposal(account.pendingAccountInput);
    if (
      !proposal ||
      Number(proposal.frame.height) !== Number(account.pendingFrame.height) ||
      proposal.frame.stateHash.toLowerCase() !== account.pendingFrame.stateHash.toLowerCase()
    ) {
      throw new Error(`BOARD_REHANKO_PENDING_INPUT_MISMATCH:${counterpartyId}:${account.pendingFrame.height}`);
    }
    source = account.pendingAccountInput;
    target = 'pendingAccountInput';
  } else {
    const cached = account.lastOutboundFrameAck;
    if (
      cached &&
      Number(cached.height) === Number(account.currentHeight) &&
      cached.counterpartyEntityId.toLowerCase() === counterpartyId
    ) {
      source = cached.response;
      target = 'lastOutboundFrameAck';
    }
  }
  if (!source || !target) return undefined;
  if (
    source.fromEntityId.toLowerCase() !== state.entityId.toLowerCase() ||
    source.toEntityId.toLowerCase() !== counterpartyId
  ) {
    throw new Error(`BOARD_REHANKO_PARTY_MISMATCH:${counterpartyId}`);
  }
  const input = cloneIsolatedAccountInput(source);
  const context = `board-rehanko:${activation.jHeight}:${activation.logIndex}:${counterpartyId}`;
  const { issued, hashesToSign } = clearLocalHankosAndCollectHashes(input, context);
  return { input, target, issued, hashesToSign };
};

const buildInFlightAccountReHankoDraft = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  activation: BoardResealActivation,
  counterpartyId: string,
  account: AccountReplica,
  position: ActivationPosition,
): AccountResealDraft | undefined => {
  const draft = buildInFlightReHankoDraft(state, counterpartyId, account, activation);
  if (!draft) return undefined;
  const output = buildResealOutput(state, store, counterpartyId, account, [{
    type: 'accountInput',
    data: cloneIsolatedAccountInput(draft.input),
  }]);
  return {
    ...(output ? { output } : {}),
    hashesToSign: output ? draft.hashesToSign : [],
    migration: migration(
      counterpartyId,
      ...position,
      output ? 'issued' : 'output-route-unavailable',
      output ? draft.issued : undefined,
      output ? {
        target: draft.target,
        input: cloneIsolatedAccountInput(draft.input),
      } : undefined,
    ),
  };
};

const buildCertifiedAccountResealDraft = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  activation: BoardResealActivation,
  counterpartyId: string,
  account: AccountReplica,
  position: ActivationPosition,
): AccountResealDraft => {
  const frameHash = account.currentFrame.stateHash.toLowerCase();
  const dispute = exactBilateralDisputeSeal(account);
  if (dispute.issue) {
    return {
      hashesToSign: [],
      migration: migration(counterpartyId, ...position, dispute.issue),
    };
  }
  const reseal = {
    height: account.currentHeight,
    frameHash,
    boardActivationJHeight: position[0],
    boardActivationLogIndex: position[1],
    ...(dispute.seal ? { disputeSeal: dispute.seal } : {}),
  };
  const output = buildResealOutput(state, store, counterpartyId, account, [{
    type: 'accountInput',
    data: {
      kind: 'board_reseal',
      fromEntityId: state.entityId,
      toEntityId: counterpartyId,
      domain: copyAccountStateDomain(account.state.domain),
      disputeConfig: copyAccountDisputeConfig(account.state.disputeConfig),
      reseal,
    },
  }]);
  const issue = output ? 'issued' : 'output-route-unavailable';
  const context = `board-reseal:${activation.jHeight}:${activation.logIndex}:${counterpartyId}`;
  const hashesToSign: HashToSign[] = output
    ? [{ hash: frameHash, type: 'accountFrame', context: `${context}:frame` }]
    : [];
  if (output && dispute.seal) {
    hashesToSign.push({ hash: dispute.seal.hash, type: 'dispute', context: `${context}:dispute` });
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

const buildAccountResealDraft = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  activation: BoardResealActivation,
  counterpartyId: string,
  account: AccountReplica,
  position: ActivationPosition,
): AccountResealDraft => {
  if (Number(account.currentHeight) < 1) {
    return { hashesToSign: [], migration: migration(counterpartyId, ...position, null) };
  }
  const inFlight = buildInFlightAccountReHankoDraft(
    state,
    store,
    activation,
    counterpartyId,
    account,
    position,
  );
  if (inFlight) return inFlight;
  const issue = accountFrameIssue(state, counterpartyId, account);
  if (issue) return { hashesToSign: [], migration: migration(counterpartyId, ...position, issue) };
  return buildCertifiedAccountResealDraft(state, store, activation, counterpartyId, account, position);
};

export const applyBoardRotationResealMigrations = (
  state: EntityState,
  updates: readonly BoardRotationAccountMigration[],
): void => {
  if (!(state.accounts instanceof EntityAccountCandidateMap)) {
    throw new Error('BOARD_RESEAL_MIGRATION_CANDIDATE_REQUIRED');
  }
  for (const update of updates) {
    const account = getEntityAccountForWrite(state.accounts, update.counterpartyId);
    if (!account) throw new Error(`BOARD_RESEAL_MIGRATION_ACCOUNT_MISSING:${update.counterpartyId}`);
    if (update.reHanko?.target === 'pendingAccountInput') {
      const pendingInput = update.reHanko.input;
      const proposal = accountInputProposal(pendingInput);
      if (
        !account.pendingFrame ||
        (pendingInput.kind !== 'frame' && pendingInput.kind !== 'frame_ack') ||
        !proposal ||
        proposal.frame.stateHash.toLowerCase() !== account.pendingFrame.stateHash.toLowerCase()
      ) {
        throw new Error(`BOARD_REHANKO_PENDING_MIGRATION_MISMATCH:${update.counterpartyId}`);
      }
      account.pendingAccountInput = cloneIsolatedAccountInput(pendingInput);
      const bundledAck = accountInputAck(pendingInput);
      if (bundledAck && account.lastOutboundFrameAck) {
        const cachedAck = accountInputAck(account.lastOutboundFrameAck.response);
        if (
          !cachedAck ||
          Number(cachedAck.height) !== Number(bundledAck.height) ||
          cachedAck.frameHash.toLowerCase() !== bundledAck.frameHash.toLowerCase()
        ) {
          throw new Error(`BOARD_REHANKO_BUNDLED_ACK_CACHE_MISMATCH:${update.counterpartyId}`);
        }
        const refreshedAck = cloneIsolatedAccountInput(account.lastOutboundFrameAck.response);
        delete refreshedAck.ack.frameHanko;
        if (refreshedAck.ack.disputeSeal) delete refreshedAck.ack.disputeSeal.hanko;
        account.lastOutboundFrameAck.response = refreshedAck;
      }
    } else if (update.reHanko?.target === 'lastOutboundFrameAck') {
      const ack = accountInputAck(update.reHanko.input);
      if (
        !account.lastOutboundFrameAck ||
        !ack ||
        Number(ack.height) !== Number(account.lastOutboundFrameAck.height)
      ) {
        throw new Error(`BOARD_REHANKO_ACK_MIGRATION_MISMATCH:${update.counterpartyId}`);
      }
      account.lastOutboundFrameAck.response = cloneIsolatedAccountInput(update.reHanko.input) as
        typeof account.lastOutboundFrameAck.response;
    }
    if (update.marker) account.boardResealMigration = { ...update.marker };
    else delete account.boardResealMigration;
  }
};

const buildBoardRotationResealDraftsForActivation = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  activation: BoardResealActivation,
  options: {
    afterCounterpartyId?: string;
    pendingOnly?: boolean;
  } = {},
): BoardRotationResealDrafts => {
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
      return accountNeedsBoardResealForActivation(account, activation);
    })
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

  const batch = orderedAccounts.slice(0, MAX_BOARD_RESEALS_PER_FRAME);

  for (const [counterpartyId, account] of batch) {
    const draft = buildAccountResealDraft(state, store, activation, counterpartyId, account, position);
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
    // and are re-armed by scheduleChangedAccountBoardReseals when that Account
    // actually changes. Polling them every second creates an infinite wake
    // loop while adding no new evidence.
    retryRequired: accountMigrations.some(update =>
      update.marker?.reason === 'output-route-unavailable'),
    nextAfterCounterpartyId: batch.at(-1)?.[0] ?? String(options.afterCounterpartyId ?? '').toLowerCase(),
  };
};

/** Build at most one bounded frame of Account hashes already certified by both parties. */
export const buildBoardRotationResealDrafts = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  event: BoardActivatedEvent,
  options: {
    afterCounterpartyId?: string;
    pendingOnly?: boolean;
  } = {},
): BoardRotationResealDrafts => buildBoardRotationResealDraftsForActivation(
  state,
  store,
  boardResealActivation(event),
  options,
);

export const buildPendingBoardRotationResealDrafts = (
  state: EntityState,
  store: CertifiedBoardNodeStore,
  activation: BoardResealActivation,
  afterCounterpartyId = '',
): BoardRotationResealDrafts => buildBoardRotationResealDraftsForActivation(state, store, activation, {
  afterCounterpartyId,
  pendingOnly: true,
});
