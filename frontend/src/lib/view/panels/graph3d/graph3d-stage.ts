/**
 * Presentation sizing. The establishing shot frames the whole network, so an object's size on
 * screen is its world size divided by the network's span. Sizes that must read from the back
 * of the room — labels, packets, bars, the J-machine — therefore scale with the span, and a
 * two-bank dispute reads exactly as large as a five-bank order book.
 */

import * as THREE from 'three';

/** World span the presentation sizes are tuned for: the Alice–Hub–Bob line. */
const REFERENCE_SPAN = 80;

/** One stage unit: 1 for the reference span, proportionally larger or smaller otherwise. */
export function stageUnit(positions: readonly THREE.Vector3[]): number {
  if (positions.length < 2) return 1;
  const span = new THREE.Box3().setFromPoints([...positions]).getSize(new THREE.Vector3()).length();
  return Math.min(3, Math.max(0.5, span / REFERENCE_SPAN));
}

/** Presentation entity label scale (the dock default is 2). */
export const stageLabelScale = (unit: number): number => 3 * unit;

/** Presentation bar thickness multiplier over the renderer's 0.2 base radius. */
export const stageBarRadiusScale = (unit: number): number => 6.5 * unit;

/** Presentation packet radius multiplier over the motion style radius. */
export const stagePacketScale = (unit: number): number => 1.9 * unit;

/**
 * One dollar scale for every part of the story: this much value fills the reference bar
 * length, so 500,000 USDC of collateral looks the same in Part 1 and in Part 5. WETH is
 * valued at the demo's 3,000 USDC per WETH, the price its order book trades at.
 */
const FULL_BAR_WHOLE_UNITS: Readonly<Record<string, number>> = {
  USDC: 1_000_000,
  USDT: 1_000_000,
  DAI: 1_000_000,
  WETH: 1_000_000 / 3_000,
};

/** World length the full-bar value occupies at stage unit 1 (the Alice–Hub–Bob line). */
const FULL_BAR_LENGTH = 26;

export type StageToken = { tokenId: number; symbol: string; decimals: number };

/** Visual units per minor unit for each token, the same in every presentation. */
export function presentationCapacityScale(tokens: readonly StageToken[], unit: number): Map<number, number> {
  return new Map(tokens.map((token) => {
    const wholeUnits = FULL_BAR_WHOLE_UNITS[token.symbol.toUpperCase()];
    if (wholeUnits === undefined) throw new Error(`GRAPH_PRESENTATION_BAR_SCALE_MISSING:${token.symbol}`);
    return [token.tokenId, (FULL_BAR_LENGTH * unit) / (wholeUnits * 10 ** token.decimals)];
  }));
}
