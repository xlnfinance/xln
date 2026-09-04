// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * Types.sol - Shared type definitions for Depository and Account library
 * Both contracts import this to ensure type compatibility
 */

// ========== SHARED ERRORS ==========
// Selectors are name-derived. Declared once so Account (library) and Depository
// cannot drift. Depository-only codes (E1/E11/E12) stay on Depository.
// Account-only errors bubble through Depository's DELEGATECALL boundary. The
// ABI-only interface below exposes those same zero-argument selectors without
// unreachable constructor branches.

error E2(); // Unauthorized / StaleNonce
error E3(); // InsufficientBalance
error E4(); // InvalidSigner
error E7(); // InvalidParty
error E8(); // LengthMismatch / Int256Overflow
error E10(); // BatchTooLarge

// Runtime frame heights and protocol nonces use exact JavaScript safe integers.
// This bound does not apply to money or other true uint256 quantities.
uint256 constant JS_SAFE_NONCE_MAX = 9007199254740991;

interface IDepositoryDelegateErrorAbi {
  // E5 is emitted only inside the linked Account library. Keeping the same
  // selector in Depository's inherited ABI lets operators and tests decode a
  // bubbled NoActiveDispute failure without a duplicate unreachable branch.
  error E5(); // NoActiveDispute / VirginAccount
  error E6(); // DisputeInProgress
  error E9(); // HashMismatch
  error TransformerGasBudgetUnavailable();
  error TransformerExecutionFailed();
}

// ========== ACCOUNT STATE ==========

struct AccountInfo {
  uint nonce;              // Unified monotonic nonce: signed nonce must be strictly greater than stored nonce
  bytes32 disputeHash;
  // Absolute unix end of dispute period T (seconds). Challenge + pull clocks
  // both use jurisdiction seconds from disputeStartTimestamp — not blocks.
  // Different chains have different blockTimes; seconds compare without config
  // conversion. Runtime mirrors these values in ms for scheduling only.
  uint256 disputeTimeout;
  // Unix start of this exact dispute. A reveal before this timestamp belongs
  // to an older/no dispute and must never satisfy the newly opened one.
  uint256 disputeStartTimestamp;
  // Bilaterally signed response windows frozen from the initial ProofBody.
  // Protocol unit is always jurisdiction unix seconds. Their sum is the sole
  // finalization barrier; a newer counter-proof cannot retune an active clock.
  uint32 leftResponseSeconds;
  uint32 rightResponseSeconds;
  bytes32 disputeInitialProofbodyHash;
  bool disputeInitialProposerIsLeft;
  // Highest mutually signed counter-proof registered before T. Keeping only
  // nonce+hash prevents the starter from racing an older finalization at T
  // without storing a potentially 176 KiB ProofBody in contract storage.
  uint256 disputeCounterNonce;
  bytes32 disputeCounterProofbodyHash;
  bool disputeCounterProposerIsLeft;
  bytes32 starterInitialArgumentsCommitment;
  bytes32 starterCounterArgumentsCommitment;
  // Commits the only newer signed branch whose starter-owned positional
  // arguments were supplied at dispute start. Without this binding, a
  // non-starter could pair those arguments with a different historical proof.
  bytes32 starterCounterProofCommitment;
  bool disputeStartedByLeft;
}

struct AccountCollateral {
  uint collateral;
  int ondelta;
}

// ========== SETTLEMENT ==========

struct SettlementDiff {
  uint tokenId;
  int leftDiff;
  int rightDiff;
  int collateralDiff;
  int ondeltaDiff;
}

// Per-token state snapshot after settlement (used in AccountSettled event)
struct TokenSettlement {
  uint tokenId;
  uint leftReserve;
  uint rightReserve;
  uint collateral;
  int ondelta;
}

// Per-account settlement result (groups all tokens for one bilateral pair)
struct AccountSettlement {
  bytes32 left;
  bytes32 right;
  TokenSettlement[] tokens;
  uint nonce;  // Post-update nonce for watcher correlation
}

// ========== DEBT ==========

struct Debt {
  bytes32 creditor;
  uint amount;
}

// ========== TRANSFORMERS (was Subcontracts) ==========

struct Allowance {
  uint deltaIndex;
  uint rightAllowance;
  uint leftAllowance;
}

struct TransformerClause {
  address transformerAddress;
  bytes encodedBatch;
  Allowance[] allowances;
}

struct ProofBody {
  bytes32 watchSeed;
  // Account-level response policy committed by every bilateral Hanko.
  // Zero is intentional same-block policy; the sum may not exceed 365 days.
  uint32 leftResponseSeconds;
  uint32 rightResponseSeconds;
  int[] offdeltas;
  uint[] tokenIds;
  TransformerClause[] transformers;
}

// ========== DISPUTE ==========

struct InitialDisputeProof {
  bytes32 counterentity;
  uint nonce;              // Unified nonce at time of signing
  bool proposerIsLeft;     // Signed branch author; LEFT wins equal-nonce collisions
  bytes32 proofbodyHash;
  // Reveal the exact signed body at start. A hash-only start can otherwise
  // commit an arbitrarily large body that no block can later carry to finalize.
  ProofBody initialProofbody;
  bytes32 watchSeed;       // Shared bilateral account seed revealed when dispute starts
  bytes sig;
  // Starter-side transformer args for the proof body at `nonce`.
  // Used when the dispute finalizes on the initial proof after timeout.
  //
  // These are full bytes, not hashes and not Solidity-level swap/pull IDs:
  // disputes must be finishable in two txs (start + finalize). A hash-only
  // value would force an extra reveal tx, while IDs/diffs would leak runtime
  // bookkeeping into the jurisdiction ABI and cost gas on every dispute.
  bytes starterInitialArguments;
  // Starter-side transformer args for exactly one newer proof body already
  // signed/sent by the starter before opening the dispute. These are not
  // counterparty args; they are the starter's own args for the counter
  // state that the counterparty may reveal in a counter-dispute.
  //
  // Example this prevents: hub signs state N with a 50% fill, then signs N+1
  // with total 75%, user stays offline, hub opens dispute. The initial args
  // must settle N, but if user reveals N+1 the starter side must switch to the
  // counter args for N+1. Reusing initial args would underclaim; rebuilding
  // live args would let deleted/reordered off-chain state drift into old proof.
  bytes starterCounterArguments;
  // Exact identity commitment of the one newer branch paired with
  // starterCounterArguments: H(nonce, proposerIsLeft, proofbodyHash).
  // bytes32(0) means no counter branch was admitted at dispute start.
  bytes32 starterCounterProofCommitment;
  //
  // Why the starter's evidence is frozen at start and cannot be improved later:
  // - Starter args must be public at start so the NON-starter can finalize at T
  //   without the starter's cooperation. A hash-only commitment would let the
  //   starter grief by never revealing and lock the Account forever.
  // - Starter args cannot be supplied at finalize because the starter would then
  //   choose evidence with hindsight of the counter-proof (withhold a secret,
  //   pick a lower fill) after the bilateral clocks were already set.
  // - Starter args are positional per transformer clause, so any clause change
  //   at or before a position (add, remove, reorder, requantize) invalidates
  //   the blob for the newer body. That is one reason a second blob exists.
  // - The other reason is binding, not indexing: the second blob is tied to ONE
  //   exact newer branch via starterCounterProofCommitment, and every other
  //   branch the non-starter may select receives empty starter evidence
  //   (Account._counterStarterArgumentsCommitment). The starter thus cannot
  //   pre-load evidence for branches it did not name at start.
  //
  // Tempting simplification, reviewed and rejected as-is: key each argument by
  // keccak256(clause) instead of clause index so one starter blob serves every
  // body containing the clause, and drop both counter fields. It fails today
  // because (1) _validateProofBody does not forbid two byte-identical clauses,
  // so a keyed lookup would double-execute one entry; (2) an open limit order
  // keeps identical clause bytes while its intended taker fill moves from N to
  // N+1, so one key cannot carry both fills and a starter would precommit the
  // higher one; (3) it silently widens starter evidence to branches the starter
  // never named, reversing the empty-evidence rule above. It would need a
  // duplicate-clause rejection, a key over (transformer, encodedBatch,
  // allowances), and an explicit decision on (3). Until then, two blobs stay.
}

struct FinalDisputeProof {
  bytes32 counterentity;
  uint initialNonce;       // Nonce when dispute was started
  uint finalNonce;         // Used for signed finalize paths; unilateral timeout path may keep this equal to initialNonce
  bool proposerIsLeft;     // Exact author of finalProofbody in the signed proof
  bytes32 initialProofbodyHash;
  ProofBody finalProofbody;
  // Exactly one precommitted starter blob plus the finalizer's optional side.
  // Repeating both start blobs and duplicating the selected side made a start
  // transaction possible whose mandatory finalize calldata exceeded block gas.
  // Malformed args are adversarial evidence and should be treated as empty by
  // transformers. Malformed ProofBody remains fatal because it is signed state.
  bytes starterArguments;
  bytes otherArguments;
  bytes sig;
  bool startedByLeft;
  bool cooperative;        // if true, skip timeout (mutual agreement)
}

/// @notice Locks a newer mutually signed state before the execution deadline.
/// @dev The exact ProofBody is validated and hashed but not stored. At/after T
///      finalization must resubmit the selected body and matching Hanko.
struct CounterDisputeProof {
  bytes32 counterentity;
  uint initialNonce;
  bytes32 initialProofbodyHash;
  uint counterNonce;
  bool proposerIsLeft;
  ProofBody counterProofbody;
  bytes sig;
}

// ========== BATCH OPERATIONS ==========

struct Settlement {
  bytes32 leftEntity;
  bytes32 rightEntity;
  SettlementDiff[] diffs;
  uint[] forgiveDebtsInTokenIds;
  bytes sig;
  uint256 nonce;
}

struct Flashloan {
  uint tokenId;
  uint amount;
}

struct ReserveToReserve {
  bytes32 receivingEntity;
  uint tokenId;
  uint amount;
}

struct ReserveToCollateral {
  uint tokenId;
  bytes32 receivingEntity;
  EntityAmount[] pairs;
}

struct EntityAmount {
  bytes32 entity;
  uint amount;
}

struct ExternalTokenToReserve {
  bytes32 entity; // Entity to credit. If bytes32(0), defaults to batch initiator / caller self
  address contractAddress;
  uint256 externalTokenId;
  uint8 tokenType;
  uint internalTokenId;
  uint amount;
}

struct ReserveToExternalToken {
  bytes32 receivingEntity;
  uint tokenId;
  uint amount;
}

struct SecretReveal {
  address transformer;
  bytes32 secret;
}

// One hash-ladder witness. Commitments and semantic role are never supplied by
// this wrapper: Depository derives them from the indexed Pull in the exact
// active, bilaterally signed initial ProofBody.
struct HashLadderWitness {
  uint16 fillRatio;      // asserted ratio, verified against the commitment
  bytes32 fullSecret;    // used iff fillRatio == 65535
  bytes32[4] reveals;    // nibble reveal nodes, used iff 0 < fillRatio < 65535
}

struct HashLadderRegistration {
  // The outer processBatch Hanko authenticates the writing Entity. The other
  // participant selects the exact ordered Account namespace that
  // DeltaTransformer later derives from its signed left/right entities. A
  // false counterparty creates an inert record; it cannot settle the real Account.
  bytes32 counterpartyEntity;
  // Role selects an independent write-policy namespace. Financial role,
  // beneficiary and ladder commitments remain signed inside DeltaTransformer.Pull.
  bool targetRole;
  bytes32 fullHash;
  bytes32 partialRoot;
  HashLadderWitness witness;
}

// C2R shortcut - expands to Settlement on-chain (saves calldata)
// Pure C2R: withdraw `amount` from my share of collateral to my reserve
struct CollateralToReserve {
  bytes32 counterparty;
  uint tokenId;
  uint amount;
  uint nonce;   // signed nonce (must be > stored account nonce)
  bytes sig;    // counterparty hanko (still bilateral)
}

struct Batch {
  Flashloan[] flashloans;
  ReserveToReserve[] reserveToReserve;
  ReserveToCollateral[] reserveToCollateral;
  CollateralToReserve[] collateralToReserve;  // C2R shortcut (expands to Settlement)
  Settlement[] settlements;
  InitialDisputeProof[] disputeStarts;
  CounterDisputeProof[] counterDisputes;
  FinalDisputeProof[] disputeFinalizations;
  ExternalTokenToReserve[] externalTokenToReserve;
  ReserveToExternalToken[] reserveToExternalToken;
  SecretReveal[] revealSecrets;
  HashLadderRegistration[] hashLadderRegistrations;
}

// ========== ENUMS ==========

enum MessageType {
  CooperativeUpdate,
  DisputeProof,
  FinalDisputeProof,
  CooperativeDisputeProof
}
