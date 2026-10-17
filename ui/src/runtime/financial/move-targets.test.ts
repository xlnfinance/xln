import { expect, test } from 'bun:test';
import { moveTargetCounterparties } from './move-targets';

const jurisdiction = { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` };
const accounts = [{ counterpartyId: 'h1', label: 'H1' }];
const summaries = ['alice', 'bob', 'h1', 'h2'].map(entityId => ({
  entityId,
  label: entityId,
  height: 0,
  jurisdiction,
}));
const selection = { self: 'alice', recipient: 'bob', accounts, summaries, jurisdiction };

test('remote recipient can receive through H2 without a sender H2 Account', () => {
  expect(moveTargetCounterparties(selection).map(row => row.counterpartyId)).toEqual(['alice', 'h1', 'h2']);
  expect(accounts).toEqual([{ counterpartyId: 'h1', label: 'H1' }]);
});

test('own Account funding retains only the sender Account choices', () => {
  for (const recipient of ['', 'alice', ' ALICE ']) {
    expect(moveTargetCounterparties({ ...selection, recipient })).toBe(accounts);
  }
});

test('same label does not admit another chain or depository, or an unqualified stack', () => {
  const foreign = [
    { entityId: 'foreign-chain', label: 'H2', height: 0, jurisdiction: { ...jurisdiction, chainId: 1 } },
    {
      entityId: 'foreign-contract',
      label: 'H2',
      height: 0,
      jurisdiction: { ...jurisdiction, depositoryAddress: `0x${'22'.repeat(20)}` },
    },
    {
      entityId: 'unqualified',
      label: 'H2',
      height: 0,
      jurisdiction: { depositoryAddress: jurisdiction.depositoryAddress },
    },
  ];
  expect(moveTargetCounterparties({ ...selection, summaries: foreign })).toEqual([]);
  expect(moveTargetCounterparties({ ...selection, jurisdiction: undefined })).toEqual([]);
  expect(
    moveTargetCounterparties({ ...selection, jurisdiction: { depositoryAddress: jurisdiction.depositoryAddress } }),
  ).toEqual([]);
});
