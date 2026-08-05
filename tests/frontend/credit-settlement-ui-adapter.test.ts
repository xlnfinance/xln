import { expect, test } from 'bun:test';

import {
  buildWalletAddTokenInput,
  buildWalletCollateralToReserveInput,
  buildWalletCreditInput,
  buildWalletDisputeFinalizeInput,
  buildWalletDisputePrepareInput,
  buildWalletDisputedAccountReopenInput,
  buildWalletExternalToAccountInputs,
  buildWalletExternalToReserveInput,
  buildWalletLendingBorrowInput,
  buildWalletLendingOfferInput,
  buildWalletLendingRepayInput,
  buildWalletOpenAccountInput,
  buildWalletPendingBatchInput,
  buildWalletReserveToCollateralInput,
  buildWalletReserveToExternalInput,
  buildWalletReserveTransferInput,
  buildWalletSettlementApproveInput,
  buildWalletSettlementExecuteInput,
  buildWalletSettlementRejectInput,
  getWalletLendingRemaining,
} from '../../frontend/packages/runtime-client/wallet-financial-input-adapter';

const ENTITY = `0x${'11'.repeat(32)}`;
const PEER = `0x${'22'.repeat(32)}`;
const RECIPIENT = `0x${'33'.repeat(32)}`;
const owner = { entityId: ENTITY, signerId: 'signer' };

test('builds exact credit and reserve movement commands through canonical transaction types', () => {
  expect(buildWalletOpenAccountInput(owner, PEER, { tokenId: 1, amount: 10_000_000_000n })
    .entityInputs?.[0]?.entityTxs).toEqual([{
      type: 'openAccount',
      data: { targetEntityId: PEER, tokenId: 1, creditAmount: 10_000_000_000n },
    }]);
  expect(buildWalletAddTokenInput({
    ...owner, counterpartyEntityId: PEER, tokenId: 1,
  }).entityInputs?.[0]?.entityTxs).toEqual([{
    type: 'extendCredit',
    data: { counterpartyEntityId: PEER, tokenId: 1, amount: 0n },
  }]);
  expect(buildWalletCreditInput({
    ...owner, counterpartyEntityId: PEER, tokenId: 1, tokenDecimals: 6, amountInput: '12.5',
  }).entityInputs?.[0]?.entityTxs).toEqual([{
    type: 'extendCredit',
    data: { counterpartyEntityId: PEER, tokenId: 1, amount: 12_500_000n },
  }]);
  expect(buildWalletReserveTransferInput({
    ...owner, recipientEntityId: RECIPIENT, tokenId: 1, tokenDecimals: 6, amountInput: '2', broadcast: true,
  }).entityInputs?.[0]?.entityTxs).toEqual([
    { type: 'r2r', data: { toEntityId: RECIPIENT, tokenId: 1, amount: 2_000_000n } },
    { type: 'j_broadcast', data: {} },
  ]);
  expect(buildWalletReserveToExternalInput({
    ...owner, recipientEoa: '0x1111111111111111111111111111111111111111',
    tokenId: 1, tokenDecimals: 6, amountInput: '1.5', broadcast: true,
  }).entityInputs?.[0]?.entityTxs).toEqual([
    { type: 'r2e', data: { receivingEntity: `0x${'00'.repeat(12)}${'11'.repeat(20)}`, tokenId: 1, amount: 1_500_000n } },
    { type: 'j_broadcast', data: {} },
  ]);
  expect(buildWalletExternalToReserveInput({
    ...owner, contractAddress: '0x4444444444444444444444444444444444444444',
    internalTokenId: 1, tokenDecimals: 6, amountInput: '3.25', maxAmount: 4_000_000n,
  }).entityInputs?.[0]?.entityTxs).toEqual([{
    type: 'e2r',
    data: {
      contractAddress: '0x4444444444444444444444444444444444444444',
      internalTokenId: 1,
      amount: 3_250_000n,
    },
  }]);
  expect(buildWalletExternalToAccountInputs({
    ...owner, contractAddress: '0x4444444444444444444444444444444444444444',
    internalTokenId: 1, tokenDecimals: 6, amountInput: '3.25', counterpartyEntityId: PEER,
  }).map(input => input.entityInputs?.[0]?.entityTxs)).toEqual([
    [{
      type: 'e2r',
      data: {
        contractAddress: '0x4444444444444444444444444444444444444444',
        internalTokenId: 1,
        amount: 3_250_000n,
      },
    }],
    [{
      type: 'r2c',
      data: { counterpartyId: PEER, tokenId: 1, amount: 3_250_000n },
    }],
  ]);
});

test('preserves settlement ownership and workspace evidence without UI-side delta math', () => {
  expect(buildWalletReserveToCollateralInput({
    ...owner, counterpartyEntityId: PEER, receivingEntityId: RECIPIENT,
    tokenId: 1, tokenDecimals: 6, amountInput: '3',
  }).entityInputs?.[0]?.entityTxs[0]).toEqual({
    type: 'r2c',
    data: { counterpartyId: PEER, receivingEntityId: RECIPIENT, tokenId: 1, amount: 3_000_000n },
  });
  expect(buildWalletCollateralToReserveInput({
    ...owner, counterpartyEntityId: PEER, executorIsLeft: true,
    tokenId: 1, tokenDecimals: 6, amountInput: '1.25',
  }).entityInputs?.[0]?.entityTxs[0]).toEqual({
    type: 'settle_propose',
    data: {
      counterpartyEntityId: PEER,
      executorIsLeft: true,
      memo: 'asset-c2r',
      ops: [{ type: 'c2r', tokenId: 1, amount: 1_250_000n }],
      continuation: { actions: [], broadcast: true },
    },
  });
  expect(buildWalletCollateralToReserveInput({
    ...owner, counterpartyEntityId: PEER, executorIsLeft: true,
    tokenId: 1, tokenDecimals: 6, amountInput: '1.25',
    postSettleOp: { type: 'r2e', recipientEoa: '0x5555555555555555555555555555555555555555' },
  }).entityInputs?.[0]?.entityTxs[0]).toMatchObject({
    type: 'settle_propose',
    data: {
      continuation: {
        actions: [{
          type: 'r2e',
          receivingEntity: `0x${'00'.repeat(12)}${'55'.repeat(20)}`,
          tokenId: 1,
          amount: 1_250_000n,
        }],
        broadcast: true,
      },
    },
  });
  const workspaceHash = `0x${'aa'.repeat(32)}`;
  expect(buildWalletSettlementApproveInput({
    ...owner, counterpartyEntityId: PEER, workspaceHash,
  }).entityInputs?.[0]?.entityTxs[0]).toEqual({
    type: 'settle_approve', data: { counterpartyEntityId: PEER, workspaceHash },
  });
  expect(buildWalletSettlementExecuteInput({
    ...owner, counterpartyEntityId: PEER,
  }).entityInputs?.[0]?.entityTxs[0]).toEqual({
    type: 'settle_execute', data: { counterpartyEntityId: PEER },
  });
  expect(buildWalletSettlementRejectInput({
    ...owner, counterpartyEntityId: PEER, reason: 'operator-rejected',
  }).entityInputs?.[0]?.entityTxs[0]).toEqual({
    type: 'settle_reject', data: { counterpartyEntityId: PEER, reason: 'operator-rejected' },
  });
  expect(buildWalletPendingBatchInput(owner, 'broadcast').entityInputs?.[0]?.entityTxs[0]).toEqual({
    type: 'j_broadcast', data: {},
  });
  expect(buildWalletPendingBatchInput(owner, 'clear').entityInputs?.[0]?.entityTxs[0]).toEqual({
    type: 'j_clear_batch', data: { reason: 'global-batch-bar-clear' },
  });
  expect(buildWalletPendingBatchInput(owner, 'rebroadcast').entityInputs?.[0]?.entityTxs[0]).toEqual({
    type: 'j_rebroadcast', data: { gasBumpBps: 1000 },
  });
});

test('builds dispute lifecycle commands with explicit accepted cross-j risk', () => {
  expect(buildWalletDisputePrepareInput({
    ...owner, counterpartyEntityId: PEER, acceptedCrossJTargetLossAmount: 7_500_000n,
  }).entityInputs?.[0]?.entityTxs[0]).toEqual({
    type: 'prepareDispute',
    data: {
      counterpartyEntityId: PEER,
      description: 'dispute-prepare-from-react-wallet',
      allowUnsafeCrossJTargetDispute: true,
      acceptedCrossJTargetLossAmount: 7_500_000n,
    },
  });
  expect(buildWalletDisputeFinalizeInput({
    ...owner, counterpartyEntityId: PEER,
  }).entityInputs?.[0]?.entityTxs[0]).toMatchObject({ type: 'disputeFinalize' });
  expect(buildWalletDisputedAccountReopenInput({
    ...owner, counterpartyEntityId: PEER,
  }).entityInputs?.[0]?.entityTxs[0]).toEqual({
    type: 'reopenDisputedAccount', data: { counterpartyEntityId: PEER },
  });
});

test('rejects unavailable boundaries before command submission', () => {
  expect(() => buildWalletOpenAccountInput(owner, PEER, { tokenId: 1, amount: 0n }))
    .toThrow('WALLET_OPEN_ACCOUNT_CREDIT_NOT_POSITIVE');
  expect(() => buildWalletCreditInput({
    ...owner, counterpartyEntityId: PEER, tokenId: 1, tokenDecimals: 6, amountInput: '-1',
  })).toThrow('TOKEN_AMOUNT_FORMAT_INVALID');
  expect(() => buildWalletSettlementApproveInput({
    ...owner, counterpartyEntityId: PEER, workspaceHash: 'stale',
  })).toThrow('WALLET_SETTLEMENT_WORKSPACE_HASH_INVALID');
  expect(() => buildWalletCollateralToReserveInput({
    ...owner, counterpartyEntityId: PEER, executorIsLeft: true,
    tokenId: 1, tokenDecimals: 6, amountInput: '2', maxAmount: 1_000_000n,
  })).toThrow('WALLET_SETTLEMENT_AMOUNT_EXCEEDS_COLLATERAL');
  expect(() => buildWalletSettlementRejectInput({
    ...owner, counterpartyEntityId: PEER, reason: 'x'.repeat(201),
  })).toThrow('WALLET_SETTLEMENT_REJECT_REASON_TOO_LONG');
  expect(() => buildWalletExternalToReserveInput({
    ...owner, contractAddress: 'not-a-token', internalTokenId: 1,
    tokenDecimals: 6, amountInput: '1',
  })).toThrow('WALLET_MOVE_EXTERNAL_TOKEN_INVALID');
  expect(() => buildWalletExternalToReserveInput({
    ...owner, contractAddress: '0x4444444444444444444444444444444444444444', internalTokenId: 1,
    tokenDecimals: 6, amountInput: '2', maxAmount: 1_000_000n,
  })).toThrow('WALLET_MOVE_AMOUNT_EXCEEDS_EXTERNAL_BALANCE');
});

test('builds the sole canonical lending offer, borrow, and repay operations', () => {
  expect(buildWalletLendingOfferInput({
    ...owner, positionId: 'lend-12345678', hubEntityId: PEER,
    tokenId: 1, tokenDecimals: 6, amountInput: '50', termId: '1d', interestBps: 125,
  }).entityInputs?.[0]?.entityTxs[0]).toMatchObject({
    type: 'lendingOffer', data: { amount: 50_000_000n, termId: '1d', interestBps: 125 },
  });
  expect(buildWalletLendingBorrowInput({
    ...owner, requestId: 'borrow-12345678', hubEntityId: PEER,
    tokenId: 1, tokenDecimals: 6, amountInput: '12.5', termId: '1h', maxInterestBps: 250,
  }).entityInputs?.[0]?.entityTxs[0]).toMatchObject({
    type: 'lendingBorrow', data: { amount: 12_500_000n, termId: '1h', maxInterestBps: 250 },
  });
  expect(buildWalletLendingRepayInput({
    ...owner, loanId: 'loan-12345678', hubEntityId: PEER, tokenId: 1, amountRaw: 13_000_000n,
  }).entityInputs?.[0]?.entityTxs[0]).toMatchObject({
    type: 'lendingRepay', data: { amount: 13_000_000n, loanId: 'loan-12345678' },
  });
  expect(getWalletLendingRemaining('13000000', '3000000')).toBe(10_000_000n);
  expect(() => getWalletLendingRemaining('1', '2')).toThrow('WALLET_LENDING_REPAYMENT_STATE_INVALID');
});
