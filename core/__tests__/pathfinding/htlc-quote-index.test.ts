import { describe, expect, test } from 'bun:test';

import {
  buildRoutingProfileIndex,
  lookupUniqueRoutingProfile,
  quoteHtlcPaymentRoute,
} from '../../pathfinding/htlc-quote';
import { calculateRequiredInboundForDesiredForward } from '../../protocol/htlc/utils';

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

  test('a hub base fee far above the payment quotes instead of throwing', () => {
    // 10 units through a hub charging base 10_000_000 + 1 ppm. The first
    // search probe already has fee >= amount; the old inversion threw
    // "Fee ... exceeds amount" there and halted the payer's Runtime.
    const greedyHub = { ...hubProfile(), metadata: { routingFeePPM: 1, baseFee: 10_000_000n } };
    const quote = quoteHtlcPaymentRoute(
      [userProfile(ALICE, HUB), greedyHub, userProfile(BOB, HUB)],
      [ALICE, HUB, BOB],
      1,
      10n,
    );
    expect(quote.senderLockAmount).toBe(10_000_020n);
    expect(quote.hopForwardAmounts.get(HUB)).toBe(10n);
  });

  test('fee inversion returns the exact minimum inbound, like Rust required_htlc_inbound', () => {
    const forwarded = (amountIn: bigint, ppm: number, base: bigint) =>
      amountIn - (base + (amountIn * BigInt(ppm)) / 1_000_000n);
    for (const [desired, ppm, base] of [
      [1n, 0, 0n], [10n, 1, 10_000_000n], [1n, 999_999, 0n], [123_456n, 2_500, 7n],
    ] as const) {
      const inbound = calculateRequiredInboundForDesiredForward(desired, ppm, base);
      expect(forwarded(inbound, ppm, base) >= desired).toBe(true);
      expect(forwarded(inbound - 1n, ppm, base) < desired).toBe(true);
    }
    expect(() => calculateRequiredInboundForDesiredForward(1n, 1_000_000, 0n))
      .toThrow('HTLC_QUOTE_FEE_INVALID');
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
