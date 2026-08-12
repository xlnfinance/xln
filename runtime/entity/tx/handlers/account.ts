import type { AccountPeerInput } from '../../../types/account';
import type { EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import { createStructuredLogger, shortId } from '../../../infra/logger';
import {
  accountInputAck,
  accountInputProposal,
  accountInputReferenceHeight,
} from '../../../account/consensus/flush';
import type { ApplyEntityTxOptions } from '../apply';
import type { AccountConsensusContext } from '../../../account/consensus/context';
import { cumulativeMarksToPhases } from '../../../infra/performance/profile';
import { getPerfMs } from '../../../infra/time';
import { AccountPeerEvidenceError } from '../../../account/input/peer-rejection';
import { resolveInboundAccount } from './account/inbound-account';
import { rejectFrozenAccountInput } from './account/frozen-input';
import type { CommittedAccountEffects } from './account/committed-input';
import {
  applyAccountConsensusInput,
  type AccountInputPhaseContext,
} from './account/input-phases';
import {
  buildAccountHandlerResult,
  type AccountHandlerResult,
} from './account/result';
import { addMessage } from '../../frame-events';

export {
  canProcessFrozenAccountInput,
  frozenAccountInputLogLevel,
} from './account/frozen-input';
export type { AccountHandlerResult } from './account/result';
export type { AccountTxTarget } from './account/orderbook-queue';
export {
  collectCommittedCrossJurisdictionCancelAcks,
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
} from './account/orderbook-cancels';
export { processOrderbookSwaps } from './account/orderbook-matching';
export type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './account/orderbook-offers';
export { applyCommittedAccountFrameFollowups } from './account/committed-frame-followups';

const accountHandlerLog = createStructuredLogger('account.handler');
const ACCOUNT_INPUT_PROFILE = typeof process !== 'undefined' && (
  process.env?.['XLN_ACCOUNT_INPUT_PROFILE'] === '1' ||
  process.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1'
);
const ACCOUNT_INPUT_SLOW_MS = Math.max(
  0,
  Number(typeof process !== 'undefined'
    ? process.env?.['XLN_ACCOUNT_INPUT_SLOW_MS'] || '250'
    : '250'),
);
const accountInputProfileEnabled = (): boolean =>
  ACCOUNT_INPUT_PROFILE ||
  process.env?.['XLN_ACCOUNT_INPUT_PROFILE'] === '1' ||
  process.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const accountInputSlowMs = (): number => {
  const configured = Number(process.env?.['XLN_ACCOUNT_INPUT_SLOW_MS'] ?? ACCOUNT_INPUT_SLOW_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : ACCOUNT_INPUT_SLOW_MS;
};

const createCommittedAccountEffects = (): CommittedAccountEffects => ({
  outputs: [],
  accountTxs: [],
  swapOffersCreated: [],
  swapCancelRequests: [],
  swapOffersCancelled: [],
  candidateEffects: [],
  hashesToSign: [],
});

type AccountInputCheckpoint = (label: string) => void;

const applyAccountInputPhases = async (
  state: EntityState,
  input: AccountPeerInput,
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
  options: ApplyEntityTxOptions | undefined,
  checkpointProfile: AccountInputCheckpoint,
): Promise<AccountHandlerResult> => {
  const incomingAck = accountInputAck(input);
  const incomingProposal = accountInputProposal(input);
  accountHandlerLog.debug('input.apply', {
    from: shortId(input.fromEntityId),
    to: shortId(input.toEntityId),
    height: accountInputReferenceHeight(input),
    frame: Boolean(incomingProposal),
    prevHanko: Boolean(incomingAck),
  });

  // Entity-frame isolation already cloned state. Every phase mutates this
  // candidate and records effects; none may publish transport or storage.
  const effects = createCommittedAccountEffects();
  let resolution: ReturnType<typeof resolveInboundAccount>;
  try {
    resolution = resolveInboundAccount(
      state,
      input,
      Boolean(incomingAck),
      Boolean(incomingProposal),
    );
  } catch (error) {
    if (!(error instanceof AccountPeerEvidenceError)) throw error;
    accountHandlerLog.warn('input.rejected', {
      code: error.code,
      from: shortId(input.fromEntityId),
      error: error.message,
    });
    addMessage(state, `⚠️ Rejected account input: ${error.message}`);
    return buildAccountHandlerResult(state, effects);
  }
  const { account, counterpartyId, createdAccount } = resolution;
  checkpointProfile('accountResolve');
  if (rejectFrozenAccountInput(state, account, input, counterpartyId)) {
    return buildAccountHandlerResult(state, effects);
  }

  const context: AccountInputPhaseContext = {
    env,
    accountConsensusContext,
    state,
    input,
    account: account,
    counterpartyId,
    createdAccount,
    effects,
    ...(options ? { options } : {}),
    checkpointProfile,
  };
  checkpointProfile('preConsensus');
  const consensus = await applyAccountConsensusInput(context);
  if (consensus.terminalResult) return consensus.terminalResult;

  checkpointProfile('finalize');
  return buildAccountHandlerResult(
    state,
    effects,
    consensus.requiredAccountResponse,
    consensus.accountJClaimNodeChanges,
  );
};

const logAccountInputProfile = (
  state: EntityState,
  input: AccountPeerInput,
  outcome: string,
  startedAt: number,
  marks: Record<string, number>,
): void => {
  const elapsedMs = Math.round(getPerfMs() - startedAt);
  if (!accountInputProfileEnabled() && elapsedMs < accountInputSlowMs()) return;
  accountHandlerLog.info('input.profile', {
    entity: shortId(state.entityId, 8),
    counterparty: shortId(input.fromEntityId, 8),
    kind: input.kind,
    height: accountInputReferenceHeight(input) ?? null,
    proposalTxs: accountInputProposal(input)?.frame.accountTxs.length ?? 0,
    outcome,
    elapsedMs,
    phases: cumulativeMarksToPhases(marks, elapsedMs),
  });
};

export async function applyAccountInputToEntity(
  state: EntityState,
  input: AccountPeerInput,
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
  options?: ApplyEntityTxOptions,
): Promise<AccountHandlerResult> {
  const startedAt = getPerfMs();
  const marks: Record<string, number> = {};
  const checkpoint = (label: string): void => {
    marks[label] = Math.round(getPerfMs() - startedAt);
  };
  let outcome = 'returned';
  try {
    return await applyAccountInputPhases(
      state,
      input,
      env,
      accountConsensusContext,
      options,
      checkpoint,
    );
  } catch (error) {
    outcome = 'threw';
    throw error;
  } finally {
    logAccountInputProfile(state, input, outcome, startedAt, marks);
  }
}
