# Current xln execution handoff

## Current SHA

- Verified executable commit: `c8fcff807e26af4569d9135d08216c1b93efce0a`, owner-approved `testnets_deploy`. Documentation-only descendants preserve this executable identity; inspect the branch tip with `git rev-parse HEAD`.
- Public execution base: `2df74f251d3ff3a869738ee1b77787f4be58185b`, dirty, as preserved in both original reports. The later source commit matches all thirteen reviewed executable/configuration/test hashes.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged. No push. Both owner-selected public financial roundtrips completed once each.
- The checked executable candidate stayed byte-identical throughout verification and commit preparation. Documentation-only finalization followed; no clean-tree release is claimed.
- Apply the [owner-approved task exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions). Prior documentation cleanup, public-proof/Svelte work, `todo.md` and all 185 public deployment files are preserved.

## Last green command

```sh
bun run stand:run --reason usdc-arbitrum-sepolia --timeout-ms 660000 -- \
  bun --env-file="$HOME/.config/xln/testnet-deployer.env" \
  jurisdictions/scripts/usdc-reserve-roundtrip.ts \
  --network=arbitrum-sepolia --chain-id=421614 \
  --token=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d \
  --deployment-dir="$PWD/jurisdictions/ignition/deployments/arb-sepolia-ignition-01" \
  --confirmations=12
```

Exit zero, `status: complete`. Actual public Arbitrum Sepolia USDC wallet
`20 -> 19 -> 20`, reserve `0 -> 1 -> 0`, debt zero, Entity nonce `0 -> 1 -> 2`.
Three successful receipts reached at least twelve confirmations each; final L2
snapshot block `329238618`. Actual native fees and balance reduction both equal
`7654409540000` wei; unexplained difference zero. Nitro receipt fields are
preserved; `gasUsedForL1` is zero in all three. Independent read-only Foundry
`cast` verification passed receipts, Transfer logs, Nitro fields and all
historical balance fields; latest/pending EOA nonce both `30`.

The earlier public Ethereum run also passed: wallet `9 -> 8 -> 9` USDC, reserve
`0 -> 1 -> 0`, debt zero, exact fees `12869822` wei, final block `12135184`,
latest/pending EOA nonce `106`. Its seven evidence files are unchanged. Each
public run executed once with no financial retry; the ticket is **12/12** complete.

Before this unchanged executable candidate ran publicly, its owning suite passed
**15 tests / 65 assertions in 227.39 s**. Then `bun run check:deployment` passed
**6/6 gates**: artifact parity, strict
deployment types, lint, **274 Hardhat tests, 64 Foundry checks and 125 Bun tests /
3,645 assertions**. All **22/22** native interruption cuts passed. Its native
gate took 1,045.678 s. All **571** covered source hashes stayed stable; all
**181** compiler/ABI/TypeChain artifact hashes matched the original baseline.
Both independent read-only review axes have no remaining findings.

Both prior isolated Anvil forks passed with the real token/XLN contracts and
zero upstream writes. They remain distinct from public receipts. The
[operator guide](deployment/usdc-reserve-roundtrip.md) records their pinned
blocks and the Arbitrum Nitro fee/precompile limits.

## First red command/error

None in the selected probe scope. Both required public roundtrips passed.
These same-chain checks do not prove Cross-J, L1 finality, browser behavior,
a whole-product release or mainnet readiness.

## Artifact path

- [Probe operator guide](deployment/usdc-reserve-roundtrip.md); [completed financial ticket](../.scratch/sepolia-arbitrum-usdc-roundtrip/issues/01-one-usdc-reserve-roundtrip.md).
- [Public Ethereum receipts and balances](evidence/usdc-roundtrip/ethereum-sepolia-20261114-01/result.json); [independent cast verification](evidence/usdc-roundtrip/ethereum-sepolia-20261114-01/cast-verification.json). Durable local evidence is excluded from source commits by owner policy.
- [Public Arbitrum receipts and balances](evidence/usdc-roundtrip/arbitrum-sepolia-20261114-01/result.json); [independent cast verification](evidence/usdc-roundtrip/arbitrum-sepolia-20261114-01/cast-verification.json).
- CLI: `jurisdictions/scripts/usdc-reserve-roundtrip.ts`; implementation: adjacent `usdc-reserve-roundtrip/`; runnable owning tests are named in the operator guide.
- Original public records remain under `jurisdictions/ignition/deployments/`; execution source `49c26224497d5e875c369098f02d515e0fb81134` and verifier source `cb52df9da1b0e1f0291db08074df122680da4526` are distinct from this probe candidate.
- Owner retention policy applied: removed 7,035 generated local evidence files and two symlinks, 1,084,615,639 regular-file bytes. Public native evidence is unchanged. Deleted detailed cases cannot be reconstructed from these summaries alone.

## Next single command

```sh
git status --short
```

Inspect remaining generated public evidence and unrelated owner edits after the
owner-selected code/documentation commits. No further signing, financial
operation or push is currently requested.

## Remaining final gates

- None outstanding for the two required public reserve roundtrips: **12/12** acceptance criteria, `Completed: yes`. The observed Arbitrum poster component was zero; a nonzero poster-fee case was not exercised.
- Preserve the checked source. Executable changes require owning checks and the applicable profile again; documentation-only edits use diff/link validation. Public reports retain their original dirty execution identity.
- The new probe tests are included in the deployment profile. The older 29 adapter tests remain separately checked and unchanged; `verify`/pre-push profile selection is still a separate follow-up.
- Cross-J, browser/UI, further Stack Manager HTTP/Rust integration and whole-product/mainnet gates remain separate and unrun.
