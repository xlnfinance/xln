/**
 * Geometry for the 2D stage.
 *
 * The 3D graph draws a network and hangs a capacity bar on each edge, where the bar ends
 * up a few pixels long because its length is an absolute value scale and the edge length
 * is a layout accident. The 2D stage inverts that: one account's capacity *is* the frame,
 * so its regions are readable, and the rest of the network is context around it.
 *
 * The bar is the same construction `deriveDelta` documents and `formatDeltaAscii` prints:
 *
 *     [----own credit----|====collateral====|----peer credit----]
 *                              ^ delta
 *
 * Everything right of the delta marker is what LEFT can still send; everything left of it
 * is what LEFT can still receive. Pure functions here, drawing in the component.
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
