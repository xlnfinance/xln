export type SwapNetAuthorization = Readonly<{
  maxFee: bigint;
  minNetReceive: bigint;
}>;

/**
 * Fee authority belongs to the maker's signed offer, not the hub's mutable fee
 * configuration. Partial fills consume a fraction of that authority measured
 * on the give leg: fee rounds down and required net rounds up. Using the
 * received leg instead would let price improvement enlarge the signed fee cap;
 * rounding both values down would let many small fills evade minimum net.
 * Remainders subtract the rounded authorization consumed by removed give.
 * Re-rounding only the retained fraction would erase fee budget and duplicate
 * minimum-net budget across a sequence of otherwise equivalent partial fills.
 */

type SwapNetAuthorizedOffer = SwapNetAuthorization & Readonly<{
  giveAmount: bigint;
  wantAmount: bigint;
}>;

const ceilDivide = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

const assertOfferAuthorization = (offer: SwapNetAuthorizedOffer): void => {
  if (
    typeof offer.giveAmount !== 'bigint' ||
    typeof offer.wantAmount !== 'bigint' ||
    offer.giveAmount <= 0n ||
    offer.wantAmount <= 0n
  ) {
    throw new Error('SWAP_NET_AUTH_OFFER_AMOUNT_INVALID');
  }
  if (typeof offer.maxFee !== 'bigint' || offer.maxFee < 0n || offer.maxFee > offer.wantAmount) {
    throw new Error('SWAP_NET_AUTH_MAX_FEE_INVALID');
  }
  if (
    typeof offer.minNetReceive !== 'bigint' ||
    offer.minNetReceive < 0n ||
    offer.minNetReceive > offer.wantAmount
  ) {
    throw new Error('SWAP_NET_AUTH_MIN_RECEIVE_INVALID');
  }
};

export const deriveSwapNetAuthorization = (
  wantAmount: bigint,
  bps: number,
): SwapNetAuthorization => {
  if (wantAmount <= 0n) throw new Error('SWAP_NET_AUTH_WANT_INVALID');
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error('SWAP_NET_AUTH_BPS_INVALID');
  }
  const maxFee = (wantAmount * BigInt(bps)) / 10_000n;
  const authorization = { maxFee, minNetReceive: wantAmount - maxFee };
  if (authorization.maxFee >= wantAmount || authorization.minNetReceive <= 0n) {
    throw new Error('SWAP_NET_AUTH_MAX_FEE_INVALID');
  }
  assertOfferAuthorization({ giveAmount: 1n, wantAmount, ...authorization });
  return authorization;
};

const proRataAuthorization = (
  offer: SwapNetAuthorizedOffer,
  giveAmount: bigint,
): SwapNetAuthorization => ({
  maxFee: (offer.maxFee * giveAmount) / offer.giveAmount,
  minNetReceive: ceilDivide(offer.minNetReceive * giveAmount, offer.giveAmount),
});

export const assertSwapNetAuthorization = (
  offer: SwapNetAuthorizedOffer,
  filledGive: bigint,
  filledWant: bigint,
  fee: bigint,
): void => {
  assertOfferAuthorization(offer);
  if (typeof filledGive !== 'bigint' || filledGive < 0n || filledGive > offer.giveAmount) {
    throw new Error('SWAP_NET_AUTH_FILL_GIVE_INVALID');
  }
  if (
    typeof filledWant !== 'bigint' ||
    typeof fee !== 'bigint' ||
    filledWant < 0n ||
    fee < 0n ||
    fee > filledWant ||
    (filledWant > 0n && fee >= filledWant)
  ) {
    throw new Error('SWAP_NET_AUTH_FILL_WANT_INVALID');
  }
  const allowed = proRataAuthorization(offer, filledGive);
  if (fee > allowed.maxFee) throw new Error('SWAP_NET_AUTH_MAX_FEE_EXCEEDED');
  if (filledWant - fee < allowed.minNetReceive) {
    throw new Error('SWAP_NET_AUTH_MIN_RECEIVE_NOT_MET');
  }
};

export const requantizeSwapNetAuthorization = (
  offer: SwapNetAuthorizedOffer,
  nextGiveAmount: bigint,
  nextWantAmount: bigint,
): SwapNetAuthorization => {
  assertOfferAuthorization(offer);
  if (nextGiveAmount <= 0n || nextGiveAmount > offer.giveAmount || nextWantAmount <= 0n) {
    throw new Error('SWAP_NET_AUTH_REMAINDER_INVALID');
  }
  const removed = proRataAuthorization(offer, offer.giveAmount - nextGiveAmount);
  const authorization = {
    maxFee: offer.maxFee - removed.maxFee,
    minNetReceive: offer.minNetReceive - removed.minNetReceive,
  };
  assertOfferAuthorization({
    giveAmount: nextGiveAmount,
    wantAmount: nextWantAmount,
    ...authorization,
  });
  return authorization;
};
