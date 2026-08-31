import type { AccountInput, AccountReplica } from '../../../../types/account';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { AccountInputDisputeRequired } from '../../../../account/consensus/types';
import { addMessage } from '../../../frame-events';
import { armPaymentSecretAckTimeout, persistVerifiedPaymentSecret } from '../../../paybook/lifecycle';
import { handlePrepareDispute } from '../dispute';
import type { CommittedAccountEffects } from './committed-input';
import { hasInboundPayment } from '../../../paybook/views';

type UnsafeFrameContext = {
  env: EntityRuntimeContext;
  state: EntityState;
  input: AccountInput;
  account: AccountReplica;
  counterpartyId: string;
  createdAccount: boolean;
  dispute: AccountInputDisputeRequired;
  effects: CommittedAccountEffects;
};

export type UnsafeFrameOutcome = {
  newState: EntityState;
  outputs: EntityInput[];
};

const persistDisputeEvidenceSecrets = (context: UnsafeFrameContext): void => {
  const { state, account, counterpartyId, dispute, effects } = context;
  for (const { hashlock, secret } of dispute.evidenceSecrets) {
    const lock = [...account.state.locks.values()].find(
      candidate => candidate.hashlock.toLowerCase() === hashlock.toLowerCase(),
    );
    if (!lock) throw new Error(`HTLC_DISPUTE_EVIDENCE_LOCK_MISSING:${hashlock}`);
    const route = persistVerifiedPaymentSecret(state, counterpartyId, lock, secret);
    const localIsLeft = account.state.leftEntity.toLowerCase() === state.entityId.toLowerCase();
    const localSentLock = lock.senderIsLeft === localIsLeft;
    if (!localSentLock || !hasInboundPayment(route)) continue;
    effects.accountTxs.push({
      accountId: route.inboundEntity,
      tx: {
        type: 'htlc_resolve',
        data: { lockId: hashlock, outcome: 'secret', secret },
      },
    });
    armPaymentSecretAckTimeout(state, route);
  }
};

const buildDisputeBroadcastOutput = (
  state: EntityState,
  disputeStarted: boolean,
): EntityInput[] =>
  disputeStarted && !state.jBatchState?.sentBatch
    ? [{
        entityId: state.entityId,
        signerId: state.config.validators[0]!,
        entityTxs: [{ type: 'j_broadcast', data: {} }],
      }]
    : [];

export const handleUnsafeAccountFrame = async (
  context: UnsafeFrameContext,
): Promise<UnsafeFrameOutcome> => {
  const { env, state, account, counterpartyId, createdAccount, dispute, effects } = context;
  if (createdAccount) {
    addMessage(state, `⚠️ Rejected uncommitted account genesis from ${counterpartyId.slice(-8)}`);
    return { newState: state, outputs: effects.outputs };
  }
  if (dispute.signedFrame) {
    account.shadow.rejectedFrameEvidence = {
      reason: dispute.reason,
      frame: structuredClone(dispute.signedFrame.frame),
      frameHanko: dispute.signedFrame.frameHanko,
    };
  }
  persistDisputeEvidenceSecrets(context);

  const startsBefore = state.jBatchState?.batch.disputeStarts.length ?? 0;
  const prepared = await handlePrepareDispute(
    state,
    {
      type: 'prepareDispute',
      data: {
        counterpartyEntityId: counterpartyId,
        description: dispute.reason,
      },
    },
    env,
  );
  const startsAfter = prepared.newState.jBatchState?.batch.disputeStarts.length ?? 0;
  const disputeStarted = startsAfter > startsBefore;
  if (disputeStarted && prepared.newState.jBatchState) {
    prepared.newState.jBatchState.autoBroadcastDraft = true;
  }
  addMessage(
    prepared.newState,
    disputeStarted
      ? '⚠️ Unsafe account frame rejected; dispute start queued'
      : '⚠️ Unsafe account frame rejected; dispute preparation awaits Hanko',
  );
  return {
    newState: prepared.newState,
    outputs: [
      ...effects.outputs,
      ...prepared.outputs,
      ...buildDisputeBroadcastOutput(prepared.newState, disputeStarted),
    ],
  };
};
