import type {
  AccountDisputeSeal,
  AccountFrameAck,
  AccountFrameProposal,
  AccountBoardReseal,
  AccountInput,
} from '../../types';

export const accountInputAck = (input: AccountInput): AccountFrameAck | undefined =>
  input.kind === 'ack' || input.kind === 'frame_ack' ? input.ack : undefined;

export const accountInputProposal = (input: AccountInput): AccountFrameProposal | undefined =>
  input.kind === 'frame' || input.kind === 'frame_ack' ? input.proposal : undefined;

export const accountInputDisputeSeal = (input: AccountInput): AccountDisputeSeal | undefined =>
  input.kind === 'dispute'
    ? input.disputeSeal
    : input.kind === 'board_reseal'
      ? input.reseal.disputeSeal
      : undefined;

export const accountInputBoardReseal = (input: AccountInput): AccountBoardReseal | undefined =>
  input.kind === 'board_reseal' ? input.reseal : undefined;

export const accountInputReferenceHeight = (input: AccountInput): number | undefined =>
  accountInputAck(input)?.height ??
  accountInputProposal(input)?.frame.height ??
  accountInputBoardReseal(input)?.height;
