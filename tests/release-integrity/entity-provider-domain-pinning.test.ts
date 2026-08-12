import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  assertEntityProviderGovernanceDomains,
  expectedEntityProviderGovernanceDomains,
} from '../../jurisdictions/scripts/verify/entity-provider-domains';

test('public EntityProvider deployment must expose the canonical governance domains', () => {
  const expected = expectedEntityProviderGovernanceDomains();
  expect(() => assertEntityProviderGovernanceDomains(expected)).not.toThrow();
  expect(() => assertEntityProviderGovernanceDomains({
    ...expected,
    BOARD_PROPOSAL_DOMAIN: keccak256(toUtf8Bytes('XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_V3')),
  })).toThrow('ENTITY_PROVIDER_GOVERNANCE_DOMAIN_MISMATCH:BOARD_PROPOSAL_DOMAIN');
});

test('public verification checks domains before source publication and stale Sepolia is disabled', () => {
  const verifier = readFileSync(
    resolve(process.cwd(), 'jurisdictions/scripts/verify/verify-public-stack.ts'),
    'utf8',
  );
  expect(verifier.indexOf('await verifyEntityProviderGovernanceDomains(')).toBeGreaterThan(0);
  expect(verifier.indexOf('await verifyEntityProviderGovernanceDomains('))
    .toBeLessThan(verifier.indexOf('const targets ='));

  const testnet = JSON.parse(readFileSync(
    resolve(process.cwd(), 'jurisdictions/deployments/testnet.json'),
    'utf8',
  )) as { jurisdictions?: Record<string, { status?: string }> };
  expect(testnet.jurisdictions?.['ethereum-sepolia']?.status).toBe('pending');
});
