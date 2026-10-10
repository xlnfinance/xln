import type { AccountTxDataSchema } from './fields';

export const ACCOUNT_TX_PAYMENT_SCHEMAS = {
  direct_payment: {
    required: {
      tokenId: 'tokenId', amount: 'bigint', route: 'stringArray', deliveryMode: 'string',
      fromEntityId: 'string', toEntityId: 'string',
    },
    optional: {
      description: 'string', trustedGatewayEntityId: 'string',
    },
    literals: { deliveryMode: ['direct', 'trusted'] },
  },
  add_delta: { required: { tokenId: 'tokenId' } },
  set_credit_limit: { required: { tokenId: 'tokenId', amount: 'bigint' } },
  request_collateral: {
    required: {
      tokenId: 'tokenId', amount: 'bigint', feeAmount: 'bigint', policyVersion: 'integer',
    },
    optional: { feeTokenId: 'tokenId' },
  },
  rebalance_refund: {
    required: {
      requestId: 'string', requestTokenId: 'tokenId', amount: 'bigint', reason: 'string',
    },
    literals: { reason: ['policy_mismatch', 'timeout', 'fee_too_low', 'manual'] },
  },
  rebalance_policy: {
    required: {
      tokenId: 'tokenId', policyVersion: 'integer', baseFee: 'bigint',
      liquidityFeeBps: 'bigint', gasFee: 'bigint',
    },
  },
  cross_pull_lock: {
    required: {
      pullId: 'string', tokenId: 'tokenId', amount: 'bigint',
      fullHash: 'string', partialRoot: 'string',
      crossJurisdiction: 'record', crossJurisdictionRoute: 'record',
    },
  },
  swap_offer: {
    required: {
      offerId: 'string', giveTokenId: 'tokenId', giveTokenDecimals: 'integer', giveAmount: 'bigint',
      wantTokenId: 'tokenId', wantTokenDecimals: 'integer', wantAmount: 'bigint', maxFee: 'bigint',
      minNetReceive: 'bigint',
    },
    optional: { priceTicks: 'bigint', timeInForce: 'integer', crossJurisdiction: 'record' },
    literals: { timeInForce: [0, 1, 2] },
  },
  swap_cancel_request: { required: { offerId: 'string' } },
  swap_resolve: {
    required: { offerId: 'string', fillRatio: 'integer', cancelRemainder: 'boolean' },
    optional: {
      fillNumerator: 'bigint', fillDenominator: 'bigint', comment: 'string',
      feeTokenId: 'tokenId', feeAmount: 'bigint', executionGiveAmount: 'bigint',
      executionWantAmount: 'bigint', restingGiveTokenId: 'tokenId',
      restingWantTokenId: 'tokenId', restingPriceTicks: 'bigint',
      restingGiveAmount: 'bigint', restingWantAmount: 'bigint',
      restingQuantizedGive: 'bigint', restingQuantizedWant: 'bigint',
    },
  },
} as const satisfies Readonly<Record<string, AccountTxDataSchema>>;
