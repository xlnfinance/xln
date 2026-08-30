import type {
  AccountDisputeHanko,
  AccountAckFrame,
  AccountFrameProposal,
} from '../../../types/account';
import type { HankoString } from '../../../types/hanko';

type CertifiedDisputeHanko = AccountDisputeHanko & { hanko: HankoString };

export type DraftAccountFrameProposal = AccountFrameProposal & {
  frameHanko?: never;
  disputeHanko?: (AccountDisputeHanko & { hanko?: never });
};

export type CertifiedAccountFrameProposal = AccountFrameProposal & {
  frameHanko: HankoString;
  disputeHanko?: CertifiedDisputeHanko;
};

export type DraftAccountAckFrame = AccountAckFrame & {
  frameHanko?: never;
  disputeHanko?: (AccountDisputeHanko & { hanko?: never });
};

export type CertifiedAccountAckFrame = AccountAckFrame & {
  frameHanko: HankoString;
  disputeHanko?: CertifiedDisputeHanko;
};

const hasText = (value: string | undefined): value is HankoString =>
  typeof value === 'string' && value.length > 0;

const hasCertifiedOptionalDisputeHanko = (disputeHanko: AccountDisputeHanko | undefined): boolean =>
  disputeHanko === undefined || hasText(disputeHanko.hanko);

export const isDraftAccountFrameProposal = (
  proposal: AccountFrameProposal,
): proposal is DraftAccountFrameProposal => proposal.frameHanko === undefined
  && proposal.disputeHanko?.hanko === undefined;

export const isCertifiedAccountFrameProposal = (
  proposal: AccountFrameProposal,
): proposal is CertifiedAccountFrameProposal => hasText(proposal.frameHanko)
  && hasCertifiedOptionalDisputeHanko(proposal.disputeHanko);

export const isDraftAccountAckFrame = (
  ack: AccountAckFrame,
): ack is DraftAccountAckFrame => ack.frameHanko === undefined
  && ack.disputeHanko?.hanko === undefined;

export const isCertifiedAccountAckFrame = (
  ack: AccountAckFrame,
): ack is CertifiedAccountAckFrame => hasText(ack.frameHanko)
  && hasCertifiedOptionalDisputeHanko(ack.disputeHanko);

export const requireCertifiedAccountFrameProposal = (
  proposal: AccountFrameProposal,
): CertifiedAccountFrameProposal => {
  if (!isCertifiedAccountFrameProposal(proposal)) {
    throw new Error(`ACCOUNT_FRAME_PROPOSAL_CERTIFICATION_INCOMPLETE:${proposal.frame.stateHash}`);
  }
  return proposal;
};

export const requireCertifiedAccountAckFrame = (
  ack: AccountAckFrame,
): CertifiedAccountAckFrame => {
  if (!isCertifiedAccountAckFrame(ack)) {
    throw new Error(`ACCOUNT_ACK_FRAME_CERTIFICATION_INCOMPLETE:${ack.frameHash}`);
  }
  return ack;
};
