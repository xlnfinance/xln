import type {
  AccountDisputeHanko,
  AccountFrame,
  AccountAckFrame,
  AccountTxBatch,
  AccountFinality,
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
});

const cloneDisputeHanko = (disputeHanko: AccountDisputeHanko): AccountDisputeHanko => ({ ...disputeHanko });

const cloneAckFrame = <T extends AccountAckFrame>(ack: T): T => ({
  ...ack,
  ...(ack.disputeHanko ? { disputeHanko: cloneDisputeHanko(ack.disputeHanko) } : {}),
});

const cloneFrameProposal = (proposal: AccountFrameProposal): AccountFrameProposal => ({
  ...proposal,
  frame: cloneIsolatedAccountFrame(proposal.frame),
  ...(proposal.disputeHanko ? { disputeHanko: cloneDisputeHanko(proposal.disputeHanko) } : {}),
});

export function cloneIsolatedAccountInput<
  T extends AccountInput | AccountTxBatch | AccountFinality,
>(input: T): T;
export function cloneIsolatedAccountInput(
  input: AccountInput | AccountTxBatch | AccountFinality,
): AccountInput | AccountTxBatch | AccountFinality {
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
    case 'ack':
      return { ...base, kind: input.kind, ack: cloneAckFrame(input.ack) };
    case 'ack_frame':
      return {
        ...base,
        kind: input.kind,
        ...(input.ack === undefined ? {} : { ack: cloneAckFrame(input.ack) }),
        proposal: cloneFrameProposal(input.proposal),
      };
    case 'dispute':
      return { ...base, kind: input.kind, disputeHanko: cloneDisputeHanko(input.disputeHanko) };
    case 'board_hanko_refresh':
      return { ...base, kind: input.kind, boardHankoRefresh: cloneAckFrame(input.boardHankoRefresh) };
  }
}
