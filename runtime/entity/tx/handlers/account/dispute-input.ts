import type { AccountPeerInput, AccountReplica } from '../../../../types/account';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { HandleAccountInputResult } from '../../../../account/consensus/types';
import { addMessage } from '../../../frame-events';
import { armHtlcSecretAckTimeout, persistVerifiedHtlcSecret } from '../../htlc-route-lifecycle';
import { handlePrepareDispute } from '../dispute';
import type { CommittedAccountEffects } from './committed-input';

type UnsafeFrameContext = {
  env: EntityRuntimeContext;
  state: EntityState;
  input: AccountPeerInput;
  account: AccountReplica;
  counterpartyId: string;
  createdAccount: boolean;
  dispute: NonNullable<HandleAccountInputResult['disputeRequired']>;
  effects: CommittedAccountEffects;
};

export type UnsafeFrameOutcome = {
  newState: EntityState;
  outputs: EntityInput[];
};

const persistDisputeEvidenceSecrets = (context: UnsafeFrameContext): void => {
  const { state, account, counterpartyId, dispute, effects } = context;
  for (const { hashlock, secret } of dispute.evidenceSecrets) {
    const lock = [...account.locks.values()].find(
      candidate => candidate.hashlock.toLowerCase() === hashlock.toLowerCase(),
    );
    if (!lock) throw new Error(`HTLC_DISPUTE_EVIDENCE_LOCK_MISSING:${hashlock}`);
    persistVerifiedHtlcSecret(state, counterpartyId, lock, secret);
    const route = state.htlcRoutes.get(hashlock)!;
    const localIsLeft = account.leftEntity.toLowerCase() === state.entityId.toLowerCase();
    const localSentLock = lock.senderIsLeft === localIsLeft;
    if (!localSentLock || !route.inboundEntity || !route.inboundLockId) continue;
    effects.accountTxs.push({
      accountId: route.inboundEntity,
      tx: {
        type: 'htlc_resolve',
        data: { lockId: route.inboundLockId, outcome: 'secret', secret },
      },
    });
    armHtlcSecretAckTimeout(state, route);
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
        description: 'late-htlc-secret-enforcement',
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
