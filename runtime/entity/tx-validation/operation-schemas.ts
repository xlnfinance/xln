import type { EntityTxDataSchema } from './fields';

export const ENTITY_TX_OPERATION_SCHEMAS = {
  chatMessage: {
    required: { message: 'string', timestamp: 'integer' },
    optional: { metadata: 'record' },
  },
  'profile-update': { required: { profile: 'record' } },
  certifyProfile: { required: { encryptionAttestations: 'array' } },
  j_event: {
    required: {
      from: 'string', jurisdictionRef: 'string', baseHeight: 'integer',
      scannedThroughHeight: 'integer', tipBlockHash: 'string', eventHistoryRoot: 'string',
      rangeHash: 'string', blocks: 'array', signature: 'string', observedAt: 'integer',
    },
  },
  openAccount: {
    required: { targetEntityId: 'string', disputeConfig: 'record' },
    optional: {
      accountDomain: 'record', watchSeed: 'string', creditAmount: 'bigint',
      tokenId: 'integer', rebalancePolicy: 'record',
    },
  },
  e2r: {
    required: { contractAddress: 'string', amount: 'bigint' },
    optional: { tokenType: 'integer', externalTokenId: 'bigint', internalTokenId: 'integer' },
  },
  r2c: {
    required: { counterpartyId: 'string', tokenId: 'integer', amount: 'bigint' },
    optional: {
      receivingEntityId: 'string', rebalanceQuoteId: 'integer',
      rebalanceFeeTokenId: 'integer', rebalanceFeeAmount: 'bigint',
    },
  },
  r2r: { required: { toEntityId: 'string', tokenId: 'integer', amount: 'bigint' } },
  r2e: { required: { receivingEntity: 'string', tokenId: 'integer', amount: 'bigint' } },
  j_broadcast: { optional: { hankoSignature: 'string', feeOverrides: 'record' } },
  entityProviderTransfer: { required: { to: 'string', tokenId: 'bigint', amount: 'bigint' } },
  entityProviderReleaseControlShares: {
    required: { controlAmount: 'bigint', dividendAmount: 'bigint', purpose: 'string' },
  },
  entityProviderCancelAction: { required: { actionHash: 'string' } },
  j_rebroadcast: { optional: { gasBumpBps: 'integer' } },
  j_abort_sent_batch: { optional: { reason: 'string', requeueToCurrent: 'boolean' } },
  j_clear_batch: { optional: { reason: 'string' } },
  extendCredit: {
    required: { counterpartyEntityId: 'string', tokenId: 'integer', amount: 'bigint' },
  },
  lendingOffer: {
    required: {
      positionId: 'string', hubEntityId: 'string', tokenId: 'integer',
      amount: 'bigint', termId: 'string', interestBps: 'integer',
    },
    literals: { termId: ['1h', '1d', '1m'] },
  },
  lendingBorrow: {
    required: {
      requestId: 'string', hubEntityId: 'string', tokenId: 'integer',
      amount: 'bigint', termId: 'string',
    },
    optional: { maxInterestBps: 'integer' },
    literals: { termId: ['1h', '1d', '1m'] },
  },
  lendingRepay: {
    required: { hubEntityId: 'string', loanId: 'string', tokenId: 'integer', amount: 'bigint' },
  },
  lendingClosePosition: { required: { hubEntityId: 'string', positionId: 'string' } },
  setHubConfig: {
    optional: {
      hubName: 'string', matchingStrategy: 'string', policyVersion: 'integer',
      routingFeePPM: 'integer', baseFee: 'bigint', swapTakerFeeBps: 'integer',
      disputeAutoFinalizeMode: 'string', minCollateralThreshold: 'bigint',
      c2rWithdrawSoftLimit: 'bigint', rebalanceBaseFee: 'bigint',
      rebalanceLiquidityFeeBps: 'bigint', rebalanceGasFee: 'bigint',
      rebalanceTimeoutMs: 'integer',
    },
    literals: {
      matchingStrategy: ['amount', 'time', 'fee'],
      disputeAutoFinalizeMode: ['auto', 'ignore'],
    },
  },
  setRebalancePolicy: {
    required: {
      counterpartyEntityId: 'string', tokenId: 'integer', r2cRequestSoftLimit: 'bigint',
      hardLimit: 'bigint', maxAcceptableFee: 'bigint',
    },
  },
  placeSwapOffer: {
    required: {
      counterpartyEntityId: 'string', offerId: 'string', giveTokenId: 'integer',
      giveAmount: 'bigint', wantTokenId: 'integer', wantAmount: 'bigint',
      maxFee: 'bigint', minNetReceive: 'bigint',
    },
    optional: { priceTicks: 'bigint', timeInForce: 'integer' },
    literals: { timeInForce: [0, 1, 2] },
  },
  proposeCancelSwap: { required: { counterpartyEntityId: 'string', offerId: 'string' } },
  initOrderbookExt: {
    required: {
      name: 'string', spreadDistribution: 'record', referenceTokenId: 'integer',
      usdQuoteAuthorityEntityId: 'string', minTradeSize: 'bigint', supportedPairs: 'stringArray',
    },
  },
  mintReserves: { required: { tokenId: 'integer', amount: 'bigint' } },
  settle_propose: {
    required: { counterpartyEntityId: 'string', ops: 'array' },
    optional: { executorIsLeft: 'boolean', memo: 'string', continuation: 'record' },
  },
  settle_update: {
    required: { counterpartyEntityId: 'string', ops: 'array' },
    optional: { executorIsLeft: 'boolean', memo: 'string' },
  },
  settle_approve: { required: { counterpartyEntityId: 'string', workspaceHash: 'string' } },
  settle_execute: {
    required: { counterpartyEntityId: 'string' },
    optional: { disableC2RShortcut: 'boolean' },
  },
  settle_reject: {
    required: { counterpartyEntityId: 'string' },
    optional: { reason: 'string' },
  },
} as const satisfies Readonly<Record<string, EntityTxDataSchema>>;
