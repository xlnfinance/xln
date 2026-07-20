import { describe, expect, test } from 'bun:test';

import { parseXlnInvoice } from '../../frontend/src/lib/utils/xlnInvoice';

const TARGET = `0x${'ab'.repeat(32)}`;
const PAYLOAD = encodeURIComponent(`${TARGET}?token=1&amount=5&desc=Local+payment`);

describe('xln invoice URL policy', () => {
  test('accepts HTTP only for an exact loopback host', () => {
    expect(parseXlnInvoice(`http://127.0.0.1:8080/app#pay/${PAYLOAD}`)).toMatchObject({
      targetEntityId: TARGET,
      tokenId: 1,
      amount: '5',
      description: 'Local payment',
    });
    expect(parseXlnInvoice(`http://localhost:8080/app#pay/${PAYLOAD}`).amount).toBe('5');
    expect(() => parseXlnInvoice(`http://xln.finance/app#pay/${PAYLOAD}`)).toThrow('Unsupported invoice format');
    expect(() => parseXlnInvoice(`http://127.0.0.1.evil.test/app#pay/${PAYLOAD}`)).toThrow('Unsupported invoice format');
  });
});
