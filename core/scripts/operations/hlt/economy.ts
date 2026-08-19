/**
 * Declarative micro-economy for one high-load test run.
 *
 * The harness is configured by describing the population — how many user
 * Runtimes exist, how often each of them acts, what they trade and against
 * which Hub — and every derived quantity (lane count, round count, cadence,
 * offered rates) follows from that description. Nothing here reaches the
 * network: this module is pure so the plan can be asserted before a single
 * process is spawned.
 */

import { requireBoundaryInteger } from '../../../protocol/boundary-validation';

/** Relative weights of the workloads a user may offer. */
export type HltWorkloadMix = Readonly<{
  swap: number;
  payment: number;
}>;

export type HltAmountRange = Readonly<{ min: bigint; max: bigint }>;

/** Every HLT payment before this session was this exact fixed amount. */
export const HLT_DEFAULT_PAYMENT_AMOUNT_RANGE: HltAmountRange = { min: 1_000n, max: 1_000n };

export type HltEconomy = Readonly<{
  /** Total user Runtime processes. Swap lanes pair them as maker/taker. */
  users: number;
  /** Actions offered per user per second. */
  ratePerUserPerSecond: number;
  durationSeconds: number;
  mix: HltWorkloadMix;
  baseTokenId: number;
  quoteTokenId: number;
  /** Hub labels from the mesh manifest, e.g. ['H1'] or ['H1','H2','H3']. */
  hubLabels: readonly string[];
  marketMakerLabels: readonly string[];
  /** Per-payment amount is drawn uniformly (deterministically) from this range. */
  paymentAmountRange?: HltAmountRange;
}>;

/**
 * Everything the workers need, derived once so no worker re-computes it and
 * silently disagrees about how many rounds a run has.
 */
export type HltPlan = Readonly<{
  economy: HltEconomy;
  /** Maker/taker pairs. Each lane is two user Runtimes. */
  swapLanes: number;
  /** Users assigned to the payment workload (sender/receiver pairs). */
  paymentLanes: number;
  rounds: number;
  cadenceMs: number;
  /** Orders per second the population offers to the Hub. */
  offeredOrderRatePerSecond: number;
  /** Economic swaps per second: one maker order plus one taker order. */
  offeredSwapRatePerSecond: number;
  offeredPaymentRatePerSecond: number;
  totalUserRuntimes: number;
}>;

export const HLT_DEFAULT_BASE_TOKEN_ID = 2;
export const HLT_DEFAULT_QUOTE_TOKEN_ID = 1;

/**
 * A lane is a maker and a taker, so an odd population cannot be paired.
 * Rejecting it here beats silently dropping one process and reporting a rate
 * that does not match the configured population.
 */
const requirePairableUsers = (users: number, code: string): number => {
  if (users % 2 !== 0) throw new Error(`${code}:${users}`);
  return users / 2;
};

const requireMix = (mix: HltWorkloadMix): HltWorkloadMix => {
  const swap = requireBoundaryInteger(mix.swap, 'HLT_MIX_SWAP_INVALID', 0);
  const payment = requireBoundaryInteger(mix.payment, 'HLT_MIX_PAYMENT_INVALID', 0);
  if (swap + payment === 0) throw new Error('HLT_MIX_EMPTY');
  return { swap, payment };
};

/**
 * Split the population between workloads by mix weight, keeping both halves
 * even so each remains pairable into lanes.
 */
const splitUsersByMix = (
  users: number,
  mix: HltWorkloadMix,
): Readonly<{ swapUsers: number; paymentUsers: number }> => {
  const total = mix.swap + mix.payment;
  const rawSwapUsers = Math.round((users * mix.swap) / total);
  const swapUsers = rawSwapUsers - (rawSwapUsers % 2);
  const paymentUsers = users - swapUsers;
  if (paymentUsers % 2 !== 0) throw new Error(`HLT_MIX_SPLIT_NOT_PAIRABLE:${swapUsers}:${paymentUsers}`);
  if (mix.swap > 0 && swapUsers === 0) throw new Error('HLT_MIX_SWAP_POPULATION_EMPTY');
  if (mix.payment > 0 && paymentUsers === 0) throw new Error('HLT_MIX_PAYMENT_POPULATION_EMPTY');
  return { swapUsers, paymentUsers };
};

export const buildHltPlan = (economy: HltEconomy): HltPlan => {
  const users = requireBoundaryInteger(economy.users, 'HLT_USERS_INVALID', 2);
  requirePairableUsers(users, 'HLT_USERS_NOT_PAIRABLE');
  const ratePerUserPerSecond = requireBoundaryInteger(
    economy.ratePerUserPerSecond,
    'HLT_RATE_PER_USER_INVALID',
    1,
  );
  const durationSeconds = requireBoundaryInteger(economy.durationSeconds, 'HLT_DURATION_INVALID', 1);
  const mix = requireMix(economy.mix);
  if (economy.hubLabels.length === 0) throw new Error('HLT_HUB_LABELS_EMPTY');
  if (economy.baseTokenId === economy.quoteTokenId) throw new Error('HLT_TOKENS_NOT_DISTINCT');
  const paymentAmountRange = economy.paymentAmountRange ?? HLT_DEFAULT_PAYMENT_AMOUNT_RANGE;
  if (paymentAmountRange.min <= 0n) {
    throw new Error(`HLT_PAYMENT_AMOUNT_MIN_INVALID:${paymentAmountRange.min}`);
  }
  if (paymentAmountRange.max < paymentAmountRange.min) {
    throw new Error(`HLT_PAYMENT_AMOUNT_RANGE_INVALID:${paymentAmountRange.min}:${paymentAmountRange.max}`);
  }
  // One round is one action per user. Sub-millisecond cadence would make the
  // scheduler, not the Hub, the thing under test.
  if (ratePerUserPerSecond > 1_000) throw new Error(`HLT_RATE_PER_USER_TOO_HIGH:${ratePerUserPerSecond}`);
  const { swapUsers, paymentUsers } = splitUsersByMix(users, mix);
  const swapLanes = swapUsers / 2;
  const paymentLanes = paymentUsers / 2;
  const rounds = durationSeconds * ratePerUserPerSecond;
  return {
    economy: {
      ...economy,
      users,
      ratePerUserPerSecond,
      durationSeconds,
      mix,
      hubLabels: [...economy.hubLabels],
      marketMakerLabels: [...economy.marketMakerLabels],
      paymentAmountRange,
    },
    swapLanes,
    paymentLanes,
    rounds,
    cadenceMs: Math.max(1, Math.round(1_000 / ratePerUserPerSecond)),
    offeredOrderRatePerSecond: users * ratePerUserPerSecond,
    offeredSwapRatePerSecond: swapLanes * ratePerUserPerSecond,
    offeredPaymentRatePerSecond: paymentLanes * ratePerUserPerSecond,
    totalUserRuntimes: users,
  };
};

/** `swap:payment` weight pair, e.g. `1:0` for a pure swap population. */
export const parseHltMix = (raw: string): HltWorkloadMix => {
  const parts = raw.split(':');
  if (parts.length !== 2) throw new Error(`HLT_MIX_FORMAT_INVALID:${raw}`);
  return requireMix({
    swap: requireBoundaryInteger(Number(parts[0]), 'HLT_MIX_SWAP_INVALID', 0),
    payment: requireBoundaryInteger(Number(parts[1]), 'HLT_MIX_PAYMENT_INVALID', 0),
  });
};

/** Comma-separated mesh labels, e.g. `H1,H2,H3`. */
export const parseHltLabels = (raw: string, code: string): string[] => {
  const labels = raw.split(',').map(label => label.trim()).filter(Boolean);
  if (labels.length === 0) throw new Error(`${code}:${raw}`);
  if (new Set(labels).size !== labels.length) throw new Error(`${code}_DUPLICATE:${raw}`);
  return labels;
};

export const describeHltPlan = (plan: HltPlan): string =>
  `[hlt] users=${plan.totalUserRuntimes} swapLanes=${plan.swapLanes} paymentLanes=${plan.paymentLanes} ` +
  `rate=${plan.economy.ratePerUserPerSecond}/user/s cadence=${plan.cadenceMs}ms rounds=${plan.rounds} ` +
  `duration=${plan.economy.durationSeconds}s offeredOrders=${plan.offeredOrderRatePerSecond}/s ` +
  `offeredSwaps=${plan.offeredSwapRatePerSecond}/s offeredPayments=${plan.offeredPaymentRatePerSecond}/s ` +
  `hubs=${plan.economy.hubLabels.join('+')} mm=${plan.economy.marketMakerLabels.join('+') || 'none'} ` +
  `tokens=${plan.economy.baseTokenId}/${plan.economy.quoteTokenId}`;
