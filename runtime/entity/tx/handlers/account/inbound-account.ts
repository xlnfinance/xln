import type { AccountPeerInput, AccountState, EntityState } from '../../../../types';
import {
  accountStateDomainFromJurisdiction,
  computeAccountStateRoot,
  EMPTY_ACCOUNT_STATE_ROOT,
  normalizeAccountStateDomain,
  sameAccountStateDomain,
} from '../../../../account/state-root';
import { normalizeAccountWatchSeed } from '../../../../account/watch-seed';
import { DEFAULT_ACCOUNT_TOKEN_IDS } from '../../../../account/default-tokens';
import { resolveJurisdictionRebalanceDefaults } from '../../../../account/rebalance-policy-defaults';
import { createEmptyAccountJClaimAccumulator } from '../../../../account/j-claim-accumulator';
import {
  accountInputReferenceHeight,
} from '../../../../account/consensus/flush';
import { createStructuredLogger, shortId } from '../../../../infra/logger';
import { addMessage } from '../../../../state-helpers';
import { assertEntityAccountInsertionCapacity } from '../../../account-capacity';
import { isLeftEntity } from '../../../id';

const accountHandlerLog = createStructuredLogger('account.handler');
const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

export type InboundAccountResolution = {
  accountMachine: AccountState;
  counterpartyId: string;
  createdAccount: boolean;
};

const findAccountKey = (
  accounts: Map<string, AccountState>,
  counterpartyId: string,
): string | null => {
  const target = normalizeEntityRef(counterpartyId);
  for (const key of accounts.keys()) {
    if (normalizeEntityRef(key) === target) return key;
  }
  return null;
};

const assertAccountInputParticipants = (
  state: EntityState,
  input: AccountPeerInput,
): string => {
  if (normalizeEntityRef(input.toEntityId) !== normalizeEntityRef(state.entityId)) {
    throw new Error(
      `ACCOUNT_INPUT_WRONG_TARGET: expected=${shortId(state.entityId)} got=${shortId(input.toEntityId)}`,
    );
  }
  if (normalizeEntityRef(input.fromEntityId) === normalizeEntityRef(state.entityId)) {
    throw new Error(`ACCOUNT_INPUT_SELF_SENDER: entity=${shortId(state.entityId)}`);
  }
  return normalizeEntityRef(input.fromEntityId);
};

const resolveInboundAccountDomain = (
  state: EntityState,
  input: AccountPeerInput,
  counterpartyId: string,
  existing: AccountState | undefined,
): AccountState['domain'] => {
  if (input.domain === undefined) throw new Error(`ACCOUNT_INPUT_DOMAIN_REQUIRED:${counterpartyId}`);
  const domain = normalizeAccountStateDomain(input.domain, 'ACCOUNT_INPUT_DOMAIN');
  if (existing) {
    if (!sameAccountStateDomain(domain, existing.domain)) {
      throw new Error(`ACCOUNT_DOMAIN_CHANGED:${counterpartyId}`);
    }
    return domain;
  }
  const jurisdiction = state.config?.jurisdiction;
  if (!jurisdiction) {
    throw new Error(`ACCOUNT_STATE_DOMAIN_MISSING: entity=${shortId(state.entityId)}`);
  }
  if (!sameAccountStateDomain(domain, accountStateDomainFromJurisdiction(jurisdiction))) {
    throw new Error(`ACCOUNT_INPUT_DOMAIN_MISMATCH:${counterpartyId}`);
  }
  return domain;
};

const assertUnknownAccountGenesis = (
  state: EntityState,
  input: AccountPeerInput,
  counterpartyId: string,
  hasAck: boolean,
  hasProposal: boolean,
): void => {
  if ((hasAck && !hasProposal) || input.kind === 'board_reseal') {
    const code = input.kind === 'board_reseal'
      ? 'ACCOUNT_BOARD_RESEAL_UNKNOWN_ACCOUNT'
      : 'ACCOUNT_INPUT_ACK_FOR_UNKNOWN_ACCOUNT';
    throw new Error(
      `${code}: from=${input.fromEntityId.slice(-8)} to=${input.toEntityId.slice(-8)}`,
    );
  }
  const incomingFrameHeight = Number(accountInputReferenceHeight(input) ?? 0);
  if (hasProposal && incomingFrameHeight === 1) return;
  const code = incomingFrameHeight > 1 ? 'ACCOUNT_SYNC_REQUIRED' : 'ACCOUNT_GENESIS_FRAME_REQUIRED';
  const error =
    `${code}: entity=${shortId(state.entityId)} ` +
    `counterparty=${shortId(counterpartyId)} inputHeight=${incomingFrameHeight}`;
  addMessage(state, error);
  throw new Error(error);
};

const createInboundAccountMachine = (
  state: EntityState,
  counterpartyId: string,
  domain: AccountState['domain'],
  watchSeed: string,
): AccountState => {
  const leftEntity = isLeftEntity(state.entityId, counterpartyId)
    ? state.entityId
    : counterpartyId;
  const rightEntity = isLeftEntity(state.entityId, counterpartyId)
    ? counterpartyId
    : state.entityId;
  const account: AccountState = {
    leftEntity,
    rightEntity,
    domain,
    watchSeed,
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: EMPTY_ACCOUNT_STATE_ROOT,
      deltas: [],
      stateHash: '',
      byLeft: state.entityId === leftEntity,
    },
    deltas: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: {
      fromEntity: state.entityId,
      toEntity: counterpartyId,
      nextProofNonce: 1,
    },
    proofBody: { tokenIds: [], deltas: [] },
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    locks: new Map(),
    swapOffers: new Map(),
    pulls: new Map(),
    swapOrderHistory: new Map(),
    swapClosedOrders: new Map(),
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 576, rightDisputeDelay: 576 },
    jNonce: 0,
  };
  for (const tokenId of DEFAULT_ACCOUNT_TOKEN_IDS) {
    account.shadow.rebalance.policy.set(
      tokenId,
      resolveJurisdictionRebalanceDefaults(state, tokenId),
    );
  }
  account.currentFrame.accountStateRoot = computeAccountStateRoot(account);
  account.currentFrame.stateHash = account.currentFrame.accountStateRoot;
  return account;
};

export const resolveInboundAccount = (
  state: EntityState,
  input: AccountPeerInput,
  hasAck: boolean,
  hasProposal: boolean,
): InboundAccountResolution => {
  const counterpartyId = assertAccountInputParticipants(state, input);
  const existingKey = findAccountKey(state.accounts, counterpartyId);
  const existing = existingKey ? state.accounts.get(existingKey) : undefined;
  if (!existing) {
    assertEntityAccountInsertionCapacity(
      state.accounts,
      counterpartyId,
      `accountInput:${state.entityId}`,
    );
  }
  const domain = resolveInboundAccountDomain(state, input, counterpartyId, existing);
  const inputWatchSeed = input.watchSeed === undefined
    ? undefined
    : normalizeAccountWatchSeed(input.watchSeed, 'ACCOUNT_INPUT');
  if (existing) {
    if (inputWatchSeed && existing.watchSeed.toLowerCase() !== inputWatchSeed) {
      throw new Error(`ACCOUNT_WATCH_SEED_MISMATCH:${counterpartyId}`);
    }
    return { accountMachine: existing, counterpartyId, createdAccount: false };
  }

  assertUnknownAccountGenesis(state, input, counterpartyId, hasAck, hasProposal);
  const watchSeed = normalizeAccountWatchSeed(inputWatchSeed, 'ACCOUNT_INPUT_GENESIS');
  accountHandlerLog.debug('machine.create', { counterparty: shortId(counterpartyId) });
  const accountMachine = createInboundAccountMachine(state, counterpartyId, domain, watchSeed);
  accountHandlerLog.debug('machine.candidate_created', { counterparty: shortId(counterpartyId) });
  return { accountMachine, counterpartyId, createdAccount: true };
};
