import type { EntityTxDataSchema } from './fields';

const ROUTE = { required: { route: 'record' } } as const;

export const ENTITY_TX_CROSS_J_SCHEMAS = {
  registerCrossJurisdictionSwap: ROUTE,
  prepareCrossJurisdictionSwap: ROUTE,
  crossJurisdictionFillNotice: {
    required: {
      orderId: 'string', fillSeq: 'integer', incrementalSourceAmount: 'bigint',
      incrementalTargetAmount: 'bigint', cumulativeSourceAmount: 'bigint',
      cumulativeTargetAmount: 'bigint', cumulativeFillRatio: 'integer', pairId: 'string',
    },
    optional: {
      routeHash: 'string', previousFillSeq: 'integer', fillNumerator: 'bigint',
      fillDenominator: 'bigint', priceImprovementMode: 'string',
      priceImprovementAmount: 'bigint', priceImprovementTokenId: 'integer',
      cancelRemainder: 'boolean', priceTicks: 'bigint',
    },
    literals: { priceImprovementMode: ['source_savings'] },
  },
  crossJurisdictionSettled: {
    required: { orderId: 'string', routeHash: 'string', binary: 'string', proof: 'record' },
  },
  requestCrossJurisdictionClear: {
    required: { orderId: 'string' },
    optional: { cancelRemainder: 'boolean', route: 'record' },
  },
  crossJurisdictionSalvage: {
    required: {
      routeId: 'string', binary: 'string', fillRatio: 'integer',
      sourceEntityId: 'string', sourceCounterpartyEntityId: 'string',
    },
    optional: { observedAt: 'integer' },
  },
  orderbookSweepCrossJurisdiction: { optional: { reason: 'string' } },
  admitCrossJurisdictionBookOrder: {
    required: { route: 'record' },
    optional: { reason: 'string' },
  },
  applyCrossJurisdictionBookProgress: {
    required: {
      orderId: 'string', sourceEntityId: 'string', fillSeq: 'integer',
      incrementalSourceAmount: 'bigint', incrementalTargetAmount: 'bigint',
      cumulativeSourceAmount: 'bigint', cumulativeTargetAmount: 'bigint',
      cumulativeFillRatio: 'integer',
    },
    optional: {
      fillNumerator: 'bigint', fillDenominator: 'bigint', priceImprovementMode: 'string',
      priceImprovementAmount: 'bigint', priceImprovementTokenId: 'integer',
      cancelRemainder: 'boolean', reason: 'string',
    },
    literals: { priceImprovementMode: ['source_savings'] },
  },
  removeCrossJurisdictionBookOrder: {
    required: { orderId: 'string', sourceEntityId: 'string' },
    optional: { sourceAccountId: 'string', route: 'record', reason: 'string' },
  },
  crossJurisdictionBookOrderRemoved: {
    required: {
      orderId: 'string', sourceEntityId: 'string', sourceAccountId: 'string',
      route: 'record', removedAt: 'integer',
    },
    optional: { reason: 'string' },
  },
} as const satisfies Readonly<Record<string, EntityTxDataSchema>>;
