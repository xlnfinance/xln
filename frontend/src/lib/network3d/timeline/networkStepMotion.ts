/**
 * What moved in one network step — the single source of payment motion in the graph.
 *
 * A step is the change between two graph states of the same network. Replay and live feed
 * the same derivation: replay compares the selected R-frame with the R-frame before it,
 * live compares the newly projected state with the one it replaces. Nothing here reads
 * runtime history or wall time, so the same pair of frames always produces the same motion.
 *
 * Signals, all read from committed graph state:
 *   - a new `pendingFrame` on X's side of account X–Y: X proposed a bilateral frame to Y;
 *   - X's `currentHeight` advancing on a frame Y proposed: X signed it and acknowledged;
 *   - collateral, reserve or dispute changes: an on-chain consequence landed on the party;
 *   - activity `j_broadcast` / `j_batch` and `j_event`: a batch went to the jurisdiction and
 *     the jurisdiction finalized it.
 */

import type { RuntimeActivityEvent } from '@xln/core/api/public/runtime-module';
import type { RuntimeGraphAccountState, RuntimeGraphProjection } from '../runtimeGraphProjection';

export type NetworkMotionKind =
  | 'payment'
  | 'htlc_lock'
  | 'htlc_resolve'
  | 'swap'
  | 'settlement'
  | 'j_claim'
  | 'credit'
  | 'account'
  | 'frame'
  | 'ack';

export type NetworkMotionAmount = { tokenId: number; amount: bigint };

export type NetworkMotionFlow = {
  fromEntityId: string;
  toEntityId: string;
  kind: NetworkMotionKind;
  tokenId?: number;
  amount?: bigint;
  /** A swap's two legs from the maker's side: what it gives, what it receives. */
  swapLegs?: { give: NetworkMotionAmount; want: NetworkMotionAmount };
};

export type NetworkMotionPulseKind = 'reserve' | 'collateral' | 'dispute';

export type NetworkMotionPulse = { entityId: string; kind: NetworkMotionPulseKind };

export type NetworkStepMotion = {
  /** Identity of the step: a step animates once, however often the graph re-renders. */
  key: string;
  flows: NetworkMotionFlow[];
  pulses: NetworkMotionPulse[];
  /** Entities that sent a batch to the jurisdiction during this step. */
  jSubmissions: string[];
  /** On-chain events observed during this step: the jurisdiction finalized a block. */
  jFinalized: number;
};

export type NetworkStepMotionInput = {
  key: string;
  /** Null for the first step of a timeline: there is nothing to compare against. */
  previous: readonly RuntimeGraphProjection[] | null;
  current: readonly RuntimeGraphProjection[];
  activity: readonly RuntimeActivityEvent[];
};

type FrameTx = { type: string; tokenId?: number; amount?: bigint; swapLegs?: NetworkMotionFlow['swapLegs'] };

/** Value-bearing kinds first: a frame carrying a payment and a credit line is a payment. */
const KIND_PRIORITY: ReadonlyArray<[NetworkMotionKind, (type: string) => boolean]> = [
  ['payment', (type) => type === 'direct_payment'],
  ['htlc_lock', (type) => type === 'htlc_lock'],
  ['htlc_resolve', (type) => type === 'htlc_resolve'],
  ['swap', (type) => type.startsWith('swap_')],
  ['settlement', (type) => type.startsWith('settle_')],
  ['j_claim', (type) => type === 'j_event_claim'],
  ['credit', (type) => type === 'set_credit_limit' || type === 'request_collateral'],
  ['account', (type) => type === 'add_delta'],
];

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

const motionAmountOf = (tokenIdValue: unknown, amount: unknown): NetworkMotionAmount | null => {
  const tokenId = Number(tokenIdValue);
  return Number.isSafeInteger(tokenId) && tokenId > 0 && typeof amount === 'bigint' ? { tokenId, amount } : null;
};

/** Swap offers state both legs; recorded fills carry them too. Anything partial has none. */
const swapLegsOf = (field: (key: string) => unknown): NetworkMotionFlow['swapLegs'] | null => {
  const give = motionAmountOf(field('giveTokenId'), field('giveAmount'));
  const want = motionAmountOf(field('wantTokenId'), field('wantAmount'));
  return give && want ? { give, want } : null;
};

/** Graph frames carry flattened txs, live replicas carry `{ type, data }`; read both once. */
const frameTxOf = (value: unknown): FrameTx => {
  const tx = recordOf(value);
  const data = recordOf(tx['data']);
  const field = (key: string): unknown => tx[key] ?? data[key];
  const tokenId = Number(field('tokenId'));
  const amount = field('amount');
  const swapLegs = swapLegsOf(field);
  return {
    type: String(tx['type'] ?? ''),
    ...(Number.isSafeInteger(tokenId) && tokenId >= 0 ? { tokenId } : {}),
    ...(typeof amount === 'bigint' ? { amount } : {}),
    ...(swapLegs ? { swapLegs } : {}),
  };
};

export const classifyFrameTxs = (accountTxs: readonly unknown[] | undefined): Omit<NetworkMotionFlow, 'fromEntityId' | 'toEntityId'> => {
  const txs = (accountTxs ?? []).map(frameTxOf);
  for (const [kind, matches] of KIND_PRIORITY) {
    const matching = txs.filter((tx) => matches(tx.type));
    if (matching.length === 0) continue;
    const valued = matching.find((tx) => tx.amount !== undefined);
    // Only a fill moves money: an offer's legs are a limit, never shown as if they had traded.
    const traded = matching.find((tx) => tx.type === 'swap_resolve' && tx.swapLegs !== undefined);
    return {
      kind,
      ...(valued?.tokenId !== undefined ? { tokenId: valued.tokenId } : {}),
      ...(valued?.amount !== undefined ? { amount: valued.amount } : {}),
      ...(traded?.swapLegs ? { swapLegs: traded.swapLegs } : {}),
    };
  }
  return { kind: 'frame' };
};

type AccountView = { observer: string; counterparty: string; state: RuntimeGraphAccountState };

/** One view per observer side of each account; the first runtime that projects it wins. */
const accountViews = (projections: readonly RuntimeGraphProjection[]): Map<string, AccountView> => {
  const views = new Map<string, AccountView>();
  for (const projection of projections) {
    for (const state of projection.accounts) {
      const observer = state.observerEntityId;
      const counterparty = observer === state.leftEntityId ? state.rightEntityId : state.leftEntityId;
      const key = `${observer}>${counterparty}`;
      if (!views.has(key)) views.set(key, { observer, counterparty, state });
    }
  }
  return views;
};

const reserveSignatures = (projections: readonly RuntimeGraphProjection[]): Map<string, string> => {
  const signatures = new Map<string, string>();
  for (const projection of projections) {
    for (const node of projection.nodes) {
      if (signatures.has(node.entityId)) continue;
      const reserves = node.replica?.state?.reserves ?? node.core?.reserves;
      const entries = reserves instanceof Map ? Array.from(reserves.entries()) : Object.entries(recordOf(reserves));
      signatures.set(node.entityId, entries
        .map(([tokenId, amount]) => `${String(tokenId)}:${String(amount)}`)
        .sort()
        .join(','));
    }
  }
  return signatures;
};

/** Zero collateral is no collateral: a token lane opening is not an on-chain deposit. */
const collateralSignature = (state: RuntimeGraphAccountState): string =>
  Array.from(state.account.state.deltas.entries())
    .filter(([, delta]) => delta.collateral !== 0n)
    .map(([tokenId, delta]) => `${tokenId}:${String(delta.collateral)}`)
    .sort()
    .join(',');

/**
 * An account side that did not exist in the previous state is new on this step: it starts
 * from height 0 with nothing pending, so its first proposal or signature still moves.
 */
const flowsOfView = (view: AccountView, previous: AccountView | undefined): NetworkMotionFlow[] => {
  const pending = view.state.account.pendingFrame;
  const previousPending = previous?.state.account.pendingFrame;
  const flows: NetworkMotionFlow[] = [];
  if (pending && pending.height !== previousPending?.height) {
    flows.push({ fromEntityId: view.observer, toEntityId: view.counterparty, ...classifyFrameTxs(pending.accountTxs) });
  }
  const committedHeight = view.state.account.currentHeight;
  const signedCounterpartyFrame = committedHeight > (previous?.state.account.currentHeight ?? 0)
    && previousPending?.height !== committedHeight;
  if (signedCounterpartyFrame) flows.push({ fromEntityId: view.observer, toEntityId: view.counterparty, kind: 'ack' });
  return flows;
};

const pulsesOfView = (view: AccountView, previous: AccountView | undefined): NetworkMotionPulse[] => {
  if (!previous) return [];
  const pulses: NetworkMotionPulse[] = [];
  if (collateralSignature(view.state) !== collateralSignature(previous.state)) {
    pulses.push({ entityId: view.observer, kind: 'collateral' });
  }
  if (view.state.account.activeDispute && !previous.state.account.activeDispute) {
    pulses.push({ entityId: view.observer, kind: 'dispute' });
  }
  return pulses;
};

const uniquePulses = (pulses: NetworkMotionPulse[]): NetworkMotionPulse[] => {
  const seen = new Set<string>();
  return pulses.filter((pulse) => {
    const key = `${pulse.entityId}|${pulse.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Blocks a materialized J-machine produced between the two states. Graph-frame replays carry
 * no J replica (`machine === null`), so they report finality through `j_event` activity only.
 */
const jBlocksBetween = (previous: readonly RuntimeGraphProjection[], current: readonly RuntimeGraphProjection[]): number => {
  const heights = (projections: readonly RuntimeGraphProjection[]): Map<string, number> => new Map(projections
    .flatMap((projection) => projection.jMachines)
    .filter((machine) => machine.machine !== null)
    .map((machine) => [machine.jMachineId, machine.height]));
  const before = heights(previous);
  return Array.from(heights(current)).reduce((blocks, [jMachineId, height]) => {
    const prior = before.get(jMachineId);
    return prior === undefined ? blocks : blocks + Math.max(0, height - prior);
  }, 0);
};

const jSubmittersOf = (activity: readonly RuntimeActivityEvent[]): string[] =>
  Array.from(new Set(activity
    .filter((event) => event.rawType === 'j_broadcast' || event.type === 'j_batch')
    .map((event) => String(event.entityId ?? '').trim().toLowerCase())
    .filter(Boolean)));

export const deriveNetworkStepMotion = (input: NetworkStepMotionInput): NetworkStepMotion => {
  const jSubmissions = jSubmittersOf(input.activity);
  const jFinalized = input.activity.filter((event) => event.type === 'j_event').length;
  if (!input.previous) return { key: input.key, flows: [], pulses: [], jSubmissions, jFinalized };
  const previousViews = accountViews(input.previous);
  const currentViews = Array.from(accountViews(input.current).entries())
    .sort(([left], [right]) => left.localeCompare(right));
  // A whole runtime joining the view is not motion; a known entity opening an account is.
  const knownObservers = new Set(input.previous.flatMap((projection) => projection.nodes.map((node) => node.entityId)));
  const flows = currentViews
    .filter(([key, view]) => previousViews.has(key) || knownObservers.has(view.observer))
    .flatMap(([key, view]) => flowsOfView(view, previousViews.get(key)));
  const accountPulses = currentViews.flatMap(([key, view]) => pulsesOfView(view, previousViews.get(key)));
  const previousReserves = reserveSignatures(input.previous);
  const reservePulses = Array.from(reserveSignatures(input.current).entries())
    .filter(([entityId, signature]) => previousReserves.has(entityId) && previousReserves.get(entityId) !== signature)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entityId]): NetworkMotionPulse => ({ entityId, kind: 'reserve' }));
  return {
    key: input.key,
    flows,
    pulses: uniquePulses([...accountPulses, ...reservePulses]),
    jSubmissions,
    jFinalized: jFinalized + jBlocksBetween(input.previous, input.current),
  };
};

/** Every entity the step touched — what the camera and focus should keep lit. */
export const networkStepMotionEntityIds = (motion: NetworkStepMotion | null): Set<string> => {
  const ids = new Set<string>();
  if (!motion) return ids;
  for (const flow of motion.flows) {
    ids.add(flow.fromEntityId);
    ids.add(flow.toEntityId);
  }
  for (const pulse of motion.pulses) ids.add(pulse.entityId);
  for (const entityId of motion.jSubmissions) ids.add(entityId);
  return ids;
};
