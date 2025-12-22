# Final V1 Specification: The "Account Proof" Insurance Model

This document outlines the final and definitive V1 specification for the XLN insurance mechanism. This design, the "Account Proof" model, is the result of a rigorous iterative process and is superior to all previous proposals in its simplicity, privacy, and architectural elegance. It is ready for implementation.

## 1. Executive Summary & Core Principle

The final design abandons all dedicated on-chain storage for insurance policies (no registries, no queues, no hashes). Instead, insurance is treated as a **native property of the bilateral channel state itself.**

**Core Principle:** An `InsuranceCertificate` is an off-chain cryptographic proof that is included directly in the channel's `ProofBody` struct. It only ever appears on-chain as `calldata` during the rare event of a dispute, requiring **zero permanent on-chain state**.

## 2. The Implementation: Integrating Insurance into the Core Protocol

The implementation requires only a minimal change to the core `Depository.sol` contract.

### A. The Modified `ProofBody`

The `ProofBody` struct, which represents the signed state of a bilateral channel, is modified to include an array of insurance certificates.

```solidity
// In Depository.sol

struct ProofBody {
    int[] offdeltas;
    uint[] tokenIds;
    SubcontractClause[] subcontracts;
    InsuranceCertificate[] certificates; // NEW: Insurance is now part of the proof itself
}

// The InsuranceCertificate remains an off-chain data object, never stored in state.
struct InsuranceCertificate {
    bytes32 insuredEntity; // The entity covered by this policy
    uint256 coverage;
    uint256 expiresAt;
    bytes32 insurer;
    bytes signature;       // The insurer's signature on the certificate hash
}
```

### B. The Secure Lifecycle Workflow

This small structural change enables a workflow that is secure, private, and correctly aligns the responsibilities of all parties.

**Step 1: Purchase (Off-Chain)**
*   `H1` (the Insured) negotiates terms with `H2` (the Insurer) via any off-chain means.
*   `H2` provides `H1` with a valid, signed `InsuranceCertificate`. This is a private transaction between two parties.

**Step 2: Inclusion in Channel State (Bilateral Agreement)**
*   This is the key step. `H1` wishes to have this insurance apply to its channel with a counterparty, `Alice`.
*   It is **`H1`'s responsibility** to provide the signed certificate data to `Alice`'s off-chain `runtime`.
*   `H1` and `Alice` then mutually sign a new `ProofBody` for their channel that now includes this certificate in the `certificates` array. The insurance is now an explicit, agreed-upon part of their shared channel state. The burden of managing and sharing this proof lies with the party who benefits from it (`H1`).

**Step 3: Dispute & Claim (Effortless and Atomic)**
*   A dispute occurs, and `Alice` must call `finalizeChannel` to settle the channel on-chain.
*   To do this, `Alice` is already required to provide the last `ProofBody` that both she and `H1` mutually signed.
*   Since the insurance certificates are part of that `ProofBody`, they are **automatically included in the `calldata` of the `finalizeChannel` call.**
*   The `_settleShortfall` function finds the certificates right there in the proof it was already given. It verifies them and processes the claim atomically. The claimant, `Alice`, has to do **zero extra work**.

## 3. Key Advantages of the "Account Proof" Model

This final design is superior for several reasons:

*   **Zero On-Chain Storage:** This is the most gas-efficient and scalable model possible. It adds no permanent state bloat to the blockchain, regardless of how many policies are issued.
*   **Perfect Claimant UX:** The experience for the claimant is seamless. They simply submit the standard dispute proof they are already required to have. The insurance claim is automatic and requires no special effort.
*   **Privacy by Default:** Insurance relationships are kept completely private between the parties in a channel. They are never broadcast publicly and are only revealed on-chain in the rare event of a dispute. This is essential for institutional and corporate adoption.
*   **Granular, Relationship-Specific Risk Management:** It enables the "selective pools" concept. `H1` can negotiate to include a specific set of insurance policies in its channel with `Alice`, while having a completely different set of policies active in its channel with `Bob`. Risk management becomes specific to each bilateral relationship.
*   **Architectural Elegance:** Insurance is no longer a "feature" bolted onto the `Depository`. It is a native, fundamental property of the channel's state proof, deeply integrated into the core protocol logic.

## 4. Security & Final Considerations

*   **Claim Security:** An insurance payout can only be triggered by a valid, signed `ProofBody` provided during a legitimate dispute. The security of the insurance claim is therefore predicated on the proven security of the core channel dispute mechanism.
*   **Policy Specificity:** As discussed, the `_processInsuranceClaims` logic must verify that the `debtor` in the shortfall matches the `insuredEntity` in the certificate, preventing a policy from being used to cover a risk it wasn't written for.
*   **Composability (V2):** While this V1 model prioritizes privacy, a future V2 could still create tradable "Policy NFTs". An entity could lock their private certificate in a new contract that issues a public NFT, which could then be used in the `ProofBody`. This model provides a clear path for future extension without compromising the V1 design.

This specification is complete. It is simple, secure, private, and scalable. It is the correct V1 to build.