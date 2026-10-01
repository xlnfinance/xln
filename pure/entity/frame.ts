// One Entity frame (spec/entity/frame.scm): the inputs of the frame are folded in four phases over one view of every
// Account, and the Accounts then propose. The phases are the only order there is: where an arrival sits among the
// frame's commands does not matter, and a command always sees what the arrivals of its own frame did (R-E1).
import { mapSet } from "../kernel/core/collections.ts";
import { accountRules, emptyReplica, type AccountReplica, type AccountRules } from "../account/frame/account.ts";
import type { JView } from "../account/clause/clock.ts";
import { propose, receive, resend, submit, type Heard, type Msg, type Outcome } from "../account/frame/frame.ts";
import { revealOnChainDue } from "../account/clause/clock.ts";
import type { AccountFault, AccountState } from "../account/model.ts";
import { holderOf, ledgerOf } from "../account/state.ts";
import { MAX_AMOUNT } from "../account/ledger.ts";
import {
  depositable, disputeOpened, disputeOver, epochAdvanced, framed, freshChain, proofNonce, withWindows,
} from "./chain.ts";
import type { AccountTx, Judge } from "../account/tx.ts";
import {
  sideOf, type AccountCommand, type Arrival, type ChainCommand, type ChainFacts, type Command, type EntityFault,
  type EntityId, type EntityInput, type EntityState, type Hook, type JAction, type JEvent, type Notice, type Outbound,
  type PeerMessage,
} from "./model.ts";

export type Frame = Readonly<{
  state: EntityState; outputs: readonly Outbound[]; notices: readonly Notice[]; chain: readonly JAction[];
}>;

/** A frame in progress: what it has built so far, and which Accounts a command has touched, in order. */
type Work = Readonly<{
  state: EntityState; outputs: readonly Outbound[]; notices: readonly Notice[]; chain: readonly JAction[];
  touched: readonly EntityId[];
}>;

const start = (state: EntityState): Work => ({ state, outputs: [], notices: [], chain: [], touched: [] });

const noting = (w: Work, notice: Notice): Work => ({ ...w, notices: [...w.notices, notice] });

const sending = (w: Work, to: EntityId, msgs: readonly Msg<AccountTx>[]): Work =>
  ({ ...w, outputs: [...w.outputs, ...msgs.map((msg): Outbound => ({ from: w.state.id, to, msg }))] });

const withReplica = (w: Work, peer: EntityId, r: AccountReplica): Work =>
  ({ ...w, state: { ...w.state, accounts: mapSet(w.state.accounts, peer, r) } });

const touching = (w: Work, peer: EntityId): Work =>
  (w.touched.includes(peer) ? w : { ...w, touched: [...w.touched, peer] });

// ---- phase 1: arrivals

/** A refusal the sender is owed a notice for; a stale ack and a kept own frame are the round working. */
const refusal = (outcome: Outcome<AccountFault>): Outcome<AccountFault> | undefined => {
  switch (outcome._tag) {
    case "refused_invalid":
    case "refused_own":
    case "refused_empty":
    case "refused_attempt":
    case "refused_not_next":
      return outcome;
    default:
      return undefined;
  }
};

/** A refusal took my frame back and left txs to try again: they wait for the view of J to move (retry pacing). */
const waitingForJ = (w: Work, peer: EntityId, view: JView, heard: Heard<AccountTx, AccountState, AccountFault>): Work =>
  (heard.outcome._tag === "rolled_back" && heard.replica.mempool.length > 0
    ? { ...w, state: { ...w.state, waiting: mapSet(w.state.waiting, peer, view) } }
    : w);

const factsOf = (w: Work, peer: EntityId): ChainFacts => w.state.chain.get(peer) ?? freshChain;

const withFacts = (w: Work, peer: EntityId, facts: ChainFacts): Work =>
  ({ ...w, state: { ...w.state, chain: mapSet(w.state.chain, peer, facts) } });

/** A frame is co-signed when the peer's frame is taken or my own is acked: one more proof of the epoch. */
const cosigned = (outcome: Outcome<AccountFault>): boolean =>
  outcome._tag === "accepted" || outcome._tag === "accepted_over_own" || outcome._tag === "committed_own";

const hearing = (rules: AccountRules, view: JView, w: Work, a: PeerMessage): Work => {
  const account = w.state.accounts.get(a.from);
  if (account === undefined) return noting(w, { _tag: "unknown_peer", from: a.from });
  const heard = receive(rules, account, a.msg);
  const refused = refusal(heard.outcome);
  const heardBy = sending(withReplica(w, a.from, heard.replica), a.from, heard.sent);
  const waiting = waitingForJ(heardBy, a.from, view, heard);
  const counted = cosigned(heard.outcome) ? withFacts(waiting, a.from, framed(factsOf(waiting, a.from))) : waiting;
  return refused === undefined ? counted : noting(counted, { _tag: "message_refused", from: a.from, outcome: refused });
};

/** What the chain did to the Account with `peer`; for an Account the Entity does not hold it is told and ignored. */
const observed = (w: Work, e: JEvent): Work => {
  if (!w.state.accounts.has(e.peer)) return noting(w, { _tag: "unknown_peer", from: e.peer });
  const facts = factsOf(w, e.peer);
  switch (e._tag) {
    case "j_epoch":
      return withFacts(w, e.peer, epochAdvanced(facts, e.epoch, e.stored));
    case "j_dispute":
      return e.by === sideOf(w.state.id, e.peer) ? w : withFacts(w, e.peer, disputeOpened(facts, e.epoch));
    case "j_dispute_over":
      return withFacts(w, e.peer, disputeOver(facts));
  }
};

const arrive = (rules: AccountRules, view: JView, w: Work, a: Arrival): Work =>
  (a._tag === "peer_message" ? hearing(rules, view, w, a) : observed(w, a));

// ---- phase 2: hooks

const hooked = (w: Work, hook: Hook): Work => {
  const account = w.state.accounts.get(hook.peer);
  return account === undefined ? w : sending(w, hook.peer, resend(account));
};

// ---- phase 3: commands

const refusedCommand = (w: Work, command: Command, fault: EntityFault): Work =>
  noting(w, { _tag: "command_refused", command, fault });

const opened = (w: Work, command: Extract<Command, { _tag: "open_account" }>): Work => {
  if (command.peer === w.state.id) return refusedCommand(w, command, { _tag: "self_account" });
  if (w.state.accounts.has(command.peer)) {
    return refusedCommand(w, command, { _tag: "account_exists", peer: command.peer });
  }
  return withReplica(w, command.peer, emptyReplica(sideOf(w.state.id, command.peer)));
};

/** The tx a command asks its Account for. */
const txOf = (command: AccountCommand): AccountTx => {
  switch (command._tag) {
    case "pay":
      return { _tag: "pay", token: command.token, amount: command.amount };
    case "set_credit":
      return { _tag: "set_credit", token: command.token, limit: command.limit };
    case "lock":
      return { _tag: "lock", token: command.token, hold: command.hold };
    case "resolve":
      return { _tag: "resolve", token: command.token, id: command.id, secret: command.secret };
    case "cancel":
      return { _tag: "cancel", token: command.token, id: command.id };
    case "expire":
      return { _tag: "expire", token: command.token, id: command.id };
  }
};

/** The Account checks the tx against its planning state at the door (R-ADMIT); a refusal is the command's notice. */
const queued = (rules: AccountRules, w: Work, command: AccountCommand): Work => {
  const account = w.state.accounts.get(command.peer);
  if (account === undefined) return refusedCommand(w, command, { _tag: "no_account", peer: command.peer });
  const admitted = submit(rules, account, txOf(command));
  return admitted.ok
    ? touching(withReplica(w, command.peer, admitted.value), command.peer)
    : refusedCommand(w, command, { _tag: "account_refused", fault: admitted.error });
};

const asked = (w: Work, action: JAction): Work => ({ ...w, chain: [...w.chain, action] });

/** A deposit waits for the first co-signed frame of an Account at epoch 0 (R-NO-DEPOSIT-BEFORE-COSIGN). */
const deposited = (w: Work, command: Extract<ChainCommand, { _tag: "deposit" }>): Work => {
  const { peer, token, amount } = command;
  if (amount < 1n || amount > MAX_AMOUNT) {
    return refusedCommand(w, command, { _tag: "account_refused", fault: { _tag: "bad_amount", amount } });
  }
  return depositable(factsOf(w, peer))
    ? asked(w, { _tag: "deposit", peer, token, amount })
    : refusedCommand(w, command, { _tag: "deposit_before_cosign" });
};

const windowed = (w: Work, command: Extract<ChainCommand, { _tag: "set_windows" }>): Work => {
  const next = withWindows(factsOf(w, command.peer), command.windows);
  return next.ok ? withFacts(w, command.peer, next.value) : refusedCommand(w, command, next.error);
};

/** A command about the chain needs an Account with the peer, as an Account command does. */
const chained = (w: Work, command: ChainCommand): Work => {
  const { peer } = command;
  if (!w.state.accounts.has(peer)) return refusedCommand(w, command, { _tag: "no_account", peer });
  return command._tag === "deposit" ? deposited(w, command) : windowed(w, command);
};

const commanded = (rules: AccountRules, w: Work, command: Command): Work => {
  switch (command._tag) {
    case "open_account":
      return opened(w, command);
    case "deposit":
    case "set_windows":
      return chained(w, command);
    default:
      return queued(rules, w, command);
  }
};

// ---- phase 4: proposals

/** The Accounts a command touched, in first-touch order, then every other Account by id (R-E4). */
const proposalOrder = (w: Work): readonly EntityId[] => {
  const rest = [...w.state.accounts.keys()].filter((peer) => !w.touched.includes(peer)).toSorted();
  return [...w.touched, ...rest];
};

/** An Account that waits for its view of J to move proposes nothing until the view is above the one it waited at. */
const paced = (w: Work, view: JView, peer: EntityId, account: AccountReplica): boolean => {
  const since = w.state.waiting.get(peer);
  return since !== undefined && account.attempt > 0 && view <= since;
};

const proposing = (rules: AccountRules, view: JView, w: Work, peer: EntityId): Work => {
  const account = w.state.accounts.get(peer);
  if (account === undefined || paced(w, view, peer, account)) return w;
  const proposed = propose(rules, account);
  return sending(withReplica(w, peer, proposed.replica), peer, proposed.sent);
};

/** What still waits is what is still paced; the rest of the rows say nothing any more. */
const stillWaiting = (w: Work, view: JView): Work => {
  const kept = [...w.state.waiting].filter(([peer]) => {
    const account = w.state.accounts.get(peer);
    return account !== undefined && paced(w, view, peer, account);
  });
  return { ...w, state: { ...w.state, waiting: new Map(kept) } };
};

/** Every tx an Account refused is told to the Entity (R-NOTICE), and the Account forgets it. */
const told = (w: Work, peer: EntityId): Work => {
  const account = w.state.accounts.get(peer);
  if (account === undefined || account.refused.length === 0) return w;
  const cleared = withReplica(w, peer, { ...account, refused: [] });
  return account.refused.reduce((acc, refused) => noting(acc, { _tag: "tx_refused", peer, refused }), cleared);
};

// ---- phase 5: duties to the chain

type Resolve = Extract<AccountTx, { _tag: "resolve" }>;

/** My resolves that no ack has covered yet: those in the pending frame, then those still queued. */
const unackedResolves = (account: AccountReplica): readonly Resolve[] =>
  [...(account.pending?.frame.txs ?? []), ...account.mempool].flatMap((tx) => (tx._tag === "resolve" ? [tx] : []));

type Asked = Readonly<{ hashlocks: readonly string[]; actions: readonly JAction[] }>;

/** A payee with an unacked resolve reveals once its view is within LAG of the deadline, once per hashlock. */
const asking = (judge: Judge, peer: EntityId, account: AccountReplica) => (acc: Asked, tx: Resolve): Asked => {
  const hold = ledgerOf(account.state, tx.token).holds.find((h) => h.id === tx.id);
  if (hold === undefined || acc.hashlocks.includes(hold.hashlock)) return acc;
  const { token, id, secret } = tx;
  const reveal: JAction = { _tag: "reveal", peer, token, id, hashlock: hold.hashlock, secret };
  return revealOnChainDue(judge.clock, hold.deadline, judge.view)
    ? { hashlocks: [...acc.hashlocks, hold.hashlock], actions: [...acc.actions, reveal] }
    : acc;
};

/**
 * While a dispute the peer started is open against me, and I hold a co-signed proof of the epoch, I counter with it.
 * The Host de-duplicates what is asked again, so each frame of the Entity restates it until the chain says the
 * dispute is over: a batch the chain reverted or a Host that crashed cannot leave the dispute unanswered for good.
 */
const counterFor = (facts: ChainFacts, peer: EntityId, account: AccountReplica): readonly JAction[] => {
  const nonce = proofNonce(facts);
  return facts.disputed && nonce !== undefined ? [{ _tag: "counter", peer, nonce, head: account.head }] : [];
};

/** What the Entity owes the chain on `peer`'s Account; a hashlock whose hold is gone is forgotten. */
const dutiful = (judge: Judge) => (w: Work, peer: EntityId): Work => {
  const account = w.state.accounts.get(peer);
  if (account === undefined) return w;
  const open = (w.state.revealed.get(peer) ?? []).filter((hashlock) => holderOf(account.state, hashlock) !== undefined);
  const asked = unackedResolves(account).reduce(asking(judge, peer, account), { hashlocks: open, actions: [] });
  const revealed = mapSet(w.state.revealed, peer, asked.hashlocks);
  const counters = counterFor(factsOf(w, peer), peer, account);
  return { ...w, chain: [...w.chain, ...asked.actions, ...counters], state: { ...w.state, revealed } };
};

const isArrival = (i: EntityInput): i is Arrival =>
  i._tag === "peer_message" || i._tag === "j_epoch" || i._tag === "j_dispute" || i._tag === "j_dispute_over";

const arrivalsOf = (inputs: readonly EntityInput[]): readonly Arrival[] => inputs.filter(isArrival);

const hooksOf = (inputs: readonly EntityInput[]): readonly Hook[] =>
  inputs.flatMap((i) => (i._tag === "resend_due" ? [i] : []));

const commandsOf = (inputs: readonly EntityInput[]): readonly Command[] =>
  inputs.flatMap((i) => (isArrival(i) || i._tag === "resend_due" ? [] : [i]));

/**
 * The frame: arrivals, then hooks, then commands, then proposals, then the refusals the Accounts hold are told, then
 * what the Entity owes the chain.
 */
export const entityFrame = (judge: Judge, state: EntityState, inputs: readonly EntityInput[]): Frame => {
  const rules = accountRules(judge);
  const arrived = arrivalsOf(inputs).reduce((w, a) => arrive(rules, judge.view, w, a), start(state));
  const afterHooks = hooksOf(inputs).reduce(hooked, arrived);
  const afterCommands = commandsOf(inputs).reduce((w, c) => commanded(rules, w, c), afterHooks);
  const propose = (w: Work, peer: EntityId): Work => proposing(rules, judge.view, w, peer);
  const proposed = proposalOrder(afterCommands).reduce(propose, afterCommands);
  const peers = [...proposed.state.accounts.keys()].toSorted();
  const done = peers.reduce(dutiful(judge), peers.reduce(told, stillWaiting(proposed, judge.view)));
  return { state: done.state, outputs: done.outputs, notices: done.notices, chain: done.chain };
};
