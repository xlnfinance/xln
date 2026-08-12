export type SwapNetAuthorization = Readonly<{
  maxFee: bigint;
  minNetReceive: bigint;
}>;

/**
 * Fee authority belongs to the maker's signed offer, not the hub's mutable fee
 * configuration. Nonterminal fills consume authority on the give leg: fee
 * rounds down and required net rounds up. A terminal fill may instead consume
 * the larger capped want progress because price improvement can satisfy the
 * full receive target while leaving give unspent. This exception is safe only
 * when cancelRemainder closes the offer; applying it to a live remainder would
 * duplicate authority across split fills. Remainders therefore continue to
 * subtract only give-leg authorization.
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

const fillAuthorization = (
  offer: SwapNetAuthorizedOffer,
  filledGive: bigint,
  filledWant: bigint,
  closesRemainder: boolean,
): SwapNetAuthorization => {
  let numerator = filledGive;
  let denominator = offer.giveAmount;
  if (closesRemainder) {
    const cappedWant = filledWant < offer.wantAmount ? filledWant : offer.wantAmount;
    if (cappedWant * denominator > numerator * offer.wantAmount) {
      numerator = cappedWant;
      denominator = offer.wantAmount;
    }
  }
  return {
    maxFee: (offer.maxFee * numerator) / denominator,
    minNetReceive: ceilDivide(offer.minNetReceive * numerator, denominator),
  };
};

export const deriveSwapFillPolicyFee = (
  offer: Readonly<{ giveAmount: bigint; wantAmount: bigint }>,
  filledGive: bigint,
  filledWant: bigint,
  bps: number,
  closesRemainder: boolean,
): bigint => {
  const policy = deriveSwapNetAuthorization(offer.wantAmount, bps);
  const authorizedPolicy = { ...offer, ...policy };
  assertOfferAuthorization(authorizedPolicy);
  if (typeof filledGive !== 'bigint' || filledGive < 0n || filledGive > offer.giveAmount) {
    throw new Error('SWAP_NET_AUTH_FILL_GIVE_INVALID');
  }
  if (typeof filledWant !== 'bigint' || filledWant < 0n) {
    throw new Error('SWAP_NET_AUTH_FILL_WANT_INVALID');
  }
  return fillAuthorization(authorizedPolicy, filledGive, filledWant, closesRemainder).maxFee;
};

export const assertSwapNetAuthorization = (
  offer: SwapNetAuthorizedOffer,
  filledGive: bigint,
  filledWant: bigint,
  fee: bigint,
  closesRemainder: boolean,
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
  const allowed = fillAuthorization(offer, filledGive, filledWant, closesRemainder);
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
