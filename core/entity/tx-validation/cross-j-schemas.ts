import type { EntityTxDataSchema } from './fields';

const ROUTE = { required: { route: 'record' } } as const;

export const ENTITY_TX_CROSS_J_SCHEMAS = {
  registerCrossJurisdictionSwap: ROUTE,
  prepareCrossJurisdictionSwap: ROUTE,
  crossJurisdictionFillNotice: {
    required: { orderId: 'string', fillSeq: 'integer', cumulativeFillRatio: 'integer' },
    optional: { routeHash: 'string', cancelRemainder: 'boolean' },
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
  crossJurisdictionForceSiblingDispute: {
    required: { routeId: 'string', observedCounterpartyEntityId: 'string' },
    optional: { observedAt: 'integer' },
  },
  orderbookSweepCrossJurisdiction: { optional: { reason: 'string' } },
  admitCrossJurisdictionBookOrder: {
    required: { route: 'record' },
    optional: { reason: 'string' },
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
