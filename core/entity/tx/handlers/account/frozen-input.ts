import type { AccountInput, AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import {
  accountInputAck,
  accountInputProposal,
  accountInputReferenceHeight,
} from '../../../../account/consensus/flush';
import { createStructuredLogger, shortId } from '../../../../support/logger';
import { addMessage } from '../../../frame-events';

const accountHandlerLog = createStructuredLogger('account.handler');

export const frozenAccountInputLogLevel = (
  account: Pick<AccountReplica, 'status' | 'activeDispute'>,
  input: Pick<AccountInput, 'kind'>,
): 'info' | 'warn' | 'error' => {
  // Reliable transport can legitimately retry a signed ACK after local
  // dispute preparation. Keep it visible without misclassifying the no-op as
  // a Runtime fault; the frozen gate still rejects it before mutation.
  if (input.kind === 'ack') return 'warn';
  const durableOnchainFreeze =
    account.status === 'disputed' &&
    (account.activeDispute?.observedOnChain === true || account.activeDispute === undefined);
  return durableOnchainFreeze && input.kind === 'ack_frame' ? 'info' : 'error';
};

export const rejectFrozenAccountInput = (
  state: EntityState,
  account: AccountReplica,
  input: AccountInput,
  counterpartyId: string,
): boolean => {
  // Finalization removes activeDispute but deliberately leaves the Account
  // permanently closed. No ordinary peer frame may cross this fence. A future
  // recovery mechanism must use a new, bilateral, domain-separated protocol.
  if ((account.status ?? 'active') === 'active') return false;
  const incomingProposal = accountInputProposal(input);
  const incomingAck = accountInputAck(input);
  const proposalTxTypes = incomingProposal?.frame.accountTxs.map(tx => tx.type) ?? [];
  const pendingAckTxTypes = incomingAck
    ? account.pendingFrame?.accountTxs.map(tx => tx.type) ?? []
    : [];
  const frameTxTypes = proposalTxTypes.length > 0 ? proposalTxTypes : pendingAckTxTypes;

  const severity = frozenAccountInputLogLevel(account, input);
  const logFrozenInput = severity === 'info'
    ? accountHandlerLog.info
    : severity === 'warn'
      ? accountHandlerLog.warn
      : accountHandlerLog.error;
  logFrozenInput('input.dropped_frozen_account', {
    counterparty: shortId(counterpartyId),
    height: accountInputReferenceHeight(input) ?? null,
    txs: frameTxTypes,
    ack: Boolean(incomingAck),
  });
  addMessage(
    state,
    `🛑 Frozen account input dropped for ${counterpartyId.slice(-4)} ` +
      `(height=${accountInputReferenceHeight(input) ?? 'n/a'}, ` +
      `txs=[${frameTxTypes.join(',')}], ack=${Boolean(incomingAck)})`,
  );
  return true;
};
