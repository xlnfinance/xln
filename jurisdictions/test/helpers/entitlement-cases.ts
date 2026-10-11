/**
 * Seeded single-token dispute states for the TS-vs-Depository entitlement
 * differential (test/dispute/DisputeEntitlementParity.test.ts).
 *
 * Δ (ondelta + offdelta) is LEFT's allocation. The runtime enforces RCPAN
 * before it signs: −leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit.
 * The jurisdiction never sees credit limits and settles the signed Δ as-is,
 * so `beyond-rcpan` states are still valid finalization inputs.
 *
 * Every state keeps collateral + both reserves ≤ uint256: total custody of
 * one token cannot exceed its supply, and the mirror and the contract both
 * reject a reserve overflow, which is outside this differential.
 */
import { INT512_MAX, INT512_MIN, UINT256_MAX } from '../../../core/protocol/boundary/integer-ranges.ts';
import {
  deriveDisputeTokenFinalization,
  type DisputeTokenFinalization,
} from '../../../core/protocol/dispute/finalization.ts';

const MASK64 = (1n << 64n) - 1n;
/** Depository.DEBT_ENFORCEMENT_CHUNK: FIFO slots swept before a shortfall. */
const DEBT_ENFORCEMENT_CHUNK = 32;

export type Rng = Readonly<{ below(bound: bigint): bigint; chance(numerator: number, denominator: number): boolean }>;

const bitLength = (value: bigint): bigint => BigInt(value.toString(2).length);
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** splitmix64 stream; `below` is unbiased rejection sampling over any width. */
export const createRng = (seed: bigint): Rng => {
  let state = seed & MASK64;
  const next64 = (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
  };
  const below = (bound: bigint): bigint => {
    if (bound <= 0n) throw new Error(`ENTITLEMENT_RNG_BOUND:${bound}`);
    const bits = bitLength(bound);
    for (;;) {
      let value = 0n;
      for (let have = 0n; have < bits; have += 64n) value = (value << 64n) | next64();
      value &= (1n << bits) - 1n;
      if (value < bound) return value;
    }
  };
  const chance = (numerator: number, denominator: number): boolean =>
    below(BigInt(denominator)) < BigInt(numerator);
  return { below, chance };
};

/** Inclusive [0, max] with mass on 0, 1, max−1, max, small values and every bit width. */
const amountUpTo = (rng: Rng, max: bigint): bigint => {
  if (max <= 0n) return 0n;
  const kind = Number(rng.below(8n));
  if (kind === 0) return 0n;
  if (kind === 1) return 1n;
  if (kind === 2) return max;
  if (kind === 3) return max - 1n;
  if (kind === 4) return rng.below(minBig(max, 1000n) + 1n);
  const width = rng.below(bitLength(max)) + 1n;
  return rng.below(minBig(max, (1n << width) - 1n) + 1n);
};

export const DELTA_REGIMES = ['left-debt', 'zero', 'inside', 'at-collateral', 'right-debt', 'beyond-rcpan'] as const;
export type DeltaRegime = (typeof DELTA_REGIMES)[number];
export type Side = 'left' | 'right';
export type PriorDebt = Readonly<{ side: Side; creditor: 'peer' | 'third'; amounts: readonly bigint[] }>;

export type EntitlementCase = Readonly<{
  regime: DeltaRegime;
  collateral: bigint;
  /** LEFT's funded share: left-receiver R2C adds it to on-chain ondelta. */
  ondelta: bigint;
  offdelta: bigint;
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
  leftReserve: bigint;
  rightReserve: bigint;
  priorDebt: PriorDebt | null;
}>;

type Frame = Readonly<{ collateral: bigint; leftCreditLimit: bigint; rightCreditLimit: bigint }>;

const positiveLimit = (rng: Rng): bigint => 1n + amountUpTo(rng, UINT256_MAX - 1n);

const frameFor = (rng: Rng, regime: DeltaRegime): Frame => ({
  collateral: regime === 'inside' ? 2n + amountUpTo(rng, UINT256_MAX - 2n) : amountUpTo(rng, UINT256_MAX),
  leftCreditLimit: regime === 'left-debt' ? positiveLimit(rng) : amountUpTo(rng, UINT256_MAX),
  rightCreditLimit: regime === 'right-debt' ? positiveLimit(rng) : amountUpTo(rng, UINT256_MAX),
});

/** Δ outside RCPAN, kept inside the int512 offdelta domain for this ondelta. */
const beyondRcpan = (rng: Rng, frame: Frame, ondelta: bigint): bigint => {
  if (rng.chance(1, 2)) {
    return -frame.leftCreditLimit - 1n - amountUpTo(rng, -INT512_MIN - frame.leftCreditLimit - 1n - ondelta);
  }
  const ceiling = frame.collateral + frame.rightCreditLimit;
  return ceiling + 1n + amountUpTo(rng, INT512_MAX + ondelta - ceiling - 1n);
};

const deltaFor = (rng: Rng, regime: DeltaRegime, frame: Frame, ondelta: bigint): bigint => {
  if (regime === 'left-debt') return -1n - amountUpTo(rng, frame.leftCreditLimit - 1n);
  if (regime === 'zero') return 0n;
  if (regime === 'inside') return 1n + rng.below(frame.collateral - 1n);
  if (regime === 'at-collateral') return frame.collateral;
  if (regime === 'right-debt') return frame.collateral + 1n + amountUpTo(rng, frame.rightCreditLimit - 1n);
  return beyondRcpan(rng, frame, ondelta);
};

const shortfallOf = (delta: bigint, collateral: bigint): { side: Side | null; amount: bigint } => {
  if (delta < 0n) return { side: 'left', amount: -delta };
  if (delta > collateral) return { side: 'right', amount: delta - collateral };
  return { side: null, amount: 0n };
};

const sum = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n);

/**
 * Debtor reserve around the anchors where the payout changes shape: nothing,
 * exactly the shortfall, exactly the swept FIFO prefix (one chunk), the whole
 * queue (swept prefix paid, the unswept tail still locks the rest), half of
 * that tail, and the whole queue plus the shortfall.
 */
const debtorReserveFor = (rng: Rng, room: bigint, shortfall: bigint, queue: readonly bigint[]): bigint => {
  const swept = sum(queue.slice(0, DEBT_ENFORCEMENT_CHUNK));
  const total = sum(queue);
  const anchors = [0n, shortfall, swept, swept + (total - swept) / 2n, total, total + shortfall];
  const anchor = anchors[Number(rng.below(BigInt(anchors.length)))]!;
  const jitterKind = Number(rng.below(3n));
  const jitter = jitterKind === 0 ? 0n : amountUpTo(rng, jitterKind === 1 ? 1000n : UINT256_MAX);
  const signed = rng.chance(1, 2) ? anchor - jitter : anchor + jitter;
  return signed < 0n ? 0n : signed > room ? room : signed;
};

/** shallow: 1-3 uint256 slots; wide: 1-3 slots up to 2^300; deep: 33-36 slots, past the FIFO chunk. */
export type PriorKind = 'none' | 'shallow' | 'wide' | 'deep';

const priorDebtFor = (rng: Rng, debtorSide: Side | null, kind: Exclude<PriorKind, 'none'>): PriorDebt => {
  const side: Side = debtorSide !== null && rng.chance(3, 4) ? debtorSide : rng.chance(1, 2) ? 'left' : 'right';
  const count = kind === 'deep' ? DEBT_ENFORCEMENT_CHUNK + 1 + Number(rng.below(4n)) : 1 + Number(rng.below(3n));
  const cap = kind === 'wide' ? 1n << 300n : kind === 'deep' ? UINT256_MAX >> 6n : UINT256_MAX;
  const amounts = Array.from({ length: count }, () => 1n + amountUpTo(rng, cap - 1n));
  return { side, creditor: rng.chance(1, 2) ? 'peer' : 'third', amounts };
};

export const generateCase = (rng: Rng, regime: DeltaRegime, prior: PriorKind): EntitlementCase => {
  const frame = frameFor(rng, regime);
  const ondelta = amountUpTo(rng, frame.collateral);
  const delta = deltaFor(rng, regime, frame, ondelta);
  const shortfall = shortfallOf(delta, frame.collateral);
  const priorDebt = prior === 'none' ? null : priorDebtFor(rng, shortfall.side, prior);
  const room = UINT256_MAX - frame.collateral;
  const queue = priorDebt !== null && priorDebt.side === shortfall.side ? priorDebt.amounts : [];
  const debtorReserve = shortfall.side === null ? amountUpTo(rng, room) : debtorReserveFor(rng, room, shortfall.amount, queue);
  const otherReserve = amountUpTo(rng, room - debtorReserve);
  const leftIsDebtor = shortfall.side === 'left' || (shortfall.side === null && rng.chance(1, 2));
  return {
    regime,
    ...frame,
    ondelta,
    offdelta: delta - ondelta,
    leftReserve: leftIsDebtor ? debtorReserve : otherReserve,
    rightReserve: leftIsDebtor ? otherReserve : debtorReserve,
    priorDebt,
  };
};

const fixedState = (
  regime: DeltaRegime,
  collateral: bigint,
  ondelta: bigint,
  delta: bigint,
  limits: readonly [left: bigint, right: bigint],
  reserves: readonly [left: bigint, right: bigint],
): EntitlementCase => ({
  regime, collateral, ondelta, offdelta: delta - ondelta,
  leftCreditLimit: limits[0], rightCreditLimit: limits[1],
  leftReserve: reserves[0], rightReserve: reserves[1], priorDebt: null,
});

/** RCPAN and width endpoints that hold for every seed and campaign size. */
export const boundaryStates = (): EntitlementCase[] => [
  fixedState('left-debt', 0n, 0n, -UINT256_MAX, [UINT256_MAX, 0n], [0n, 0n]),
  fixedState('left-debt', 0n, 0n, -UINT256_MAX, [UINT256_MAX, 0n], [UINT256_MAX, 0n]),
  fixedState('right-debt', UINT256_MAX, UINT256_MAX, 2n * UINT256_MAX, [0n, UINT256_MAX], [0n, 0n]),
  fixedState('at-collateral', UINT256_MAX, 0n, UINT256_MAX, [0n, 0n], [0n, 0n]),
  fixedState('inside', UINT256_MAX, 1n, UINT256_MAX - 1n, [0n, 0n], [0n, 0n]),
  fixedState('zero', UINT256_MAX, UINT256_MAX, 0n, [0n, 0n], [0n, 0n]),
  fixedState('beyond-rcpan', 0n, 0n, INT512_MIN, [0n, 0n], [UINT256_MAX, 0n]),
  fixedState('beyond-rcpan', UINT256_MAX, UINT256_MAX, INT512_MAX + UINT256_MAX, [0n, 0n], [0n, 0n]),
];

type FifoSweep = Readonly<{ paid: bigint; outstanding: bigint; reserve: bigint; queueCleared: boolean }>;

/**
 * Account.enforceDebts for one fresh queue (no zero slots): at most
 * DEBT_ENFORCEMENT_CHUNK entries, each paid min(entry, available). The TS
 * mirror documents FIFO routing as the caller's job; this is that caller.
 */
const sweepFifo = (reserve: bigint, amounts: readonly bigint[]): FifoSweep => {
  let available = reserve;
  let cleared = 0;
  for (const amount of amounts.slice(0, DEBT_ENFORCEMENT_CHUNK)) {
    if (available === 0n) break;
    const pay = minBig(amount, available);
    available -= pay;
    if (pay < amount) break;
    cleared++;
  }
  const paid = reserve - available;
  return { paid, outstanding: sum(amounts) - paid, reserve: available, queueCleared: cleared === amounts.length };
};

export type EntitlementExpectation = Readonly<{
  mirror: DisputeTokenFinalization;
  debtorSide: Side | null;
  sweep: FifoSweep | null;
  /** Index DebtCreated must report for the new row (prior slots never shrink until cleared). */
  newDebtIndex: number;
}>;

/** Compose the caller's FIFO sweep with the canonical TS mirror, exactly as Depository orders them. */
export const expectEntitlement = (state: EntitlementCase, tokenId: number): EntitlementExpectation => {
  const base = { tokenId, collateral: state.collateral, ondelta: state.ondelta, offdelta: state.offdelta };
  const probe = deriveDisputeTokenFinalization({ ...base, leftReserve: state.leftReserve, rightReserve: state.rightReserve });
  const debtorSide: Side | null = probe.shortfall.leftToRight > 0n ? 'left' : probe.shortfall.rightToLeft > 0n ? 'right' : null;
  const reserves = { left: state.leftReserve, right: state.rightReserve };
  const debt = { left: 0n, right: 0n };
  const prior = state.priorDebt;
  let sweep: FifoSweep | null = null;
  if (prior !== null && prior.side === debtorSide) {
    sweep = sweepFifo(reserves[prior.side], prior.amounts);
    reserves[prior.side] = sweep.reserve;
    debt[prior.side] = sweep.outstanding;
    const peer: Side = prior.side === 'left' ? 'right' : 'left';
    if (prior.creditor === 'peer') reserves[peer] += sweep.paid;
  } else if (prior !== null) {
    debt[prior.side] = sum(prior.amounts);
  }
  const mirror = deriveDisputeTokenFinalization({
    ...base,
    leftReserve: reserves.left,
    rightReserve: reserves.right,
    existingDebtOutstanding: debt,
  });
  const priorSlots = prior !== null && prior.side === debtorSide && !(sweep?.queueCleared ?? false) ? prior.amounts.length : 0;
  return { mirror, debtorSide, sweep, newDebtIndex: priorSlots };
};
