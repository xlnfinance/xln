import { expect, test } from 'bun:test';
import { parseXlnInvoice } from '../../../../../frontend/src/lib/utils/xlnInvoice';
import { invoiceNote } from '../../../../../ui/src/screens/pay-intent';

test('fixpay-8 a TRON invoice cannot populate an EVM Pay form', () => {
  const invoice = parseXlnInvoice(`xln://pay?target=0x${'22'.repeat(32)}&jId=tron`);
  expect(() => Reflect.apply(invoiceNote, undefined, [invoice, 'sepolia'])).toThrow('jurisdiction');
});

test('fixpay-8 a jurisdiction switch invalidates an already accepted scoped invoice', () => {
  const invoice = parseXlnInvoice(`xln://pay?target=0x${'22'.repeat(32)}&jId=tron`);
  expect(() => invoiceNote(invoice, 'tron')).not.toThrow();
  expect(() => invoiceNote(invoice, 'sepolia')).toThrow('jurisdiction');
  expect(() => invoiceNote(invoice)).toThrow('jurisdiction');
});
