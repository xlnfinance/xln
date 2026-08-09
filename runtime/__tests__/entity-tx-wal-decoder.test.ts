import { describe, expect, test } from 'bun:test';
import { validateEntityTx } from '../entity/tx-validation';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;
const gatewayId = `0x${'44'.repeat(32)}`;
const hash = `0x${'33'.repeat(32)}`;

describe('persisted EntityTx decoder', () => {
  test('rejects malformed payloads before a restored frame reaches a reducer', () => {
    expect(() => validateEntityTx(
      { type: 'directPayment', data: {} },
      'WAL_DIRECT_PAYMENT',
    )).toThrow('WAL_DIRECT_PAYMENT_DATA_FIELDS');

    expect(() => validateEntityTx(
      { type: 'j_event', data: { from: entityId } },
      'WAL_J_EVENT',
    )).toThrow('WAL_J_EVENT_DATA_FIELDS');

    expect(() => validateEntityTx(
      { type: 'accountInput', data: { kind: 'frame' } },
      'WAL_ACCOUNT_INPUT',
    )).toThrow('WAL_ACCOUNT_INPUT_DATA_FROM_ENTITY_ID');

    expect(() => validateEntityTx(
      {
        type: 'accountInput',
        data: {
          kind: 'unknown',
          fromEntityId: counterpartyId,
          toEntityId: entityId,
          domain: { chainId: 31_337, depositoryAddress: `0x${'55'.repeat(20)}` },
          disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        },
      },
      'WAL_ACCOUNT_INPUT_KIND',
    )).toThrow('WAL_ACCOUNT_INPUT_KIND_DATA_KIND_INVALID:unknown');
  });

  test('rejects extra fields, wrong primitives, and invalid literal unions', () => {
    expect(() => validateEntityTx({
      type: 'directPayment',
      data: {
        targetEntityId: counterpartyId,
        tokenId: '1',
        amount: 10n,
        route: [entityId, counterpartyId],
        deliveryMode: 'direct',
      },
    }, 'WAL_DIRECT_PAYMENT')).toThrow('WAL_DIRECT_PAYMENT_DATA_TOKENID');

    expect(() => validateEntityTx({
      type: 'directPayment',
      data: {
        targetEntityId: counterpartyId,
        tokenId: 1,
        amount: 10n,
        route: [entityId, counterpartyId],
        deliveryMode: 'instant',
      },
    }, 'WAL_DIRECT_PAYMENT')).toThrow('WAL_DIRECT_PAYMENT_DATA_DELIVERYMODE_VALUE');

    expect(() => validateEntityTx({
      type: 'directPayment',
      data: {
        targetEntityId: counterpartyId,
        tokenId: 1,
        amount: 10n,
        route: [entityId, gatewayId, counterpartyId],
        deliveryMode: 'trusted',
      },
    }, 'WAL_DIRECT_PAYMENT')).toThrow('WAL_DIRECT_PAYMENT_DATA_TRUSTED_GATEWAY_REQUIRED');

    expect(() => validateEntityTx({
      type: 'mintReserves',
      data: { tokenId: 1, amount: 10n, ignored: true },
    }, 'WAL_MINT')).toThrow('WAL_MINT_DATA_FIELDS');
  });

  test('accepts representative payment, cross-j, operation, and Account inputs', () => {
    expect(validateEntityTx({
      type: 'directPayment',
      data: {
        targetEntityId: counterpartyId,
        tokenId: 1,
        amount: 10n,
        route: [entityId, gatewayId, counterpartyId],
        deliveryMode: 'trusted',
        trustedGatewayEntityId: gatewayId,
      },
    }, 'WAL_DIRECT_PAYMENT').type).toBe('directPayment');

    expect(validateEntityTx({
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: 'order-1',
        fillSeq: 1,
        incrementalSourceAmount: 2n,
        incrementalTargetAmount: 3n,
        cumulativeSourceAmount: 2n,
        cumulativeTargetAmount: 3n,
        cumulativeFillRatio: 32_768,
        pairId: '1:2',
      },
    }, 'WAL_CROSS_J').type).toBe('crossJurisdictionFillNotice');

    expect(validateEntityTx({
      type: 'lendingOffer',
      data: {
        positionId: 'position-1',
        hubEntityId: entityId,
        tokenId: 1,
        amount: 100n,
        termId: '1d',
        interestBps: 125,
      },
    }, 'WAL_LENDING').type).toBe('lendingOffer');

    expect(validateEntityTx({
      type: 'accountInput',
      data: {
        kind: 'dispute',
        fromEntityId: entityId,
        toEntityId: counterpartyId,
        domain: { chainId: 31_337, depositoryAddress: `0x${'44'.repeat(20)}` },
        disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        watchSeed: hash,
        disputeSeal: {
          hash,
          proofBodyHash: hash,
          proofNonce: 1,
          proposerIsLeft: true,
        },
      },
    }, 'WAL_ACCOUNT').type).toBe('accountInput');
  });
});
