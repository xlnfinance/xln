/**
 * Acts of a network story.
 *
 * A flat scrubber over 34 steps hides the shape of what happened: you cannot jump to "the
 * dispute" without dragging blindly. Acts are runs of consecutive steps that are about the
 * same thing, derived from the activity the runtime already recorded — never a hardcoded
 * list, so a scenario nobody has written yet still gets a chapter track.
 */

import type { RuntimeActivityEvent } from '@xln/runtime/xln-api';
import { activityForStep, type NetworkCaptionStep } from './networkCaption';

export type NetworkActKind =
  | 'funding'
  | 'accounts'
  | 'payments'
  | 'routing'
  | 'swaps'
  | 'settlement'
  | 'dispute'
  | 'setup';

export type NetworkAct = {
  kind: NetworkActKind;
  title: string;
  /** Inclusive step index range. */
  fromIndex: number;
  toIndex: number;
  stepCount: number;
};

const TITLES: Record<NetworkActKind, string> = {
  funding: 'Funding',
  accounts: 'Accounts',
  payments: 'Payments',
  routing: 'Routing',
  swaps: 'Swaps',
  settlement: 'Settlement',
  dispute: 'Dispute',
  setup: 'Setup',
};

export const actTitle = (kind: NetworkActKind): string => TITLES[kind] ?? TITLES.setup;

const text = (value: unknown): string => String(value ?? '').trim();

/**
 * Reserve movements read as "payment" by type alone, but a demo's opening act is funding,
 * not payments — the raw type is what separates them.
 */
const kindOf = (event: RuntimeActivityEvent): NetworkActKind | null => {
  const rawType = text(event.rawType).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (rawType === 'r2r' || rawType === 'r2c' || rawType === 'e2r' || rawType === 'r2e') return 'funding';
  if (rawType.includes('reserve')) return 'funding';
  switch (text(event.type)) {
    case 'dispute': return 'dispute';
    case 'settlement': return 'settlement';
    case 'swap':
    case 'cross_swap': return 'swaps';
    case 'htlc': return 'routing';
    case 'payment': return 'payments';
    case 'account': return 'accounts';
    default: return null;
  }
};

/**
 * The act a step belongs to, or null when the step carries nothing that names an act —
 * batch broadcasts and consensus bookkeeping continue whatever act is already running
 * instead of chopping it into fragments.
 */
export const actKindForStep = (
  events: readonly RuntimeActivityEvent[],
  step: NetworkCaptionStep,
): NetworkActKind | null => {
  for (const event of activityForStep(events, step)) {
    const kind = kindOf(event);
    if (kind) return kind;
  }
  return null;
};

export type NetworkActStep = { index: number; runtimeId: string; height: number };

/** An act shorter than this is a blip, not a chapter. */
const MIN_ACT_STEPS = 2;

/**
 * Absorb interruptions.
 *
 * One account tweak in the middle of a funding run does not start a chapter and end it
 * again — it is a beat inside the run. Only a short act flanked by the same kind on both
 * sides is absorbed, so a genuine transition (even a brief one, like a single dispute
 * step) keeps its own chapter.
 */
const absorbInterruptions = (acts: NetworkAct[]): NetworkAct[] => {
  const kept: NetworkAct[] = [];
  for (let index = 0; index < acts.length; index += 1) {
    const act = acts[index];
    if (!act) continue;
    const previous = kept[kept.length - 1];
    const next = acts[index + 1];
    const isInterruption =
      previous !== undefined &&
      next !== undefined &&
      act.stepCount < MIN_ACT_STEPS &&
      previous.kind === next.kind;
    if (previous && (previous.kind === act.kind || isInterruption)) {
      previous.toIndex = act.toIndex;
      previous.stepCount += act.stepCount;
      continue;
    }
    kept.push({ ...act });
  }
  return kept;
};

/** Consecutive steps of the same kind, merged into one act. */
export const deriveNetworkActs = (
  steps: readonly NetworkActStep[],
  events: readonly RuntimeActivityEvent[],
): NetworkAct[] => {
  const acts: NetworkAct[] = [];
  let running: NetworkActKind = 'setup';
  for (const step of steps) {
    const kind: NetworkActKind =
      actKindForStep(events, { runtimeId: step.runtimeId, height: step.height, cues: [] }) ?? running;
    running = kind;
    const last = acts[acts.length - 1];
    if (last && last.kind === kind) {
      last.toIndex = step.index;
      last.stepCount += 1;
      continue;
    }
    acts.push({ kind, title: actTitle(kind), fromIndex: step.index, toIndex: step.index, stepCount: 1 });
  }
  // Absorbing can make two same-kind acts adjacent, which the next pass then merges.
  // Two passes is enough to reach a fixed point on any real story; the loop guards the
  // pathological case rather than trusting that.
  let smoothed = acts;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = absorbInterruptions(smoothed);
    if (next.length === smoothed.length) return next;
    smoothed = next;
  }
  return smoothed;
};

/** Index of the act containing a step, or -1. */
export const actIndexOfStep = (acts: readonly NetworkAct[], stepIndex: number): number =>
  acts.findIndex((act) => stepIndex >= act.fromIndex && stepIndex <= act.toIndex);
