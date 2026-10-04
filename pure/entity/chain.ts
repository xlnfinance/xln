// What an Entity does with what it knows of the chain for one Account (R-IMPLICIT-NONCE-FROM-CHAIN,
// R-NO-DEPOSIT-BEFORE-COSIGN, R-WINDOWS-NEVER-SHORTEN). The facts come from the Host's events and from the Entity's own
// committed frames; a proof's nonce is read off them and never derived from an earlier proof.
import { mapSet } from "../kernel/core/collections.ts";
import { err, ok, type Result } from "../kernel/core/result.ts";
import { proofBodyHash, type ProofBody } from "../chain/proof/proof.ts";
import { MAX_PROOF_TOKENS } from "../account/proof/body.ts";
import type { TokenId } from "../account/model.ts";
import type { Held } from "../account/state.ts";
import type { Answer, ChainFacts, DisputeStart, EntityFault, JEvent, Registered, Windows } from "./model.ts";

export const freshChain: ChainFacts =
  {
    epoch: 0n, stored: 0n, frames: 0n, windows: undefined, against: undefined, frozen: false, cosigned: 0n,
    held: new Map(), starting: undefined, behind: undefined, lost: false,
  };

/** The Host holds back this Account's events from block `from`: the earliest it ever said stands until it is over. */
export const behindFrom = (f: ChainFacts, from: bigint): ChainFacts =>
  (f.behind !== undefined && f.behind <= from ? f : { ...f, behind: from });

/** The Host has delivered what it held: an Account it can no longer read stays behind (R-WATCH-STALL). */
export const behindOver = (f: ChainFacts): ChainFacts => (f.lost ? f : { ...f, behind: undefined });

/** The Host cannot read the Account's past from block `from` on: behind for good, from the earliest block it said. */
export const accountLost = (f: ChainFacts, from: bigint): ChainFacts => ({ ...behindFrom(f, from), lost: true });

/**
 * The chain moved the epoch on: no proof of the new epoch is signed yet. An older or repeated report changes nothing.
 */
export const epochAdvanced = (f: ChainFacts, epoch: bigint, stored: bigint): ChainFacts =>
  (epoch <= f.epoch ? f : { ...f, epoch, stored, frames: 0n, against: undefined, frozen: false, starting: undefined });

/**
 * What the chain holds for a token, kept as it stands. A token the Account has a ledger for is always kept: the proof
 * already bounds those. The Entity keeps no more than a proof body can carry of the others, so a peer that puts dust in
 * many tokens fills a row each and no more, and cannot crowd out a token with a ledger: the token past the cap is
 * `undefined`, to be told.
 */
export const keepHolding = (
  f: ChainFacts, token: TokenId, held: Held, ledgered: ReadonlySet<TokenId>,
): ChainFacts | undefined => {
  const unledgered = [...f.held.keys()].filter((t) => !ledgered.has(t)).length;
  return ledgered.has(token) || f.held.has(token) || unledgered < MAX_PROOF_TOKENS
    ? { ...f, held: mapSet(f.held, token, held) }
    : undefined;
};

/** One more frame is co-signed in this epoch. */
export const framed = (f: ChainFacts): ChainFacts => ({ ...f, frames: f.frames + 1n });

/** The body the start revealed, kept only if it is the one the chain logged the hash of: nothing else is believed. */
const shown = (e: Extract<JEvent, { _tag: "j_dispute" }>): Readonly<{ body?: ProofBody }> => {
  const hash = e.body === undefined ? undefined : proofBodyHash(e.body);
  return e.body !== undefined && hash?.ok === true && hash.value.toLowerCase() === e.bodyHash.toLowerCase()
    ? { body: e.body }
    : {};
};

/**
 * A dispute the Entity was told without its body (the Host had not the bytes yet) gets the body when the Host tells it
 * again with the bytes read: only the dispute of that nonce and body hash, and only a body that hashes to what the
 * chain logged (so it can only be the one it has, if it has one).
 */
const bodied = (f: ChainFacts, e: Extract<JEvent, { _tag: "j_dispute" }>): ChainFacts => {
  const { against } = f;
  const same = against !== undefined && e.epoch === f.epoch && against.nonce === e.nonce
    && against.bodyHash.toLowerCase() === e.bodyHash.toLowerCase();
  return same && shown(e).body !== undefined
    ? { ...f, against: { ...against, ...shown(e) } }
    : f;
};

/**
 * The peer opened a dispute in the epoch the Entity is in. One in another epoch is not about its proofs, and a repeated
 * report keeps the dispute it first named (with the answer already given to it).
 */
export const disputeOpened = (f: ChainFacts, e: Extract<JEvent, { _tag: "j_dispute" }>): ChainFacts =>
  (e.epoch !== f.epoch || f.against !== undefined
    ? bodied(f, e)
    : {
      ...f,
      against: {
        nonce: e.nonce, proposerIsLeft: e.proposerIsLeft, bodyHash: e.bodyHash, window: e.timeout, over: false,
        answer: undefined, countered: undefined, ...shown(e),
      },
    });

/** The node asked the chain to counter the dispute against it with `answer`: it is asked again until it registers. */
export const answered = (f: ChainFacts, answer: Answer): ChainFacts =>
  (f.against === undefined || f.against.answer !== undefined ? f : { ...f, against: { ...f.against, answer } });

/**
 * The chain registered a counter (its nonce, author and body hash) for the dispute. For a dispute this node
 * started it is a counter against it: it stops asking to finalize with its opening proof, which the chain now
 * refuses, and keeps the counter's identity, which tells a finalize's proof from the others (R-LEDGER-REBASE) and
 * lets the node finalize with it itself once the window is over and it can rebuild the body (the chain lets either
 * party execute it after the window). For one against it, the counter is kept whoever registered it (a watchtower of
 * the node may have, before the node asked for its own), and one that is the one it asked for is registered.
 */
export const countered = (f: ChainFacts, e: Extract<JEvent, { _tag: "j_countered" }>): ChainFacts => {
  const asked = f.against?.answer;
  const ours = asked?.counter;
  const mine = ours !== undefined && ours.nonce === e.nonce && ours.proposerIsLeft === e.proposerIsLeft;
  const against = f.against !== undefined && asked !== undefined && mine
    ? { ...f.against, answer: { ...asked, registered: true } }
    : f.against;
  const registered: Registered = { nonce: e.nonce, proposerIsLeft: e.proposerIsLeft, bodyHash: e.bodyHash };
  return {
    ...f, against: against === undefined ? undefined : { ...against, countered: registered },
    starting: f.starting === undefined ? undefined : { ...f.starting, countered: registered },
  };
};

/**
 * The Host found that the chain will refuse the counter the node asked for, for good (its window is closed, a newer or
 * the same counter is registered, the dispute moved, its signature or hash is void), so it is not restated. A counter
 * the chain holds for a reason that can heal never gets here: the Host drops it for now and the Entity asks again. A
 * counter of another nonce is not the one dropped, and a registered counter is finalized with whatever is said of it.
 */
export const counterLapsed = (f: ChainFacts, nonce: bigint): ChainFacts => {
  const answer = f.against?.answer;
  return f.against === undefined || answer === undefined || answer.counter.nonce !== nonce
    ? f
    : { ...f, against: { ...f.against, answer: { ...answer, lapsed: true } } };
};

/**
 * The chain finalized the dispute: it paid the Account out of its collateral, so it holds none and no ondelta for any
 * token now, and says so in no `AccountSettled` (R-LEDGER-REBASE). `ledgered` are the tokens the Account has a ledger
 * for.
 */
export const paidOut = (f: ChainFacts, ledgered: Iterable<TokenId>): ChainFacts => {
  const none: Held = { collateral: 0n, ondelta: 0n };
  return { ...f, held: new Map([...f.held.keys(), ...ledgered].map((token): [TokenId, Held] => [token, none])) };
};

/** The dispute is over, whoever started it: nothing is left to counter or to finalize. */
export const disputeOver = (f: ChainFacts): ChainFacts => ({ ...f, against: undefined, starting: undefined });

/**
 * The node asked the chain to open a dispute with `start`. The record is kept until the dispute is over or the epoch
 * moves on, and no second start replaces it: the chain holds the dispute it opened first, with that start's nonce.
 */
export const disputeAsked = (f: ChainFacts, start: DisputeStart): ChainFacts =>
  ({ ...f, starting: { start, window: undefined, over: false, countered: undefined } });

/**
 * The chain says the dispute opened with `nonce` has a window ending at `timeout`. A dispute of another epoch or
 * another nonce, or one the node did not ask for, is not about this record; an older or repeated report keeps the
 * window it first gave.
 */
export const windowOpened = (f: ChainFacts, epoch: bigint, nonce: bigint, timeout: bigint): ChainFacts =>
  (f.starting === undefined || epoch !== f.epoch || nonce !== f.starting.start.nonce || f.starting.window !== undefined
    ? f
    : { ...f, starting: { ...f.starting, window: timeout } });

/**
 * The Host dropped the start the node asked for, because it would revert: no dispute is coming from it, so the record
 * goes and the node may ask again. A start of another nonce, or one that already has its window, is not the one
 * dropped (a repeat or an older report changes nothing).
 */
export const startLapsed = (f: ChainFacts, nonce: bigint): ChainFacts =>
  (f.starting === undefined || f.starting.window !== undefined || f.starting.start.nonce !== nonce
    ? f
    : { ...f, starting: undefined });

/**
 * The chain's clock passed the end of the window: a dispute the chain gave a window is over its window, whether the
 * node started it or answers it.
 */
export const windowOver = (f: ChainFacts): ChainFacts => ({
  ...f,
  starting: f.starting === undefined || f.starting.window === undefined ? f.starting : { ...f.starting, over: true },
  against: f.against === undefined ? undefined : { ...f.against, over: true },
});

/** The first nonce a proof of an epoch may take: two above the stored nonce, since none is signed at stored + 1. */
export const firstNonce = (f: ChainFacts): bigint => f.stored + 2n;

/**
 * The nonce of the newest co-signed proof of this epoch, if there is one: the proof of the frame at slot `used`, the
 * Account's newest committed slot, signed at the epoch's first nonce plus the slot, less one. A slot is not a count
 * of frames: the Left lane starts at the second slot, a retry skips slots, and `used` carries across epochs while
 * `frames` starts again. An epoch with no co-signed frame has no proof of its own.
 */
export const proofNonce = (f: ChainFacts, used: number): bigint | undefined =>
  (f.frames === 0n ? undefined : firstNonce(f) + BigInt(used) - 1n);

/** Epoch 0 has no implicit proof to fall back to: a deposit waits for the first co-signed frame. */
export const depositable = (f: ChainFacts): boolean => f.epoch > 0n || f.frames > 0n;

const MAX_WINDOW = 2n ** 32n - 1n;

const inRange = (n: bigint): boolean => n >= 1n && n <= MAX_WINDOW;

const shorter = (now: Windows, next: Windows): boolean => next.left < now.left || next.right < now.right;

/**
 * Windows are whole seconds that fit the proof's uint32, and inside an epoch they never decrease once a proof
 * carries them.
 */
export const withWindows = (f: ChainFacts, windows: Windows): Result<ChainFacts, EntityFault> => {
  if (!inRange(windows.left) || !inRange(windows.right)) return err({ _tag: "bad_windows", windows });
  const current = f.windows;
  return current !== undefined && f.frames > 0n && shorter(current, windows)
    ? err({ _tag: "windows_shorten", current })
    : ok({ ...f, windows });
};

/**
 * The node co-signed a settlement or a C2R: its Account proposes nothing until the operation lands or lapses. The
 * operation is the `cosigned`-th of this Account: its serial, which the Host echoes when the operation lapses.
 */
export const cosignFrozen = (f: ChainFacts): ChainFacts => ({ ...f, frozen: true, cosigned: f.cosigned + 1n });

/** A dispute is open on the Account, whoever started it: it is the chain's to settle until it is over. */
export const inDispute = (f: ChainFacts): boolean => f.starting !== undefined || f.against !== undefined;

/**
 * The node signs nothing new on the Account (R-DISPUTE-FREEZE, R-COSIGN-FREEZE): its signature is out on a settlement
 * or a C2R, a dispute is open, or the Host still owes it events of the Account (`behind`, R-WATCH-STALL: a finalize
 * whose secrets it cannot read yet may have dissolved holds). The proof a dispute rests on must stay the newest one the
 * node holds, and a frame committed now would be sealed under an epoch the finalize is about to void.
 */
export const quiet = (f: ChainFacts): boolean =>
  f.frozen || inDispute(f) || f.behind !== undefined || f.unresolved !== undefined;

/** The serial the next operation of this Account will have. */
export const nextSerial = (f: ChainFacts): bigint => f.cosigned + 1n;

/** An operation lapsed: it ends the freeze only if it is the one that is out; a repeated or older report is a no-op. */
export const cosignLapsed = (f: ChainFacts, serial: bigint): ChainFacts =>
  (f.frozen && f.cosigned === serial ? { ...f, frozen: false } : f);
