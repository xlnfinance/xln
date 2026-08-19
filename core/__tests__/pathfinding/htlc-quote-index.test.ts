import { describe, expect, test } from 'bun:test';

import {
  buildRoutingProfileIndex,
  lookupUniqueRoutingProfile,
  quoteHtlcPaymentRoute,
} from '../../pathfinding/htlc-quote';

const id = (nibble: string): string => `0x${nibble.repeat(32)}`;
const ALICE = id('1');
const HUB = id('2');
const BOB = id('3');
const domain = { chainId: 1, depositoryAddress: `0x${'aa'.repeat(20)}` };

const userProfile = (entityId: string, hubId: string) => ({
  entityId,
  entityEncryptionPublicKey: id('9'),
  metadata: { routingFeePPM: 1, baseFee: 0n },
  accounts: [{
    counterpartyId: hubId,
    domain,
    tokenCapacities: { 1: { inCapacity: 1_000n, outCapacity: 1_000n } },
  }],
});

const hubProfile = () => ({
  entityId: HUB,
  entityEncryptionPublicKey: id('8'),
  metadata: { routingFeePPM: 1, baseFee: 0n },
  accounts: [] as Array<{
    counterpartyId: string;
    domain: typeof domain;
    tokenCapacities: Record<number, { inCapacity: bigint; outCapacity: bigint }>;
  }>,
});

describe('routing profile index', () => {
  test('lookup is case-insensitive and requires exactly one profile', () => {
    const index = buildRoutingProfileIndex([
      userProfile(ALICE.toUpperCase(), HUB),
      hubProfile(),
      userProfile(BOB, HUB),
    ]);
    expect(lookupUniqueRoutingProfile(index, ALICE).entityId.toLowerCase()).toBe(ALICE);
    expect(() => lookupUniqueRoutingProfile(index, id('4'))).toThrow('HTLC_PAYMENT_PROFILE_MATCH_COUNT');
    const duplicated = buildRoutingProfileIndex([userProfile(BOB, HUB), userProfile(BOB, HUB)]);
    expect(() => lookupUniqueRoutingProfile(duplicated, BOB)).toThrow(':2');
  });

  test('a missing hop profile fails quote instead of inventing capacity', () => {
    expect(() => quoteHtlcPaymentRoute(
      [userProfile(ALICE, HUB), hubProfile()],
      [ALICE, HUB, BOB],
      1,
      10n,
    )).toThrow(`HTLC_PAYMENT_PROFILE_MATCH_COUNT:${BOB}:0`);
  });
});
