import type {
  AccountDisputeSeal,
  AccountFrame,
  AccountFrameAck,
  AccountFrameProposal,
  AccountInput,
  AccountSettleAction,
  AccountTx,
} from '../types';

export const cloneIsolatedAccountTx = <T extends AccountTx>(tx: T): T => structuredClone(tx);

export const cloneIsolatedAccountFrame = (frame: AccountFrame): AccountFrame => ({
  height: frame.height,
  timestamp: frame.timestamp,
  jHeight: frame.jHeight,
  accountTxs: frame.accountTxs.map(cloneIsolatedAccountTx),
  prevFrameHash: frame.prevFrameHash,
  accountStateRoot: frame.accountStateRoot,
  stateHash: frame.stateHash,
  ...(frame.byLeft !== undefined ? { byLeft: frame.byLeft } : {}),
  deltas: frame.deltas.map(delta => ({ ...delta })),
});

const cloneDisputeSeal = (seal: AccountDisputeSeal): AccountDisputeSeal => ({ ...seal });

const cloneFrameAck = <T extends AccountFrameAck>(ack: T): T => ({
  ...ack,
  ...(ack.disputeSeal ? { disputeSeal: cloneDisputeSeal(ack.disputeSeal) } : {}),
});

const cloneFrameProposal = (proposal: AccountFrameProposal): AccountFrameProposal => ({
  ...proposal,
  frame: cloneIsolatedAccountFrame(proposal.frame),
  ...(proposal.disputeSeal ? { disputeSeal: cloneDisputeSeal(proposal.disputeSeal) } : {}),
});

const cloneSettleAction = (action: AccountSettleAction): AccountSettleAction => ({
  ...action,
  ...(action.ops ? { ops: action.ops.map(op => structuredClone(op)) } : {}),
});

export function cloneIsolatedAccountInput<T extends AccountInput>(input: T): T;
export function cloneIsolatedAccountInput(input: AccountInput): AccountInput {
  const base = {
    fromEntityId: input.fromEntityId,
    toEntityId: input.toEntityId,
    domain: structuredClone(input.domain),
    ...(input.watchSeed !== undefined ? { watchSeed: input.watchSeed } : {}),
  };
  switch (input.kind) {
    case 'frame':
      return { ...base, kind: input.kind, proposal: cloneFrameProposal(input.proposal) };
    case 'ack':
      return { ...base, kind: input.kind, ack: cloneFrameAck(input.ack) };
    case 'frame_ack':
      return {
        ...base,
        kind: input.kind,
        ack: cloneFrameAck(input.ack),
        proposal: cloneFrameProposal(input.proposal),
      };
    case 'dispute':
      return { ...base, kind: input.kind, disputeSeal: cloneDisputeSeal(input.disputeSeal) };
    case 'board_reseal':
      return { ...base, kind: input.kind, reseal: cloneFrameAck(input.reseal) };
    case 'settle':
      return {
        ...base,
        kind: input.kind,
        settleAction: cloneSettleAction(input.settleAction),
        ...(input.newSettlementHanko !== undefined
          ? { newSettlementHanko: input.newSettlementHanko }
          : {}),
      };
  }
}
