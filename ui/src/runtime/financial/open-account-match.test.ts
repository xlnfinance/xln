import { expect, test } from 'bun:test';
import type { EntityTx } from '@xln/core/api/public/runtime-module';
import { entityTxOpensAccount } from './open-account-match';

const hub = `0x${'ab'.repeat(32)}`;
const other = `0x${'cd'.repeat(32)}`;
const open = (target: string) => ({
  type: 'openAccount',
  data: { targetEntityId: target, creditAmount: 0n, tokenId: 1 },
}) as unknown as EntityTx;
const command = (txs: EntityTx[]) => ({ type: 'entityCommand', data: { txs } }) as unknown as EntityTx;
const proposal = (txs: EntityTx[]) =>
  ({ type: 'propose', data: { proposer: 'p', action: { type: 'entity_transaction', data: { txs } } } }) as unknown as EntityTx;

// Admission wraps a user's openAccount into a signed entityCommand (and a
// multi-signer board into a collective proposal) before it reaches the Entity
// mempool, proposal or locked frame; the pending check must see through both.
test('an openAccount is found bare, inside an entityCommand and inside a collective proposal', () => {
  expect(entityTxOpensAccount(open(hub.toUpperCase().replace('0X', '0x')), hub)).toBe(true);
  expect(entityTxOpensAccount(command([open(hub)]), hub)).toBe(true);
  expect(entityTxOpensAccount(proposal([command([open(hub)])]), hub)).toBe(true);
  expect(entityTxOpensAccount(command([open(other)]), hub)).toBe(false);
  expect(entityTxOpensAccount({ type: 'propose', data: { proposer: 'p', action: { type: 'collective_message', data: { message: 'x' } } } } as unknown as EntityTx, hub)).toBe(false);
});
