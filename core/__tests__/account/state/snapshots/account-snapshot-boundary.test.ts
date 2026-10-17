import { expect, test } from 'bun:test';
import { validateAccountReplica } from '../../../../account/validation/state-validation';
import { LIMITS } from '../../../../config/constants';
import { entity, makeAccount } from '../../../helpers/cross-j';

const offer = (offerId: string) => ({
  offerId,
  giveTokenId: 1,
  wantTokenId: 2,
  giveTokenDecimals: 6,
  wantTokenDecimals: 6,
  giveAmount: 20n,
  wantAmount: 20n,
  maxFee: 0n,
  minNetReceive: 20n,
  priceTicks: 10_000n,
  makerIsLeft: true,
  createdHeight: 1,
  quantizedGive: 20n,
  quantizedWant: 20n,
});
const account = () => makeAccount(entity('11'), entity('22'));

test('canonical empty Account snapshot still validates', () => {
  const canonical = account();
  expect(validateAccountReplica(canonical)).toBe(canonical);
});

test('complete unsigned dispute drafts retain their canonical proposer side', () => {
  for (const prefix of ['current', 'counterparty']) {
    const canonical = {
      ...account(),
      [`${prefix}DisputeHash`]: entity('33'),
      [`${prefix}DisputeProofBodyHash`]: entity('44'),
      [`${prefix}DisputeProofNonce`]: 1,
      [`${prefix}DisputeProofProposerIsLeft`]: false,
    };
    expect(validateAccountReplica(canonical)).toBe(canonical);
  }
});

test('Account snapshot rejects an offer indexed under another signed offerId', () => {
  const canonical = account();
  const malformed = { ...canonical, state: { ...canonical.state, swapOffers: new Map([['wrong', offer('signed')]]) } };
  expect(() => validateAccountReplica(malformed)).toThrow('offerId');
});

test('Account snapshot rejects more offers than canonical admission permits', () => {
  const canonical = account();
  const swapOffers = new Map(
    Array.from({ length: LIMITS.MAX_ACCOUNT_SWAP_OFFERS + 1 }, (_, index) => {
      const key = `offer-${index}`;
      return [key, offer(key)] as const;
    }),
  );
  expect(() => validateAccountReplica({ ...canonical, state: { ...canonical.state, swapOffers } })).toThrow(
    'offer limit',
  );
});

test('Account snapshot rejects partial proof metadata and orphan Hanko on either side', () => {
  for (const prefix of ['current', 'counterparty']) {
    expect(() => validateAccountReplica({ ...account(), [`${prefix}DisputeHash`]: entity('33') })).toThrow(
      'PROOF_PARTIAL',
    );
    expect(() => validateAccountReplica({ ...account(), [`${prefix}DisputeProofHanko`]: '0x1234' })).toThrow(
      'HANKO_WITHOUT_PROOF',
    );
  }
});
