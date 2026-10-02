// What an Entity does with what it knows of the chain for one Account (R-IMPLICIT-NONCE-FROM-CHAIN,
// R-NO-DEPOSIT-BEFORE-COSIGN, R-WINDOWS-NEVER-SHORTEN). The facts come from the Host's events and from the Entity's own
// committed frames; a proof's nonce is read off them and never derived from an earlier proof.
import { mapSet } from "../kernel/core/collections.ts";
import { err, ok, type Result } from "../kernel/core/result.ts";
import { MAX_PROOF_TOKENS } from "../account/proof/body.ts";
import type { TokenId } from "../account/model.ts";
import type { Held } from "../account/state.ts";
import type { ChainFacts, DisputeStart, EntityFault, Windows } from "./model.ts";

export const freshChain: ChainFacts =
  {
    epoch: 0n, stored: 0n, frames: 0n, windows: undefined, disputed: false, frozen: false, cosigned: 0n,
    held: new Map(), starting: undefined,
  };

/**
 * The chain moved the epoch on: no proof of the new epoch is signed yet. An older or repeated report changes nothing.
 */
export const epochAdvanced = (f: ChainFacts, epoch: bigint, stored: bigint): ChainFacts =>
  (epoch <= f.epoch ? f : { ...f, epoch, stored, frames: 0n, disputed: false, frozen: false, starting: undefined });

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

/** A dispute opened in another epoch than the one the Entity knows is not about its proofs. */
export const disputeOpened = (f: ChainFacts, epoch: bigint): ChainFacts =>
  (epoch === f.epoch ? { ...f, disputed: true } : f);

/** The dispute is over, whoever started it: nothing is left to counter or to finalize. */
export const disputeOver = (f: ChainFacts): ChainFacts => ({ ...f, disputed: false, starting: undefined });

/**
 * The node asked the chain to open a dispute with `start`. Asking again with the dispute already open keeps what the
 * chain said of its window.
 */
export const disputeAsked = (f: ChainFacts, start: DisputeStart): ChainFacts =>
  ({ ...f, starting: { start, window: f.starting?.window, over: f.starting?.over ?? false } });

/**
 * The chain says the dispute the node started has a window ending at `timeout`. A dispute of another epoch, or one the
 * node did not ask for, is not about this record; an older or repeated report keeps the window it first gave.
 */
export const windowOpened = (f: ChainFacts, epoch: bigint, timeout: bigint): ChainFacts =>
  (f.starting === undefined || epoch !== f.epoch || f.starting.window !== undefined
    ? f
    : { ...f, starting: { ...f.starting, window: timeout } });

/** The chain's clock passed the end of the window: only a dispute the chain gave a window is over its window. */
export const windowOver = (f: ChainFacts): ChainFacts =>
  (f.starting === undefined || f.starting.window === undefined ? f : { ...f, starting: { ...f.starting, over: true } });

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

/** The serial the next operation of this Account will have. */
export const nextSerial = (f: ChainFacts): bigint => f.cosigned + 1n;

/** An operation lapsed: it ends the freeze only if it is the one that is out; a repeated or older report is a no-op. */
export const cosignLapsed = (f: ChainFacts, serial: bigint): ChainFacts =>
  (f.frozen && f.cosigned === serial ? { ...f, frozen: false } : f);
