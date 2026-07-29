/**
 * Motion for a capacity bar.
 *
 * A payment is the delta separator moving toward whoever paid, and the allocation on
 * either side changing to match — so that is what animates. Nothing travels along the
 * edge, because nothing does in the protocol: the same collateral is simply owned in a
 * different proportion a moment later. Several accounts can be reallocating at once, so
 * every bar animates independently and simultaneously.
 *
 * The scene rebuilds its meshes whenever a step changes, so continuity cannot come from
 * keeping meshes alive. It comes from remembering the layout each account was last drawn
 * at: a new bar starts where the old one ended and moves to where it belongs.
 */

import {
  EMPTY_CAPACITY_VECTOR,
  creditStrain,
  lerpCapacity,
  type CapacityVector,
} from './capacityBar';

/** How long a reallocation takes to read as a move rather than a cut. */
export const CAPACITY_MOTION_MS = 520;

export type CapacityMotionFrame = {
  vector: CapacityVector;
  /** 0..1 per side: how hard that credit line is being leaned on right now. */
  strain: { own: number; peer: number };
  /** True while the bar is still moving toward its target. */
  moving: boolean;
};

type MotionEntry = {
  from: CapacityVector;
  to: CapacityVector;
  startedAt: number;
  apply: (frame: CapacityMotionFrame) => void;
};

const lastDrawn = new Map<string, CapacityVector>();
const active = new Map<string, MotionEntry>();

const sameVector = (left: CapacityVector, right: CapacityVector): boolean =>
  Math.abs(left.markerAt - right.markerAt) < 1e-6 &&
  left.sizes.every((size, index) => Math.abs(size - (right.sizes[index] ?? 0)) < 1e-6);

const frameFor = (vector: CapacityVector, moving: boolean): CapacityMotionFrame => ({
  vector,
  strain: creditStrain(vector),
  moving,
});

/**
 * Register a bar for animation and return the frame it should be drawn at right now.
 *
 * The first time an account is seen it appears at its true layout — an account that has
 * just been opened has nothing to move from, and sliding it in from zero would claim a
 * reallocation that never happened.
 */
export const beginCapacityMotion = (
  accountKey: string,
  target: CapacityVector,
  nowMs: number,
  apply: (frame: CapacityMotionFrame) => void,
): CapacityMotionFrame => {
  const previous = lastDrawn.get(accountKey);
  lastDrawn.set(accountKey, target);
  if (!previous || sameVector(previous, target)) {
    active.delete(accountKey);
    return frameFor(target, false);
  }
  active.set(accountKey, { from: previous, to: target, startedAt: nowMs, apply });
  return frameFor(previous, true);
};

/** Advance every moving bar. Called once per rendered frame. */
export const updateCapacityMotion = (nowMs: number): void => {
  for (const [key, entry] of active) {
    const t = (nowMs - entry.startedAt) / CAPACITY_MOTION_MS;
    if (t >= 1) {
      entry.apply(frameFor(entry.to, false));
      active.delete(key);
      continue;
    }
    entry.apply(frameFor(lerpCapacity(entry.from, entry.to, t), true));
  }
};

/**
 * Forget every remembered layout.
 *
 * Jumping to a different point in the story is not a reallocation, and animating from
 * wherever playback happened to be would draw a move that never took place.
 */
export const resetCapacityMotion = (): void => {
  lastDrawn.clear();
  active.clear();
};

/** Layout an account was last drawn at, for tests and for callers rebuilding a scene. */
export const lastDrawnCapacity = (accountKey: string): CapacityVector =>
  lastDrawn.get(accountKey) ?? EMPTY_CAPACITY_VECTOR;
