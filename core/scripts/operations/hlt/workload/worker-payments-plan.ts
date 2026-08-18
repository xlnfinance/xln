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
  amount: bigint,
): bigint[] => {
  const totals = Array.from({ length: receivers }, () => 0n);
  for (let round = 0; round < rounds; round += 1) {
    for (let senderIndex = 0; senderIndex < senders; senderIndex += 1) {
      const receiver = paymentReceiverIndex(senderIndex, round, receivers);
      totals[receiver] = totals[receiver]! + amount;
    }
  }
  return totals;
};

/** What each sender spends in total; the Hub must be able to fund the mirror. */
export const paymentTotalPerSender = (rounds: number, amount: bigint): bigint => {
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error(`HLT_PAYMENT_ROUNDS_INVALID:${rounds}`);
  if (amount <= 0n) throw new Error(`HLT_PAYMENT_AMOUNT_INVALID:${amount}`);
  return amount * BigInt(rounds);
};
