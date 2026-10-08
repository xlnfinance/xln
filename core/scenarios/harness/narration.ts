/**
 * Narration that speaks about a state the Runtime has already applied.
 *
 * `snap()` titles the NEXT runtime frame, the one that applies the change it announces. An
 * outcome ("Bob is paid from Hub's reserve") must instead sit on the frame where that state is
 * already visible, and some steps add a second beat to the same frame (a finality ladder, a
 * "what if Hub failed" aside). Those beats attach to the latest committed frame. They are
 * recorded here, per scenario run, so the Runtime never learns about presentation, and the
 * trail exporter turns each beat into a cue of its own.
 */

import type { RuntimeReplica } from '../../runtime/types';
import { snap } from './helpers';

/** One rung of a ladder such as bilateral → on-chain → legal finality. */
export type NarrationBadge = {
  label: string;
  detail: string;
  /** done: reached; bounded: holds only up to a limit; outside: decided outside the protocol. */
  tone: 'done' | 'bounded' | 'outside';
};

export type NarrationBeatText = {
  what?: string;
  why?: string;
  tradfiParallel?: string;
  keyMetrics?: string[];
  badges?: NarrationBadge[];
  /** Entities the beat is about; defaults to the parties the frame's inputs touched. */
  focusEntityIds?: string[];
  /** A presentation starts at this beat: every earlier step is setup it summarises. */
  condensePrior?: true;
  /** A presentation ends at this beat; later frames stay in the full timeline only. */
  endsPresentation?: true;
};

export type ScenarioNarrationBeat = NarrationBeatText & {
  /** Runtime height of the committed frame the beat describes. */
  height: number;
  title: string;
};

const beatsByEnv = new WeakMap<RuntimeReplica, ScenarioNarrationBeat[]>();

/** Narrate the latest committed frame: its state is what the beat describes. */
export const narrate = (env: RuntimeReplica, title: string, text: NarrationBeatText = {}): void => {
  const height = Math.floor(Number(env.state.height));
  if (!Number.isSafeInteger(height) || height < 1) throw new Error(`SCENARIO_NARRATION_BEFORE_FIRST_FRAME:${title}`);
  if (!title.trim()) throw new Error('SCENARIO_NARRATION_TITLE_REQUIRED');
  const beats = beatsByEnv.get(env) ?? [];
  beats.push({ height, title, ...text });
  beatsByEnv.set(env, beats);
};

/** Every beat narrated on this Runtime, in narration order. */
export const readScenarioNarration = (env: RuntimeReplica): ScenarioNarrationBeat[] =>
  [...(beatsByEnv.get(env) ?? [])];

/** A titled piece of narration, either announced (`announce`) or told after the fact (`tell`). */
export type NarrationEntry = NarrationBeatText & { title: string };

/** Announce the change the NEXT committed frame applies. Beat-only fields are not carried. */
export const announce = (env: RuntimeReplica, entry: NarrationEntry): void => {
  if (entry.badges || entry.condensePrior || entry.endsPresentation) {
    throw new Error(`SCENARIO_ANNOUNCE_BEAT_FIELDS:${entry.title}`);
  }
  snap(env, entry.title, {
    ...(entry.what ? { what: entry.what } : {}),
    ...(entry.why ? { why: entry.why } : {}),
    ...(entry.tradfiParallel ? { tradfiParallel: entry.tradfiParallel } : {}),
    ...(entry.keyMetrics ? { keyMetrics: entry.keyMetrics } : {}),
  });
};

/** Tell what the latest committed frame shows. */
export const tell = (env: RuntimeReplica, entry: NarrationEntry): void => {
  const { title, ...text } = entry;
  narrate(env, title, text);
};
