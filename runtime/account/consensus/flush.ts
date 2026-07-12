import type {
  AccountDisputeSeal,
  AccountFrameAck,
  AccountFrameProposal,
  AccountInput,
} from '../../types';

export const accountInputAck = (input: AccountInput): AccountFrameAck | undefined =>
  input.kind === 'ack' || input.kind === 'frame_ack' ? input.ack : undefined;

export const accountInputProposal = (input: AccountInput): AccountFrameProposal | undefined =>
  input.kind === 'frame' || input.kind === 'frame_ack' ? input.proposal : undefined;

export const accountInputDisputeSeal = (input: AccountInput): AccountDisputeSeal | undefined =>
  input.kind === 'dispute' ? input.disputeSeal : undefined;

export const accountInputReferenceHeight = (input: AccountInput): number | undefined =>
  accountInputAck(input)?.height ?? accountInputProposal(input)?.frame.height;
