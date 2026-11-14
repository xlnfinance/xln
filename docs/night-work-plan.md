# Current xln execution handoff

## Current SHA

- Public execution: `49c26224497d5e875c369098f02d515e0fb81134`, `testnets_deploy`; deployment implementation commit `ceb1d0522d20b171ca21803f152ecf3fd5875441`.
- Current executable commit: `cb52df9da1b0e1f0291db08074df122680da4526`; resolve the subsequent documentation HEAD with `git rev-parse HEAD`.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged.
- The L1/L2 verifier fix and native `xln-verify` operation are committed. Unrelated owner work and generated local evidence remain dirty; no clean release candidate is claimed. All 13 unrelated owner file hashes are unchanged.
- Owner-approved MacBook M5 / branch exceptions. Public deployment was explicitly authorized; the later read-only checks sent no transactions. No push.

## Last green command

`bun run check:deployment`: 6/6 gates, 274 Hardhat tests, 64 Foundry checks,
110 Bun tests / 3,582 assertions. All 561 covered source hashes stayed stable;
all 181 compiler/ABI/TypeChain artifact hashes are unchanged. Owning focused
regressions passed 17 tests / 71 assertions. The final read-only verifier's
covered sources match that green profile; remaining sealed contract/configuration
metadata matches the original execution commit.
The checked executable source content is now committed at the SHA above;
the retained reports still identify the actual dirty verification-time candidate.

Then `xln-verify` exited zero on both actual public stacks without a key:
Ethereum at block `12129021` (minimum receipt depth 206), Arbitrum at L2 block
`328957948` (minimum depth 7,771). Both reports are `verified`, with zero current
signatures/broadcasts. All 91 files in each original native directory remained
byte-identical. Ethereum's earlier compatible completed resume also sent zero.
Each chain has eleven successful deployment receipts and exact expense/balance
accounting with `unaccountedDeltaWei = 0`.

## First red command/error

No unresolved failure in this selected deployment-verification scope.
Arbitrum's original `xln-deploy` invocation remains `failed/verifying` with
`STACK_MANAGER_FOUNDATION_AUTHORITY_MISMATCH`: it compared Foundation L1 height
`12128839` with receipt L2 height `328950104`. The corrected verifier checks
matching raw receipt/header L1 context. Owner-selected read-only verification
passed without changing the original failed outcome, seal, journal or artifacts.
This does not permit an incompatible resume or certify whole-product release.

## Artifact path

- `jurisdictions/ignition/deployments/eth-sepolia-ignition-01/` and sibling `eth-sepolia-ignition-01.readonly-final.json`.
- `jurisdictions/ignition/deployments/arb-sepolia-ignition-01/` and sibling `arb-sepolia-ignition-01.readonly-final.json`.
- Local scoped result: `docs/evidence/deployment-check/2026-11-13T22-29-23.491Z-59664/result.json`. Generated evidence is excluded from commits by owner decision; preserve active public native evidence.
- [CLI inputs/outputs and read-only command](deployment/ignition-stack-design.md#read-only-verification-of-an-existing-deployment).
- Delivery records: [Ethereum](../.scratch/sepolia-arbitrum-deployment/issues/03-ethereum-sepolia-delivery.md), [Arbitrum](../.scratch/sepolia-arbitrum-deployment/issues/04-arbitrum-sepolia-delivery.md).

## Next single command

```sh
git status --short --branch
```

Inspect remaining unrelated owner work and generated local evidence separately.
The owner authorized separate code and documentation commits for this slice;
neither includes generated evidence or unrelated owner files. No further public
deployment or signing is needed for these two existing stacks. No push.

## Remaining final gates

- A clean committed release run is not claimed. The executable commit matches the green scoped source/artifact hashes; executable changes require owning checks and the applicable profile again.
- USDC funding/approval/deposit/withdrawal, the reserve roundtrip, Cross-J and interrupted-transfer proof are separate unrun financial tasks.
- Discovery/Runtime activation and TS/Rust HTTP/UI integration remain deferred consumers.
- Whole-product/mainnet acceptance still requires the full repository/browser/financial/release gates and a clean committed candidate. None is established by these contract-deployment results.
