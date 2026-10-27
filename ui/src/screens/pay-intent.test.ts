import { expect, test } from 'bun:test';
import { parseXlnInvoice } from '../../../frontend/src/lib/utils/xlnInvoice';
import { invoiceNote, resolvePayRecipient } from './pay-intent';

const first = `0x${'1'.repeat(64)}`;
const second = `0x${'2'.repeat(64)}`;
const known = [
  { entityId: first, label: 'Alice' },
  { entityId: second, label: 'Alice' },
];

test('a picked recipient retains its identity despite duplicate or changed gossip labels', () => {
  expect(resolvePayRecipient('Alice', second, known).target).toBe(second);
  expect(resolvePayRecipient('Alice', second, [{ entityId: first, label: 'Alice' }]).target).toBe(second);
});

test('editing a selection to an ambiguous typed name refuses payment until an explicit pick', () => {
  expect(resolvePayRecipient(' ALICE ', null, known)).toEqual({ target: '', ambiguous: true });
  expect(resolvePayRecipient('Alice', null, [known[0]!])).toEqual({ target: first, ambiguous: false });
  expect(resolvePayRecipient(second.toUpperCase(), null, known).target).toBe(second);
  expect(resolvePayRecipient('unknown', null, known).target).toBe('');
  expect(resolvePayRecipient('', null, known).target).toBe('');
});

test('custody invoices preserve the exact uid note and lock, with or without a description', () => {
  const invoice = parseXlnInvoice(`xln://pay?target=${second}&desc=Lunch&u=alice`);
  expect(invoiceNote(invoice)).toEqual({ description: 'Lunch | uid:alice', locked: true });
  expect(invoiceNote({ ...invoice, description: '' })).toEqual({ description: 'uid:alice', locked: true });
  expect(invoiceNote({ ...invoice, recipientUserId: '', noteLocked: false })).toEqual({
    description: 'Lunch',
    locked: true,
  });
  expect(invoiceNote({ ...invoice, recipientUserId: '', description: '', noteLocked: true })).toEqual({
    description: '',
    locked: true,
  });
});

test('a new plain invoice clears any prior custody attribution and unlocks the note', () => {
  expect(invoiceNote(parseXlnInvoice(`xln://pay?target=${second}`))).toEqual({ description: '', locked: false });
});
