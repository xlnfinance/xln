/**
 * Global caption for one NetworkMachine step.
 *
 * The runtime already produces titled events (`RuntimeActivityEvent.title/subtitle`), so a
 * caption is derived, not authored: live hub debugging gets readable subtitles for free.
 * An authored cue on the step wins when a demo wants a curated line.
 */

import type { RuntimeActivityEvent } from '@xln/core/api/public/runtime-module';
import { activeNetworkMachineCue, type NetworkMachineCue, type NetworkMachineCueBadge } from '../networkMachine';
import type { NetworkMotionFlow, NetworkMotionKind, NetworkStepMotion } from './networkStepMotion';

export type NetworkCaption = {
  title: string;
  subtitle: string;
  /** One sentence on what this step proves about the protocol. Empty when unknown. */
  mechanic: string;
  /** Events in this step beyond the headline one. */
  extraCount: number;
  source: 'cue' | 'activity' | 'motion' | 'frame';
  accent?: string;
  what?: string;
  why?: string;
  tradfiParallel?: string;
  keyMetrics?: string[];
  /** A narrated ladder, e.g. bilateral → on-chain → legal finality. */
  badges?: NetworkMachineCueBadge[];
};

/**
 * What each step teaches. The runtime's own titles are operational ("Payment sent"); a demo
 * has to say why that is interesting, so the explanation lives here, next to the renderer.
 */
const MECHANIC_BY_TYPE: Record<string, string> = {
  payment: 'Bilateral transfer: both banks sign the new account state; nothing goes on-chain.',
  htlc: 'Hash-locked across the route: every hop completes with one secret, or every lock expires.',
  swap: 'Order matched inside the bilateral account: both currency legs change in one signed frame.',
  cross_swap: 'Both legs are tied to one condition: both commit, or neither does.',
  settlement: 'Both banks sign one settlement; only its net amounts move on the Depository.',
  account: 'Account capacity changes: a credit limit is set by the bank that carries the risk.',
  j_event: 'Recorded on-chain: the Depository confirmed what the account already agreed.',
  j_batch: 'Several instructions sent to the Depository in one on-chain transaction.',
  system: 'Runtime bookkeeping: no value moved.',
  error: 'Failure surfaced instead of being hidden.',
};

/**
 * The runtime titles some events with their raw tx type ("r2r", "extendCredit"). A caption is
 * read by people, so those get words; runtime-authored titles are kept as they are.
 */
const TITLE_BY_RAW_TYPE: Record<string, string> = {
  r2r: 'Reserve transfer queued',
  r2c: 'Reserve moved into collateral',
  j_broadcast: 'Instructions sent to the Depository',
  j_event_claim: 'On-chain result acknowledged by both banks',
  extendCredit: 'Credit limit set',
  mintReserves: 'Test balances credited',
  initOrderbookExt: 'Order book opened',
  setRebalancePolicy: 'Collateral policy recorded',
  settle_transition: 'Settlement advances',
  prepareDispute: 'Exit prepared: account frozen',
  disputeFinalize: 'Dispute finalized on-chain',
  scheduledWake: 'Deadline check by the bank\'s own runtime',
  add_delta: 'Currency added to the account',
};

const FINALITY_PARALLEL =
  "Irrevocable between the two banks once both sign, and enforceable on-chain up to the account's collateral; above that it is an unsecured claim. Legal finality depends on system designation.";

/** One line a central banker already knows, per mechanic. Shown when no cue authored one. */
const TRADFI_BY_TYPE: Record<string, string> = {
  payment: `A correspondent transfer. ${FINALITY_PARALLEL}`,
  htlc: 'A chain of conditional payments tied to one secret: either every hop completes, from payee back to payer, or every lock expires and is refunded. Intermediaries carry the timing risk.',
  swap: 'An FX trade inside one bilateral account: both currency legs change in one co-signed frame.',
  cross_swap: 'Both currency legs are tied to one condition: both commit, or neither does.',
  settlement: 'Bilateral settlement: two banks sign one instruction, and only its net amounts move on the Depository.',
  account: 'A credit limit set by the receiving bank: how much its counterparty may owe it, unsecured.',
  j_event: 'The Depository has recorded it in a final block.',
  j_batch: 'One on-chain transaction carrying several instructions; each is applied in full.',
  dispute: 'The Depository applies the latest co-signed state mechanically; legal finality depends on governing law.',
  r2r: "A gross transfer between two reserve balances. Settled in the Depository's settlement asset (here a USDC test token; in a central bank deployment, tokenised reserves).",
  r2c: "Reserve moved into collateral for one counterparty: collateral locked per counterparty plays the nostro's role, but in a neutral contract.",
  mintReserves: 'Test balances credited on the Depository.',
  extendCredit: 'A credit limit set by the receiving bank: how much its counterparty may owe it, unsecured.',
};

const MOTION_TITLE: Record<NetworkMotionKind, string> = {
  payment: 'Payment in flight',
  htlc_lock: 'Hash-locked payment forwarded',
  htlc_resolve: 'Secret revealed: the payment completes back along the route',
  swap: 'Swap order in flight',
  settlement: 'Settlement terms co-signed',
  j_claim: 'On-chain result acknowledged by both banks',
  credit: 'Credit limit proposed',
  account: 'Currency added to the account',
  frame: 'Account update proposed',
  ack: 'Counterparty signed the update',
};

const MOTION_TYPE: Record<NetworkMotionKind, string> = {
  payment: 'payment', htlc_lock: 'htlc', htlc_resolve: 'htlc', swap: 'swap', settlement: 'settlement',
  j_claim: 'j_event', credit: 'account', account: 'account', frame: 'account', ack: 'account',
};

/** Sharper wording where the raw type is too coarse to explain the mechanic. */
const mechanicFor = (event: RuntimeActivityEvent): string => {
  // Raw types arrive in mixed conventions (`set_credit_limit`, `reserveToCollateral`),
  // so compare on letters alone.
  const rawType = text(event.rawType).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (rawType.includes('creditlimit')) {
    return 'Credit limit — the maximum accepted unsecured exposure, not collateral.';
  }
  if (rawType.includes('reserve') && rawType.includes('collateral')) {
    return 'Reserves become collateral: this step needs an on-chain transaction.';
  }
  if (rawType.includes('dispute')) {
    return 'Unilateral dispute — signed evidence enforces the collateral-backed claim; unsecured debt is not guaranteed.';
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
  /** The step's motion: a step whose frame carries no activity is still described by it. */
  motion?: NetworkStepMotion | null;
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
  if (!from || !to || from === to) return from || to;
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
  const derived = derivedCaption(step, events, context);
  const cue = activeNetworkMachineCue(step.cues);
  if (!cue) return derived;
  // The authored cue speaks; the step's own event fills only what the author left unsaid.
  // A per-frame runtime line ("payment routed", a fee-inclusive amount) is never added under
  // a cue: it can contradict the authored title, and the stage already shows the motion.
  const why = text(cue.why) || derived.mechanic;
  const tradfiParallel = text(cue.tradfiParallel) || text(derived.tradfiParallel);
  return {
    title: text(cue.title),
    subtitle: text(cue.subtitle),
    mechanic: '',
    extraCount: 0,
    source: 'cue',
    ...(text(cue.accent) ? { accent: text(cue.accent) } : {}),
    ...(text(cue.what) ? { what: text(cue.what) } : {}),
    ...(why ? { why } : {}),
    ...(tradfiParallel ? { tradfiParallel } : {}),
    ...(cue.keyMetrics ? { keyMetrics: [...cue.keyMetrics] } : {}),
    ...(cue.badges ? { badges: cue.badges.map((badge) => ({ ...badge })) } : {}),
  };
};

/** The caption a step earns without authoring: its runtime activity, else its motion. */
const derivedCaption = (
  step: NetworkCaptionStep,
  events: readonly RuntimeActivityEvent[],
  context: NetworkCaptionContext,
): NetworkCaption => {
  const stepEvents = activityForStep(events, step);
  const headline = stepEvents.find((event) => text(event.title));
  if (!headline) return motionCaption(step, context);

  // Account-frame events are recorded from the receiving side only; the step's motion knows
  // both parties, so it names them when the event cannot.
  const lead = leadFlow(context);
  const selfReferential = !headline.counterpartyId || text(headline.counterpartyId) === text(headline.entityId);
  const subtitle = selfReferential && lead
    ? [describeAmount(headline, context), describeFlow(lead, context)].filter(Boolean).join('  ·  ')
    : describeEvent(headline, context);
  const tradfiParallel = headline.rawType.toLowerCase().includes('dispute')
    ? TRADFI_BY_TYPE['dispute']
    : TRADFI_BY_TYPE[headline.rawType] ?? TRADFI_BY_TYPE[text(headline.type)];
  return {
    title: headline.title === headline.rawType ? (TITLE_BY_RAW_TYPE[headline.rawType] ?? headline.title) : text(headline.title),
    subtitle,
    mechanic: mechanicFor(headline),
    extraCount: Math.max(0, stepEvents.length - 1),
    source: 'activity',
    ...(tradfiParallel ? { tradfiParallel } : {}),
  };
};

const leadFlow = (context: NetworkCaptionContext): NetworkMotionFlow | undefined => {
  const flows = context.motion?.flows ?? [];
  return flows.find((flow) => flow.kind !== 'ack') ?? flows[0];
};

const describeFlow = (flow: NetworkMotionFlow, context: NetworkCaptionContext): string => {
  const label = (entityId: string): string => text(context.labelFor?.(entityId)) || `${entityId.slice(0, 6)}…${entityId.slice(-4)}`;
  return `${label(flow.fromEntityId)} → ${label(flow.toEntityId)}`;
};

/** A step with no activity of its own: say what moved, or fall back to the frame number. */
const motionCaption = (step: NetworkCaptionStep, context: NetworkCaptionContext): NetworkCaption => {
  const flows = context.motion?.flows ?? [];
  const lead = leadFlow(context);
  if (!lead) {
    return { title: `Frame ${Math.floor(Number(step.height || 0))}`, subtitle: '', mechanic: '', extraCount: 0, source: 'frame' };
  }
  const amount = lead.amount !== undefined && lead.tokenId !== undefined
    ? text(context.formatAmount?.(lead.tokenId, lead.amount.toString()))
    : '';
  const type = MOTION_TYPE[lead.kind];
  const tradfiParallel = TRADFI_BY_TYPE[type];
  return {
    title: MOTION_TITLE[lead.kind],
    subtitle: [amount, describeFlow(lead, context)].filter(Boolean).join('  ·  '),
    mechanic: MECHANIC_BY_TYPE[type] ?? '',
    extraCount: Math.max(0, flows.length - 1),
    source: 'motion',
    ...(tradfiParallel ? { tradfiParallel } : {}),
  };
};
