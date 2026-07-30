import { describe, expect, test } from 'bun:test';
import { decodeAccountFrame } from '../account/frame-validation';
import { decodeAccountTx } from '../account/tx-validation';

const hash = `0x${'11'.repeat(32)}`;
const entityId = `0x${'22'.repeat(32)}`;

const decodeTx = (value: unknown, code = 'ACCOUNT_TX') =>
  decodeAccountTx(value, code);

const genesisFrame = (accountTxs: unknown[]) => ({
  height: 0,
  timestamp: 0,
  jHeight: 0,
  accountTxs,
  prevFrameHash: '',
  accountStateRoot: hash,
  stateHash: '',
  byLeft: true,
  deltas: [],
});

describe('signed Account frame transaction decoder', () => {
  test('requires the signed bilateral proposer side', () => {
    const { byLeft: _byLeft, ...missingSide } = genesisFrame([]);
    expect(() => decodeAccountFrame(missingSide)).toThrow(
      'AccountFrame.fields:missing=byLeft',
    );
  });

  test('rejects malformed money payloads and unknown or extra fields', () => {
    expect(() => decodeTx({
      type: 'direct_payment',
      data: { tokenId: 1, amount: '10' },
    })).toThrow('ACCOUNT_TX_DATA_AMOUNT');

    expect(() => decodeTx({
      type: 'request_collateral',
      data: {
        tokenId: 1,
        amount: 10n,
        feeAmount: 1n,
        policyVersion: 1,
        ignored: true,
      },
    })).toThrow('ACCOUNT_TX_DATA_FIELDS');

    expect(() => decodeTx({ type: 'future_money_tx', data: {} }))
      .toThrow('ACCOUNT_TX_TYPE_UNKNOWN');
  });

  test('rejects malformed nested settlement payloads', () => {
    expect(() => decodeTx({
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        revision: 1,
        executorIsLeft: true,
        ops: [{ type: 'r2c', tokenId: 1, amount: '10' }],
      },
    })).toThrow('ACCOUNT_TX_DATA_OPS_0_AMOUNT');

  });

  test('accepts representative financial, lending, HTLC, and settlement variants', () => {
    expect(decodeTx({
      type: 'direct_payment',
      data: { tokenId: 1, amount: 10n, deliveryMode: 'trusted' },
    }).type).toBe('direct_payment');

    expect(decodeTx({
      type: 'lending_fund',
      data: {
        positionId: 'position-1',
        hubEntityId: entityId,
        lenderEntityId: entityId,
        tokenId: 1,
        amount: 100n,
        termId: '1d',
        interestBps: 125,
      },
    }).type).toBe('lending_fund');

    expect(decodeTx({
      type: 'htlc_resolve',
      data: { lockId: 'lock-1', outcome: 'secret', secret: 'secret' },
    }).type).toBe('htlc_resolve');

    expect(decodeTx({
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        revision: 1,
        executorIsLeft: true,
        ops: [{ type: 'r2c', tokenId: 1, amount: 10n }],
      },
    }).type).toBe('settle_transition');
  });

  test('decodeAccountFrame applies the exact AccountTx boundary', () => {
    expect(() => decodeAccountFrame(genesisFrame([
      { type: 'set_credit_limit', data: { tokenId: 1, amount: '10' } },
    ]))).toThrow('AccountFrame.accountTxs_0_DATA_AMOUNT');

    const decoded = decodeAccountFrame(genesisFrame([
      { type: 'set_credit_limit', data: { tokenId: 1, amount: 10n } },
    ]));
    expect(decoded.accountTxs[0]?.type).toBe('set_credit_limit');
  });

  test('rejects fractional or negative Account frame coordinates', () => {
    expect(() => decodeAccountFrame({
      ...genesisFrame([]),
      height: 0.5,
    })).toThrow('AccountFrame.height');
    expect(() => decodeAccountFrame({
      ...genesisFrame([]),
      jHeight: -1,
    })).toThrow('AccountFrame.jHeight');
    expect(() => decodeAccountFrame({
      ...genesisFrame([]),
      deltas: false,
    })).toThrow('AccountFrame.deltas');
    expect(() => decodeAccountFrame({
      ...genesisFrame([]),
      byLeft: 'left',
    })).toThrow('AccountFrame.byLeft');
  });

  test('requires canonical frame hashes at every committed height', () => {
    expect(() => decodeAccountFrame({
      ...genesisFrame([]),
      height: 1,
      timestamp: 1,
      prevFrameHash: 'genesis',
      stateHash: 'short',
    })).toThrow('AccountFrame.stateHash is invalid for height 1');

    expect(() => decodeAccountFrame({
      ...genesisFrame([]),
      height: 2,
      timestamp: 1,
      prevFrameHash: 'genesis',
      stateHash: hash,
    })).toThrow('AccountFrame.prevFrameHash is invalid for height 2');
  });

});
