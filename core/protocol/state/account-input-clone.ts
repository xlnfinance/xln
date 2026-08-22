import type {
  AccountDisputeSeal,
  AccountFrame,
  AccountFrameAck,
  AccountFrameProposal,
  AccountInput,
  AccountState,
  AccountStateDomain,
  AccountTx,
} from '../../types/account';
import { cloneIsolatedProtocolValue } from './isolated-value-clone';

export const copyAccountStateDomain = (domain: AccountStateDomain): AccountStateDomain => ({
  chainId: domain.chainId,
  depositoryAddress: domain.depositoryAddress,
});

export const copyAccountDisputeConfig = (
  config: AccountState['disputeConfig'],
): AccountState['disputeConfig'] => ({
  leftResponseSeconds: config.leftResponseSeconds,
  rightResponseSeconds: config.rightResponseSeconds,
});

export const cloneIsolatedAccountTx = <T extends AccountTx>(tx: T): T =>
  cloneIsolatedProtocolValue(tx, 'ACCOUNT_TX_CLONE');

export const cloneIsolatedAccountFrame = (frame: AccountFrame): AccountFrame => ({
  height: frame.height,
  timestamp: frame.timestamp,
  jHeight: frame.jHeight,
  accountTxs: frame.accountTxs.map(cloneIsolatedAccountTx),
  prevFrameHash: frame.prevFrameHash,
  accountStateRoot: frame.accountStateRoot,
  stateHash: frame.stateHash,
  byLeft: frame.byLeft,
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

export function cloneIsolatedAccountInput<T extends AccountInput>(input: T): T;
export function cloneIsolatedAccountInput(input: AccountInput): AccountInput {
  if (input.kind === 'enqueue') {
    return { kind: 'enqueue', txs: input.txs.map(cloneIsolatedAccountTx) };
  }
  const base = {
    fromEntityId: input.fromEntityId,
    toEntityId: input.toEntityId,
    domain: copyAccountStateDomain(input.domain),
    disputeConfig: copyAccountDisputeConfig(input.disputeConfig),
    ...(input.watchSeed !== undefined ? { watchSeed: input.watchSeed } : {}),
  };
  switch (input.kind) {
    case 'external_finality':
      return {
        ...base,
        kind: input.kind,
        finality:
          input.finality.kind === 'dispute_finalized'
            ? {
                ...input.finality,
                finalizedTokenIds: [...input.finality.finalizedTokenIds],
              }
            : { ...input.finality },
      };
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
  }
}
