import type { Proposal } from '@xln/core/entity/types';
import type { EntityTx } from '@xln/core/types/entity-tx';

export type ConsensusPaymentProposalView = {
  recipientEntityId: string;
  tokenId: number;
  tokenSymbol: string | null;
  tokenName: string | null;
  recipientAmount: bigint;
  /** Optional caller commitment; null means the proposer derives it during frame preparation. */
  hashlock: string | null;
  maxSenderDebit: bigint;
  maxFee: bigint;
  deliveryMode: 'instant' | 'async';
};

export type ConsensusTokenMetadata = Readonly<{ symbol?: string; name?: string }>;

export type EntityConsensusSettingsOptions = Readonly<{
  resolveTokenMetadata?: (tokenId: number) => ConsensusTokenMetadata | null;
}>;

type HtlcPaymentTx = Extract<EntityTx, { type: 'htlcPayment' }>;

const projectionError = (code: string, proposalId: string, txIndex: number): Error =>
  new Error(`${code}:proposal=${proposalId}:tx=${txIndex}`);

const requireRecipient = (value: unknown, proposalId: string, txIndex: number): string => {
  const recipient = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^0x[0-9a-f]{64}$/.test(recipient)) {
    throw projectionError('CONSENSUS_SETTINGS_HTLC_RECIPIENT_INVALID', proposalId, txIndex);
  }
  return recipient;
};

const requireTokenId = (value: unknown, proposalId: string, txIndex: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw projectionError('CONSENSUS_SETTINGS_HTLC_TOKEN_INVALID', proposalId, txIndex);
  }
  return Number(value);
};

const requireRecipientAmount = (value: unknown, proposalId: string, txIndex: number): bigint => {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw projectionError('CONSENSUS_SETTINGS_HTLC_RECIPIENT_AMOUNT_INVALID', proposalId, txIndex);
  }
  return value;
};

const requireSenderDebitCap = (value: unknown, proposalId: string, txIndex: number): bigint => {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw projectionError('CONSENSUS_SETTINGS_HTLC_MAX_SENDER_DEBIT_INVALID', proposalId, txIndex);
  }
  return value;
};

const projectHashlock = (value: unknown, proposalId: string, txIndex: number): string | null => {
  if (value === undefined) return null;
  const hashlock = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^0x[0-9a-f]{64}$/.test(hashlock)) {
    throw projectionError('CONSENSUS_SETTINGS_HTLC_HASHLOCK_INVALID', proposalId, txIndex);
  }
  return hashlock;
};

const requireDeliveryMode = (
  value: unknown,
  proposalId: string,
  txIndex: number,
): ConsensusPaymentProposalView['deliveryMode'] => {
  if (value !== 'instant' && value !== 'async') {
    throw projectionError('CONSENSUS_SETTINGS_HTLC_DELIVERY_MODE_INVALID', proposalId, txIndex);
  }
  return value;
};

const projectTokenMetadata = (
  tokenId: number,
  resolver?: EntityConsensusSettingsOptions['resolveTokenMetadata'],
): Pick<ConsensusPaymentProposalView, 'tokenSymbol' | 'tokenName'> => {
  const metadata = resolver?.(tokenId) ?? null;
  if (metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    throw new Error(`CONSENSUS_SETTINGS_TOKEN_METADATA_INVALID:token=${tokenId}`);
  }
  const tokenSymbol = typeof metadata?.symbol === 'string' && metadata.symbol.trim()
    ? metadata.symbol.trim()
    : null;
  const tokenName = typeof metadata?.name === 'string' && metadata.name.trim()
    ? metadata.name.trim()
    : null;
  return { tokenSymbol, tokenName };
};

const projectPendingPayment = (
  proposalId: string,
  tx: HtlcPaymentTx,
  txIndex: number,
  options: EntityConsensusSettingsOptions,
): ConsensusPaymentProposalView => {
  const recipientEntityId = requireRecipient(tx.data.targetEntityId, proposalId, txIndex);
  const tokenId = requireTokenId(tx.data.tokenId, proposalId, txIndex);
  const recipientAmount = requireRecipientAmount(tx.data.amount, proposalId, txIndex);
  const hashlock = projectHashlock(tx.data.hashlock, proposalId, txIndex);
  const maxSenderDebit = requireSenderDebitCap(tx.data.maxSenderDebit, proposalId, txIndex);
  if (maxSenderDebit < recipientAmount) {
    throw projectionError('CONSENSUS_SETTINGS_HTLC_MAX_SENDER_DEBIT_BELOW_AMOUNT', proposalId, txIndex);
  }
  const maxFee = maxSenderDebit - recipientAmount;
  const deliveryMode = requireDeliveryMode(tx.data.deliveryMode, proposalId, txIndex);
  return {
    recipientEntityId, tokenId, ...projectTokenMetadata(tokenId, options.resolveTokenMetadata),
    recipientAmount, hashlock, maxSenderDebit, maxFee, deliveryMode,
  };
};

export const projectConsensusPayments = (
  proposal: Proposal,
  options: EntityConsensusSettingsOptions,
): ConsensusPaymentProposalView[] => proposal.action.type === 'entity_transaction'
  ? proposal.action.data.txs.flatMap((tx, txIndex) => tx.type === 'htlcPayment'
    ? [projectPendingPayment(proposal.id, tx, txIndex, options)]
    : [])
  : [];
