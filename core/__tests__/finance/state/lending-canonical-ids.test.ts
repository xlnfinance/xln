import { expect, test } from 'bun:test';
import { decodeAccountTx } from '../../../account/tx-validation';
import { ACCOUNT_TX_LENDING_SCHEMAS } from '../../../account/tx-validation/lending-schemas';

const hub = `0x${'ab'.repeat(32)}`;
const lender = `0x${'cd'.repeat(32)}`;
const fund = { type: 'lending_fund', data: { positionId: 'lend-1111111111111111', hubEntityId: hub,
  lenderEntityId: lender, tokenId: 1, amount: 10_000n, termId: '1d', interestBps: 10_000 } };

test('uppercase hub cannot pass the savings schema and bypass bank acceptance policy', () => {
  expect(decodeAccountTx(fund, 'TEST')).toEqual(fund);
  expect(() => decodeAccountTx({ ...fund, data: { ...fund.data, hubEntityId: `0x${'AB'.repeat(32)}` } }, 'TEST')).toThrow();
});

for (const [type, schema] of Object.entries(ACCOUNT_TX_LENDING_SCHEMAS)) {
  if (type === 'credit_request') continue;
  for (const field of Object.keys(schema.required).filter(key => key.endsWith('EntityId'))) {
    test(`${type} rejects noncanonical ${field} at the schema boundary`, () => {
      const data = Object.fromEntries(Object.entries(schema.required).map(([key, kind]) => [key,
        key.endsWith('EntityId') ? hub : key === 'termId' ? '1d' : kind === 'bigint' ? 1n : kind === 'integer' ? 1 : 'id']));
      for (const invalid of [`0x${'AB'.repeat(32)}`, ` ${hub}`, `${hub} `, '0x12']) {
        expect(() => decodeAccountTx({ type, data: { ...data, [field]: invalid } }, 'TEST')).toThrow();
      }
    });
  }
}

test('noncanonical lending identity has a typed sender-reject disposition', () => {
  let failure: unknown;
  try {
    decodeAccountTx({ ...fund, data: { ...fund.data, hubEntityId: `0x${'AB'.repeat(32)}` } }, 'PEER');
  } catch (error) {
    failure = error;
  }
  expect(failure).toHaveProperty('disposition', 'reject');
  expect(failure).toHaveProperty('code', 'ACCOUNT_TX_ENTITY_ID_NON_CANONICAL');
});
