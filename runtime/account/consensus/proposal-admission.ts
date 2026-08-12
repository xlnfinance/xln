import type { AccountReplica, AccountTx } from '../../types/account';
import { getAccountPerspective } from '../state/perspective';
import { safeStringify } from '../../protocol/serialization';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { MAX_ACCOUNT_FRAME_TXS } from './frame';
import { MEMPOOL_LIMIT } from './constants';
import type { ProposeAccountFrameResult } from './types';

const accountLog = createStructuredLogger('account');

type ProposalAdmission = {
  success: true;
  myEntityId: string;
  counterparty: string;
  quiet: boolean;
  events: string[];
  proposalWindow: AccountTx[];
  frameTimestamp: number;
  frameJHeight: number;
};

export type ProposalAdmissionResult =
  | ProposalAdmission
  | { success: false; result: ProposeAccountFrameResult };

export type AccountProposalAdmissionContext = Readonly<{
  runtimeTimestamp: number;
  quietLogs: boolean;
}>;

const selectProposalWindow = (
  account: AccountReplica,
  selected: readonly AccountTx[] | undefined,
): AccountTx[] => {
  const source = selected ?? account.mempool;
  if (source.length === 0) throw new Error('ACCOUNT_PROPOSAL_SELECTION_EMPTY');
  if (source.length > MAX_ACCOUNT_FRAME_TXS) {
    throw new Error(`ACCOUNT_PROPOSAL_SELECTION_TOO_LARGE:${source.length}`);
  }
  if (selected) {
    const remaining = new Map<string, number>();
    for (const tx of account.mempool) {
      const key = safeStringify(tx);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const tx of selected) {
      const key = safeStringify(tx);
      const count = remaining.get(key) ?? 0;
      if (count === 0) throw new Error('ACCOUNT_PROPOSAL_SELECTION_NOT_IN_MEMPOOL');
      remaining.set(key, count - 1);
    }
  }
  return [...source];
};

const validateProposalTimestamp = (timestamp: number): void => {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`ACCOUNT_PROPOSAL_ENTITY_TIMESTAMP_INVALID:${String(timestamp)}`);
  }
};

const rejectUnavailableProposal = (
  account: AccountReplica,
  quiet: boolean,
  events: string[],
): ProposeAccountFrameResult | null => {
  const status = account.status ?? 'active';
  if (status !== 'active') {
    return {
      success: false,
      error: `ACCOUNT_PROPOSAL_STATUS_FROZEN:${status}`,
      events,
    };
  }
  if (account.mempool.length > MEMPOOL_LIMIT) {
    accountLog.warn('proposal.mempool_overflow', {
      mempool: account.mempool.length,
      limit: MEMPOOL_LIMIT,
    });
    return {
      success: false,
      error: `Mempool overflow: ${account.mempool.length} > ${MEMPOOL_LIMIT}`,
      events,
    };
  }
  if (account.mempool.length === 0) {
    accountLog.debug('proposal.empty_mempool');
    return { success: false, error: 'No transactions to propose', events };
  }
  if (account.pendingFrame) {
    if (!quiet) accountLog.debug('proposal.waiting_ack', {
      pendingHeight: account.pendingFrame.height,
    });
    return { success: false, error: 'Waiting for ACK on pending frame', events };
  }
  return null;
};

export const prepareProposalAdmission = (
  context: AccountProposalAdmissionContext,
  account: AccountReplica,
  entityFrameTimestamp: number,
  entityJHeight: number | undefined,
  selectedMempoolTxs: readonly AccountTx[] | undefined,
): ProposalAdmissionResult => {
  const myEntityId = account.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(account.state, myEntityId);
  const quiet = context.quietLogs;
  if (!quiet) {
    accountLog.debug('proposal.start', {
      counterparty: shortId(counterparty),
      mempool: account.mempool.length,
      pendingFrame: Boolean(account.pendingFrame),
      height: account.currentHeight,
    });
  }
  const events: string[] = [];
  const unavailable = rejectUnavailableProposal(account, quiet, events);
  if (unavailable) return { success: false, result: unavailable };

  // Both sides may propose their independently observed J claim. Requiring a
  // previously committed peer claim here would deadlock bilateral finality;
  // the proof-verified Account transition is the only 2-of-2 gate.
  const proposalWindow = selectProposalWindow(account, selectedMempoolTxs);
  if (!quiet) {
    accountLog.info('proposal.frame_create', {
      txs: proposalWindow.map(tx => tx.type),
      mempool: account.mempool.length,
      frameMax: MAX_ACCOUNT_FRAME_TXS,
    });
  }
  // Dual-Runtime peers advance Entity clocks independently. A lagging
  // proposer must not mint an Account frame behind the already-committed
  // bilateral watermark — clamp to the watermark (receiver-side skew checks
  // in incoming-preflight still reject hostile peer skew).
  const previousFrameTimestamp = account.currentFrame?.timestamp ?? 0;
  const frameTimestamp = Math.max(entityFrameTimestamp, previousFrameTimestamp);
  validateProposalTimestamp(frameTimestamp);
  return {
    success: true,
    myEntityId,
    counterparty,
    quiet,
    events,
    proposalWindow,
    frameTimestamp,
    frameJHeight: entityJHeight ?? account.state.lastFinalizedJHeight ?? 0,
  };
};
