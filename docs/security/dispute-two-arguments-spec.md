# Bilateral dispute argument commitments

Status: implemented canonical protocol

## Purpose

A signed `ProofBody` fixes executable transformer logic, but its dynamic
arguments can become available only when a dispute is submitted. Positional
arguments must still refer to the exact signed state being finalized. Building
them from newer live Account state can shift swap, HTLC, or Pull positions and
apply valid evidence to the wrong signed program.

The protocol therefore commits two starter-owned argument blobs at dispute
start:

- `starterInitialArguments` belongs to the initial signed ProofBody;
- `starterCounterArguments` belongs to one exact newer signed ProofBody
  identity committed as `H(nonce, proposerIsLeft, proofbodyHash)`.

There is one production ABI. There are no V2 structs, deprecated aliases,
block-based deadlines, or compatibility readers.

## Canonical contract surface

`InitialDisputeProof` contains the full initial ProofBody, its hash and nonce,
the counterparty Hanko, the shared watch seed, and both starter argument blobs.
The full body is required at start so a signer cannot activate a body too large
to finalize within the contract limits.

`FinalDisputeProof` contains the exact final ProofBody, `starterArguments`
selected from the start commitment, `otherArguments` supplied by the finalizer,
and the signed final nonce when applicable. The transformer receives explicit
left/right arguments after the contract derives participant roles.

The stored dispute hash commits:

- initial nonce and starter side;
- absolute Unix-second start and timeout;
- signed left/right response seconds;
- initial ProofBody hash;
- commitments to both starter argument blobs and the exact counter-proof
  identity paired with the counter blob.

Argument commitments include the starter side and dispute start timestamp.
This prevents replaying a blob across another role or dispute clock.

## Runtime invariant

The Runtime builds arguments only from immutable snapshots indexed by exact
`proofbodyHash`. It may commit no newer blob or exactly one newer blob already
signed by the starter. Ambiguous or missing snapshots fail loudly; the Runtime
never rebuilds historical arguments from current Account state.

At finalization:

- the initial proof selects `starterInitialArguments`;
- the exact committed newer proof selects `starterCounterArguments`;
- any other valid newer/equal-LEFT proof still wins, but receives empty
  starter-side evidence; this prevents both stale-state veto and argument
  pairing across different signed programs;
- malformed dynamic argument wrappers soft-decode to empty evidence exactly as
  the signed transformer specifies;
- malformed, missing, reverting, or over-budget signed transformer programs
  revert and leave the dispute active.

Pull evidence is not carried in either dynamic argument blob. Pull settlement
reads the Account-scoped HashLadder registry for the signed Pull role and exact
active dispute clock.

## Time and finalization

All jurisdiction deadlines are Unix seconds. The Runtime uses milliseconds
only for scheduling and floors to seconds at the contract boundary.

- A Pull-containing proof cannot finalize before
  `S + leftResponseSeconds + rightResponseSeconds` for either party.
- A Pull-free non-starter may finalize immediately because its fresh outer
  Hanko is mutual acceptance of the exact state.
- A Pull-free starter waits for the timeout; otherwise it could unilaterally
  close an old signed state before the counterparty responds.
- Zero response windows are valid bilateral policy. The sum may not exceed
  365 days.

## Required gates

- Contract/runtime dispute-hash parity for both argument commitments and the
  exact second-based clock.
- Initial, counter, missing, ambiguous, malformed, and oversized argument
  regressions.
- Starter/non-starter Pull-free finalization asymmetry and the unconditional
  Pull timeout barrier.
- Cross-j Source/Target registry role, reveal-window, race, and finality tests.
