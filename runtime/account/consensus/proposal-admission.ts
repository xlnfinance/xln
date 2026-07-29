import type { AccountReplica, AccountTx } from '../../types/account';
import type { RuntimeState } from '../../types';
import { getAccountPerspective } from '../perspective';
import { safeStringify } from '../../protocol/serialization';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { MAX_ACCOUNT_FRAME_TXS } from './frame';
import { MEMPOOL_LIMIT } from './constants';
import type { ProposeAccountFrameResult } from './types';

const accountLog = createStructuredLogger('account');

export type ProposalAdmission = {
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

const validateProposalTimestamp = (
  env: RuntimeState,
  account: AccountReplica,
  timestamp: number,
  myEntityId: string,
  counterparty: string,
): void => {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`ACCOUNT_PROPOSAL_ENTITY_TIMESTAMP_INVALID:${String(timestamp)}`);
  }
  const previous = account.currentFrame?.timestamp ?? 0;
  if (timestamp >= previous) return;
  accountLog.warn('proposal.timestamp_regressed_accepted', {
    accountHeight: account.currentHeight,
    entityId: myEntityId,
    counterpartyEntityId: counterparty,
    previousTimestamp: previous,
    proposedTimestamp: timestamp,
    regressionMs: previous - timestamp,
    runtimeTimestamp: env.timestamp,
  });
};

const rejectUnavailableProposal = (
  account: AccountReplica,
  quiet: boolean,
  events: string[],
): ProposeAccountFrameResult | null => {
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
  env: RuntimeState,
  account: AccountReplica,
  entityFrameTimestamp: number,
  entityJHeight: number | undefined,
  selectedMempoolTxs: readonly AccountTx[] | undefined,
): ProposalAdmissionResult => {
  const myEntityId = account.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(account, myEntityId);
  const quiet = env.quietRuntimeLogs === true;
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
  validateProposalTimestamp(env, account, entityFrameTimestamp, myEntityId, counterparty);
  return {
    success: true,
    myEntityId,
    counterparty,
    quiet,
    events,
    proposalWindow,
    frameTimestamp: entityFrameTimestamp,
    frameJHeight: entityJHeight ?? account.lastFinalizedJHeight ?? 0,
  };
};
