# XLN vs Lightning/Raiden Invariant Comparison

## Purpose
- Document how XLN's reserve-credit invariant generalizes channel-style invariants
- Highlight operational consequences for liquidity, risk, and upgrade paths
- Provide checkpoints and logs for reasoning and future verification runs

## Quick Summary
| System | Core Primitive | Invariant (Δ = bilateral balance) | Liquidity Envelope | Expected Failure Mode |
|--------|----------------|------------------------------------|--------------------|-----------------------|
| Lightning Network | Full-reserve payment channel | `0 ≤ Δ ≤ collateral` | Symmetric to posted collateral | Inbound liquidity exhaustion; forced channel closure |
| Raiden Network | Full-reserve payment channel | `0 ≤ Δ ≤ collateral` | Limited by locked ETH/ERC20 escrow | On-chain dispute; collateral slashing |
| XLN | Reserve-credit provable account | `-leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit` | Asymmetric mix of credit headroom + escrow | Link-level loss caps; optional collateral unwind |

### Verification Log
- [x] Cross-checked invariant definition with `docs/invariant.md`
- [x] Confirmed Lightning/Raiden invariants match FRPAP definition
- [x] Noted operational consequences for liquidity and recovery

## Invariant Anatomy
### Lightning Network (FRPAP)
- Channels are dual-funded escrows enforced by HTLC scripts
- Collateral posted on-chain establishes the invariant `0 ≤ Δ ≤ collateral`
- Payment flow moves Δ toward payer; exceeding collateral triggers failure (requires rebalancing or closing)
- No notion of credit; all capacity is prepaid liquidity

### Raiden Network (Ethereum Variant)
- Mirrors Lightning's FRPAP invariant within ERC20/ETH escrows
- Uses smart contracts for channel deposits, proofs, and disputes
- Δ range identical: `0 ≤ Δ ≤ collateral`, with settlement enforced by on-chain adjudication
- Additional gas/latency overhead for dispute windows, but invariant mechanics unchanged

### XLN (RCPAN Hybrid)
- Defined in `docs/invariant.md`: `-leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit`
- Δ remains a bilateral saldo, but envelope extends into negative range via credit extensions
- Collateral augments only the positive (receiver) side; credit limits cap exposure on both sides
- Supports FCUAN-style credit without losing provable enforcement on collateralized portion

## Operational Consequences
- **Inbound Liquidity**: Lightning/Raiden require prefunding; XLN adds credit headroom so receivers are not blocked by empty channels.
- **Risk Surface**: FRPAP risk equals posted collateral; XLN caps losses at `credit + collateral`, allowing bounded but positive leverage.
- **Topology Scaling**: Lightning/Raiden depend on routing with strict balance constraints; XLN links can lean on credit to absorb transient imbalances.
- **Dispute Flow**: Lightning/Raiden escalate to on-chain settlement; XLN stays bilateral unless collateralized portion is contested, preserving sovereignty.

## Upgrade Paths and Testing Hooks
- **Lightning/Raiden**: Optimization focuses on improving rebalancing algorithms and reducing dispute costs; invariant itself is fixed.
- **XLN**: Jurisdiction machines can tune credit policies, collateral requirements, and logging thresholds while keeping invariant bounds explicit.
- **Next Verification Step**: Simulate Δ evolution under mixed credit/collateral scenarios, logging `Δ`, `credit`, `collateral` each tick for regression comparisons.

## Takeaways
- XLN subsumes FRPAP invariants, enabling credit + collateral in a single bilateral ledger.
- Lightning/Raiden remain special cases (collateral-only) within the XLN invariant envelope.
- Adoption strategy: introduce XLN channels that start in FRPAP mode, then progressively enable credit as counterparties prove reliability.



