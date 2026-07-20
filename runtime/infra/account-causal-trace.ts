import { accountInputAck, accountInputProposal } from '../account/consensus/flush';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';
import type { AccountInput, AccountTx, EntityInput } from '../types';

export type AccountTxCausalTrace = {
  type: AccountTx['type'];
  offerId?: string;
  fillRatio?: number;
};

export type AccountEnvelopeCausalTrace = {
  kind: AccountInput['kind'];
  from: string;
  to: string;
  ackHeight?: number;
  proposalHeight?: number;
  proposalTxs: AccountTxCausalTrace[];
  hasSwapTx: boolean;
};

export type EntityInputCausalTrace = {
  entity: string;
  signer: string;
  entityFrameHeight?: number;
  entityTxTypes: string[];
  entityOfferIds: string[];
  accountEnvelopes: AccountEnvelopeCausalTrace[];
};

const shortId = (value: unknown): string => String(value || '').slice(-8);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const offerIdFromData = (value: unknown): string | undefined => {
  const data = asRecord(value);
  const direct = typeof data?.['offerId'] === 'string' ? data['offerId'] : '';
  if (direct) return direct;
  const route = asRecord(data?.['route']);
  const routed = typeof route?.['orderId'] === 'string' ? route['orderId'] : '';
  return routed || undefined;
};

const summarizeAccountTx = (tx: AccountTx): AccountTxCausalTrace => {
  const data = asRecord(tx.data);
  const offerId = offerIdFromData(tx.data);
  const fillRatio = typeof data?.['fillRatio'] === 'number' ? data['fillRatio'] : undefined;
  return {
    type: tx.type,
    ...(offerId ? { offerId } : {}),
    ...(fillRatio !== undefined ? { fillRatio } : {}),
  };
};

export const summarizeAccountEnvelope = (input: AccountInput): AccountEnvelopeCausalTrace => {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const proposalTxs = (proposal?.frame.accountTxs ?? []).map(summarizeAccountTx);
  return {
    kind: input.kind,
    from: shortId(input.fromEntityId),
    to: shortId(input.toEntityId),
    ...(ack ? { ackHeight: ack.height } : {}),
    ...(proposal ? { proposalHeight: proposal.frame.height } : {}),
    proposalTxs,
    hasSwapTx: proposalTxs.some(tx => tx.type.toLowerCase().includes('swap')),
  };
};

export const summarizeRuntimeAccountCausality = (
  inputs: readonly EntityInput[],
): EntityInputCausalTrace[] => inputs.flatMap((input) => {
  const effectiveTxs = getEffectiveEntityInputTxs(input);
  const accountEnvelopes = effectiveTxs.flatMap(tx =>
    tx.type === 'accountInput' ? [summarizeAccountEnvelope(tx.data)] : []);
  const swapEntityTxs = effectiveTxs.filter(tx => tx.type.toLowerCase().includes('swap'));
  if (accountEnvelopes.length === 0 && swapEntityTxs.length === 0) return [];
  return [{
    entity: shortId(input.entityId),
    signer: shortId(input.signerId),
    ...(input.proposedFrame ? { entityFrameHeight: input.proposedFrame.height } : {}),
    entityTxTypes: effectiveTxs.map(tx => tx.type),
    entityOfferIds: swapEntityTxs
      .map(tx => offerIdFromData(tx.data))
      .filter((offerId): offerId is string => Boolean(offerId)),
    accountEnvelopes,
  }];
});

export const causalTraceContainsWork = (
  trace: readonly EntityInputCausalTrace[],
): boolean => trace.length > 0;
