import type { EntityTx, RoutedEntityInput, RuntimeInput } from '@xln/runtime/api/public/runtime-module';
import { isAddress } from 'ethers';

import {
  buildBroadcastTx,
  buildAddTokenToAccountTx,
  buildExternalToReserveTx,
  buildMoveSettlementContinuation,
  buildOpenAccountTx,
  buildPrepareDisputeTx,
  buildDisputeFinalizeTx,
  buildReopenDisputedAccountTx,
  buildReserveToCollateralTx,
  buildReserveToExternalEoaTx,
  buildReserveToReserveTx,
  buildSettlementApproveTx,
  type MovePostSettleOp,
} from '$lib/components/Entity/entity-action-txs';
import { parseTokenAmountInput } from '$lib/components/Entity/token-amount-input';
import {
  buildPendingBatchActionTxs,
  type PendingBatchAction,
} from '$lib/components/Entity/pending-batch-preview';

const ENTITY_ID = /^0x[0-9a-f]{64}$/;

type CommandOwner = Readonly<{ entityId: string; signerId: string }>;

type WalletEntityTxs = NonNullable<RoutedEntityInput['entityTxs']>;

const ownerInput = (owner: CommandOwner, entityTxs: WalletEntityTxs): RuntimeInput => {
  const entityId = String(owner.entityId || '').trim().toLowerCase();
  const signerId = String(owner.signerId || '').trim().toLowerCase();
  if (!ENTITY_ID.test(entityId)) throw new Error('WALLET_COMMAND_ENTITY_ID_INVALID');
  if (!signerId) throw new Error('WALLET_COMMAND_SIGNER_MISSING');
  return { runtimeTxs: [], entityInputs: [{ entityId, signerId, entityTxs }], jInputs: [] };
};

const counterpartyId = (value: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ENTITY_ID.test(normalized)) throw new Error('WALLET_COMMAND_COUNTERPARTY_INVALID');
  return normalized;
};

const tokenId = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('WALLET_COMMAND_TOKEN_ID_INVALID');
  return value;
};

export const buildWalletOpenAccountInput = (
  owner: CommandOwner,
  targetEntityId: string,
  initialCredit?: Readonly<{ tokenId: number; amount: bigint }>,
): RuntimeInput => {
  const openAccount = buildOpenAccountTx(counterpartyId(targetEntityId));
  if (!initialCredit) return ownerInput(owner, [openAccount]);
  if (initialCredit.amount <= 0n) throw new Error('WALLET_OPEN_ACCOUNT_CREDIT_NOT_POSITIVE');
  return ownerInput(owner, [{
    ...openAccount,
    data: {
      ...openAccount.data,
      tokenId: tokenId(initialCredit.tokenId),
      creditAmount: initialCredit.amount,
    },
  }]);
};

export const buildWalletAddTokenInput = (input: CommandOwner & Readonly<{
  counterpartyEntityId: string;
  tokenId: number;
}>): RuntimeInput => ownerInput(input, [
  buildAddTokenToAccountTx(counterpartyId(input.counterpartyEntityId), tokenId(input.tokenId)),
]);

export const buildWalletCreditInputRaw = (input: CommandOwner & Readonly<{
  counterpartyEntityId: string;
  tokenId: number;
  amount: bigint;
}>): RuntimeInput => {
  if (input.amount <= 0n) throw new Error('WALLET_CREDIT_AMOUNT_NOT_POSITIVE');
  return ownerInput(input, [{
    type: 'extendCredit',
    data: {
      counterpartyEntityId: counterpartyId(input.counterpartyEntityId),
      tokenId: tokenId(input.tokenId),
      amount: input.amount,
    },
  }]);
};

export const buildWalletCreditInput = (input: CommandOwner & Readonly<{
  counterpartyEntityId: string;
  tokenId: number;
  tokenDecimals: number;
  amountInput: string;
}>): RuntimeInput => buildWalletCreditInputRaw({
  ...input,
  amount: parseTokenAmountInput(input.amountInput, input.tokenDecimals),
});

export const buildWalletReserveTransferInput = (input: CommandOwner & Readonly<{
  recipientEntityId: string;
  tokenId: number;
  tokenDecimals: number;
  amountInput: string;
  broadcast: boolean;
  maxAmount?: bigint;
}>): RuntimeInput => {
  const amount = parseTokenAmountInput(input.amountInput, input.tokenDecimals);
  if (input.maxAmount !== undefined && amount > input.maxAmount) {
    throw new Error('WALLET_MOVE_AMOUNT_EXCEEDS_RESERVE');
  }
  const txs: WalletEntityTxs = [
    buildReserveToReserveTx(counterpartyId(input.recipientEntityId), tokenId(input.tokenId), amount),
  ];
  if (input.broadcast) txs.push(buildBroadcastTx());
  return ownerInput(input, txs);
};

export const buildWalletReserveToExternalInput = (input: CommandOwner & Readonly<{
  recipientEoa: string;
  tokenId: number;
  tokenDecimals: number;
  amountInput: string;
  broadcast: boolean;
  maxAmount?: bigint;
}>): RuntimeInput => {
  const recipientEoa = String(input.recipientEoa || '').trim();
  if (!isAddress(recipientEoa)) throw new Error('WALLET_MOVE_EXTERNAL_RECIPIENT_INVALID');
  const amount = parseTokenAmountInput(input.amountInput, input.tokenDecimals);
  if (input.maxAmount !== undefined && amount > input.maxAmount) {
    throw new Error('WALLET_MOVE_AMOUNT_EXCEEDS_RESERVE');
  }
  const txs: WalletEntityTxs = [
    buildReserveToExternalEoaTx(recipientEoa, tokenId(input.tokenId), amount),
  ];
  if (input.broadcast) txs.push(buildBroadcastTx());
  return ownerInput(input, txs);
};

export const buildWalletExternalToReserveInput = (input: CommandOwner & Readonly<{
  contractAddress: string;
  internalTokenId: number;
  tokenDecimals: number;
  amountInput: string;
  maxAmount?: bigint;
}>): RuntimeInput => {
  const contractAddress = String(input.contractAddress || '').trim();
  if (!isAddress(contractAddress)) throw new Error('WALLET_MOVE_EXTERNAL_TOKEN_INVALID');
  const amount = parseTokenAmountInput(input.amountInput, input.tokenDecimals);
  if (input.maxAmount !== undefined && amount > input.maxAmount) {
    throw new Error('WALLET_MOVE_AMOUNT_EXCEEDS_EXTERNAL_BALANCE');
  }
  return ownerInput(input, [buildExternalToReserveTx({
    contractAddress,
    amount,
    internalTokenId: tokenId(input.internalTokenId),
  })]);
};

export const buildWalletExternalToAccountInputs = (input: CommandOwner & Readonly<{
  contractAddress: string;
  internalTokenId: number;
  tokenDecimals: number;
  amountInput: string;
  maxAmount?: bigint;
  counterpartyEntityId: string;
  receivingEntityId?: string;
}>): readonly [RuntimeInput, RuntimeInput] => {
  const contractAddress = String(input.contractAddress || '').trim();
  if (!isAddress(contractAddress)) throw new Error('WALLET_MOVE_EXTERNAL_TOKEN_INVALID');
  const amount = parseTokenAmountInput(input.amountInput, input.tokenDecimals);
  if (input.maxAmount !== undefined && amount > input.maxAmount) {
    throw new Error('WALLET_MOVE_AMOUNT_EXCEEDS_EXTERNAL_BALANCE');
  }
  const internalTokenId = tokenId(input.internalTokenId);
  return Object.freeze([
    ownerInput(input, [buildExternalToReserveTx({ contractAddress, amount, internalTokenId })]),
    ownerInput(input, [buildReserveToCollateralTx({
      counterpartyEntityId: counterpartyId(input.counterpartyEntityId),
      selfEntityId: input.entityId,
      ...(input.receivingEntityId ? { receivingEntityId: counterpartyId(input.receivingEntityId) } : {}),
      tokenId: internalTokenId,
      amount,
    })]),
  ]);
};

export const buildWalletReserveToCollateralInput = (input: CommandOwner & Readonly<{
  counterpartyEntityId: string;
  receivingEntityId?: string;
  tokenId: number;
  tokenDecimals: number;
  amountInput: string;
}>): RuntimeInput => ownerInput(input, [buildReserveToCollateralTx({
  counterpartyEntityId: counterpartyId(input.counterpartyEntityId),
  selfEntityId: input.entityId,
  ...(input.receivingEntityId ? { receivingEntityId: counterpartyId(input.receivingEntityId) } : {}),
  tokenId: tokenId(input.tokenId),
  amount: parseTokenAmountInput(input.amountInput, input.tokenDecimals),
})]);

export const buildWalletCollateralToReserveInput = (input: CommandOwner & Readonly<{
  counterpartyEntityId: string;
  executorIsLeft: boolean;
  tokenId: number;
  tokenDecimals: number;
  amountInput: string;
  maxAmount?: bigint;
  postSettleOp?: MovePostSettleOp;
  broadcast?: boolean;
}>): RuntimeInput => {
  const internalTokenId = tokenId(input.tokenId);
  const amount = parseTokenAmountInput(input.amountInput, input.tokenDecimals);
  if (input.maxAmount !== undefined && amount > input.maxAmount) {
    throw new Error('WALLET_SETTLEMENT_AMOUNT_EXCEEDS_COLLATERAL');
  }
  return ownerInput(input, [{
    type: 'settle_propose',
    data: {
      counterpartyEntityId: counterpartyId(input.counterpartyEntityId),
      executorIsLeft: input.executorIsLeft,
      memo: 'asset-c2r',
      ops: [{ type: 'c2r', tokenId: internalTokenId, amount }],
      continuation: buildMoveSettlementContinuation(
        input.entityId,
        internalTokenId,
        amount,
        input.postSettleOp ?? { type: 'none' },
        input.broadcast ?? true,
      ),
    },
  }]);
};

export const buildWalletSettlementApproveInput = (input: CommandOwner & Readonly<{
  counterpartyEntityId: string;
  workspaceHash: string;
}>): RuntimeInput => {
  const workspaceHash = String(input.workspaceHash || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(workspaceHash)) throw new Error('WALLET_SETTLEMENT_WORKSPACE_HASH_INVALID');
  return ownerInput(input, [buildSettlementApproveTx(counterpartyId(input.counterpartyEntityId), workspaceHash)]);
};

export const buildWalletSettlementExecuteInput = (input: CommandOwner & Readonly<{
  counterpartyEntityId: string;
}>): RuntimeInput => ownerInput(input, [{
  type: 'settle_execute',
  data: { counterpartyEntityId: counterpartyId(input.counterpartyEntityId) },
}]);

export const buildWalletSettlementRejectInput = (input: CommandOwner & Readonly<{
  counterpartyEntityId: string;
  reason?: string;
}>): RuntimeInput => {
  const reason = String(input.reason || '').trim();
  if (reason.length > 200) throw new Error('WALLET_SETTLEMENT_REJECT_REASON_TOO_LONG');
  return ownerInput(input, [{
    type: 'settle_reject',
    data: {
      counterpartyEntityId: counterpartyId(input.counterpartyEntityId),
      ...(reason ? { reason } : {}),
    },
  }]);
};

export const buildWalletPendingBatchInput = (
  owner: CommandOwner,
  action: PendingBatchAction,
): RuntimeInput => ownerInput(owner, buildPendingBatchActionTxs(action));

export const buildWalletDisputePrepareInput = (input: CommandOwner & Readonly<{
  counterpartyEntityId: string;
  acceptedCrossJTargetLossAmount?: bigint;
}>): RuntimeInput => {
  const accepted = input.acceptedCrossJTargetLossAmount;
  if (accepted !== undefined && accepted < 0n) throw new Error('WALLET_DISPUTE_ACCEPTED_LOSS_INVALID');
  return ownerInput(input, [buildPrepareDisputeTx(
    counterpartyId(input.counterpartyEntityId),
    'dispute-prepare-from-react-wallet',
    accepted !== undefined && accepted > 0n
      ? { allowUnsafeCrossJTargetDispute: true, acceptedCrossJTargetLossAmount: accepted }
      : {},
  )]);
};

export const buildWalletDisputeFinalizeInput = (
  input: CommandOwner & Readonly<{ counterpartyEntityId: string }>,
): RuntimeInput => ownerInput(input, [
  buildDisputeFinalizeTx(counterpartyId(input.counterpartyEntityId), 'dispute-finalize-from-react-wallet'),
]);

export const buildWalletDisputedAccountReopenInput = (
  input: CommandOwner & Readonly<{ counterpartyEntityId: string }>,
): RuntimeInput => ownerInput(input, [buildReopenDisputedAccountTx(counterpartyId(input.counterpartyEntityId))]);

type WalletLendingTerm = '1h' | '1d' | '1m';
type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

const lendingId = (value: string, field: string): string => {
  const normalized = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{7,127}$/i.test(normalized)) throw new Error(`WALLET_LENDING_${field}_INVALID`);
  return normalized;
};

const lendingTerm = (value: WalletLendingTerm): WalletLendingTerm => {
  if (value !== '1h' && value !== '1d' && value !== '1m') throw new Error('WALLET_LENDING_TERM_INVALID');
  return value;
};

const basisPoints = (value: number, field: string): number => {
  const normalized = Math.floor(Number(value));
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error(`WALLET_LENDING_${field}_INVALID`);
  return normalized;
};

export const getWalletLendingRemaining = (
  repaymentAmount: string | bigint,
  repaidAmount: string | bigint,
): bigint => {
  const repayment = BigInt(repaymentAmount);
  const repaid = BigInt(repaidAmount);
  if (repayment < 0n || repaid < 0n || repaid > repayment) {
    throw new Error('WALLET_LENDING_REPAYMENT_STATE_INVALID');
  }
  return repayment - repaid;
};

export const buildWalletLendingOfferTx = (input: Readonly<{
  positionId: string;
  hubEntityId: string;
  tokenId: number;
  amount: bigint;
  termId: WalletLendingTerm;
  interestBps: number;
}>): EntityTxOf<'lendingOffer'> => {
  if (input.amount <= 0n) throw new Error('WALLET_LENDING_OFFER_AMOUNT_NOT_POSITIVE');
  return {
  type: 'lendingOffer',
  data: {
    positionId: lendingId(input.positionId, 'POSITION_ID'),
    hubEntityId: counterpartyId(input.hubEntityId),
    tokenId: tokenId(input.tokenId),
    amount: input.amount,
    termId: lendingTerm(input.termId),
    interestBps: basisPoints(input.interestBps, 'INTEREST_BPS'),
  },
  };
};

export const buildWalletLendingOfferInput = (input: CommandOwner & Readonly<{
  positionId: string;
  hubEntityId: string;
  tokenId: number;
  tokenDecimals: number;
  amountInput: string;
  termId: WalletLendingTerm;
  interestBps: number;
}>): RuntimeInput => ownerInput(input, [buildWalletLendingOfferTx({
  ...input,
  amount: parseTokenAmountInput(input.amountInput, input.tokenDecimals),
})]);

export const buildWalletLendingBorrowTx = (input: Readonly<{
  requestId: string;
  hubEntityId: string;
  tokenId: number;
  amount: bigint;
  termId: WalletLendingTerm;
  maxInterestBps: number;
}>): EntityTxOf<'lendingBorrow'> => {
  if (input.amount <= 0n) throw new Error('WALLET_LENDING_BORROW_AMOUNT_NOT_POSITIVE');
  return {
  type: 'lendingBorrow',
  data: {
    requestId: lendingId(input.requestId, 'REQUEST_ID'),
    hubEntityId: counterpartyId(input.hubEntityId),
    tokenId: tokenId(input.tokenId),
    amount: input.amount,
    termId: lendingTerm(input.termId),
    maxInterestBps: basisPoints(input.maxInterestBps, 'MAX_INTEREST_BPS'),
  },
  };
};

export const buildWalletLendingBorrowInput = (input: CommandOwner & Readonly<{
  requestId: string;
  hubEntityId: string;
  tokenId: number;
  tokenDecimals: number;
  amountInput: string;
  termId: WalletLendingTerm;
  maxInterestBps: number;
}>): RuntimeInput => ownerInput(input, [buildWalletLendingBorrowTx({
  ...input,
  amount: parseTokenAmountInput(input.amountInput, input.tokenDecimals),
})]);

export const buildWalletLendingRepayTx = (input: Readonly<{
  loanId: string;
  hubEntityId: string;
  tokenId: number;
  amountRaw: bigint;
}>): EntityTxOf<'lendingRepay'> => {
  if (input.amountRaw <= 0n) throw new Error('WALLET_LENDING_REPAYMENT_NOT_POSITIVE');
  return {
    type: 'lendingRepay',
    data: {
      hubEntityId: counterpartyId(input.hubEntityId),
      loanId: lendingId(input.loanId, 'LOAN_ID'),
      tokenId: tokenId(input.tokenId),
      amount: input.amountRaw,
    },
  };
};

export const buildWalletLendingRepayInput = (input: CommandOwner & Readonly<{
  loanId: string;
  hubEntityId: string;
  tokenId: number;
  amountRaw: bigint;
}>): RuntimeInput => {
  return ownerInput(input, [buildWalletLendingRepayTx(input)]);
};
