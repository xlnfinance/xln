import type { AccountPeerInput, AccountReplica } from '../../types/account';
import type { RuntimeEntityInputsEnvelope } from '../../runtime/types';
import { accountInputAck, accountInputProposal } from '../../account/consensus/flush';
import { safeStringify } from '../../protocol/serialization';

export type AccountDeliveryHop =
  | 'committed-output'
  | 'p2p-route'
  | 'ws-send-start'
  | 'ws-send-flushed'
  | 'direct-decoded'
  | 'direct-admitted'
  | 'runtime-mempool'
  | 'account-apply-start'
  | 'account-apply-done';

const traceEnabled = (): boolean =>
  typeof process !== 'undefined' && process.env?.['XLN_P2P_DELIVERY_TRACE'] === '1';

const accountInputRow = (input: AccountPeerInput): Record<string, unknown> => {
  const proposal = accountInputProposal(input);
  const ack = accountInputAck(input);
  return {
    kind: input.kind,
    fromEntityId: input.fromEntityId,
    toEntityId: input.toEntityId,
    proposalHeight: proposal?.frame.height ?? null,
    proposalHash: proposal?.frame.stateHash ?? null,
    ackHeight: ack?.height ?? null,
    ackHash: ack?.frameHash ?? null,
  };
};

const envelopeAccountInputs = (envelope: RuntimeEntityInputsEnvelope): AccountPeerInput[] =>
  envelope.entityInputs.flatMap(entityInput =>
    (entityInput.entityTxs ?? []).flatMap(tx => tx.type === 'accountInput' ? [tx.data] : []));

export const traceAccountDeliveryHop = (
  hop: AccountDeliveryHop,
  envelope: RuntimeEntityInputsEnvelope,
  fields: Record<string, unknown> = {},
): void => {
  if (!traceEnabled()) return;
  const accountInputs = envelopeAccountInputs(envelope);
  if (accountInputs.length === 0) return;
  console.log(safeStringify({
    type: 'XLN_ACCOUNT_DELIVERY_TRACE',
    atMs: Date.now(),
    hop,
    // The Runtime envelope signature binds source, target and exact canonical
    // inputs, so it is the zero-copy correlation id shared by every wire hop.
    deliveryId: envelope.sourceSignature,
    sourceRuntimeId: envelope.sourceRuntimeId,
    sourceRuntimeHeight: envelope.sourceRuntimeHeight,
    sourceRuntimeTimestamp: envelope.sourceRuntimeTimestamp,
    accountInputs: accountInputs.map(accountInputRow),
    ...fields,
  }));
};

export const traceAccountApplyHop = (
  hop: 'account-apply-start' | 'account-apply-done',
  input: AccountPeerInput,
  fields: Record<string, unknown> = {},
): void => {
  if (!traceEnabled()) return;
  console.log(safeStringify({
    type: 'XLN_ACCOUNT_DELIVERY_TRACE',
    atMs: Date.now(),
    hop,
    accountInput: accountInputRow(input),
    ...fields,
  }));
};

export const traceAccountFlushHop = (
  hop: 'entity-response-required' | 'entity-flush-start' | 'entity-flush-done',
  entityId: string,
  accountKey: string,
  account: AccountReplica,
  requiredResponse: AccountPeerInput | undefined,
  fields: Record<string, unknown> = {},
): void => {
  if (!traceEnabled()) return;
  console.log(safeStringify({
    type: 'XLN_ACCOUNT_DELIVERY_TRACE',
    atMs: Date.now(),
    hop,
    entityId,
    accountKey,
    currentHeight: account.currentHeight,
    currentHash: account.currentFrame.stateHash,
    pendingHeight: account.pendingFrame?.height ?? null,
    pendingHash: account.pendingFrame?.stateHash ?? null,
    pendingInput: account.pendingAccountInput ? accountInputRow(account.pendingAccountInput) : null,
    requiredResponse: requiredResponse ? accountInputRow(requiredResponse) : null,
    lastOutboundAckHeight: account.lastOutboundFrameAck?.height ?? null,
    rollbackCount: account.rollbackCount,
    lastRollbackFrameHash: account.lastRollbackFrameHash ?? null,
    mempoolTxTypes: account.mempool.map(tx => tx.type),
    ...fields,
  }));
};
