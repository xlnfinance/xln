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
  /** One sentence on what this step proves about the protocol. Empty when unknown. */
  mechanic: string;
  /** Events in this step beyond the headline one. */
  extraCount: number;
  source: 'cue' | 'activity' | 'frame';
  accent?: string;
};

/**
 * What each step teaches. The runtime's own titles are operational ("Payment sent"); a demo
 * has to say why that is interesting, so the explanation lives here, next to the renderer.
 */
const MECHANIC_BY_TYPE: Record<string, string> = {
  payment: 'Bilateral transfer — settled between two parties, nothing on-chain.',
  htlc: 'Hash-locked across the route: an intermediary cannot take the money mid-hop.',
  swap: 'Order matched inside the bilateral account — no shared orderbook to trust.',
  cross_swap: 'Atomic across jurisdictions: both legs commit, or neither does.',
  settlement: 'Both sides sign the netted result; only the difference reaches the chain.',
  account: 'Account capacity changes — credit is granted, not deposited.',
  j_event: 'Observed on-chain: the jurisdiction confirmed what the account already knew.',
  j_batch: 'Batched to the jurisdiction — many account changes, one on-chain transaction.',
  system: 'Runtime bookkeeping — no value moved.',
  error: 'Failure surfaced instead of being hidden.',
};

/** Sharper wording where the raw type is too coarse to explain the mechanic. */
const mechanicFor = (event: RuntimeActivityEvent): string => {
  // Raw types arrive in mixed conventions (`set_credit_limit`, `reserveToCollateral`),
  // so compare on letters alone.
  const rawType = text(event.rawType).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (rawType.includes('creditlimit')) {
    return 'Unsecured credit extended — capacity without locking collateral.';
  }
  if (rawType.includes('reserve') && rawType.includes('collateral')) {
    return 'Reserves become collateral: this is the step that costs a J-transaction.';
  }
  if (rawType.includes('dispute')) {
    return 'Unilateral exit — the last signed frame is enough to reclaim funds.';
  }
  if (rawType.includes('openaccount')) {
    return 'A new bilateral account: one counterparty, no network-wide registration.';
  }
  return MECHANIC_BY_TYPE[text(event.type)] ?? '';
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

/** Resolves ids and minor units into words the viewer can read. */
export type NetworkCaptionContext = {
  labelFor?: (entityId: string) => string;
  formatAmount?: (tokenId: number, amountMinor: string) => string;
};

const describeParticipants = (
  event: RuntimeActivityEvent,
  context: NetworkCaptionContext,
): string => {
  const label = (value: unknown): string => {
    const id = text(value);
    if (!id) return '';
    return text(context.labelFor?.(id)) || `${id.slice(0, 6)}…${id.slice(-4)}`;
  };
  const from = label(event.direction === 'in' ? event.counterpartyId : event.entityId);
  const to = label(event.direction === 'in' ? event.entityId : event.counterpartyId);
  if (!from || !to) return from || to;
  return `${from} → ${to}`;
};

const describeAmount = (event: RuntimeActivityEvent, context: NetworkCaptionContext): string => {
  const amount = text(event.amount);
  const tokenId = Number(event.tokenId ?? 0);
  if (!amount || !tokenId) return '';
  return text(context.formatAmount?.(tokenId, amount)) || `${amount} (token ${tokenId})`;
};

/** Human subtitle: who, how much — falling back to the runtime's own wording. */
export const describeEvent = (
  event: RuntimeActivityEvent,
  context: NetworkCaptionContext = {},
): string => {
  const parts = [describeAmount(event, context), describeParticipants(event, context)].filter(Boolean);
  return parts.length > 0 ? parts.join('  ·  ') : text(event.subtitle);
};

export const captionForStep = (
  step: NetworkCaptionStep,
  events: readonly RuntimeActivityEvent[],
  context: NetworkCaptionContext = {},
): NetworkCaption => {
  const cue = step.cues.find((candidate) => text(candidate.title));
  if (cue) {
    return {
      title: text(cue.title),
      subtitle: text(cue.subtitle),
      mechanic: '',
      extraCount: 0,
      source: 'cue',
      ...(text(cue.accent) ? { accent: text(cue.accent) } : {}),
    };
  }

  const stepEvents = activityForStep(events, step);
  // Prefer what happened over what the consensus recorded: a frame that both moved money
  // and emitted bookkeeping should read as the payment.
  const headline = stepEvents.find((event) => text(event.title) && event.type !== 'system')
    ?? stepEvents.find((event) => text(event.title));
  if (!headline) {
    return {
      title: `Frame ${Math.floor(Number(step.height || 0))}`,
      subtitle: '',
      mechanic: '',
      extraCount: 0,
      source: 'frame',
    };
  }

  return {
    title: text(headline.title),
    subtitle: describeEvent(headline, context),
    mechanic: mechanicFor(headline),
    extraCount: Math.max(0, stepEvents.length - 1),
    source: 'activity',
  };
};
