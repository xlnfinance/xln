// What an Entity does with what it knows of the chain for one Account (R-IMPLICIT-NONCE-FROM-CHAIN,
// R-NO-DEPOSIT-BEFORE-COSIGN, R-WINDOWS-NEVER-SHORTEN). The facts come from the Host's events and from the Entity's own
// committed frames; a proof's nonce is read off them and never derived from an earlier proof.
import { err, ok, type Result } from "../kernel/core/result.ts";
import type { ChainFacts, EntityFault, Windows } from "./model.ts";

export const freshChain: ChainFacts =
  { epoch: 0n, stored: 0n, frames: 0n, windows: undefined, disputed: false, frozen: false, cosigned: 0n };

/**
 * The chain moved the epoch on: no proof of the new epoch is signed yet. An older or repeated report changes nothing.
 */
export const epochAdvanced = (f: ChainFacts, epoch: bigint, stored: bigint): ChainFacts =>
  (epoch <= f.epoch ? f : { ...f, epoch, stored, frames: 0n, disputed: false, frozen: false });

/** One more frame is co-signed in this epoch. */
export const framed = (f: ChainFacts): ChainFacts => ({ ...f, frames: f.frames + 1n });

/** A dispute opened in another epoch than the one the Entity knows is not about its proofs. */
export const disputeOpened = (f: ChainFacts, epoch: bigint): ChainFacts =>
  (epoch === f.epoch ? { ...f, disputed: true } : f);

export const disputeOver = (f: ChainFacts): ChainFacts => ({ ...f, disputed: false });

/**
 * The nonce of the newest co-signed proof of this epoch, if there is one: the stored nonce the chain reports, plus one
 * for the implicit proof that sits at stored + 1, plus one for each frame. The first signed proof of an epoch is at
 * stored + 2 and no proof is ever signed at stored + 1: a Right-authored proof there only ties the implicit one.
 */
export const proofNonce = (f: ChainFacts): bigint | undefined =>
  (f.frames === 0n ? undefined : f.stored + 1n + f.frames);

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
