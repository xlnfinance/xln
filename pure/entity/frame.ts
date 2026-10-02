// One Entity frame (spec/entity/frame.scm): the inputs of the frame are folded in four phases over one view of every
// Account, and the Accounts then propose. The phases are the only order there is: where an arrival sits among the
// frame's commands does not matter, and a command always sees what the arrivals of its own frame did (R-E1).
import { mapDelete, mapSet } from "../kernel/core/collections.ts";
import { emptyReplica } from "../account/frame/account.ts";
import type { JHeight, JView } from "../account/clause/clock.ts";
import {
  propose, receive, resend, submit, type FrameHash, type Heard, type Msg, type Outcome,
} from "../account/frame/frame.ts";
import { revealOnChainDue } from "../account/clause/clock.ts";
import type { AccountState, Side } from "../account/model.ts";
import { proofBodyOf, type ProofTerms } from "../account/proof/body.ts";
import { proofBodyHash, type ProofBody } from "../chain/proof/proof.ts";
import type { Check } from "./signing/attest.ts";
import { signingOf, type Anchor } from "./signing/signing.ts";
import { dissolved, holderOf, ledgerOf, rebased, withHeld } from "../account/state.ts";
import { MAX_AMOUNT } from "../account/ledger.ts";
import {
  answered, cosignFrozen, cosignLapsed, counterLapsed, countered, depositable, disputeAsked, disputeOpened, disputeOver,
  epochAdvanced, framed, freshChain, inDispute, keepHolding, nextSerial, paidOut, proofNonce, quiet, startLapsed,
  windowOpened, windowOver, withWindows,
} from "./chain.ts";
import { entityRules, type EntityRules } from "./rules.ts";
import { hashlocksOf, intentFor, learned, revealed, revealedBy, withEntry, type Intent } from "./paybook/paybook.ts";
import { askedOf, cosignFault, foldsOf, withdrawalOf } from "./cosign.ts";
import type { AccountTx, Judge } from "../account/tx.ts";
import {
  sideOf, type AccountCommand, type Arrival, type ChainCommand, type ChainFacts, type Command, type CosignAsk,
  type DisputeCounter, type DisputeStart, type Registered, type EntityFault, type Entry, type EntityId,
  type EntityInput, type EntityReplica, type EntityState, type Hook, type JAction, type JEvent, type Notice,
  type Outbound,
  type PaybookCommand, type PeerFault, type PeerMessage, type PeerProof, type SecretRevealed,
} from "./model.ts";

export type Frame = Readonly<{
  state: EntityState; outputs: readonly Outbound[]; notices: readonly Notice[]; chain: readonly JAction[];
}>;

/** The rules `peer`'s Account is judged by in the frame so far: they change when the node's signature goes out. */
type Rulebook = (w: Work, peer: EntityId) => EntityRules;

/** A frame in progress: what it has built so far, and which Accounts a command has touched, in order. */
type Work = Readonly<{
  state: EntityState; outputs: readonly Outbound[]; notices: readonly Notice[]; chain: readonly JAction[];
  touched: readonly EntityId[];
}>;

const start = (state: EntityState): Work => ({ state, outputs: [], notices: [], chain: [], touched: [] });

const noting = (w: Work, notice: Notice): Work => ({ ...w, notices: [...w.notices, notice] });

/** The head a message commits its sender to, for the Host to sign: a frame's, the pending one's, and an ack's. */
const attestOf = (account: EntityReplica | undefined, msg: Msg<AccountTx>): FrameHash | undefined => {
  switch (msg._tag) {
    case "frame": return account?.pending?.head;
    case "ack": return msg.hash;
    case "refusal": return undefined;
  }
};

const sending = (w: Work, to: EntityId, msgs: readonly Msg<AccountTx>[]): Work => {
  const account = w.state.accounts.get(to);
  const outbound = (msg: Msg<AccountTx>): Outbound => {
    const attest = attestOf(account, msg);
    return attest === undefined ? { from: w.state.id, to, msg } : { from: w.state.id, to, msg, attest };
  };
  return { ...w, outputs: [...w.outputs, ...msgs.map(outbound)] };
};

const withReplica = (w: Work, peer: EntityId, r: EntityReplica): Work =>
  ({ ...w, state: { ...w.state, accounts: mapSet(w.state.accounts, peer, r) } });

const touching = (w: Work, peer: EntityId): Work =>
  (w.touched.includes(peer) ? w : { ...w, touched: [...w.touched, peer] });

// ---- phase 1: arrivals

/** A refusal the sender is owed a notice for; a stale ack and a kept own frame are the round working. */
const refusal = (outcome: Outcome<PeerFault>): Outcome<PeerFault> | undefined => {
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
const waitingForJ = (w: Work, peer: EntityId, view: JView, heard: Heard<AccountTx, AccountState, PeerFault>): Work =>
  (heard.outcome._tag === "rolled_back" && heard.replica.mempool.length > 0
    ? { ...w, state: { ...w.state, waiting: mapSet(w.state.waiting, peer, view) } }
    : w);

const asked = (w: Work, action: JAction): Work => ({ ...w, chain: [...w.chain, action] });

const factsOf = (w: Work, peer: EntityId): ChainFacts => w.state.chain.get(peer) ?? freshChain;

const withFacts = (w: Work, peer: EntityId, facts: ChainFacts): Work =>
  ({ ...w, state: { ...w.state, chain: mapSet(w.state.chain, peer, facts) } });

/**
 * A frame is co-signed when the peer's frame is taken or my own is acked: one more proof of the epoch. A frame of mine
 * acked after my view of the chain moved on is committed but was sealed under the old epoch: it is no proof of the new
 * one, and counts for nothing (R-FRAME-EPOCH). A peer's frame is taken only under my own view. (Within an epoch the
 * stored nonce, and so the first nonce, does not change: a report of the same epoch is ignored.)
 */
const cosigned = (outcome: Outcome<PeerFault>, own: EntityReplica["pending"], facts: ChainFacts): boolean =>
  outcome._tag === "accepted" || outcome._tag === "accepted_over_own"
  || (outcome._tag === "committed_own" && own?.frame.epoch === facts.epoch);

/**
 * A frame of the peer that was taken tells the paybook what the peer answered to the locks made to it. A frame refused
 * as frozen (an Account in dispute refuses every frame its peer proposes) still shows the secrets of its resolves: a
 * secret proves itself by its hash, and the hub that holds the lock upstream must not lose it to the freeze
 * (R-DISPUTE-FREEZE). A frame refused for any other fault is no news.
 */
const takenFrom = (w: Work, a: PeerMessage, outcome: Outcome<PeerFault>): Work => {
  if (a.msg._tag !== "frame") return w;
  const { txs } = a.msg.frame;
  const book = w.state.paybook;
  if (outcome._tag === "accepted" || outcome._tag === "accepted_over_own") {
    return { ...w, state: { ...w.state, paybook: learned(book, a.from, txs) } };
  }
  const frozen = outcome._tag === "refused_invalid" && outcome.fault._tag === "frozen";
  return frozen ? { ...w, state: { ...w.state, paybook: revealedBy(book, txs) } } : w;
};

/** A secret the chain showed (R-DISPUTE-FREEZE): to the paybook it is the resolve of the payee, on any Account. */
const secretShown = (w: Work, e: SecretRevealed): Work =>
  ({ ...w, state: { ...w.state, paybook: revealed(w.state.paybook, e.secret) } });

/** The side whose frame made the head the round took: mine when the peer's ack committed it, the peer's otherwise. */
const authorOf = (heard: Heard<AccountTx, AccountState, PeerFault>): Side => {
  const mine = heard.replica.side;
  if (heard.outcome._tag === "committed_own") return mine;
  return mine === "left" ? "right" : "left";
};

/** The round took the head the message commits its sender to: a frame of the peer's, or the ack of my own. */
const committed = (outcome: Outcome<PeerFault>): boolean =>
  outcome._tag === "accepted" || outcome._tag === "accepted_over_own" || outcome._tag === "committed_own";

/**
 * R-SIGNED-HEADS-ON-THE-WIRE: a head is committed only with its peer's signature on it, checked against the head this
 * Entity computed itself, so a signature over another head, another Account or another epoch is no signature here.
 */
const unsigned = (check: Check, a: PeerMessage, head: FrameHash): "missing" | "wrong" | undefined => {
  if (a.sig === undefined) return "missing";
  return check(a.from, head, a.sig) ? undefined : "wrong";
};

const withProof = (w: Work, peer: EntityId, proof: PeerProof): Work =>
  ({ ...w, state: { ...w.state, proofs: mapSet(w.state.proofs, peer, proof) } });

/**
 * R-LEDGER-REBASE: the peer's signature over a head is a proof only if the frame that made the head was sealed in the
 * epoch this node signs in now. The ack of a pending frame of mine that commits after the epoch moved is the peer's
 * signature over a head of the voided epoch: the head stays (the lineage goes on), the proof is not kept, since a
 * dispute from it would only revert. A frame of the peer's is judged only in my own epoch, so it is always current.
 */
const sealedNow = (rules: EntityRules, outcome: Outcome<PeerFault>, pending: EntityReplica["pending"]): boolean =>
  outcome._tag !== "committed_own"
  || (pending !== undefined && pending.frame.epoch === rules.epoch && pending.frame.firstNonce === rules.firstNonce);

/**
 * R-DISPUTE-FREEZE: the ack of a frame of mine that was sealed before the dispute commits nothing while the dispute is
 * open: the head stays the one the dispute rests on. The frame stays pending (the peer, which committed it, is told
 * again at the epoch that follows, and a frame the new epoch does not accept is sealed anew like any other).
 */
const ackedInDispute = (w: Work, a: PeerMessage): boolean =>
  a.msg._tag === "ack" && inDispute(factsOf(w, a.from));

const hearing = (rules: Rulebook, check: Check, view: JView, w: Work, a: PeerMessage): Work => {
  const account = w.state.accounts.get(a.from);
  if (account === undefined) return noting(w, { _tag: "unknown_peer", from: a.from });
  if (ackedInDispute(w, a)) return w;
  const rule = rules(w, a.from);
  const heard = receive(rule, account, a.msg);
  const head = heard.replica.head;
  const why = committed(heard.outcome) ? unsigned(check, a, head) : undefined;
  if (why !== undefined) return noting(w, { _tag: "message_unsigned", from: a.from, head, why });
  const refused = refusal(heard.outcome);
  const heardBy = sending(withReplica(w, a.from, heard.replica), a.from, heard.sent);
  const waiting = waitingForJ(heardBy, a.from, view, heard);
  const facts = factsOf(waiting, a.from);
  const counted = cosigned(heard.outcome, account.pending, facts) ? withFacts(waiting, a.from, framed(facts)) : waiting;
  const taken = takenFrom(counted, a, heard.outcome);
  const proved = committed(heard.outcome) && a.sig !== undefined && sealedNow(rule, heard.outcome, account.pending)
    ? withProof(taken, a.from, { head, slot: heard.replica.used, author: authorOf(heard), sig: a.sig })
    : taken;
  return refused === undefined ? proved : noting(proved, { _tag: "message_refused", from: a.from, outcome: refused });
};

/**
 * Every token the Account has a ledger for takes what the chain holds for it, on the committed state and on the state a
 * pending frame of mine would commit, so that the ack of that frame does not bring the old amounts back. Neither is in
 * a proof, so the peer's own copy may be a step behind without a signature differing; its refusals are what pace
 * the two views. A token the Account has no ledger for is not given one: the token list is in the proof, and only a
 * frame both sides signed changes it (R-J-COLLATERAL-NO-LEDGER).
 */
const reconciled = (w: Work, peer: EntityId): Work => {
  const account = w.state.accounts.get(peer);
  const held = factsOf(w, peer).held;
  return account === undefined ? w : withReplica(w, peer, {
    ...account,
    state: withHeld(account.state, held),
    pending: account.pending === undefined
      ? undefined
      : { ...account.pending, after: withHeld(account.pending.after, held) },
  });
};

/**
 * R-LEDGER-REBASE: the chain moved the Account's epoch on, so every proof of the old epoch is void and offdelta counts
 * from zero. The committed state and the state a pending frame of mine would commit both restart there, so the ack of
 * a frame the peer committed before it heard of the move brings no old offdelta back, and the peer, which rebases the
 * same way when it hears, holds the same ledger. The frame itself stays: it commits if the peer re-acks it, and is
 * taken back and sealed again under the new epoch if the peer refuses it as another epoch's. The peer's signature over
 * a head of the old epoch names a void epoch, so it is forgotten: a dispute from it would only revert.
 */
const rebasing = (w: Work, peer: EntityId, finalized: Finalized | undefined): Work => {
  const account = w.state.accounts.get(peer);
  const forgot = { ...w, state: { ...w.state, proofs: mapDelete(w.state.proofs, peer) } };
  if (account === undefined) return forgot;
  const told = destroyed(forgot, peer, account, finalized);
  // The txs the chain paid are in no frame the node seals again: not in the pending frame (it gives back only the rest
  // if it is rolled back), not in the mempool.
  const settled = finalized?.paid?.txs ?? [];
  const inFrame = withoutPaid(account.pending?.frame.txs ?? [], settled);
  const inQueue = withoutPaid(account.mempool, withoutPaid(settled, inFrame.removed).kept);
  return withReplica(told, peer, {
    ...account,
    state: rebased(account.state),
    mempool: inQueue.kept,
    pending: account.pending === undefined ? undefined : {
      ...account.pending, after: rebased(account.pending.after),
      ...(settled.length === 0 ? {} : { owed: inFrame.kept }),
    },
  });
};

/**
 * The proof a dispute finalize paid by: its nonce (unknown when no proof the node can name has the hash the chain
 * logged), the epoch it moved to, the nonce of the node's own head, and the nonce its pending frame would have signed
 * (all under the epoch that ended).
 */
type Finalized = Readonly<{
  nonce: bigint | undefined; epoch: bigint; committed: bigint | undefined; pending: bigint | undefined;
  paid: Paid | undefined;
}>;

/** The frame of its own the node signed that the chain paid by, as the one lookup that names the nonce finds it. */
type Paid = Readonly<{ nonce: bigint; txs: readonly AccountTx[] }>;

/**
 * A proof the node can name: the nonce it was signed at and the hash of its body. `own` marks the node's own committed
 * state, the state its pending frame would commit and the state of each frame it signed and then rolled back, with the
 * txs of the frame (the peer holds the signature of a rolled-back frame as it does of any other, R-SIGNED-IS-LIVE).
 */
type Named = Readonly<{
  nonce: bigint | undefined; hash: string | undefined; own?: "committed" | "pending" | "signed";
  txs?: readonly AccountTx[] | undefined;
}>;

const hashOf = (body: ProofBody): string | undefined => {
  const hash = proofBodyHash(body);
  return hash.ok ? hash.value : undefined;
};

const stateHash = (terms: ProofTerms, state: AccountState): string | undefined => {
  const body = proofBodyOf(terms, state);
  return body.ok ? hashOf(body.value) : undefined;
};

/**
 * Every proof the node can name for its Account with `peer`, in the order a hash found twice is read: the counter the
 * chain registered against its own start (a state it may not hold), the proof the peer's dispute opened with
 * (likewise), its committed state, the state its pending frame would commit and the state of every frame it signed in
 * this epoch that no commit has superseded (a frame the peer refused and the node took back is one). A dispute the
 * node started opened with its committed state and its own counter was built from it: the freeze commits nothing after
 * either (R-DISPUTE-FREEZE).
 */
const proofsKnown = (terms: ProofTerms, facts: ChainFacts, account: EntityReplica): readonly Named[] => {
  const { starting, against } = facts;
  const pending = account.pending;
  return [
    { nonce: starting?.countered?.nonce, hash: starting?.countered?.bodyHash },
    { nonce: against?.nonce, hash: against?.bodyHash },
    { nonce: proofNonce(facts, account.used), hash: stateHash(terms, account.state), own: "committed" },
    {
      nonce: pending === undefined ? undefined : pending.frame.firstNonce + BigInt(pending.frame.slot) - 1n,
      hash: pending === undefined ? undefined : stateHash(terms, pending.after),
      own: "pending", txs: pending?.frame.txs,
    },
    ...account.unsuperseded.flatMap((entry): readonly Named[] => {
      const { sealed } = entry;
      if (sealed === undefined || sealed.epoch !== facts.epoch || entry.slot === pending?.frame.slot) return [];
      return [{
        nonce: sealed.firstNonce + BigInt(entry.slot) - 1n, hash: stateHash(terms, sealed.after), own: "signed",
        txs: entry.txs,
      }];
    }),
  ];
};

/**
 * The finalize that moved the epoch on, when it was one: a dispute was open on the Account, and a settlement or a C2R
 * is reverted by the chain while one is, so no other path moves the epoch then. The chain logs the hash of the body of
 * the proof it paid by (`DisputeFinalized.finalProofbodyHash`, Depository.sol 142-148) and the Host carries it on the
 * epoch event; the nonce is that of the proof the node holds or remembers with the same hash: the opening proof, the
 * counter the chain registered, or a state of its own (a proof of its own that the peer finalized with). No
 * proof with that hash is a nonce unknown, told as such, never guessed from the nonce the chain stores: a timeout
 * stores the opening nonce plus one but a signed finalize stores its own, and the logs of the two do not differ.
 */
const finalizedBy = (
  w: Work, terms: ProofTerms, facts: ChainFacts, e: Extract<JEvent, { _tag: "j_epoch" }>,
): Finalized | undefined => {
  if (!inDispute(facts)) return undefined;
  const account = w.state.accounts.get(e.peer);
  const hash = e.finalBodyHash?.toLowerCase();
  const matched = account === undefined || hash === undefined
    ? []
    : proofsKnown(terms, facts, account).filter((proof) => proof.hash?.toLowerCase() === hash);
  // A frame of the node's own whose state has the committed state's body adds nothing a proof holds (a quote is no
  // clause until it is filled): the chain paid nothing of it, and it does not name the proof.
  const neutral = matched.some((proof) => proof.own === "committed")
    && matched.some((proof) => proof.own === "pending" || proof.own === "signed");
  const named = neutral ? matched.filter((proof) => proof.own === undefined || proof.own === "committed") : matched;
  const byNonce = (x: Named, y: Named): number => ((x.nonce ?? -1n) < (y.nonce ?? -1n) ? 1 : -1);
  const [top] = named.toSorted(byNonce);
  const [ownTop] = named.filter((proof) => proof.own === "pending" || proof.own === "signed").toSorted(byNonce);
  return {
    nonce: top?.nonce, epoch: e.epoch, committed: proofNonce(facts, account?.used ?? 0),
    paid: ownTop?.nonce === undefined ? undefined : { nonce: ownTop.nonce, txs: ownTop.txs ?? [] },
    pending: account?.pending === undefined
      ? undefined
      : account.pending.frame.firstNonce + BigInt(account.pending.frame.slot) - 1n,
  };
};

/**
 * R-DISPUTE-FREEZE: a finalize moved the epoch on and the rebase zeroes offdelta. If the committed head is above the
 * proof the finalize paid by (a frame the proof does not hold: one committed after the proof was signed, or sealed
 * before the dispute and acked after it), each token is told to the node's owner with both nonces and the offdelta the
 * node counted. A frame of the node's own still pending that carries a payment, a lock, an offer or a fill the peer may
 * have committed before it heard of the dispute is not held by the proof either, and the rebase zeroes what it paid, so
 * the node is told which (`pending_rebased`): the frame stays pending and is sent again in the new epoch, where it
 * commits or comes back as `tx_refused`, so the owner waits and does not ask again. A pending frame whose own body the
 * chain paid by, a frame it signed and took back included (the peer holds its signature as well), is paid: the owner is
 * told so (`paid_on_chain`) and its txs are in no frame sealed again (the pending frame stays for the lineage the peer
 * may have committed, giving back only what was not paid). A committed head at or below the
 * finalized nonce is held by the proof the chain paid by: not told. A finalize whose proof the node cannot name is told
 * with the finalized nonce unknown: the node does not guess whether its head was held. A settlement or a withdrawal
 * moving the epoch tells nothing. The offdelta the proof holds is not here: the node that lost something is not the
 * one that opened with the proof, so it holds none of its body, and the DisputeFinalized event carries only hashes
 * (Depository.sol 142-148); it is owed from the calldata of the start or the counter.
 */
const lost = (head: bigint | undefined, paid: bigint | undefined): boolean =>
  head !== undefined && (paid === undefined || head > paid);

const SPENDING = new Set(["pay", "lock", "offer", "fill"]);

const destroyed = (w: Work, peer: EntityId, account: EntityReplica, finalized: Finalized | undefined): Work => {
  if (finalized === undefined) return w;
  const { committed, nonce, epoch, pending, paid } = finalized;
  const told = !lost(committed, nonce) || committed === undefined
    ? w
    : [...account.state.ledgers].reduce((acc, [token, l]) => noting(acc, {
      _tag: "offdelta_rebased", peer, token, epoch, committedNonce: committed, offdelta: l.offdelta,
      finalizedNonce: nonce,
    }), w);
  const settled = paid?.txs ?? [];
  const spent = settled.filter((tx) => SPENDING.has(tx._tag));
  const paidTold = paid === undefined || spent.length === 0
    ? told
    : noting(told, {
      _tag: "pending_rebased", peer, epoch, nonce: paid.nonce, finalizedNonce: nonce, txs: spent, fate: "paid_on_chain",
    });
  const txs = withoutPaid(account.pending?.frame.txs ?? [], settled).kept.filter((tx) => SPENDING.has(tx._tag));
  return pending === undefined || !lost(pending, nonce) || txs.length === 0
    ? paidTold
    : noting(paidTold, {
      _tag: "pending_rebased", peer, epoch, nonce: pending, finalizedNonce: nonce, txs, fate: "resent_in_new_epoch",
    });
};

const txKey = (tx: AccountTx): string => JSON.stringify(tx, (_key, v) => (typeof v === "bigint" ? `${v}n` : v));

type Split = Readonly<{
  kept: readonly AccountTx[]; removed: readonly AccountTx[]; owing: ReadonlyMap<string, number>;
}>;

const countOf = (txs: readonly AccountTx[]): ReadonlyMap<string, number> =>
  txs.reduce<ReadonlyMap<string, number>>(
    (acc, tx) => mapSet(acc, txKey(tx), (acc.get(txKey(tx)) ?? 0) + 1), new Map<string, number>());

/**
 * `txs` without one occurrence of each tx the chain paid (`paid`): a payment asked twice is paid once by a frame that
 * held it once. `removed` is what was found in `txs`, so the rest of `paid` is looked for in the next place.
 */
const withoutPaid = (txs: readonly AccountTx[], paid: readonly AccountTx[]): Split =>
  txs.reduce((acc: Split, tx): Split => {
    const left = acc.owing.get(txKey(tx)) ?? 0;
    return left === 0
      ? { ...acc, kept: [...acc.kept, tx] }
      : { ...acc, removed: [...acc.removed, tx], owing: mapSet(acc.owing, txKey(tx), left - 1) };
  }, { kept: [], removed: [], owing: countOf(paid) });

/** The chain's collateral and ondelta for one token, kept; one with no ledger past the cap is told and dropped. */
const holding = (w: Work, e: Extract<JEvent, { _tag: "j_collateral" }>): Work => {
  const ledgered = new Set(w.state.accounts.get(e.peer)?.state.ledgers.keys());
  const amounts = { collateral: e.collateral, ondelta: e.ondelta };
  const kept = keepHolding(factsOf(w, e.peer), e.token, amounts, ledgered);
  return kept === undefined
    ? noting(w, { _tag: "holding_dropped", peer: e.peer, token: e.token })
    : reconciled(withFacts(w, e.peer, kept), e.peer);
};

/**
 * R-LEDGER-REBASE: a finalized dispute paid the Account out: no collateral and no ondelta are held for any token.
 * R-HOLD-DISSOLVE: and it settled every clause of the proof it used, so the Account's holds, quotes and offers are
 * over, in the committed state and in the state a pending frame would commit. A lock this Entity forwarded to `peer`
 * is a lock `peer` gave up, as far as the paybook is concerned, so the failure walks back to its source the usual way.
 */
const finalized = (w: Work, peer: EntityId): Work => {
  const account = w.state.accounts.get(peer);
  const ledgered = account?.state.ledgers.keys() ?? [];
  const given = [...(account?.state.ledgers ?? [])]
    .flatMap(([token, l]) => l.holds.map((h): AccountTx => ({ _tag: "cancel", token, id: h.id })));
  const told = { ...w, state: { ...w.state, paybook: learned(w.state.paybook, peer, given) } };
  const { pending } = account ?? {};
  const open = account === undefined ? told : withReplica(told, peer, {
    ...account,
    state: dissolved(account.state),
    pending: pending === undefined ? undefined : { ...pending, after: dissolved(pending.after) },
  });
  return reconciled(withFacts(open, peer, paidOut(disputeOver(factsOf(w, peer)), ledgered)), peer);
};

/** What the chain did to the Account with `peer`, as the facts the Entity holds for the pair say. */
const chainFact = (w: Work, terms: ProofTerms, e: JEvent): Work => {
  const facts = factsOf(w, e.peer);
  switch (e._tag) {
    case "j_epoch": {
      const moved = epochAdvanced(facts, e.epoch, e.stored);
      return moved === facts ? w : rebasing(withFacts(w, e.peer, moved), e.peer, finalizedBy(w, terms, facts, e));
    }
    case "j_dispute":
      return withFacts(w, e.peer, e.by === sideOf(w.state.id, e.peer)
        ? windowOpened(facts, e.epoch, e.nonce, e.timeout)
        : disputeOpened(facts, e));
    case "j_countered":
      return withFacts(w, e.peer, countered(facts, e));
    case "j_window_over":
      return withFacts(w, e.peer, windowOver(facts));
    case "j_dispute_over":
      return finalized(w, e.peer);
    case "j_start_lapsed":
      return withFacts(w, e.peer, startLapsed(facts, e.nonce));
    case "j_counter_lapsed":
      return withFacts(w, e.peer, counterLapsed(facts, e.nonce));
    case "j_collateral":
      return holding(w, e);
    case "j_op_lapsed":
      return withFacts(w, e.peer, cosignLapsed(facts, e.serial));
    case "j_finalize_unread":
      return noting(w, { _tag: "finalize_unread", peer: e.peer });
  }
};

/**
 * The facts are the chain's, whether or not the Entity holds the Account yet: an Account opened after the chain moved
 * the epoch on signs under that epoch, not under epoch 0 (R-FRAME-EPOCH: a frame of another epoch is parked, and
 * nothing would ever tell the late Entity). An Account the Entity does not hold is told as well.
 */
const observed = (w: Work, terms: ProofTerms, e: JEvent): Work => {
  const kept = chainFact(w, terms, e);
  return w.state.accounts.has(e.peer) ? kept : noting(kept, { _tag: "unknown_peer", from: e.peer });
};

/** The node co-signs a peer's ask while no signature of its own waits, and a C2R only with no offdelta to fold. */
const cosigning = (w: Work, a: CosignAsk): Work => {
  const account = w.state.accounts.get(a.from);
  if (account === undefined) return noting(w, { _tag: "unknown_peer", from: a.from });
  const facts = factsOf(w, a.from);
  const fault = cosignFault(account, facts, a.op.amount);
  const action = askedOf({ peer: a.from, serial: nextSerial(facts) }, a.op, foldsOf(account.state));
  if (fault !== undefined) return noting(w, { _tag: "cosign_refused", from: a.from, op: a.op, fault });
  return action.ok
    ? asked(withFacts(w, a.from, cosignFrozen(facts)), action.value)
    : noting(w, { _tag: "cosign_refused", from: a.from, op: a.op, fault: action.error });
};

const arrive = (rules: Rulebook, terms: ProofTerms, check: Check, view: JView, w: Work, a: Arrival): Work => {
  switch (a._tag) {
    case "peer_message":
      return hearing(rules, check, view, w, a);
    case "cosign_ask":
      return cosigning(w, a);
    case "j_secret":
      return secretShown(w, a);
    default:
      return observed(w, terms, a);
  }
};

// ---- phase 2: hooks

const hooked = (w: Work, hook: Hook): Work => {
  const account = w.state.accounts.get(hook.peer);
  return account === undefined || inDispute(factsOf(w, hook.peer)) ? w : sending(w, hook.peer, resend(account));
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

/** The tx a command asks its Account for; an offer's maker is this node's side, whatever a caller would like. */
const txOf = (self: Side, command: AccountCommand): AccountTx => {
  switch (command._tag) {
    case "pay":
      return { _tag: "pay", token: command.token, amount: command.amount };
    case "set_credit":
      return { _tag: "set_credit", token: command.token, limit: command.limit };
    case "lock":
      return command.route === undefined || command.route.length === 0
        ? { _tag: "lock", token: command.token, hold: command.hold }
        : { _tag: "lock", token: command.token, hold: command.hold, route: command.route };
    case "resolve":
      return { _tag: "resolve", token: command.token, id: command.id, secret: command.secret };
    case "cancel":
      return { _tag: "cancel", token: command.token, id: command.id };
    case "expire":
      return { _tag: "expire", token: command.token, id: command.id };
    case "offer":
      return {
        _tag: "offer",
        offer: { id: command.id, maker: self, give: command.give, want: command.want, deadline: command.deadline },
      };
    case "fill":
      return { _tag: "fill", id: command.id, ratio: command.ratio };
    case "retract":
      return { _tag: "retract", id: command.id };
    case "lapse":
      return { _tag: "lapse", id: command.id };
  }
};

/** A command that takes on value or exposure; a release (a resolve, a cancel, an expire) is not one. */
const commits = (command: AccountCommand): boolean =>
  command._tag === "pay" || command._tag === "lock" || command._tag === "offer" || command._tag === "fill";

/**
 * The Account checks the tx against its planning state at the door (R-ADMIT); a refusal is the command's notice. While
 * a dispute is open the Account seals nothing (R-DISPUTE-FREEZE), so a command that takes on value is refused back to
 * whoever asked, not queued to be voided by the epoch move; a release waits in the queue for the new epoch.
 */
const queued = (rules: Rulebook, w: Work, command: AccountCommand): Work => {
  const account = w.state.accounts.get(command.peer);
  if (account === undefined) return refusedCommand(w, command, { _tag: "no_account", peer: command.peer });
  if (commits(command) && inDispute(factsOf(w, command.peer))) {
    return refusedCommand(w, command, { _tag: "account_disputed" });
  }
  const admitted = submit(rules(w, command.peer), account, txOf(sideOf(w.state.id, command.peer), command));
  return admitted.ok
    ? touching(withReplica(w, command.peer, admitted.value), command.peer)
    : refusedCommand(w, command, { _tag: "account_refused", fault: admitted.error });
};

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

/** The node's own withdrawal: it co-signs it as it sends it, so the Account proposes nothing until it lands. */
const withdrawn = (w: Work, command: Extract<ChainCommand, { _tag: "withdraw" }>): Work => {
  const { peer, token, amount } = command;
  const account = w.state.accounts.get(peer);
  const facts = factsOf(w, peer);
  const fault = account === undefined ? undefined : cosignFault(account, facts, amount);
  if (account === undefined || fault !== undefined) {
    return refusedCommand(w, command, fault ?? { _tag: "no_account", peer });
  }
  const op = withdrawalOf({ peer, serial: nextSerial(facts) }, token, amount, foldsOf(account.state));
  return asked(withFacts(w, peer, cosignFrozen(facts)), op);
};

/** The node's own tokens into its reserve: it names no peer and needs no Account, so it asks the chain at once. */
const funded = (w: Work, command: Extract<ChainCommand, { _tag: "fund" }>): Work => {
  const { token, amount } = command;
  return amount >= 1n && amount <= MAX_AMOUNT
    ? asked(w, { _tag: "fund", token, amount })
    : refusedCommand(w, command, { _tag: "bad_fund", amount });
};

/**
 * A dispute from the newest head the peer signed that the Account committed: everything the chain's dispute start
 * holds, from the Account's state and the proof the Entity keeps (R-SIGNED-HEADS-ON-THE-WIRE). Without such a proof,
 * or when the state cannot be signed as a proof, there is nothing to start with.
 */
const disputed = (w: Work, terms: ProofTerms, command: Extract<ChainCommand, { _tag: "dispute" }>): Work => {
  const { peer } = command;
  const facts = factsOf(w, peer);
  if (inDispute(facts)) return refusedCommand(w, command, { _tag: "dispute_pending" });
  const account = w.state.accounts.get(peer);
  const proof = w.state.proofs.get(peer);
  const nonce = proofNonce(factsOf(w, peer), account?.used ?? 0);
  if (account === undefined || proof === undefined || proof.head !== account.head || nonce === undefined) {
    return refusedCommand(w, command, { _tag: "no_proof", why: "none" });
  }
  const body = proofBodyOf(terms, account.state);
  if (!body.ok) return refusedCommand(w, command, { _tag: "no_proof", why: "unsignable" });
  const start: DisputeStart = {
    peer, nonce, epoch: factsOf(w, peer).epoch, proposerIsLeft: proof.author === "left", body: body.value,
    sig: proof.sig,
  };
  return withFacts(asked(w, { _tag: "dispute_start", ...start }), peer, disputeAsked(factsOf(w, peer), start));
};

/** A command about the chain needs an Account with the peer, as an Account command does. */
const chained = (w: Work, terms: ProofTerms, command: Exclude<ChainCommand, { _tag: "fund" }>): Work => {
  const { peer } = command;
  if (!w.state.accounts.has(peer)) return refusedCommand(w, command, { _tag: "no_account", peer });
  switch (command._tag) {
    case "deposit":
      return deposited(w, command);
    case "set_windows":
      return windowed(w, command);
    case "withdraw":
      return withdrawn(w, command);
    case "dispute":
      return disputed(w, terms, command);
  }
};

/** The paybook takes an entry for a hashlock it has none for: a second one is the caller's mistake, told. */
const prepared = (w: Work, command: PaybookCommand): Work => {
  if (w.state.paybook.has(command.hashlock)) {
    return refusedCommand(w, command, { _tag: "entry_exists", hashlock: command.hashlock });
  }
  const entry: Entry = command._tag === "forward"
    ? { _tag: "forward", from: command.from, to: command.to, route: [] }
    : { _tag: "receive", from: command.from, token: command.token, amount: command.amount, secret: command.secret };
  return { ...w, state: { ...w.state, paybook: withEntry(w.state.paybook, command.hashlock, entry) } };
};

const commanded = (rules: Rulebook, terms: ProofTerms, w: Work, command: Command): Work => {
  switch (command._tag) {
    case "open_account":
      return opened(w, command);
    case "fund":
      return funded(w, command);
    case "deposit":
    case "set_windows":
    case "withdraw":
    case "dispute":
      return chained(w, terms, command);
    case "forward":
    case "expect":
      return prepared(w, command);
    default:
      return queued(rules, w, command);
  }
};

// ---- phase 3b: the paybook

/** One step of the paybook through the Account's door: the entry that stands is the one the door's answer picks. */
const intended = (rules: Rulebook, w: Work, i: Intent): Work => {
  const done = queued(rules, w, i.command);
  const entry = done.notices.length > w.notices.length ? i.refused : i.admitted;
  return { ...done, state: { ...done.state, paybook: withEntry(done.state.paybook, i.hashlock, entry) } };
};

/**
 * What the paybook owes now, asked of the Accounts before they propose, one entry at a time against the state the
 * entry before it left, so that two payments to one next hop in a frame take two slots. Two rounds: a lock the door
 * refuses makes a `fail` entry, which the second round turns into a cancel of the lock it was forwarding.
 */
const forwarding = (rules: Rulebook, judge: Judge) => (w: Work): Work => {
  const step = (inner: Work, hashlock: string): Work => {
    const i = intentFor(inner.state, judge.clock, judge.view, hashlock);
    return i === undefined ? inner : intended(rules, inner, i);
  };
  const round = (acc: Work): Work => hashlocksOf(acc.state).reduce(step, acc);
  return round(round(w));
};

// ---- phase 4: proposals

/** The Accounts a command touched, in first-touch order, then every other Account by id (R-E4). */
const proposalOrder = (w: Work): readonly EntityId[] => {
  const rest = [...w.state.accounts.keys()].filter((peer) => !w.touched.includes(peer)).toSorted();
  return [...w.touched, ...rest];
};

/** An Account that waits for its view of J to move proposes nothing until the view is above the one it waited at. */
const paced = (w: Work, view: JView, peer: EntityId, account: EntityReplica): boolean => {
  const since = w.state.waiting.get(peer);
  return since !== undefined && account.attempt > 0 && view <= since;
};

const proposing = (rules: Rulebook, view: JView, w: Work, peer: EntityId): Work => {
  const account = w.state.accounts.get(peer);
  if (account === undefined || paced(w, view, peer, account) || quiet(factsOf(w, peer))) return w;
  const proposed = propose(rules(w, peer), account);
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
const unackedResolves = (account: EntityReplica): readonly Resolve[] =>
  [...(account.pending?.frame.txs ?? []), ...account.mempool].flatMap((tx) => (tx._tag === "resolve" ? [tx] : []));

type Asked = Readonly<{ hashlocks: readonly string[]; actions: readonly JAction[] }>;

/**
 * A payee with an unacked resolve reveals once its view is within LAG of the deadline, once per hashlock. On an Account
 * that is quiet (a dispute is open, or its signature is out) no frame is sealed, so the resolve cannot be acked there:
 * it reveals as soon as the resolve is asked, instead of waiting for a deadline the reveal might not reach in time.
 */
const asking = (due: (deadline: JHeight) => boolean, peer: EntityId, account: EntityReplica) =>
  (acc: Asked, tx: Resolve): Asked => {
    const hold = ledgerOf(account.state, tx.token).holds.find((h) => h.id === tx.id);
    if (hold === undefined || acc.hashlocks.includes(hold.hashlock)) return acc;
    const { token, id, secret } = tx;
    const reveal: JAction = { _tag: "reveal", peer, token, id, hashlock: hold.hashlock, secret };
    return due(hold.deadline)
      ? { hashlocks: [...acc.hashlocks, hold.hashlock], actions: [...acc.actions, reveal] }
      : acc;
  };

/**
 * The counter to a dispute the peer started against me: the newest proof I hold, if the chain would rank it above the
 * one the dispute opened with (a higher nonce, or the same nonce authored by Left over Right's). My head must be the
 * one the peer signed, and its body is what my committed state signs as (the same rule as a start).
 */
const counterOf = (w: Work, terms: ProofTerms, peer: EntityId, account: EntityReplica): DisputeCounter | undefined => {
  const facts = factsOf(w, peer);
  const proof = w.state.proofs.get(peer);
  const nonce = proofNonce(facts, account.used);
  const against = facts.against;
  if (against === undefined || proof === undefined || nonce === undefined || proof.head !== account.head) {
    return undefined;
  }
  const left = proof.author === "left";
  const newer = nonce > against.nonce || (nonce === against.nonce && left && !against.proposerIsLeft);
  const body = proofBodyOf(terms, account.state);
  return newer && body.ok
    ? {
      peer, nonce, head: account.head, proposerIsLeft: left, body: body.value, sig: proof.sig,
      initial: { nonce: against.nonce, bodyHash: against.bodyHash },
    }
    : undefined;
};

/**
 * While a dispute the peer started is open against me, I counter it once with the newest proof I hold, and remember
 * what I asked. The Host de-duplicates what is asked again, so each frame restates the counter until the chain says it
 * registered: a batch the chain reverted or a Host that crashed cannot leave the dispute unanswered for good. A dispute
 * that opened with the newest proof I hold has nothing newer to be answered with.
 */
const answering = (terms: ProofTerms) => (w: Work, peer: EntityId, account: EntityReplica): Work => {
  const against = factsOf(w, peer).against;
  if (against === undefined) return w;
  if (against.answer !== undefined) {
    return against.answer.registered || against.answer.lapsed
      ? w
      : asked(w, { _tag: "counter", ...against.answer.counter });
  }
  const counter = counterOf(w, terms, peer, account);
  if (counter === undefined) return w;
  const answer = answered(factsOf(w, peer), { counter, registered: false, lapsed: false });
  return asked(withFacts(w, peer, answer), { _tag: "counter", ...counter });
};

/**
 * The body of the counter the chain registered against a dispute I started, when I can rebuild it: one of the states
 * I hold (the committed one, or the one a frame of mine in flight would commit) whose proof body has the hash the chain
 * logged. The counterer's newest state is often exactly that frame, which I proposed and it committed before my ack
 * reached it. A body I cannot rebuild is not guessed: the chain would revert a finalize that names another.
 */
const rebuilt = (terms: ProofTerms, account: EntityReplica, counter: Registered): ProofBody | undefined => {
  const states = [account.state, ...(account.pending === undefined ? [] : [account.pending.after])];
  const bodies = states.flatMap((state) => {
    const body = proofBodyOf(terms, state);
    return body.ok ? [body.value] : [];
  });
  return bodies.find((body) => {
    const hash = proofBodyHash(body);
    return hash.ok && hash.value === counter.bodyHash;
  });
};

/**
 * Once the chain's clock is past the window of a dispute, the node that holds its outcome asks to finalize. For a
 * dispute it started that is its opening proof, unless the chain registered a counter (which the chain then finalizes
 * only with its own proof); then it finalizes with that counter when it can rebuild its body, so a counterer that is
 * down leaves the Account no more locked than one that is up (the chain lets either party execute the selected counter
 * after the window). For one it answered, its registered counter. Like the counter it is asked again at each frame
 * until the chain says the dispute is over: the Host de-duplicates, and the chain skips a finalize of a dispute that
 * is already over.
 */
const finalFor = (terms: ProofTerms, w: Work, peer: EntityId, account: EntityReplica): readonly JAction[] => {
  const facts = factsOf(w, peer);
  const mine = sideOf(w.state.id, peer) === "left";
  const { start, over, countered } = facts.starting ?? { start: undefined, over: false, countered: undefined };
  const answer = facts.against?.over ? facts.against.answer : undefined;
  if (start !== undefined && over && countered === undefined) {
    return [{
      _tag: "dispute_finalize", peer, nonce: start.nonce, proposerIsLeft: start.proposerIsLeft, body: start.body,
      startedByLeft: mine, initial: undefined,
    }];
  }
  const body = start !== undefined && over && countered !== undefined ? rebuilt(terms, account, countered) : undefined;
  const opening = start === undefined ? undefined : proofBodyHash(start.body);
  if (start !== undefined && countered !== undefined && body !== undefined && opening?.ok === true) {
    return [{
      _tag: "dispute_finalize", peer, nonce: countered.nonce, proposerIsLeft: countered.proposerIsLeft, body,
      startedByLeft: mine, initial: { nonce: start.nonce, bodyHash: opening.value },
    }];
  }
  return answer?.registered === true && facts.against !== undefined
    ? [{
      _tag: "dispute_finalize", peer, nonce: answer.counter.nonce, proposerIsLeft: answer.counter.proposerIsLeft,
      body: answer.counter.body, startedByLeft: !mine, initial: answer.counter.initial,
    }]
    : [];
};

/**
 * A dispute the peer started that opened with a state I hold, with no newer proof to answer it with, is one I may
 * accept at once: the chain lets the non-starter finalize the exact state the starter chose before the window is over,
 * when it has no pull (Account.sol, `_disputeFinalizeInternal`). So a starter that goes down leaves the Account no
 * more locked than one that stays up. The body is rebuilt from the states I hold, and only when its hash is the one the
 * chain logged for the start; a start whose body I cannot rebuild is waited out as before.
 */
const accepting = (terms: ProofTerms, w: Work, peer: EntityId, account: EntityReplica): readonly JAction[] => {
  const { against } = factsOf(w, peer);
  const unanswered = against !== undefined && (against.answer === undefined || against.answer.lapsed);
  const body = against !== undefined && unanswered ? rebuilt(terms, account, against) : undefined;
  return against !== undefined && body !== undefined
    ? [{
      _tag: "dispute_finalize", peer, nonce: against.nonce, proposerIsLeft: against.proposerIsLeft, body,
      startedByLeft: sideOf(w.state.id, peer) !== "left", initial: undefined,
    }]
    : [];
};

/** What the Entity owes the chain on `peer`'s Account; a hashlock whose hold is gone is forgotten. */
const dutiful = (judge: Judge, terms: ProofTerms) => (w: Work, peer: EntityId): Work => {
  const account = w.state.accounts.get(peer);
  if (account === undefined) return w;
  const open = (w.state.revealed.get(peer) ?? []).filter((hashlock) => holderOf(account.state, hashlock) !== undefined);
  const due = (deadline: JHeight): boolean =>
    quiet(factsOf(w, peer)) || revealOnChainDue(judge.clock, deadline, judge.view);
  const asks = unackedResolves(account).reduce(asking(due, peer, account), { hashlocks: open, actions: [] });
  const revealed = mapSet(w.state.revealed, peer, asks.hashlocks);
  const revealing = { ...w, chain: [...w.chain, ...asks.actions], state: { ...w.state, revealed } };
  const countering = answering(terms)(revealing, peer, account);
  const finals = [...finalFor(terms, countering, peer, account), ...accepting(terms, countering, peer, account)];
  return { ...countering, chain: [...countering.chain, ...finals] };
};

const isArrival = (i: EntityInput): i is Arrival =>
  i._tag === "peer_message" || i._tag === "cosign_ask" || i._tag === "j_secret" || i._tag === "j_epoch"
  || i._tag === "j_dispute"
  || i._tag === "j_countered" || i._tag === "j_window_over" || i._tag === "j_dispute_over"
  || i._tag === "j_start_lapsed" || i._tag === "j_counter_lapsed" || i._tag === "j_collateral"
  || i._tag === "j_op_lapsed" || i._tag === "j_finalize_unread";

const arrivalsOf = (inputs: readonly EntityInput[]): readonly Arrival[] => inputs.filter(isArrival);

const hooksOf = (inputs: readonly EntityInput[]): readonly Hook[] =>
  inputs.flatMap((i) => (i._tag === "resend_due" ? [i] : []));

const commandsOf = (inputs: readonly EntityInput[]): readonly Command[] =>
  inputs.flatMap((i) => (isArrival(i) || i._tag === "resend_due" ? [] : [i]));

/**
 * The frame: arrivals, then hooks, then commands, then proposals, then the refusals the Accounts hold are told, then
 * what the Entity owes the chain. Each Account signs in a context of its own, read off the chain facts the Entity holds
 * for it: its key, its epoch and its first nonce (R-FRAME-SIGNATURE-NAMES-ACCOUNT).
 */
export const entityFrame = (
  judge: Judge, anchor: Anchor, state: EntityState, inputs: readonly EntityInput[],
): Frame => {
  const rules: Rulebook = (w, peer) => {
    const facts = factsOf(w, peer);
    return entityRules(judge, signingOf(anchor, w.state.id, peer, facts),
      { self: sideOf(w.state.id, peer), frozen: quiet(facts) });
  };
  const hear = (w: Work, a: Arrival) => arrive(rules, anchor.terms, anchor.check, judge.view, w, a);
  const arrived = arrivalsOf(inputs).reduce(hear, start(state));
  const afterHooks = hooksOf(inputs).reduce(hooked, arrived);
  const afterCommands = commandsOf(inputs).reduce((w, c) => commanded(rules, anchor.terms, w, c), afterHooks);
  const afterPaybook = forwarding(rules, judge)(afterCommands);
  const propose = (w: Work, peer: EntityId): Work => proposing(rules, judge.view, w, peer);
  const proposed = proposalOrder(afterPaybook).reduce(propose, afterPaybook);
  const peers = [...proposed.state.accounts.keys()].toSorted();
  const owing = peers.reduce(dutiful(judge, anchor.terms), peers.reduce(told, stillWaiting(proposed, judge.view)));
  const done = peers.reduce(reconciled, owing);
  return { state: done.state, outputs: done.outputs, notices: done.notices, chain: done.chain };
};
