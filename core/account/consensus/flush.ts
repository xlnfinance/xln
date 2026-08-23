import type { AccountDisputeHanko, AccountFrameAck, AccountFrameProposal, AccountBoardHankoRefresh, AccountInput } from '../../types/account';

export const accountInputAck = (input: AccountInput): AccountFrameAck | undefined =>
  input.kind === 'ack' || input.kind === 'frame_ack' ? input.ack : undefined;

export const accountInputProposal = (input: AccountInput): AccountFrameProposal | undefined =>
  input.kind === 'frame' || input.kind === 'frame_ack' ? input.proposal : undefined;

export const accountInputDisputeHanko = (input: AccountInput): AccountDisputeHanko | undefined =>
  input.kind === 'dispute'
    ? input.disputeHanko
    : input.kind === 'board_hanko_refresh'
      ? input.boardHankoRefresh.disputeHanko
      : undefined;

export const accountInputBoardHankoRefresh = (input: AccountInput): AccountBoardHankoRefresh | undefined =>
  input.kind === 'board_hanko_refresh' ? input.boardHankoRefresh : undefined;

export const accountInputReferenceHeight = (input: AccountInput): number | undefined =>
  accountInputAck(input)?.height ??
  accountInputProposal(input)?.frame.height ??
  accountInputBoardHankoRefresh(input)?.height;
