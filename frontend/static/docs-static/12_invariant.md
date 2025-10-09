# 1.2 RCPAN Invariant 

[pairing: Pye Corner Audio - The Simplest Equation](https://www.youtube.com/watch?v=Vp0a8tdzJmk) (but yes, technically it's inequality)


The core credit–collateral mechanism can be grasped in three minutes. Accounts are bilateral relationships between entities. 

For centuries, the world has run on FCUAN (full-credit, unprovable account networks—i.e., traditional banking credit rails): bilateral, uncollateralized limits between end-users (“spokes”) and banks/brokers (“hubs”). Any CEX (e.g., Binance, Coinbase) is also FCUAN. 

FCUAN scales phenomenally but offers weak user security. Any spoke can be censored, and assets seized at any moment. Hubs can default, even without malice (Diamond–Dybvig–style hub runs). 

Deposit insurance is typically small relative to broad money (≪ M2), which systematically externalizes tail risk and invites moral hazard.

Two entities start a financial relationship (per-asset Δ balances). Their xln wallets compare their hex IDs; the lower becomes L (left), the other R (right). Imagine an x-axis where:

. is zero (0)
Δ delta is the signed balance (saldo) between counterparties
[ ] are invariant boundaries—how far Δ can move given mutual credit and shared collateral

Clean slate (all zeros):

(L)eft entity   [.Δ]   (R)ight entity

Either party can extend a credit limit to the other:
- unused, uncollateralized credit line (credit)
* used credit

Example (leftCreditLimit = 3, rightCreditLimit = 3):

[---.Δ---]

Payments pull Δ toward the payer’s side (away from the receiver) while the receiver’s allocation increases.
L pays 2 to R → Δ = −2:

[-Δ**.---]

R pays back 3 → Δ = +1:

[---.*∆--]

This is what 99.99% of the world economy runs on. Today, every bank, broker, CEX, and payment intermediary is pure FCUAN.

A different approach, FRPAP (full-reserve, provable account primitives), often called “payment/state channels,” was popularized by the 2017 Lightning Network paper. FRPAP/Payment channels are full-reserve bilateral accounts with proofs—not a network architecture.

Every full-reserve design (e.g., Raiden on Ethereum, Hydra on Cardano) inherits the inbound-capacity constraint—an architectural limit, not an implementation bug. It’s more precise to treat this as a family of three account primitives—proofs, collateral, and delta transformers—rather than a scalable network.

In diagrams:
= collateral (fully escrowed). Think of it as a dedicated 2-of-2 escrow with cryptographic guarantees.

We draw collateral to the right of zero. R posts 3 units of collateral:

[.Δ===]

R pays 2 (Δ moves right):

[.==Δ=]

xln is the first RCPAN (Reserve-Credit, Provable Account Network): credit where it scales, collateral where it secures—a principled hybrid of FCUAN and FRPAP.

FCUAN invariant:
−leftCreditLimit ≤ Δ ≤ rightCreditLimit
[---.---]

FRPAP invariant:
0 ≤ Δ ≤ collateral
[.===]

RCPAN (xln) superset invariant:
−leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit
[---.===---]

xln can mimic both: ignore collateral functionality and it works like banking with enforceable proofs; ignore credit lines and it works like Lightning/full-reserve payment-channel networks. 

Using both is where the real synergy emerges.

Practical consequences: no inbound liquidity wall and no unbounded hub risk—losses are link-capped; throughput scales with links, not global broadcasts.

Follow for news, analysis, and a verification-first roadmap (proof sketch, benchmarks, economic spec, security playbook). xln is layer-2 done right.

🔗 https://github.com/xlnfinance/xln