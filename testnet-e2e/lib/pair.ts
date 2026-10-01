// One Account as two replicas of the rewrite's frame round (pure/account/frame), side by side, with the messages
// carried from one to the other in memory (gap `host-transport`). Frames are unsigned on main (gap `signed-frames`).
import { accountRules, emptyReplica, type AccountReplica } from "../../pure/account/frame/account.ts";
import { propose, receive, submit, type Msg } from "../../pure/account/frame/frame.ts";
import type { ClockParams, JView } from "../../pure/account/clause/clock.ts";
import { deposit } from "../../pure/account/ledger.ts";
import { other, type AccountState, type Ledger, type Side, type TokenId } from "../../pure/account/model.ts";
import { ledgerOf, withLedger } from "../../pure/account/state.ts";
import type { AccountTx } from "../../pure/account/tx.ts";
import { must, type Party } from "./chain.ts";

export type Pair = Readonly<{ left: Party; right: Party; replicas: Readonly<Record<Side, AccountReplica>> }>;

export const openPair = (left: Party, right: Party): Pair =>
  ({ left, right, replicas: { left: emptyReplica("left"), right: emptyReplica("right") } });

export const sideOfParty = (pair: Pair, p: Party): Side => (pair.left.id === p.id ? "left" : "right");

const stateKey = (s: AccountState): string =>
  JSON.stringify([...s.ledgers].map(([t, l]) => [t.toString(), l]), (_, v) => (typeof v === "bigint" ? `${v}n` : v));

/** Both sides hold the same head and the same money, or the round is broken. */
export const assertAgree = (pair: Pair, what: string): void => {
  const { left, right } = pair.replicas;
  if (left.head !== right.head) throw new Error(`${what}: the replicas hold different heads (${left.head} and ${right.head})`);
  if (stateKey(left.state) !== stateKey(right.state)) throw new Error(`${what}: the replicas hold different state`);
  if (left.pending !== undefined || right.pending !== undefined) throw new Error(`${what}: a frame is still pending`);
};

export type View = Readonly<{ clock: ClockParams; view: JView }>;

/** `author` queues `tx` (refused at the door if it cannot apply), proposes, and the two sides trade messages until
 * quiet. A refusal at the door, or by the peer, is an error: a step that expected a refusal says so itself. */
export const commit = (pair: Pair, v: View, author: Side, tx: AccountTx, what: string): Pair => {
  const rules = accountRules({ clock: v.clock, view: v.view });
  const queued = submit(rules, pair.replicas[author], tx);
  if (!queued.ok) throw new Error(`${what}: refused at the door: ${queued.error._tag}`);
  const first = propose(rules, queued.value);
  const state: { replicas: Record<Side, AccountReplica>; inbox: { to: Side; msg: Msg<AccountTx> }[]; guard: number } =
    { replicas: { ...pair.replicas, [author]: first.replica }, inbox: first.sent.map((msg) => ({ to: other(author), msg })), guard: 0 };
  while (state.inbox.length > 0) {
    if (++state.guard > 40) throw new Error(`${what}: the round did not settle in 40 messages`);
    const { to, msg } = state.inbox.shift()!;
    const heard = receive(rules, state.replicas[to], msg);
    state.replicas = { ...state.replicas, [to]: heard.replica };
    state.inbox.push(...heard.sent.map((m) => ({ to: other(to), msg: m })));
  }
  const next = { ...pair, replicas: state.replicas };
  const refused = next.replicas[author].refused;
  if (refused.length > 0) throw new Error(`${what}: refused: ${JSON.stringify(refused[0]!.fault, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  assertAgree(next, what);
  return next;
};

/** A deposit the chain made (R2C) copied into both ledgers by hand: there is no J event path on main (gap `j-events`). */
export const creditDeposit = (pair: Pair, token: TokenId, side: Side, amount: bigint): Pair => {
  const apply = (r: AccountReplica): AccountReplica =>
    ({ ...r, state: withLedger(r.state, token, must(deposit(ledgerOf(r.state, token), side, amount), "deposit")) });
  return { ...pair, replicas: { left: apply(pair.replicas.left), right: apply(pair.replicas.right) } };
};

export const ledgerIn = (pair: Pair, token: TokenId): Ledger => ledgerOf(pair.replicas.left.state, token);
