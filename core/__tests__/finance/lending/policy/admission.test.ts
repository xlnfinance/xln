import { expect, test } from 'bun:test';
import { handleLendingPolicy } from '../../../../entity/tx/handlers/payments/lending-policy';
import { safeStringify } from '../../../../protocol/serialization';
import { addr, entity, makeJurisdiction, makeState } from '../../../helpers/cross-j';
import type { EntityTx } from '../../../../types/entity-tx';

const BANK = entity('11');
const BORROWER = entity('22');
const jurisdiction = makeJurisdiction('bank-policy-admission', 31337, 'dd', 'ee');
const terms = {
  chainId: jurisdiction.chainId,
  depositoryAddress: jurisdiction.depositoryAddress,
  tokenId: 1,
  termId: '1h' as const,
  savingsInterestBps: 100,
  loanInterestBps: 200,
  loanLateMs: 3_600_000,
  expiresAt: 9_000_000,
};
const facility = {
  borrowerEntityId: BORROWER,
  tokenId: 1,
  termId: '1h' as const,
  maxPrincipal: 2_500n,
  expiresAt: 9_000_000,
};
type PolicyTx = Extract<EntityTx, { type: 'lendingSetTerms' | 'lendingApprove' }>;
const injectedFacility = { ...facility, chainId: 31338, depositoryAddress: addr('44'), jNonce: 99 };
const extraEnvelope = { type: 'lendingSetTerms' as const, data: terms, untrustedExtra: true };

const cases: Array<{ tx: PolicyTx; rejection: string }> = [
  {
    tx: { type: 'lendingApprove', data: injectedFacility },
    rejection: 'LENDING_POLICY_INPUT_DATA_FIELDS:missing=none:extra=chainId,depositoryAddress,jNonce',
  },
  { tx: extraEnvelope, rejection: 'LENDING_POLICY_INPUT_FIELDS:missing=none:extra=untrustedExtra' },
  {
    tx: { type: 'lendingSetTerms', data: { ...terms, depositoryAddress: `0x${'DD'.repeat(20)}` } },
    rejection: 'LENDING_POLICY_DOMAIN_INVALID',
  },
  {
    tx: { type: 'lendingSetTerms', data: { ...terms, savingsInterestBps: -1 } },
    rejection: 'LENDING_POLICY_INPUT_DATA_SAVINGSINTERESTBPS:-1',
  },
  {
    tx: { type: 'lendingSetTerms', data: { ...terms, expiresAt: Number.MAX_SAFE_INTEGER } },
    rejection: 'LENDING_POLICY_CLOCK_OVERFLOW:9007199261940992',
  },
  {
    tx: { type: 'lendingApprove', data: { ...facility, termId: 'demand' } },
    rejection: 'LENDING_POLICY_INPUT_DATA_TERMID_VALUE',
  },
  {
    tx: { type: 'lendingApprove', data: { ...facility, maxPrincipal: -1n } },
    rejection: 'LENDING_FACILITY_AMOUNT_INVALID',
  },
  {
    tx: { type: 'lendingApprove', data: { ...facility, expiresAt: -1 } },
    rejection: 'LENDING_POLICY_INPUT_DATA_EXPIRESAT:-1',
  },
];

for (const { tx, rejection } of cases)
  test(`local bank policy rejects before mutation: ${rejection}`, () => {
    const state = makeState(BANK, addr('33'), jurisdiction, BORROWER);
    state.profile = { ...state.profile, isHub: true };
    const before = safeStringify(state);
    expect(() => handleLendingPolicy(state, tx, true)).toThrow(rejection);
    expect(safeStringify(state)).toBe(before);
    try {
      handleLendingPolicy(state, tx, true);
      throw new Error('MALFORMED_POLICY_ACCEPTED');
    } catch (error) {
      expect(error).toMatchObject({ disposition: 'reject', rejection });
    }
  });
