import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_ACCOUNT_TOKEN_IDS,
  getDefaultRebalancePolicyForToken,
  resolveJurisdictionRebalanceDefaults,
} from '../account/defaults';
import type { EntityState, JurisdictionConfig } from '../entity/types';

const baseJurisdiction: JurisdictionConfig = {
  name: 'Testnet',
  address: 'http://localhost:8545',
  chainId: 31337,
  depositoryAddress: `0x${'11'.repeat(20)}`,
  entityProviderAddress: `0x${'22'.repeat(20)}`,
};

const stateWithJurisdiction = (jurisdiction: JurisdictionConfig): EntityState =>
  ({ config: { jurisdiction } } as unknown as EntityState);

test('rebalance defaults fall back to token defaults when the jurisdiction declares no policy', () => {
  const state = stateWithJurisdiction(baseJurisdiction);
  for (const tokenId of DEFAULT_ACCOUNT_TOKEN_IDS) {
    expect(resolveJurisdictionRebalanceDefaults(state.config.jurisdiction, tokenId))
      .toEqual(getDefaultRebalancePolicyForToken(tokenId));
  }
});

test('rebalance defaults scale jurisdiction USD policy into each token precision', () => {
  const state = stateWithJurisdiction({
    ...baseJurisdiction,
    rebalancePolicyUsd: { r2cRequestSoftLimit: 500, hardLimit: 10_000, maxFee: 15 },
  } as JurisdictionConfig);

  // USDC carries 6 decimals, WETH 18. Same USD policy, different raw scale.
  expect(resolveJurisdictionRebalanceDefaults(state.config.jurisdiction, 1)).toEqual({
    r2cRequestSoftLimit: 500_000_000n,
    hardLimit: 10_000_000_000n,
    maxAcceptableFee: 15_000_000n,
  });
  expect(resolveJurisdictionRebalanceDefaults(state.config.jurisdiction, 2)).toEqual({
    r2cRequestSoftLimit: 500_000_000_000_000_000_000n,
    hardLimit: 10_000_000_000_000_000_000_000n,
    maxAcceptableFee: 15_000_000_000_000_000_000n,
  });
});

test('rebalance defaults reject an inverted or negative jurisdiction policy', () => {
  const inverted = stateWithJurisdiction({
    ...baseJurisdiction,
    rebalancePolicyUsd: { r2cRequestSoftLimit: 10_000, hardLimit: 500, maxFee: 15 },
  } as JurisdictionConfig);
  expect(() => resolveJurisdictionRebalanceDefaults(inverted.config.jurisdiction, 1))
    .toThrow('REBALANCE_POLICY_USD_INVALID:token=1');

  const negative = stateWithJurisdiction({
    ...baseJurisdiction,
    rebalancePolicyUsd: { r2cRequestSoftLimit: -1, hardLimit: 500, maxFee: 15 },
  } as JurisdictionConfig);
  expect(() => resolveJurisdictionRebalanceDefaults(negative.config.jurisdiction, 1))
    .toThrow('REBALANCE_POLICY_USD_INVALID:token=1');
});

/**
 * The opening side seeded its local rebalance policy while the inbound-genesis
 * side left the map empty, and checkAutoRebalance returns early on an empty map.
 * That made auto-rebalance structurally impossible for whichever side did not
 * open the account. Both creation paths must seed from the same resolver.
 */
test('both account creation paths seed the local rebalance policy', () => {
  const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');
  const openAccount = source('runtime/entity/tx/handlers/open-account.ts');
  const inboundAccount = source('runtime/entity/tx/handlers/account/inbound-account.ts');

  for (const handler of [openAccount, inboundAccount]) {
    expect(handler).toContain('resolveJurisdictionRebalanceDefaults');
    expect(handler).toContain('shadow.rebalance.policy.set');
  }
  // Neither side may keep a private copy of the policy maths.
  expect(openAccount).not.toContain('const resolveJurisdictionRebalanceDefaults');
  expect(inboundAccount).toContain('DEFAULT_ACCOUNT_TOKEN_IDS');
});
