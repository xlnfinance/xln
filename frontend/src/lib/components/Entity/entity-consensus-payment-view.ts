import type { EntityTx, Proposal } from '@xln/runtime/types';

export type ConsensusPaymentProposalView = {
  recipientEntityId: string;
  tokenId: number;
  tokenSymbol: string | null;
  tokenName: string | null;
  recipientAmount: bigint;
  hashlock: string;
  totalDebit: bigint;
  totalFee: bigint;
  deliveryMode: 'instant' | 'async';
};

export type ConsensusTokenMetadata = Readonly<{ symbol?: string; name?: string }>;

export type EntityConsensusSettingsOptions = Readonly<{
  resolveTokenMetadata?: (tokenId: number) => ConsensusTokenMetadata | null;
}>;

type HtlcPaymentTx = Extract<EntityTx, { type: 'htlcPayment' }>;

const projectionError = (code: string, proposalId: string, txIndex: number): Error =>
  new Error(`${code}:proposal=${proposalId}:tx=${txIndex}`);

const requirePreparedAmount = (
  value: unknown,
  code: string,
  proposalId: string,
  txIndex: number,
  allowZero = false,
): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw projectionError(code, proposalId, txIndex);
  }
  const amount = BigInt(value);
  if (allowZero ? amount < 0n : amount <= 0n) throw projectionError(code, proposalId, txIndex);
  return amount;
};

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

const requireHashlock = (value: unknown, proposalId: string, txIndex: number): string => {
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

const assertPreparedEnvelope = (value: unknown, proposalId: string, txIndex: number): void => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectionError('CONSENSUS_SETTINGS_HTLC_PREPARED_ENVELOPE_INVALID', proposalId, txIndex);
  }
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

const projectPreparedPayment = (
  proposalId: string,
  tx: HtlcPaymentTx,
  txIndex: number,
  options: EntityConsensusSettingsOptions,
): ConsensusPaymentProposalView => {
  const recipientEntityId = requireRecipient(tx.data.targetEntityId, proposalId, txIndex);
  const tokenId = requireTokenId(tx.data.tokenId, proposalId, txIndex);
  const recipientAmount = requireRecipientAmount(tx.data.amount, proposalId, txIndex);
  const hashlock = requireHashlock(tx.data.hashlock, proposalId, txIndex);
  const totalDebit = requirePreparedAmount(tx.data.preparedSenderLockAmount, 'CONSENSUS_SETTINGS_HTLC_PREPARED_DEBIT_INVALID', proposalId, txIndex);
  const totalFee = requirePreparedAmount(tx.data.preparedTotalFee, 'CONSENSUS_SETTINGS_HTLC_PREPARED_FEE_INVALID', proposalId, txIndex, true);
  if (totalDebit !== recipientAmount + totalFee) {
    throw projectionError('CONSENSUS_SETTINGS_HTLC_TOTAL_MISMATCH', proposalId, txIndex);
  }
  const deliveryMode = requireDeliveryMode(tx.data.deliveryMode, proposalId, txIndex);
  assertPreparedEnvelope(tx.data.preparedEnvelope, proposalId, txIndex);
  return {
    recipientEntityId, tokenId, ...projectTokenMetadata(tokenId, options.resolveTokenMetadata),
    recipientAmount, hashlock, totalDebit, totalFee, deliveryMode,
  };
};

export const projectConsensusPayments = (
  proposal: Proposal,
  options: EntityConsensusSettingsOptions,
): ConsensusPaymentProposalView[] => proposal.action.type === 'entity_transaction'
  ? proposal.action.data.txs.flatMap((tx, txIndex) => tx.type === 'htlcPayment'
    ? [projectPreparedPayment(proposal.id, tx, txIndex, options)]
    : [])
  : [];
