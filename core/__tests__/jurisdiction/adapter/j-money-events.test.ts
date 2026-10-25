import { expect, test } from 'bun:test';
import type { Interface } from 'ethers';
import { Depository__factory } from '../../../../jurisdictions/typechain-types';
import { rawEventToJEvents } from '../../../jurisdiction/adapter/events/j-event-payloads';

const depository = Depository__factory.createInterface();
const left = `0x${'11'.repeat(32)}`;
const right = `0x${'22'.repeat(32)}`;
const word = 1n << 256n;

function decodeEvent(iface: Interface, name: string, values: unknown[]) {
  const event = iface.getEvent(name);
  if (!event) throw new Error(`MISSING_ABI_EVENT:${name}`);
  const parsed = iface.parseLog(iface.encodeEventLog(event, values));
  if (!parsed) throw new Error(`MISSING_DECODED_EVENT:${name}`);
  return rawEventToJEvents({ name, args: parsed.args.toObject(), blockNumber: 1 }, left);
}

test('AccountSettled retains a negative allocation beyond the old signed word', () => {
  const events = decodeEvent(depository, 'AccountSettled', [[{
    left, right, nonce: 1n,
    tokens: [{ tokenId: 1n, leftReserve: 0n, rightReserve: 0n, collateral: 0n,
      ondelta: { high: -2n, low: word - 1n } }],
  }]]);
  expect(events).toHaveLength(1);
  expect(events[0]?.data).toMatchObject({ ondelta: (-word - 1n).toString() });
});

test('all debt events preserve unsigned512 amounts in canonical decimal fields', () => {
  const amount = { high: 1n, low: 7n };
  const expected = (word + 7n).toString();
  const created = decodeEvent(depository, 'DebtCreated', [left, right, 1n, amount, 0n, 1n]);
  const enforced = decodeEvent(depository, 'DebtEnforced', [left, right, 1n, 9n, amount, 0n]);
  const forgiven = decodeEvent(depository, 'DebtForgiven', [left, right, 1n, amount, 0n]);
  expect(created[0]?.data).toMatchObject({ amount: expected, debtSeq: '1' });
  expect(enforced[0]?.data).toMatchObject({ amountPaid: '9', remainingAmount: expected });
  expect(forgiven[0]?.data).toMatchObject({ amountForgiven: expected });
});

test('a retired scalar debt payload is rejected at the raw ABI boundary', () => {
  expect(() => rawEventToJEvents({ name: 'DebtCreated', args: {
    debtor: left, creditor: right, tokenId: 1n, amount: 7n, debtIndex: 0n, debtSeq: 1n,
  }, blockNumber: 1 }, left)).toThrow('ABI_MONEY_TUPLE');
});
