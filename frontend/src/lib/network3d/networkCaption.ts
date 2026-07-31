/**
 * Global caption for one NetworkMachine step.
 *
 * The runtime already produces titled events (`RuntimeActivityEvent.title/subtitle`), so a
 * caption is derived, not authored: live hub debugging gets readable subtitles for free.
 * An authored cue on the step wins when a demo wants a curated line.
 */

import type { RuntimeActivityEvent } from '@xln/runtime/xln-api';
import type { NetworkMachineCue } from './networkMachine';

export type NetworkCaption = {
  title: string;
  subtitle: string;
  /** Events in this step beyond the headline one. */
  extraCount: number;
  source: 'cue' | 'activity' | 'frame';
  accent?: string;
};

export type NetworkCaptionStep = {
  runtimeId: string;
  height: number;
  cues: NetworkMachineCue[];
};

const text = (value: unknown): string => String(value ?? '').trim();

/** Events of one runtime at one height, ordered the way the runtime recorded them. */
export const activityForStep = (
  events: readonly RuntimeActivityEvent[],
  step: NetworkCaptionStep,
): RuntimeActivityEvent[] => {
  const runtimeId = text(step.runtimeId).toLowerCase();
  const height = Math.floor(Number(step.height || 0));
  return events.filter((event) => {
    if (Math.floor(Number(event.height || 0)) !== height) return false;
    const eventRuntimeId = text(event.runtimeId).toLowerCase();
    return !eventRuntimeId || !runtimeId || eventRuntimeId === runtimeId;
  });
};

export const captionForStep = (
  step: NetworkCaptionStep,
  events: readonly RuntimeActivityEvent[],
): NetworkCaption => {
  const cue = step.cues.find((candidate) => text(candidate.title));
  if (cue) {
    return {
      title: text(cue.title),
      subtitle: text(cue.subtitle),
      extraCount: 0,
      source: 'cue',
      ...(text(cue.accent) ? { accent: text(cue.accent) } : {}),
    };
  }

  const stepEvents = activityForStep(events, step);
  const headline = stepEvents.find((event) => text(event.title));
  if (!headline) {
    return {
      title: `Frame ${Math.floor(Number(step.height || 0))}`,
      subtitle: '',
      extraCount: 0,
      source: 'frame',
    };
  }

  return {
    title: text(headline.title),
    subtitle: text(headline.subtitle),
    extraCount: Math.max(0, stepEvents.length - 1),
    source: 'activity',
  };
};
