/**
 * The open Account round of one Runtime, for the length of one Entity frame.
 *
 * A frame opens a round before it dispatches anything, hands its arrivals to
 * the engine in as few calls as the "one arrival per account" rule allows, and
 * closes the round when the frame ends. Closing is a check, not a cleanup: a
 * verdict nobody consumed means the engine moved an account the Entity did
 * not, and that must stop the frame rather than survive into a signed one.
 */
import type { RuntimeReplica } from '../../runtime/types';
import type { Wave } from '../wave-decode';
import {
  inboundArrivals,
  inboundRound,
  inboundRows,
  inboundSlice,
  type InboundArrival,
} from './inbound';
import type { EntityTx } from '../../types/entity-tx';

const fail = (code: string, detail: Readonly<Record<string, unknown>> = {}): never => {
  throw new Error(`RSCORE_ROUND_${code}:${JSON.stringify(detail)}`);
};

type HandedOver = Readonly<{ accountId: string; operationIndex: number; wave: Wave }>;

type OpenRound = {
  ownerEntityId: string;
  pending: InboundArrival[];
  handed: HandedOver[];
  calls: number;
};

const open = new Map<string, OpenRound>();

const runtimeKey = (env: RuntimeReplica): string => String(env.runtimeId ?? '');

/** How many engine calls the open rounds of this Runtime have made so far. */
export const accountRoundCalls = { inbound: 0 };

/**
 * Open a round over the arrivals this Entity frame carries.
 *
 * Nested dispatch reuses the round its parent opened: the arrivals are the
 * frame's, not the nesting level's.
 */
export const openAccountRound = (
  env: RuntimeReplica,
  ownerEntityId: string,
  entityTxs: readonly EntityTx[],
): boolean => {
  const key = runtimeKey(env);
  if (open.has(key)) return false;
  open.set(key, {
    ownerEntityId: ownerEntityId.trim().toLowerCase(),
    pending: inboundArrivals(entityTxs),
    handed: [],
    calls: 0,
  });
  return true;
};

/** Close the round this frame opened, refusing anything it left behind. */
export const closeAccountRound = (env: RuntimeReplica): void => {
  const key = runtimeKey(env);
  const round = open.get(key);
  open.delete(key);
  if (round === undefined || round.handed.length === 0) return;
  fail('INBOUND_VERDICT_UNCONSUMED', {
    owner: round.ownerEntityId,
    accounts: round.handed.map(entry => entry.accountId),
  });
};

/**
 * The engine's answer for the next arrival of this account.
 *
 * The answer is already here when the account leads the current round; when
 * the round is spent, the next one crosses now. `null` means this input is not
 * one the frame carried — a handler built it — and the caller executes it on
 * its own.
 */
export const takeInboundVerdict = async (
  env: RuntimeReplica,
  ownerEntityId: string,
  accountId: string,
  hand: (rows: readonly ReturnType<typeof inboundRows>[number][]) => Promise<Wave>,
): Promise<Wave | null> => {
  const round = open.get(runtimeKey(env));
  if (round === undefined) return null;
  if (round.ownerEntityId !== ownerEntityId.trim().toLowerCase()) return null;
  const account = accountId.trim().toLowerCase();
  const held = round.handed.findIndex(entry => entry.accountId === account);
  if (held >= 0) {
    const [entry] = round.handed.splice(held, 1);
    if (entry === undefined) return fail('INBOUND_QUEUE_CORRUPT', { account });
    return inboundSlice(entry.wave, entry.accountId, entry.operationIndex);
  }
  if (round.pending.length === 0 || round.pending[0]?.accountId !== account) return null;
  const next = inboundRound(round.pending);
  round.pending = round.pending.slice(next.length);
  const wave = await hand(inboundRows(next));
  round.calls += 1;
  accountRoundCalls.inbound += 1;
  round.handed = next.map((arrival, index) => ({
    accountId: arrival.accountId,
    operationIndex: index,
    wave,
  }));
  const first = round.handed.shift();
  if (first === undefined || first.accountId !== account) {
    return fail('INBOUND_ROUND_HEAD', { account, head: first?.accountId ?? null });
  }
  return inboundSlice(first.wave, first.accountId, first.operationIndex);
};
