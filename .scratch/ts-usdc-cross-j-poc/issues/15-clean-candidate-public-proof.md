# 15: Prove the public journey on a clean committed candidate

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-human
Blocked by: 04 - Interrupted journey recovery; 05 - Public single-run preparation; 06 - Public single-run demo

Produce a verified one-USDC public proof on a clean, committed candidate and
retain a self-contained signed Cross-J trace. The owner closed
[06](06-public-sepolia-arbitrum-proof.md) as an observed demo on 2026-11-19.
Its existing receipt and WAL evidence records the actual working-tree digest.

## Acceptance criteria

- [x] Verify the immutable SHA and its committed configuration on a clean tree
      with the owning financial/recovery checks and the applicable broad
      verification profile.
- [x] Bind the public run manifest to the verified SHA. Refresh operator
      funding, executable quote and tariff, balances, credit,
      chain bindings, nonce slots and payer limits for this candidate. Obtain
      explicit spending authority for the exact public run and any separate
      recovery obligations before submission.
- [x] Prove one full public deposit of 1 USDC, signed Cross-J execution and
      external payout in the accepted range with zero source remainder and
      no unresolved Pull or pending Account ACK. Bind the receipts and WAL
      evidence to the exact tested SHA and manifest.
- [x] Retain the maker order, signed route authorization, actual fill sequence,
      both Account commitments, deadline and reveal evidence. Preserve raw
      receipts, pinned balance snapshots and payer costs by chain, including
      applicable Arbitrum fee components, in durable evidence. Keep vault seeds
      and private keys out of the package.
- [x] Report the scope of this public proof and the separate whole-product
      acceptance gates under AGENTS.md.

## Evidence

- [Completed public demo and its recorded candidate](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-executed.json)
- [Canonical nonce-based receipt report](13-public-report-exact-nonce-receipts.md)
- [Five-run and recovery budget](14-five-run-and-recovery-gas-plan.md)

The candidate `1ce560d954f4f59dc4e0bf5f9182dc1ad225711d` passed `bun run check`
and 24 owning PoC tests in a clean checkout. The approved
[journey manifest](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-journey-unsigned.json)
has SHA-256 `1d35072041c0b2ffb09a66fb449e86d2104b09fd4c1f335c3752ad310e17d0cb`.

### Stand preparation and funding

The [stand preparation](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-preparation.json)
opened both authenticated user Accounts and verified 100 WAL frames. The
separately approved [funding manifest](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-funding-unsigned.json)
has SHA-256 `16277245d2608e9aa8b043644b78ba52a2c345f8d89e3aa8ef09112b307313b0`. All nine calls succeeded. The
[funding report](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-funded-public.json)
and [independent funding reconciliation](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-funding-receipts.json)
record the 1 USDC user principal, the 0.000001 and 1 USDC Hub reserves, and
payer gas. The [funded Runtime and quote evidence](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-reserves-and-quote.json)
verifies both reserve observations and the full-lot quote under signed tariff
version 1.

### Completed public proof on `1ce560d95`

On 2026-11-22, the canonical CLI completed `ticket15-pqmqwh-1usdc-20261122`
on `ticket15-fresh-pQmqWH` within the approved window. It restored the original
funded stores, revalidated Hub and MM readiness, the executable quote, signed
tariff, credit, backing, balances and nonces, then executed the five authorized
calls. The complete 1 USDC deposit filled in one Cross-J execution. Gross
output was 0.999900 USDC, the signed tariff charged 0.100099 USDC, and the
recipient `0x28360c2e06e220f2fd245f299db4661a538cef19` received 0.899801 USDC.

Two RPCs agreed on all five successful receipts, the block hashes used to pin
the balance snapshots, and the Arbitrum L1 gas fields. Payer ETH balance changes
matched the actual fees: 13,770,616 wei for the Ethereum Sepolia user,
3,725,734,272,000 wei for the Arbitrum Sepolia Hub and 5,636,343,414,000 wei
for the Arbitrum Sepolia user. Both Arbitrum receipts reported zero
`gasUsedForL1`.

The replay verified 237 WAL frames across user (59), Hub (115) and MM (63).
The signed trace binds the admitted maker order and its reciprocal fill at
Hub frame 84 to the authorized route. The two Account closes match their
bilateral Hanko certificates and the same verified reveal within their
signed deadlines. Both terminal Account roots agree across the Hub and user,
with zero available user balance, unresolved Pulls or pending Account ACKs.
The source on-chain Account still records the 1 USDC of collateral, which
the closed bilateral state assigns to the Hub. The public proof covers this
browserless EVM testnet journey on the verified candidate. Whole-product
acceptance is governed by [AGENTS.md](../../../AGENTS.md#verification-scope).

- [Execution report and approved manifest binding](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-journey-executed.json)
- [Raw receipts, pinned balances, nonce windows and actual fees](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-journey-receipts.json)
- [Signed route, maker fill, Account commitments, deadlines and reveal](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-journey-signed-trace.json)
- [WAL integrity results](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-journey-wal.json)
