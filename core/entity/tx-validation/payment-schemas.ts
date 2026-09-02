import type { EntityTxDataSchema } from './fields';

export const ENTITY_TX_PAYMENT_SCHEMAS = {
  directPayment: {
    required: {
      targetEntityId: 'string', tokenId: 'integer', amount: 'bigint', route: 'stringArray',
      deliveryMode: 'string',
    },
    optional: { description: 'string', trustedGatewayEntityId: 'string' },
    literals: { deliveryMode: ['direct', 'trusted'] },
  },
  resolveHtlcLock: {
    required: { counterpartyEntityId: 'string', lockId: 'string', secret: 'string' },
    optional: { crossJurisdictionRouteId: 'string', description: 'string' },
  },
  crossPullClose: {
    required: { counterpartyEntityId: 'string', pullId: 'string', binary: 'string', proof: 'record' },
    optional: { route: 'record', description: 'string' },
  },
  requestCollateral: {
    required: {
      counterpartyEntityId: 'string', tokenId: 'integer', amount: 'bigint',
      feeAmount: 'bigint', policyVersion: 'integer',
    },
    optional: { feeTokenId: 'integer' },
  },
  prepareDispute: {
    required: { counterpartyEntityId: 'string' },
    optional: {
      description: 'string', minCooldownMs: 'integer', crossJurisdictionRouteId: 'string',
      starterInitialArguments: 'string',
    },
  },
  disputeStart: {
    required: { counterpartyEntityId: 'string' },
    // The counter commitment is derived from the higher-priority bilaterally
    // signed proof. A wire override is not Hanko-bound and must remain an
    // unknown field instead of becoming attacker-selected finalize evidence.
    optional: {
      crossJurisdictionRouteId: 'string', starterInitialArguments: 'string',
      starterCounterArguments: 'string', description: 'string',
    },
  },
  disputeFinalize: {
    required: { counterpartyEntityId: 'string' },
    optional: { useOnchainRegistry: 'boolean', description: 'string' },
  },
  processHtlcTimeouts: { optional: { expiredLocks: 'array' } },
} as const satisfies Readonly<Record<string, EntityTxDataSchema>>;
