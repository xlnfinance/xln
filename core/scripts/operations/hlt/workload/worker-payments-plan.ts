/**
 * Deterministic random pairing and credit sizing for the payment population.
 *
 * A payment run is only a real network test when the sender does not know its
 * receiver in advance: pairing every sender to a fixed partner would exercise
 * one bilateral lane per user forever, which is exactly the shape a routed Hub
 * never sees. Each round therefore permutes the receivers, and the permutation
 * is a pure function of the round so an evidence reader can reconstruct the
 * exact per-receiver total without trusting the driver's own bookkeeping.
 */

/** Odd multiplier: coprime with any power of two, so the step is a permutation. */
const PERMUTATION_STRIDE = 2_654_435_761;

/** Odd multiplier decorrelated from PERMUTATION_STRIDE, for the amount PRNG. */
const AMOUNT_PRNG_STRIDE = 1_000_003n;

export type HltAmountRange = Readonly<{ min: bigint; max: bigint }>;

/**
 * Deterministic per-(sender, round) amount in `[range.min, range.max]`. Pure
 * function of the inputs, like `paymentReceiverIndex`, so an evidence reader
 * can reconstruct the exact per-receiver total without trusting the driver's
 * own bookkeeping — a real network run must vary payment sizes, but the
 * settlement barrier still needs an exact expected total per receiver.
 */
export const paymentAmountFor = (
  senderIndex: number,
  round: number,
  range: HltAmountRange,
): bigint => {
  if (range.min <= 0n) throw new Error(`HLT_PAYMENT_AMOUNT_MIN_INVALID:${range.min}`);
  if (range.max < range.min) throw new Error(`HLT_PAYMENT_AMOUNT_RANGE_INVALID:${range.min}:${range.max}`);
  if (range.max === range.min) return range.min;
  const span = range.max - range.min + 1n;
  const seed = BigInt(senderIndex) * AMOUNT_PRNG_STRIDE + BigInt(round) * BigInt(PERMUTATION_STRIDE);
  // A cheap xorshift-style mix: this is a load-test fixture, not a security
  // boundary, so uniformity over `span` matters more than cryptographic mixing.
  const mixed = (seed ^ (seed >> 17n)) * 0x2545f4914f6cdd1dn;
  const nonNegative = mixed < 0n ? -mixed : mixed;
  return range.min + (nonNegative % span);
};

/**
 * Receiver index for `senderIndex` in `round`, over `receivers` receivers.
 * Every round is a full permutation, so each receiver is paid exactly once per
 * round and per-receiver totals stay exact.
 */
export const paymentReceiverIndex = (
  senderIndex: number,
  round: number,
  receivers: number,
): number => {
  if (!Number.isSafeInteger(receivers) || receivers < 1) {
    throw new Error(`HLT_PAYMENT_RECEIVERS_INVALID:${receivers}`);
  }
  if (!Number.isSafeInteger(senderIndex) || senderIndex < 0 || senderIndex >= receivers) {
    throw new Error(`HLT_PAYMENT_SENDER_INDEX_INVALID:${senderIndex}`);
  }
  if (!Number.isSafeInteger(round) || round < 0) throw new Error(`HLT_PAYMENT_ROUND_INVALID:${round}`);
  // Rotating by the round keeps every round a bijection; the stride decorrelates
  // neighbouring senders so one receiver is not hammered by adjacent lanes.
  const rotated = (senderIndex + round) % receivers;
  return (rotated * (PERMUTATION_STRIDE % receivers) + round) % receivers;
};

/**
 * How much each receiver is owed after `rounds` rounds. With a permutation per
 * round every receiver is paid exactly once per round, so the expectation is
 * uniform — but it is derived rather than assumed, because a future pairing
 * that is not a permutation must fail the evidence check instead of passing it.
 */
export const paymentTotalsByReceiver = (
  senders: number,
  receivers: number,
  rounds: number,
  range: HltAmountRange,
): bigint[] => {
  const totals = Array.from({ length: receivers }, () => 0n);
  for (let round = 0; round < rounds; round += 1) {
    for (let senderIndex = 0; senderIndex < senders; senderIndex += 1) {
      const receiver = paymentReceiverIndex(senderIndex, round, receivers);
      totals[receiver] = totals[receiver]! + paymentAmountFor(senderIndex, round, range);
    }
  }
  return totals;
};

/** What `senderIndex` spends in total; the Hub must be able to fund the mirror. */
export const paymentTotalForSender = (senderIndex: number, rounds: number, range: HltAmountRange): bigint => {
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error(`HLT_PAYMENT_ROUNDS_INVALID:${rounds}`);
  let total = 0n;
  for (let round = 0; round < rounds; round += 1) total += paymentAmountFor(senderIndex, round, range);
  return total;
};
