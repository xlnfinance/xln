# 06: Prove the complete public Sepolia-to-Arbitrum USDC journey

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: 04 - Recover the interrupted financial journey without duplicate effects; 05 - Prepare the public execution inputs and native-gas budget

## Owner-approved closure scope

On 2026-11-19 the owner accepted the observed `fresh-UbkYJm` public
testnet demo as completion of this ticket. The run binds working-tree
digest `7c1dc0e7b67b7e79389845459ff95c673128c348320ac669dbd229cb19295fc4`
at HEAD `b2dceb3438ff2582cee0c5741fe4a0528f5cbd26`. Verification and a
public run on a clean committed candidate, with the complete signed
Cross-J trace exported, are tracked in [15](15-clean-candidate-public-proof.md).
Whole-product acceptance follows the release gates in AGENTS.md.

## Acceptance criteria

- [x] Use the canonical TypeScript journey and retain the exact candidate,
      approved manifest, fresh quote, signed tariff, payer limits and observed
      backing before the first broadcast.
- [x] Approve, deposit and post as source Account collateral exactly 1,000,000
      units of Ethereum Sepolia USDC from the dedicated user wallet.
- [x] Execute the full source amount through the canonical signed Cross-J
      path with maker liquidity. Retain the maker order, confirmed payout
      calculation and both settled route legs in the run and replay evidence.
- [x] Cover the target claim from the Hub's actual reserve and prove the
      canonical settlement and external withdrawal to the bound Arbitrum
      Sepolia EOA. Reconcile the pricing and signed fee against the payout
      guard.
- [x] Retain five exact receipts, pinned balances, payer costs and WAL replay.
      Confirm zero source remainder, unresolved Pulls, pending Account frames
      or unsecured user claim after settlement. Report completion for the
      observed testnet demo.

## Verified result

`fresh-ubkyjm-1usdc-20261119` completed five public transactions and had
zero failed receipts. The unit ledger is
`1,000,000 - 100 (exchange pricing) - 100,099 (signed tariff) = 899,801`
USDC atoms. Current and archive RPCs matched the receipt for 0.899801 USDC
to `0xc610e84b42230a7294852f8f5d6cf2f6a181778a`. Both route legs settled
with zero remainder and zero live Pulls at user Runtime frame 52. Checks
covered 215 WAL frames. All five transactions fit the approved payer limits.

- [Unsigned source of the approved manifest](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-authority-unsigned.json)
- [Five receipts, balances, exact gas and WAL replay](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-executed.json)
- [Five verified on-chain receipts](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-raw-receipts.json)
- [Post-run Hub and Account reconciliation](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-hub-balances.json)
- [Earlier public demo](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-executed.json)

## Comments

The owner selected this scope on 2026-11-19. The five-run and recovery
budget remains in [14](14-five-run-and-recovery-gas-plan.md). The original
stand funding and restore remain in [11](11-separate-operator-funding.md)
and [12](12-public-rpc-capacity-and-funded-catchup.md).
