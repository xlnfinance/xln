import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyAccountTx } from '../../../account/tx/apply';
import type { AccountTx } from '../../../types/account';
import { safeStringify } from '../../../protocol/serialization';
import { entity, makeAccount } from '../../helpers/cross-j';

type Vector = Readonly<{
  status: 'dispute_preparing' | 'disputed';
  txType: 'direct_payment';
  expectedCode: 'ACCOUNT_CLOSED_FOR_DISPUTE';
  expectedMessage: string;
}>;

const LEFT = entity('11');
const RIGHT = entity('22');
const vectors = JSON.parse(readFileSync(
  join(import.meta.dir, 'account-tx-dispute-admission-vectors.json'),
  'utf8',
)) as { vectors: Vector[] };

const payment = (): Extract<AccountTx, { type: 'direct_payment' }> => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount: 1n,
    route: [RIGHT],
    fromEntityId: LEFT,
    toEntityId: RIGHT,
    deliveryMode: 'direct',
  },
});

test('shared frozen AccountTx vectors reject before mutating TypeScript state', async () => {
  for (const vector of vectors.vectors) {
    const account = makeAccount(LEFT, RIGHT);
    account.status = vector.status;
    const before = safeStringify(account);
    const result = await applyAccountTx(account, payment(), true, 2_000);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`ACCOUNT_TX_VECTOR_UNEXPECTED_OK:${vector.status}`);
    expect(result.rejection.code).toBe(vector.expectedCode);
    expect(result.rejection.message).toBe(vector.expectedMessage);
    expect(safeStringify(account)).toBe(before);
  }
});
