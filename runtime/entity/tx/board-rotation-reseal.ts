import type {
  AccountBoardResealMigration,
  AccountDisputeSeal,
  AccountMachine,
  EntityInput,
  EntityState,
  Env,
  HashToSign,
  JurisdictionEvent,
} from '../../types';
import { resolveObserverCertifiedAccountCounterpartyProposer } from '../../account/counterparty-route';
import { buildCrossJurisdictionEntityOutput } from './cross-j-outputs';

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
};

type AccountResealDraft = {
  output?: EntityInput;
  hashesToSign: HashToSign[];
  migration: BoardRotationAccountMigration;
};

type ActivationPosition = readonly [jHeight: number, logIndex: number];

export const MAX_BOARD_RESEALS_PER_FRAME = 32;
export const BOARD_RESEAL_HOOK_ID = 'board-reseal';
export const BOARD_RESEAL_RETRY_MS = 1_000;

const bytes32 = (value: string): boolean => /^0x[0-9a-f]{64}$/.test(value.toLowerCase());

const hasAnyDisputeSealEvidence = (account: AccountMachine): boolean => Boolean(
  account.currentDisputeProofHanko ||
  account.counterpartyDisputeProofHanko ||
  account.currentDisputeHash ||
  account.counterpartyDisputeHash ||
  account.currentDisputeProofBodyHash ||
  account.counterpartyDisputeProofBodyHash ||
  account.currentDisputeProofNonce !== undefined ||
  account.counterpartyDisputeProofNonce !== undefined
);

type DisputeSealDraft = {
  seal?: AccountDisputeSeal;
  issue?: AccountBoardResealMigration['reason'];
};

const exactBilateralDisputeSeal = (account: AccountMachine): DisputeSealDraft => {
  if (!hasAnyDisputeSealEvidence(account)) return {};
  const localHash = account.currentDisputeHash?.toLowerCase();
  const remoteHash = account.counterpartyDisputeHash?.toLowerCase();
  const localBody = account.currentDisputeProofBodyHash?.toLowerCase();
  const remoteBody = account.counterpartyDisputeProofBodyHash?.toLowerCase();
  const localNonce = account.currentDisputeProofNonce;
  const remoteNonce = account.counterpartyDisputeProofNonce;
  if (
    !account.currentDisputeProofHanko ||
    !account.counterpartyDisputeProofHanko ||
    !localHash ||
    !localBody ||
    localHash !== remoteHash ||
    localBody !== remoteBody ||
    localNonce !== remoteNonce
  ) return { issue: 'bilateral-dispute-uncertified' };
  if (!bytes32(localHash) || !bytes32(localBody) || !Number.isSafeInteger(localNonce) || localNonce! < 0) {
    return { issue: 'certified-dispute-invalid' };
  }
  return { seal: { hash: localHash, proofBodyHash: localBody, proofNonce: localNonce! } };
};

const accountFrameIssue = (
  state: EntityState,
  counterpartyId: string,
  account: AccountMachine,
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
): BoardRotationAccountMigration => ({
  counterpartyId,
  marker: reason ? { activationJHeight, activationLogIndex, reason } : null,
});

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

export const boardResealActivation = (event: BoardActivatedEvent): BoardResealActivation => {
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
  for (const [rawCounterpartyId, account] of state.accounts) {
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
  env: Env,
  counterpartyId: string,
  account: AccountMachine,
  input: NonNullable<EntityInput['entityTxs']>,
): EntityInput | undefined => {
  try {
    const signerId = resolveObserverCertifiedAccountCounterpartyProposer(
      env,
      state,
      account,
      counterpartyId,
    );
    if (!signerId) return undefined;
    return buildCrossJurisdictionEntityOutput(env, counterpartyId, input, signerId);
  } catch (error) {
    // An absent/non-authoritative bilateral witness is retryable. Corrupt
    // Account identity, frame hashes, or certified Patricia nodes remain loud.
    if (error instanceof Error && error.message.startsWith('HANKO_')) {
      return undefined;
    }
    throw error;
  }
};

const buildCertifiedAccountResealDraft = (
  state: EntityState,
  env: Env,
  activation: BoardResealActivation,
  counterpartyId: string,
  account: AccountMachine,
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
  const output = buildResealOutput(state, env, counterpartyId, account, [{
    type: 'accountInput',
    data: {
      kind: 'board_reseal',
      fromEntityId: state.entityId,
      toEntityId: counterpartyId,
      domain: structuredClone(account.domain),
      reseal,
    },
  }]);
  const issue = output ? null : 'output-route-unavailable';
  const context = `board-reseal:${activation.jHeight}:${activation.logIndex}:${counterpartyId}`;
  const hashesToSign: HashToSign[] = output
    ? [{ hash: frameHash, type: 'accountFrame', context: `${context}:frame` }]
    : [];
  if (output && dispute.seal) {
    hashesToSign.push({ hash: dispute.seal.hash, type: 'dispute', context: `${context}:dispute` });
  }
  return { ...(output ? { output } : {}), hashesToSign, migration: migration(counterpartyId, ...position, issue) };
};

const buildAccountResealDraft = (
  state: EntityState,
  env: Env,
  activation: BoardResealActivation,
  counterpartyId: string,
  account: AccountMachine,
  position: ActivationPosition,
): AccountResealDraft => {
  if (Number(account.currentHeight) < 1) {
    return { hashesToSign: [], migration: migration(counterpartyId, ...position, null) };
  }
  const issue = accountFrameIssue(state, counterpartyId, account);
  if (issue) return { hashesToSign: [], migration: migration(counterpartyId, ...position, issue) };
  return buildCertifiedAccountResealDraft(state, env, activation, counterpartyId, account, position);
};

export const applyBoardRotationResealMigrations = (
  state: EntityState,
  updates: readonly BoardRotationAccountMigration[],
): void => {
  for (const update of updates) {
    const account = state.accounts.get(update.counterpartyId);
    if (!account) throw new Error(`BOARD_RESEAL_MIGRATION_ACCOUNT_MISSING:${update.counterpartyId}`);
    if (update.marker) account.boardResealMigration = { ...update.marker };
    else delete account.boardResealMigration;
  }
};

const buildBoardRotationResealDraftsForActivation = (
  state: EntityState,
  env: Env,
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
      return account.boardResealMigration?.activationJHeight === position[0] &&
        account.boardResealMigration.activationLogIndex === position[1];
    })
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

  const batch = orderedAccounts.slice(0, MAX_BOARD_RESEALS_PER_FRAME);

  for (const [counterpartyId, account] of batch) {
    const draft = buildAccountResealDraft(state, env, activation, counterpartyId, account, position);
    if (draft.output) outputs.push(draft.output);
    hashesToSign.push(...draft.hashesToSign);
    accountMigrations.push(draft.migration);
  }
  return {
    outputs,
    hashesToSign,
    accountMigrations,
    hasMore: orderedAccounts.length > batch.length,
    retryRequired: accountMigrations.some(update => update.marker !== null),
    nextAfterCounterpartyId: batch.at(-1)?.[0] ?? String(options.afterCounterpartyId ?? '').toLowerCase(),
  };
};

/** Build at most one bounded frame of Account hashes already certified by both parties. */
export const buildBoardRotationResealDrafts = (
  state: EntityState,
  env: Env,
  event: BoardActivatedEvent,
  options: {
    afterCounterpartyId?: string;
    pendingOnly?: boolean;
  } = {},
): BoardRotationResealDrafts => buildBoardRotationResealDraftsForActivation(
  state,
  env,
  boardResealActivation(event),
  options,
);

export const buildPendingBoardRotationResealDrafts = (
  state: EntityState,
  env: Env,
  activation: BoardResealActivation,
  afterCounterpartyId = '',
): BoardRotationResealDrafts => buildBoardRotationResealDraftsForActivation(state, env, activation, {
  afterCounterpartyId,
  pendingOnly: true,
});
