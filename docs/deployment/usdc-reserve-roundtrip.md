# One-USDC reserve roundtrip probe

The probe checks reserve ingress and egress independently on one chain:
an external wallet deposits exactly `1_000_000` six-decimal token units into
its own XLN reserve, then withdraws exactly that amount to the same wallet.
The [specification](../../.scratch/sepolia-arbitrum-usdc-roundtrip/spec.md)
owns the local demonstration and the two separate public runs.

## Inputs

Run `bun jurisdictions/scripts/usdc-reserve-roundtrip.ts` from the repository
root with explicit inputs:

Arguments use `--name=value`; separate `--name value` arguments are rejected.

| Argument           | Meaning                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `--network`        | `local`, `ethereum-sepolia` or `arbitrum-sepolia`                                                    |
| `--chain-id`       | Expected chain ID: `31337`, `11155111` or `421614`, respectively                                     |
| `--token`          | Expected token address, matched to the original deployment and live registry                         |
| `--deployment-dir` | Original native deployment directory with its manifest, journal, execution seal and sealed artifacts |
| `--confirmations`  | Optional depth; cannot reduce the original deployment's minimum of twelve                            |

RPC values come from `XLN_STACK_MANAGER_RPC_URL` for the local fixture,
`ETH_SEPOLIA_RPC` for Ethereum Sepolia or `ARB_SEPOLIA_RPC` for Arbitrum Sepolia.
The external wallet key uses the existing `DEPLOYER_PRIVATE_KEY` environment
channel. Keep keys and credential-bearing RPC URLs out of arguments and logs.
The wallet may differ from the original deployer; it controls its own lazy Entity.

## Local demonstration

```sh
bun run stand:status
bun run stand:run --reason usdc-reserve-roundtrip --timeout-ms 300000 -- \
  bun test core/__tests__/network/jurisdiction/usdc-reserve-roundtrip.test.ts \
  core/__tests__/network/jurisdiction/usdc-reserve-roundtrip-evidence.test.ts
```

The test creates a real local Anvil stack and explicitly labelled six-decimal
fixture token using existing contract tooling. Fixture funding occurs before
the measured roundtrip. The deposit itself must transfer tokens from the
wallet through the normal signed batch; fixture funding is not deposit evidence.
The local token establishes no issuer-backed public USDC provenance.

## Ethereum Sepolia fork rehearsal (2026-11-14)

The unchanged CLI also passed on an isolated Anvil fork of Ethereum Sepolia,
pinned at block `12135037`, hash
`0x33df9eb970341d5cfa12e794d22e4f52a6245b33798c385ab9757fb65b60125b`.
It used the existing USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
and existing XLN deployment, preserving chain ID `11155111`. No replacement
token, deployment, mint, impersonation or balance override was used.

Wallet units were `9000000 -> 8000000 -> 9000000`; reserve units were
`0 -> 1000000 -> 0`. Approval, deposit and withdrawal each had twelve local
confirmations. Local native fees and balance reduction both equalled
`382021002674147` wei. The upstream proxy forwarded only reads; public ETH,
USDC and EOA nonce `103` were unchanged. This verifies the forked-state path;
public financial acceptance remains separate.

## Arbitrum Sepolia fork rehearsal (2026-11-14)

The unchanged CLI also passed on an isolated Anvil fork of Arbitrum Sepolia,
pinned at L2 block `329232602`, hash
`0xe3415843af0d6cbdfb2251ddd4dc7f4072c6d544132d235b2fd6d8e9ea9833aa`.
It used existing USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` and
the existing XLN deployment, preserving chain ID `421614`.

Wallet units were `20000000 -> 19000000 -> 20000000`; reserve units were
`0 -> 1000000 -> 0`. All three successful local receipts reached twelve
confirmations. Local native fees and balance reduction both equalled
`382191035293864` wei. Original EntityProvider receipt/header L1 context was
preserved exactly: `12128839` alongside L2 creation block `328950104`.
Public ETH, USDC and EOA nonce `27` were unchanged; upstream writes were zero.

This is forked-contract evidence. New local receipts do not contain Nitro's
`l1BlockNumber`/`gasUsedForL1` extensions, so this run does not establish actual
Nitro fee or precompile semantics. The public results below are separate runs.

## Public Ethereum Sepolia result (2026-11-14)

The owner-selected public run completed once, without financial retries, using
the unchanged checked CLI. This was Ethereum Sepolia, chain `11155111`, using
USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` and Depository
`0x32A4A72992aD142E36fA1C5989b95FeD60987818`. The external signer and withdrawal
recipient were both `0x42Da3Ba8c586F6fe9eF6ed1d09423eB73E4fe25b`.

Command executed from the repository root:

```sh
bun run stand:run --reason usdc-eth-sepolia --timeout-ms 660000 -- \
  bun --env-file="$HOME/.config/xln/testnet-deployer.env" \
  jurisdictions/scripts/usdc-reserve-roundtrip.ts \
  --network=ethereum-sepolia --chain-id=11155111 \
  --token=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 \
  --deployment-dir="$PWD/jurisdictions/ignition/deployments/eth-sepolia-ignition-01" \
  --confirmations=12
```

The actual invocation redirected stdout/stderr into fresh evidence files outside
the original deployment directory. It exited zero with `status: complete`.

| Operation               | Public transaction                                                                                               | Block    | Depth at final snapshot | Fee, wei |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | -------- | ----------------------- | -------- |
| Approve exactly 1 USDC  | [Approval](https://sepolia.etherscan.io/tx/0xa46bd4dfe1ec6fb080dc2f09c3b4025711aded48bda5eec54677e523251359ad)   | 12135148 | 37                      | 2479626  |
| Deposit exactly 1 USDC  | [Deposit](https://sepolia.etherscan.io/tx/0x7e7a59f3bd4ea99bc2cce2ea58adfe2b3c7063a6e68c742be51cb1c361a1ef01)    | 12135160 | 25                      | 7762642  |
| Withdraw exactly 1 USDC | [Withdrawal](https://sepolia.etherscan.io/tx/0x357bbb5899b4b0cf2b60611f225e40bf3c32c0255a7e5bca4a3f43add6e8b0a8) | 12135173 | 12                      | 2627554  |

All three receipts have status `0x1`. The canonical final snapshot is block
`12135184`, hash `0x1699b5abfee4a9e78a3b0d6b8a393907d5436ac25c4d8a9982582b0e158e308f`.

| Snapshot block      | Wallet USDC atomic units | Reserve atomic units | Debt | Entity nonce | Wallet native wei    |
| ------------------- | ------------------------ | -------------------- | ---- | ------------ | -------------------- |
| 12135147, initial   | 9000000                  | 0                    | 0    | 0            | 41202999650308634752 |
| 12135171, deposited | 8000000                  | 1000000              | 0    | 1            | 41202999650298392484 |
| 12135184, restored  | 9000000                  | 0                    | 0    | 2            | 41202999650295764930 |

USDC Transfer logs confirm wallet-to-Depository and Depository-to-wallet transfers
of exactly `1000000` each. Native reduction and summed receipt expenses both equal
`12869822` wei (`0.000000000012869822` ETH); unexplained native difference is zero.
Approval was consumed by the deposit; allowance is zero at all three snapshots.

The [raw report](../evidence/usdc-roundtrip/ethereum-sepolia-20261114-01/result.json)
records dirty probe base `2df74f251d3ff3a869738ee1b77787f4be58185b`, seven exact
probe source hashes, original deployment identity, receipts and balance points.
An independent [Foundry cast verification](../evidence/usdc-roundtrip/ethereum-sepolia-20261114-01/cast-verification.json)
re-read all three receipts and all six balance fields at each historical snapshot.
It confirmed chain/signer identity, USDC transfer directions, native conservation
and EOA nonce `106` for both latest and pending. At its observed block `12135186`,
receipt depths were `39/27/14`; it signed and broadcast zero transactions.
The probe was uncommitted during public execution; its later committed identity
is recorded below. The original deployment was executed from
`49c26224497d5e875c369098f02d515e0fb81134`; this run did not redeploy it.
Original native deployment records remain unchanged. Public financial evidence
is retained locally and excluded from source commits under the owner policy.

## Public Arbitrum Sepolia result (2026-11-14)

The owner separately selected this public run. The same unchanged CLI completed
once with no financial retries on chain `421614`, using USDC
`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` and Depository
`0x8223AA4c60Adb851f53a120c3D3841De9e77c188`. The external signer and withdrawal
recipient were both `0x42Da3Ba8c586F6fe9eF6ed1d09423eB73E4fe25b`.

Command executed from the repository root, with stdout/stderr redirected to
fresh files outside the original deployment directory:

```sh
bun run stand:run --reason usdc-arbitrum-sepolia --timeout-ms 660000 -- \
  bun --env-file="$HOME/.config/xln/testnet-deployer.env" \
  jurisdictions/scripts/usdc-reserve-roundtrip.ts \
  --network=arbitrum-sepolia --chain-id=421614 \
  --token=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d \
  --deployment-dir="$PWD/jurisdictions/ignition/deployments/arb-sepolia-ignition-01" \
  --confirmations=12
```

| Operation               | Public transaction                                                                                              | L2 block  | Depth at final snapshot | Fee, wei      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | --------- | ----------------------- | ------------- |
| Approve exactly 1 USDC  | [Approval](https://sepolia.arbiscan.io/tx/0x752cd332f5c8cf87712f82b600a246a4bed9e530fd1c7f12dd38fdc3636f75ad)   | 329238549 | 70                      | 1108740000000 |
| Deposit exactly 1 USDC  | [Deposit](https://sepolia.arbiscan.io/tx/0x1f8788ffd02ef92765965fd7cbffc1ad1fef4f5b98cb8b463a6a9f37df285393)    | 329238575 | 44                      | 3781629540000 |
| Withdraw exactly 1 USDC | [Withdrawal](https://sepolia.arbiscan.io/tx/0x76203ec3aee0f8c0ed5e6334a3cc757e8eaa97561af1418f017cb89af9e1322a) | 329238601 | 18                      | 2764040000000 |

The CLI exited zero with `status: complete`; all receipts have status `0x1`.
The canonical final snapshot is L2 block `329238618`, hash
`0x59085d2c61001f368e94b02c44fa1f3e8b3c3161c4303e24911bc64c4a02a265`.

| Snapshot L2 block    | Wallet USDC atomic units | Reserve atomic units | Debt | Entity nonce | Wallet native wei  |
| -------------------- | ------------------------ | -------------------- | ---- | ------------ | ------------------ |
| 329238538, initial   | 20000000                 | 0                    | 0    | 0            | 528577054914845600 |
| 329238591, deposited | 19000000                 | 1000000              | 0    | 1            | 528572164545305600 |
| 329238618, restored  | 20000000                 | 0                    | 0    | 2            | 528569400505305600 |

USDC Transfer logs confirm exactly `1000000` units in each direction. Allowance
is zero at all three snapshots. Native reduction and summed receipt expenses
both equal `7654409540000` wei (`0.00000765440954` ETH), with zero unexplained
difference. Each type-2 receipt cost is `gasUsed * effectiveGasPrice`.

Actual Nitro receipts preserve `l1BlockNumber` values `12135212/12135213/12135213`
and `gasUsedForL1 = 0` for all three operations. The parent-chain poster component
is represented in child-chain gas units and belongs inside the total charge;
it must not be added twice. See the official [Arbitrum gas and fees documentation](https://developer.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees)
(accessed 2026-11-14). This run observes a zero poster component; it does not
exercise a nonzero poster-fee case. L2 confirmation depth does not certify L1
finality.

The [raw report](../evidence/usdc-roundtrip/arbitrum-sepolia-20261114-01/result.json)
records the dirty probe base `2df74f251d3ff3a869738ee1b77787f4be58185b`, seven
probe source hashes, original deployment identity and raw receipts/snapshots.
An independent [Foundry cast verification](../evidence/usdc-roundtrip/arbitrum-sepolia-20261114-01/cast-verification.json)
re-read receipts, Nitro fields, USDC transfer directions and all six balance
fields at each historical point. Its observed L2 block `329238692` gave receipt
depths `144/118/92`; latest/pending EOA nonce both equalled `30`.
It signed and broadcast zero transactions. Original deployment evidence and
the earlier Ethereum roundtrip evidence were preserved unchanged.

## Committed source identity

Probe source, owning tests and deployment-profile integration were committed
after both public runs as `c8fcff807e26af4569d9135d08216c1b93efce0a`.
All thirteen executable/configuration/test files match the reviewed snapshot;
all 571 covered source hashes and 181 artifact hashes remain unchanged.
The prior green owning suite and six-gate deployment profile therefore cover
the same executable contents. Commit preparation changed documentation only.

Original public reports retain their actual dirty execution base
`2df74f251d3ff3a869738ee1b77787f4be58185b` and seven probe source hashes.
Those observations are not relabelled as clean-tree runs at the later commit.
Unrelated owner edits and generated evidence remain outside the source commits;
whole-product release acceptance is separate.

## Checks and outputs

Before spending, the probe verifies the original sealed deployment identity,
current contract code/bindings, chain and token dimensions, wallet funding and
a clean debt-free reserve. It uses the existing batch/Hanko signing and token
operations; the amount is fixed rather than a user-configurable quote.

Approval is sent only when required. Native funding is checked against the
actual gas estimate and current fee policy before each broadcast. This is a
staged check, not an upfront worst-case budget for all future operations.

JSON on stdout reports chain/token/wallet identity, confirmed transactions,
chain-height balance snapshots and separate native expenses. Phase and known
transaction identifiers are emitted on stderr. Preserve any redirected report
in a fresh file outside the original deployment directory.

For success, the deposit decreases the wallet token balance by `1_000_000` and
increases its reserve by the same amount. Withdrawal restores both balances
exactly. ETH gas is reconciled separately using the existing receipt-expense
logic, including the target network's fee semantics.

A failure reports its phase and known transactions/balances and exits nonzero.
Inspect those observations before another invocation; the probe does not
automatically repeat a financial operation or resume an interrupted roundtrip.

## Public execution boundary

Both public stacks have [deployment records](ignition-stack-design.md#verified-public-deployments-2026-11-14).
The owner separately selected both public runs above; each completed its own
preflight, approval, deposit, withdrawal and exact balance/native-cost checks.
The financial ticket is complete with all twelve acceptance criteria checked.
Future invocations require their own authority and fresh prerequisites; the CLI
does not authorize automatic repetition or interrupted-transfer recovery.

These are two independent same-chain reserve roundtrips. Cross-J,
liquidity, quotes, settlement/dispute expansion and UI remain separate tasks.

The local implementation and applicable deployment profile are verified. The
[single handoff](../night-work-plan.md) records the checked source identity,
measured counts and remaining public gates. Generated local case outputs were
removed after verification under the owner retention policy; the original
public deployment records are preserved.
