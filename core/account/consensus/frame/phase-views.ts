import type {
  AccountDisputeSeal,
  AccountFrameAck,
  AccountFrameProposal,
} from '../../../types/account';
import type { HankoString } from '../../../types/hanko';

type CertifiedDisputeSeal = AccountDisputeSeal & { hanko: HankoString };

export type DraftAccountFrameProposal = AccountFrameProposal & {
  frameHanko?: never;
  disputeSeal?: (AccountDisputeSeal & { hanko?: never });
};

export type CertifiedAccountFrameProposal = AccountFrameProposal & {
  frameHanko: HankoString;
  disputeSeal?: CertifiedDisputeSeal;
};

export type DraftAccountFrameAck = AccountFrameAck & {
  frameHanko?: never;
  disputeSeal?: (AccountDisputeSeal & { hanko?: never });
};

export type CertifiedAccountFrameAck = AccountFrameAck & {
  frameHanko: HankoString;
  disputeSeal?: CertifiedDisputeSeal;
};

const hasText = (value: string | undefined): value is HankoString =>
  typeof value === 'string' && value.length > 0;

const hasCertifiedOptionalDisputeSeal = (seal: AccountDisputeSeal | undefined): boolean =>
  seal === undefined || hasText(seal.hanko);

export const isDraftAccountFrameProposal = (
  proposal: AccountFrameProposal,
): proposal is DraftAccountFrameProposal => proposal.frameHanko === undefined
  && proposal.disputeSeal?.hanko === undefined;

export const isCertifiedAccountFrameProposal = (
  proposal: AccountFrameProposal,
): proposal is CertifiedAccountFrameProposal => hasText(proposal.frameHanko)
  && hasCertifiedOptionalDisputeSeal(proposal.disputeSeal);

export const isDraftAccountFrameAck = (
  ack: AccountFrameAck,
): ack is DraftAccountFrameAck => ack.frameHanko === undefined
  && ack.disputeSeal?.hanko === undefined;

export const isCertifiedAccountFrameAck = (
  ack: AccountFrameAck,
): ack is CertifiedAccountFrameAck => hasText(ack.frameHanko)
  && hasCertifiedOptionalDisputeSeal(ack.disputeSeal);

export const requireCertifiedAccountFrameProposal = (
  proposal: AccountFrameProposal,
): CertifiedAccountFrameProposal => {
  if (!isCertifiedAccountFrameProposal(proposal)) {
    throw new Error(`ACCOUNT_FRAME_PROPOSAL_CERTIFICATION_INCOMPLETE:${proposal.frame.stateHash}`);
  }
  return proposal;
};

export const requireCertifiedAccountFrameAck = (
  ack: AccountFrameAck,
): CertifiedAccountFrameAck => {
  if (!isCertifiedAccountFrameAck(ack)) {
    throw new Error(`ACCOUNT_FRAME_ACK_CERTIFICATION_INCOMPLETE:${ack.frameHash}`);
  }
  return ack;
};
