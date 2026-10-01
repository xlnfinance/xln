// One Entity frame (spec/entity/frame.scm): the inputs of the frame are folded in four phases over one view of every
// Account, and the Accounts then propose. The phases are the only order there is: where an arrival sits among the
// frame's commands does not matter, and a command always sees what the arrivals of its own frame did (R-E1).
import { mapSet } from "../kernel/core/collections.ts";
import { accountRules, emptyReplica, type AccountReplica, type AccountRules } from "../account/frame/account.ts";
import { propose, receive, resend, submit, type Msg, type Outcome } from "../account/frame/frame.ts";
import type { AccountFault } from "../account/model.ts";
import type { AccountTx, Judge } from "../account/tx.ts";
import {
  sideOf, type Arrival, type Command, type EntityFault, type EntityId, type EntityInput, type EntityState, type Hook,
  type Notice, type Outbound,
} from "./model.ts";

export type Frame = Readonly<{ state: EntityState; outputs: readonly Outbound[]; notices: readonly Notice[] }>;

/** A frame in progress: what it has built so far, and which Accounts a command has touched, in order. */
type Work = Readonly<{
  state: EntityState; outputs: readonly Outbound[]; notices: readonly Notice[]; touched: readonly EntityId[];
}>;

const start = (state: EntityState): Work => ({ state, outputs: [], notices: [], touched: [] });

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

const arrive = (rules: AccountRules, w: Work, a: Arrival): Work => {
  const account = w.state.accounts.get(a.from);
  if (account === undefined) return noting(w, { _tag: "unknown_peer", from: a.from });
  const heard = receive(rules, account, a.msg);
  const refused = refusal(heard.outcome);
  const heardBy = sending(withReplica(w, a.from, heard.replica), a.from, heard.sent);
  return refused === undefined ? heardBy : noting(heardBy, { _tag: "message_refused", from: a.from, outcome: refused });
};

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

type OnAccount = Exclude<Command, { _tag: "open_account" }>;

/** The tx a command asks its Account for. */
const txOf = (command: OnAccount): AccountTx =>
  (command._tag === "pay"
    ? { _tag: "pay", token: command.token, amount: command.amount }
    : { _tag: "set_credit", token: command.token, limit: command.limit });

/** The Account checks the tx against its planning state at the door (R-ADMIT); a refusal is the command's notice. */
const queued = (rules: AccountRules, w: Work, command: OnAccount): Work => {
  const account = w.state.accounts.get(command.peer);
  if (account === undefined) return refusedCommand(w, command, { _tag: "no_account", peer: command.peer });
  const admitted = submit(rules, account, txOf(command));
  return admitted.ok
    ? touching(withReplica(w, command.peer, admitted.value), command.peer)
    : refusedCommand(w, command, { _tag: "account_refused", fault: admitted.error });
};

const commanded = (rules: AccountRules, w: Work, command: Command): Work =>
  (command._tag === "open_account" ? opened(w, command) : queued(rules, w, command));

// ---- phase 4: proposals

/** The Accounts a command touched, in first-touch order, then every other Account by id (R-E4). */
const proposalOrder = (w: Work): readonly EntityId[] => {
  const rest = [...w.state.accounts.keys()].filter((peer) => !w.touched.includes(peer)).toSorted();
  return [...w.touched, ...rest];
};

const proposing = (rules: AccountRules, w: Work, peer: EntityId): Work => {
  const account = w.state.accounts.get(peer);
  if (account === undefined) return w;
  const proposed = propose(rules, account);
  return sending(withReplica(w, peer, proposed.replica), peer, proposed.sent);
};

/** Every tx an Account refused is told to the Entity (R-NOTICE), and the Account forgets it. */
const told = (w: Work, peer: EntityId): Work => {
  const account = w.state.accounts.get(peer);
  if (account === undefined || account.refused.length === 0) return w;
  const cleared = withReplica(w, peer, { ...account, refused: [] });
  return account.refused.reduce((acc, refused) => noting(acc, { _tag: "tx_refused", peer, refused }), cleared);
};

const arrivalsOf = (inputs: readonly EntityInput[]): readonly Arrival[] =>
  inputs.flatMap((i) => (i._tag === "peer_message" ? [i] : []));

const hooksOf = (inputs: readonly EntityInput[]): readonly Hook[] =>
  inputs.flatMap((i) => (i._tag === "resend_due" ? [i] : []));

const commandsOf = (inputs: readonly EntityInput[]): readonly Command[] =>
  inputs.flatMap((i) => (i._tag === "peer_message" || i._tag === "resend_due" ? [] : [i]));

/** The frame: arrivals, then hooks, then commands, then proposals, then the refusals the Accounts hold are told. */
export const entityFrame = (judge: Judge, state: EntityState, inputs: readonly EntityInput[]): Frame => {
  const rules = accountRules(judge);
  const arrived = arrivalsOf(inputs).reduce((w, a) => arrive(rules, w, a), start(state));
  const afterHooks = hooksOf(inputs).reduce(hooked, arrived);
  const afterCommands = commandsOf(inputs).reduce((w, c) => commanded(rules, w, c), afterHooks);
  const proposed = proposalOrder(afterCommands).reduce((w, peer) => proposing(rules, w, peer), afterCommands);
  const done = [...proposed.state.accounts.keys()].toSorted().reduce(told, proposed);
  return { state: done.state, outputs: done.outputs, notices: done.notices };
};
