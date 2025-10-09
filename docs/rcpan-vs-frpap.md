# RCPAN vs. FRPAP: A Comparison of Account Network Invariants

This document compares two core models for account networks, FRPAP (Full-Reserve, Provable Account Primitives) and RCPAN (Reserve-Credit, Provable Account Network), with a brief overview of the traditional FCUAN (Full-Credit, Unprovable Account Networks) model for context.

## 1. Core Models

### FCUAN (Full-Credit, Unprovable Account Networks)

This is the model traditional banking and centralized exchanges (CEX) run on. It consists of bilateral, uncollateralized credit limits.

*   **Pros:** Scales exceptionally well.
*   **Cons:** Weak user security. Users can be censored, assets seized, and hubs can default.

### FRPAP (Full-Reserve, Provable Account Primitives)

Popularized by systems like the Lightning Network and Raiden, this model uses full-reserve bilateral accounts with cryptographic proofs. These are often called "payment channels" or "state channels."

*   **Pros:** Strong cryptographic security for the funds held in the channel.
*   **Cons:** Suffers from the "inbound capacity" or "inbound liquidity" problem, which is an architectural limitation.

### RCPAN (Reserve-Credit, Provable Account Network)

XLN introduces RCPAN as a hybrid model, combining the strengths of both FCUAN and FRPAP. It uses credit where it helps scalability and collateral where it's needed for security.

*   **Pros:** Solves the inbound liquidity problem, provides bounded risk, and maintains high scalability without centralized dependencies.

## 2. The Invariants

Let's define the operational boundaries (invariants) for each model.

*   `Δ` (delta): The signed balance between two parties.
*   `creditLimit`: A mutually agreed-upon credit line.
*   `collateral`: Escrowed funds in a 2-of-2 multisig contract.

### FCUAN Invariant

The balance can move between the negative credit limit of one party and the positive credit limit of the other.

`−leftCreditLimit ≤ Δ ≤ rightCreditLimit`

Diagrammatically:
`[---.Δ---]`

### FRPAP Invariant

The balance can only move between zero and the total amount of collateral locked in the channel.

`0 ≤ Δ ≤ collateral`

Diagrammatically:
`[.Δ===]`

### RCPAN (XLN) Invariant

The RCPAN model combines the two, creating a superset invariant.

`−leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit`

Diagrammatically:
`[---.Δ===---]`

This hybrid model can mimic both pure credit and pure collateral systems, but its real strength lies in using both simultaneously.

## 3. Side-by-Side Comparison

| Feature               | FCUAN (Traditional Banking)            | FRPAP (Lightning/Raiden)                  | RCPAN (XLN)                                |
| --------------------- | -------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| **Core Principle**    | Uncollateralized Credit                | Full-Reserve Collateral                   | Hybrid Credit & Collateral                 |
| **Inbound Liquidity** | No issue                               | Architecturally limited                   | Solved                                     |
| **Scalability**       | Very High (but centralized)            | Limited by on-chain actions and liquidity | High (O(1) per-hop updates)                |
| **Counterparty Risk** | Unbounded (hub default)                | Low (limited to channel capacity)         | Bounded (capped at collateral + credit)    |
| **Security**          | Weak (censorship, seizure)             | Strong (cryptographic proofs)             | Strong (proofs + sovereign exits)          |
| **Dependencies**      | Centralized hubs                       | Global consensus / Data Availability      | Local state, no sequencers                 |
| **Flexibility**       | Low (rigid system)                     | Moderate (payment-focused)                | High (can mimic both FCUAN and FRPAP)      |

## 4. Conclusion

The RCPAN model implemented by XLN presents a significant evolution in the design of decentralized financial networks. By creating a superset of the pure credit and pure reserve models, it addresses the fundamental limitations of each.

The result is a network that offers:
*   The scalability and flexibility of traditional credit systems.
*   The security and verifiability of full-reserve channel networks.
*   A solution to the inbound liquidity problem that plagues FRPAP systems.

This makes RCPAN a more robust and practical foundation for a global, decentralized financial system.
