# 15: Prove the public journey on a clean committed candidate

Type: implementation
Category: enhancement
Completed: no
Status: ready-for-human
Blocked by: 04 - Interrupted journey recovery; 05 - Public single-run preparation; 06 - Public single-run demo

Produce a verified one-USDC public proof on a clean, committed candidate and
retain a self-contained signed Cross-J trace. The owner closed
[06](06-public-sepolia-arbitrum-proof.md) as an observed demo on 2026-11-19.
Its existing receipt and WAL evidence records the actual working-tree digest.

## Acceptance criteria

- [ ] Identify one immutable SHA containing the executable and configuration
      used for the public run. Verify it on a clean tree with the owning
      financial/recovery checks and the applicable broad verification profile.
- [ ] Refresh operator funding, executable quote and tariff, balances, credit,
      chain bindings, nonce slots and payer limits for this candidate. Obtain
      explicit spending authority for the exact public run and any separate
      recovery obligations before submission.
- [ ] Prove one full public deposit of 1 USDC, signed Cross-J execution and
      external payout in the accepted range with zero source remainder and
      no unresolved Pull or pending Account ACK. Bind the receipts and WAL
      evidence to the exact tested SHA and manifest.
- [ ] Retain the maker order, signed route authorization, actual fill sequence,
      both Account commitments, deadline and reveal evidence. Preserve raw
      receipts, pinned balance snapshots and payer costs by chain, including
      applicable Arbitrum fee components, in durable evidence. Keep vault seeds
      and private keys out of the package.
- [ ] Report the scope of this public proof and the separate whole-product
      acceptance gates under AGENTS.md.

## Evidence

- [Completed public demo and its recorded candidate](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-executed.json)
- [Canonical nonce-based receipt report](13-public-report-exact-nonce-receipts.md)
- [Five-run and recovery budget](14-five-run-and-recovery-gas-plan.md)
