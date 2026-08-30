import type { PaybookEntry } from '../types';

type InboundPayment = PaybookEntry & Required<Pick<PaybookEntry, 'inboundEntity'>>;
type OutboundPayment = PaybookEntry & Required<Pick<PaybookEntry, 'outboundEntity'>>;

export type ForwardingPayment = InboundPayment & OutboundPayment;

export type FinalRecipientPayment = InboundPayment & {
  originated?: never;
  outboundEntity?: never;
};

export type SecretAckPendingPayment = InboundPayment & {
  secret: string;
  secretAckPending: true;
  secretAckStartedAt: number;
  secretAckDeadlineAt: number;
};

const hasText = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

export const hasInboundPayment = (entry: PaybookEntry): entry is InboundPayment =>
  hasText(entry.inboundEntity);

const hasOutboundPayment = (entry: PaybookEntry): entry is OutboundPayment =>
  hasText(entry.outboundEntity);

export const isForwardingPayment = (
  entry: PaybookEntry,
): entry is ForwardingPayment => hasInboundPayment(entry) && hasOutboundPayment(entry);

export const isFinalRecipientPayment = (
  entry: PaybookEntry,
): entry is FinalRecipientPayment => hasInboundPayment(entry)
  && entry.originated !== true
  && entry.outboundEntity === undefined;

export const isSecretAckPendingPayment = (
  entry: PaybookEntry,
): entry is SecretAckPendingPayment => hasInboundPayment(entry)
  && hasText(entry.secret)
  && entry.secretAckPending === true
  && Number.isSafeInteger(entry.secretAckStartedAt)
  && Number.isSafeInteger(entry.secretAckDeadlineAt)
  && entry.secretAckDeadlineAt! >= entry.secretAckStartedAt!;

export const isDisputeReadyPayment = (
  entry: PaybookEntry,
  timestamp: number,
): entry is SecretAckPendingPayment => isSecretAckPendingPayment(entry)
  && timestamp >= entry.secretAckDeadlineAt;
