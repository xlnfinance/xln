import { normalizeEntityRef } from '../../account-key';
import type { AccountPeerInput, AccountReplica } from '../../../../types/account';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import type { EntityState } from '../../../types';
import {
  accountStateDomainFromJurisdiction,
  computeAccountStateRoot,
  EMPTY_ACCOUNT_STATE_ROOT,
  normalizeAccountStateDomain,
  sameAccountStateDomain,
} from '../../../../account/commitment/state-root';
import { isAccountWatchSeed } from '../../../../protocol/identity/account-watch-seed';
import {
  DEFAULT_ACCOUNT_TOKEN_IDS,
  resolveJurisdictionRebalanceDefaults,
} from '../../../../account/config/defaults';
import { createEmptyAccountJClaimAccumulator } from '../../../../account/j-claims/j-claim-accumulator';
import {
  accountInputReferenceHeight,
} from '../../../../account/consensus/flush';
import { getAccountInputEnvelopeError } from '../../../../account/input';
import {
  AccountPeerEvidenceError,
  type AccountPeerRejectionCode,
} from '../../../../account/input/peer-rejection';
import { createStructuredLogger, shortId } from '../../../../support/logger';
import { addMessage } from '../../../frame-events';
import { getEntityAccountForWrite } from '../../../state/persistent-account-map';
import { isLeftEntity } from '../../../id';
import { canonicalAccountDisputeConfig } from '../../../../account/config/dispute-config';

const accountHandlerLog = createStructuredLogger('account.handler');
const rejectPeerInput = (code: AccountPeerRejectionCode, reason: string): never => {
  throw new AccountPeerEvidenceError(code, reason);
};

export type InboundAccountResolution = {
  account: AccountReplica;
  counterpartyId: string;
  createdAccount: boolean;
};

const findAccountKey = (
  accounts: ReadonlyMap<string, AccountReplica>,
  counterpartyId: string,
): string | null => {
  const target = normalizeEntityRef(counterpartyId);
  return accounts.has(target) ? target : null;
};

const assertAccountInputParticipants = (
  state: EntityState,
  input: AccountPeerInput,
): string => {
  if (normalizeEntityRef(input.toEntityId) !== normalizeEntityRef(state.entityId)) {
    return rejectPeerInput(
      'ACCOUNT_PEER_PARTY_MISMATCH',
      `ACCOUNT_INPUT_WRONG_TARGET: expected=${shortId(state.entityId)} got=${shortId(input.toEntityId)}`,
    );
  }
  if (normalizeEntityRef(input.fromEntityId) === normalizeEntityRef(state.entityId)) {
    return rejectPeerInput(
      'ACCOUNT_PEER_PARTY_MISMATCH',
      `ACCOUNT_INPUT_SELF_SENDER: entity=${shortId(state.entityId)}`,
    );
  }
  return normalizeEntityRef(input.fromEntityId);
};

const resolveInboundAccountDomain = (
  state: EntityState,
  input: AccountPeerInput,
  counterpartyId: string,
): AccountReplica['state']['domain'] => {
  if (input.domain === undefined) {
    return rejectPeerInput(
      'ACCOUNT_PEER_DOMAIN_INVALID',
      `ACCOUNT_INPUT_DOMAIN_REQUIRED:${counterpartyId}`,
    );
  }
  let domain: AccountReplica['state']['domain'];
  try {
    domain = normalizeAccountStateDomain(input.domain, 'ACCOUNT_INPUT_DOMAIN');
  } catch {
    return rejectPeerInput(
      'ACCOUNT_PEER_DOMAIN_INVALID',
      `ACCOUNT_INPUT_DOMAIN_INVALID:${counterpartyId}`,
    );
  }
  const jurisdiction = state.config?.jurisdiction;
  if (!jurisdiction) {
    throw new Error(`ACCOUNT_STATE_DOMAIN_MISSING: entity=${shortId(state.entityId)}`);
  }
  if (!sameAccountStateDomain(domain, accountStateDomainFromJurisdiction(jurisdiction))) {
    return rejectPeerInput(
      'ACCOUNT_PEER_DOMAIN_MISMATCH',
      `ACCOUNT_INPUT_DOMAIN_MISMATCH:${counterpartyId}`,
    );
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
  const runtimeKind = (input as { kind?: unknown }).kind;
  if (!['frame', 'ack', 'frame_ack', 'dispute', 'board_reseal'].includes(String(runtimeKind))) {
    const error =
      `ACCOUNT_GENESIS_FRAME_REQUIRED: entity=${shortId(state.entityId)} ` +
      `counterparty=${shortId(counterpartyId)} inputHeight=0`;
    addMessage(state, error);
    throw new Error(error);
  }
  if ((hasAck && !hasProposal) || input.kind === 'board_reseal') {
    const code = input.kind === 'board_reseal'
      ? 'ACCOUNT_BOARD_RESEAL_UNKNOWN_ACCOUNT'
      : 'ACCOUNT_INPUT_ACK_FOR_UNKNOWN_ACCOUNT';
    return rejectPeerInput(
      input.kind === 'board_reseal'
        ? 'ACCOUNT_PEER_BOARD_RESEAL_INVALID'
        : 'ACCOUNT_PEER_ACK_UNMATCHED',
      `${code}: from=${input.fromEntityId.slice(-8)} to=${input.toEntityId.slice(-8)}`,
    );
  }
  const incomingFrameHeight = Number(accountInputReferenceHeight(input) ?? 0);
  if (hasProposal && incomingFrameHeight === 1) return;
  const code = incomingFrameHeight > 1 ? 'ACCOUNT_SYNC_REQUIRED' : 'ACCOUNT_GENESIS_FRAME_REQUIRED';
  const error =
    `${code}: entity=${shortId(state.entityId)} ` +
    `counterparty=${shortId(counterpartyId)} inputHeight=${incomingFrameHeight}`;
  return rejectPeerInput('ACCOUNT_PEER_FRAME_CHAIN_INVALID', error);
};

const createInboundAccountState = (
  state: EntityState,
  counterpartyId: string,
  domain: AccountReplica['state']['domain'],
  watchSeed: string,
  disputeConfig: AccountReplica['state']['disputeConfig'],
): AccountReplica => {
  const leftEntity = isLeftEntity(state.entityId, counterpartyId)
    ? state.entityId
    : counterpartyId;
  const rightEntity = isLeftEntity(state.entityId, counterpartyId)
    ? counterpartyId
    : state.entityId;
  const account: AccountReplica = {
    state: {
      leftEntity,
      rightEntity,
      domain,
      watchSeed,
      deltas: PersistentAccountStateMap.empty('deltas'),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      pulls: PersistentAccountStateMap.empty('pulls'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig: canonicalAccountDisputeConfig(disputeConfig),
      jNonce: 0,
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
    },
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
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: {
      fromEntity: state.entityId,
      toEntity: counterpartyId,
      nextProofNonce: 1,
    },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.fromEntries(
          'rebalanceShadowPolicy',
          DEFAULT_ACCOUNT_TOKEN_IDS.map(tokenId => [
            tokenId,
            resolveJurisdictionRebalanceDefaults(state.config.jurisdiction, tokenId),
          ] as const),
        ),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
  // The inbound replica knows its complete genesis Account state, so it can
  // commit accountStateRoot immediately. It still has no signed Account frame:
  // stateHash remains empty until bilateral consensus accepts H=1.
  account.currentFrame.accountStateRoot = computeAccountStateRoot(account.state, undefined, 'inboundGenesis');
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
  const existing = existingKey ? getEntityAccountForWrite(state.accounts, existingKey) : undefined;
  if (existing) {
    const envelopeError = getAccountInputEnvelopeError(existing.state, input);
    if (envelopeError) return rejectPeerInput(envelopeError.code, envelopeError.reason);
    return { account: existing, counterpartyId, createdAccount: false };
  }
  assertUnknownAccountGenesis(state, input, counterpartyId, hasAck, hasProposal);
  const domain = resolveInboundAccountDomain(state, input, counterpartyId);
  if (!isAccountWatchSeed(input.watchSeed)) {
    return rejectPeerInput(
      'ACCOUNT_PEER_WATCH_SEED_INVALID',
      `ACCOUNT_INPUT:ACCOUNT_WATCH_SEED_INVALID:${counterpartyId}`,
    );
  }
  const watchSeed = input.watchSeed.toLowerCase();
  accountHandlerLog.debug('machine.create', { counterparty: shortId(counterpartyId) });
  const account = createInboundAccountState(
    state,
    counterpartyId,
    domain,
    watchSeed,
    canonicalAccountDisputeConfig(input.disputeConfig),
  );
  accountHandlerLog.debug('machine.candidate_created', { counterparty: shortId(counterpartyId) });
  return { account, counterpartyId, createdAccount: true };
};
