/**
 * The capacity bar — one layout, both scenes.
 *
 * This is the construction `deriveDelta` documents and `formatDeltaAscii` prints:
 *
 *     [----own credit----|====collateral====|----peer credit----]
 *                              ^ delta
 *
 * Everything left of the delta marker is what LEFT can send; everything right of it is
 * what LEFT can receive. A payment is not an object travelling anywhere — it is this
 * marker moving toward whoever paid, and the allocation on either side of it changing to
 * match. Which is why the layout lives here as data: the same numbers place an SVG rect
 * and a cylinder, and the same numbers can be interpolated to animate the move.
 *
 * Pure functions only; drawing belongs to the scenes.
 */

export type DerivedForStage = {
  delta: bigint;
  collateral: bigint;
  ownCreditLimit: bigint;
  peerCreditLimit: bigint;
  inOwnCredit: bigint;
  outPeerCredit: bigint;
  totalCapacity: bigint;
};

export type StageRegionKind = 'ownCreditFree' | 'ownCreditDrawn' | 'collateralPeer' | 'collateralOwn' | 'peerCreditDrawn' | 'peerCreditFree';

export type StageRegion = {
  kind: StageRegionKind;
  /** Fraction of the whole bar, 0..1. */
  start: number;
  size: number;
  amount: bigint;
};

export type StageBar = {
  regions: StageRegion[];
  /** Delta position as a fraction of the bar, 0..1. */
  markerAt: number;
  total: bigint;
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const ratio = (part: bigint, whole: bigint): number => (whole <= 0n ? 0 : Number(part) / Number(whole));

/**
 * Split an account into drawable regions.
 *
 * The credit windows widen to whatever has actually been drawn, exactly as deriveDelta
 * does: a limit lowered after the fact must never make signed debt vanish from the
 * picture.
 */
export const stageBarFor = (derived: DerivedForStage): StageBar => {
  const drawnOwn = derived.inOwnCredit > 0n ? derived.inOwnCredit : 0n;
  const drawnPeer = derived.outPeerCredit > 0n ? derived.outPeerCredit : 0n;
  const ownWindow = derived.ownCreditLimit > drawnOwn ? derived.ownCreditLimit : drawnOwn;
  const peerWindow = derived.peerCreditLimit > drawnPeer ? derived.peerCreditLimit : drawnPeer;
  const collateral = derived.collateral > 0n ? derived.collateral : 0n;
  const total = ownWindow + collateral + peerWindow;
  if (total <= 0n) return { regions: [], markerAt: 0.5, total: 0n };

  // Collateral is split by the delta: what LEFT holds and what RIGHT holds.
  const ownCollateral = derived.delta <= 0n
    ? 0n
    : derived.delta >= collateral ? collateral : derived.delta;
  const peerCollateral = collateral - ownCollateral;

  // Axis order, left to right: everything left of the marker is LEFT's to send, everything
  // right of it is what LEFT can still receive. So LEFT's own collateral share sits before
  // the marker and the peer's share after it — not the other way round.
  const sequence: Array<{ kind: StageRegionKind; amount: bigint }> = [
    { kind: 'ownCreditFree', amount: ownWindow - drawnOwn },
    { kind: 'ownCreditDrawn', amount: drawnOwn },
    { kind: 'collateralOwn', amount: ownCollateral },
    { kind: 'collateralPeer', amount: peerCollateral },
    { kind: 'peerCreditDrawn', amount: drawnPeer },
    { kind: 'peerCreditFree', amount: peerWindow - drawnPeer },
  ];

  const regions: StageRegion[] = [];
  let cursor = 0;
  for (const entry of sequence) {
    const amount = entry.amount > 0n ? entry.amount : 0n;
    const size = ratio(amount, total);
    if (size > 0) regions.push({ kind: entry.kind, start: cursor, size, amount });
    cursor += size;
  }

  // Where LEFT's claim ends. Same construction formatDeltaAscii prints: at the far left
  // LEFT has drawn its whole credit line, at the far right it holds collateral plus all of
  // the peer's line.
  const markerAt = clamp01(ratio(ownWindow + derived.delta, total));
  return { regions, markerAt, total };
};

/**
 * The regions in axis order, always all six.
 *
 * Interpolating between two layouts means interpolating the same slots, and a region that
 * is absent is a region of size zero — not a region that does not exist. Building a bar
 * from a fixed vector is what lets a payment animate as "this boundary slid and these
 * shares changed" instead of "the picture was rebuilt".
 */
export const CAPACITY_REGION_ORDER = [
  'ownCreditFree',
  'ownCreditDrawn',
  'collateralOwn',
  'collateralPeer',
  'peerCreditDrawn',
  'peerCreditFree',
] as const satisfies ReadonlyArray<StageRegionKind>;

export type CapacityVector = {
  /** Fraction of the bar per region, in CAPACITY_REGION_ORDER, summing to ~1. */
  sizes: number[];
  markerAt: number;
};

export const capacityVector = (bar: StageBar): CapacityVector => ({
  sizes: CAPACITY_REGION_ORDER.map(
    (kind) => bar.regions.find((region) => region.kind === kind)?.size ?? 0,
  ),
  markerAt: bar.markerAt,
});

export const EMPTY_CAPACITY_VECTOR: CapacityVector = {
  sizes: CAPACITY_REGION_ORDER.map(() => 0),
  markerAt: 0.5,
};

/** Ease-out: value moves fast when it starts and settles, the way a decision lands. */
export const easeCapacity = (t: number): number => {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - (1 - clamped) ** 3;
};

export const lerpCapacity = (from: CapacityVector, to: CapacityVector, t: number): CapacityVector => {
  const eased = easeCapacity(t);
  return {
    sizes: to.sizes.map((size, index) => {
      const start = from.sizes[index] ?? 0;
      return start + (size - start) * eased;
    }),
    markerAt: from.markerAt + (to.markerAt - from.markerAt) * eased,
  };
};

/**
 * How hard a credit line is being leaned on, 0..1, per side.
 *
 * Drawn against drawn-plus-free: an account with a huge unused limit is not under strain,
 * and one that has taken nearly all of a small line is.
 */
export const creditStrain = (vector: CapacityVector): { own: number; peer: number } => {
  const at = (kind: StageRegionKind): number =>
    vector.sizes[CAPACITY_REGION_ORDER.indexOf(kind)] ?? 0;
  const ratioOf = (drawn: number, free: number): number => (drawn + free <= 0 ? 0 : drawn / (drawn + free));
  return {
    own: ratioOf(at('ownCreditDrawn'), at('ownCreditFree')),
    peer: ratioOf(at('peerCreditDrawn'), at('peerCreditFree')),
  };
};

export type StagePoint = { x: number; y: number };

/**
 * Ring layout for the context map.
 *
 * Deterministic from position in the sorted id list, so the same network always draws the
 * same shape and a node never jumps between steps.
 */
export const ringLayout = (count: number, radius: number): StagePoint[] => {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 0, y: 0 }];
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
};

/** Compact money for a node badge: 2.5M, 850K, 1.2B. */
export const compactAmount = (value: number): string => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return value.toFixed(abs > 0 && abs < 1 ? 2 : 0);
};
