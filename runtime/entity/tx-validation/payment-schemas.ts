import type { EntityTxDataSchema } from './fields';

export const ENTITY_TX_PAYMENT_SCHEMAS = {
  directPayment: {
    required: { targetEntityId: 'string', tokenId: 'integer', amount: 'bigint', route: 'stringArray' },
    optional: { description: 'string', deliveryMode: 'string', trustedGatewayEntityId: 'string' },
    literals: { deliveryMode: ['trusted'] },
  },
  hashlockPayment: {
    required: { targetEntityId: 'string', tokenId: 'integer', amount: 'bigint', hashlock: 'string' },
    optional: {
      lockId: 'string', timelock: 'bigint', revealBeforeHeight: 'integer',
      description: 'string', startedAtMs: 'integer', crossJurisdictionRelay: 'record',
    },
  },
  resolveHtlcLock: {
    required: { counterpartyEntityId: 'string', lockId: 'string', secret: 'string' },
    optional: { crossJurisdictionRouteId: 'string', description: 'string' },
  },
  pullLock: {
    required: {
      counterpartyEntityId: 'string', pullId: 'string', tokenId: 'integer', amount: 'bigint',
      revealedUntilTimestamp: 'integer', fullHash: 'string', partialRoot: 'string',
    },
    optional: { crossJurisdiction: 'record', crossJurisdictionRoute: 'record', description: 'string' },
  },
  resolvePull: {
    required: { counterpartyEntityId: 'string', pullId: 'string', binary: 'string' },
    optional: { description: 'string' },
  },
  cancelPull: {
    required: { counterpartyEntityId: 'string', pullId: 'string' },
    optional: { description: 'string' },
  },
  crossPullClose: {
    required: { counterpartyEntityId: 'string', pullId: 'string', binary: 'string', proof: 'record' },
    optional: { route: 'record', description: 'string' },
  },
  pullCancelExpired: {
    required: { counterpartyEntityId: 'string', pullId: 'string' },
    optional: { description: 'string' },
  },
  requestCollateral: {
    required: {
      counterpartyEntityId: 'string', tokenId: 'integer', amount: 'bigint',
      feeAmount: 'bigint', policyVersion: 'integer',
    },
    optional: { feeTokenId: 'integer' },
  },
  reopenDisputedAccount: {
    required: { counterpartyEntityId: 'string' },
    optional: { jNonce: 'integer' },
  },
  prepareDispute: {
    required: { counterpartyEntityId: 'string' },
    optional: {
      description: 'string', minCooldownMs: 'integer', crossJurisdictionRouteId: 'string',
      starterInitialArguments: 'string', allowUnsafeCrossJTargetDispute: 'boolean',
      acceptedCrossJTargetLossAmount: 'bigint',
    },
  },
  disputeStart: {
    required: { counterpartyEntityId: 'string' },
    optional: {
      crossJurisdictionRouteId: 'string', starterInitialArguments: 'string',
      starterIncrementedArguments: 'string', description: 'string',
      allowUnsafeCrossJTargetDispute: 'boolean', acceptedCrossJTargetLossAmount: 'bigint',
    },
  },
  disputeFinalize: {
    required: { counterpartyEntityId: 'string' },
    optional: { cooperative: 'boolean', useOnchainRegistry: 'boolean', description: 'string' },
  },
  processHtlcTimeouts: { optional: { expiredLocks: 'array' } },
  manualHtlcLock: {
    required: {
      counterpartyId: 'string', lockId: 'string', hashlock: 'string', timelock: 'bigint',
      revealBeforeHeight: 'integer', amount: 'bigint', tokenId: 'integer',
    },
  },
} as const satisfies Readonly<Record<string, EntityTxDataSchema>>;
