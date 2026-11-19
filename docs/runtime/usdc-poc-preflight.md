# Public USDC PoC preparation

The [fresh public stand preflight](usdc-poc-fresh-demo.md) records the
separate one-run demo option on the existing contracts.

Ticket 05 remains **incomplete until separate operator funding**, by owner decision
2026-11-17. Ticket 06 has not started. No public financial transaction has been
broadcast during this preparation. The local financial journey and its recovery
matrix remain separate evidence from a public Cross-J transfer.

## Observed boundary

The [preparation evidence](../evidence/ts-usdc-cross-j-poc/local-evidence.md#public-preflightjson)
records the exact candidate, configuration digest, deployment inputs, chain
points, code hashes, payer identities, balances, unsigned calls and estimates.
Private vaults and Runtime stores remain under
`.logs/ts-usdc-cross-j-poc/public/`, with private directory/file permissions.

- Ethereum Sepolia `11155111` and Arbitrum Sepolia `421614` both pass sealed
  deployment verification and verification against current canonical artifacts.
- A dedicated user Runtime opens one Account on each chain through the normal
  production commands. Both Account heads and reciprocal Hankos agree with the
  independent Hub Runtime. Signed profiles and effective cover tariffs are
  retained. The target signer EOA in the identity inventory is address B.
- Separate TS Hub/MM processes use the canonical authenticated relay and direct
  transport. All probe processes stop after observations; the report is not a
  claim that a service remains running.
- The prepared identities have no funded on-chain position. The available
  deployment-wallet pool is separate capital. A wallet balance does not fund a
  Hub reserve or establish MM/User credit.
- The observed MM phase is blocked before financial bootstrap; the Hub has no
  committed executable maker order. Gross target quote, exact target credit,
  total cover fee and final payout therefore remain unset.

The existing global `jurisdictions/jurisdictions.json` contains the older
Sepolia/USDT deployment. This operation creates a separate catalog using the
verified USDC manifests; it does not admit the old catalog as the selected stack.

## Confirmed software blockers

The retained public report predates the USDC-only MM readiness fix in
[ticket 07](../../.scratch/ts-usdc-cross-j-poc/issues/07-usdc-only-mm-bootstrap.md).
MM readiness now requires the configured markets: USDC-only Cross-J needs
committed Accounts and actual Cross-J depth, without an unrelated same-J book.
Configured same-J markets still require their books, and an empty market
configuration stays unready.
See [per-job readiness](../../core/orchestrator/market-maker/node/mm-node-core.ts),
[aggregate health](../../core/orchestrator/market-maker/node/mm-node-health.ts)
and [the quote lifecycle](../../core/orchestrator/market-maker/node/mm-node-run.ts).

The [local lifecycle regression](../../core/__tests__/market/startup/usdc-only-bootstrap.test.ts)
starts independent Hub/MM Runtimes on two private Anvil chains with one
registered USDC each. It reaches `offers-ready` with nine committed offers in
each Cross-J direction and zero same-J offers. The
[retained local evidence](../evidence/ts-usdc-cross-j-poc/usdc-only-mm-bootstrap.json)
also records the green mixed-market financial journey and full check. This is
a dirty local candidate, not a refreshed public quote or a public transfer.

Other prerequisites before a public financial run remain separate:

- The [financial CLI](usdc-poc-execution.md) from completed ticket 08 uses verified
  public configuration and dedicated signers through the shared canonical commands.
  The separate local fixture still owns Anvil funding; it is not the public runner.
- The gateway is read-only by default. Its explicit execution mode enforces an
  approved finite normal-flow grant. No public grant is approved. Funder-paid
  operator prefunding, native ETH transfers and forced recovery are outside this
  grant and need their own scoped execution and authority.
- The fresh operator probe creates new attempt stores and rejects funded
  identities. The [restore launcher](usdc-poc-session.md) selects existing vaults
  and stores and restores the canonical checkpoint/WAL/outbox. Its local funded
  validation does not establish current public readiness or spending authority.
- Current automatic Hub/MM credit setup uses a USD 2,000,000 notional. This is
  a signed credit allowance, not a requirement to deposit 2,000,000 USDC.
  Public Hub reserve readiness separately tests a positive reserve. Neither
  value determines the liquidity required by this particular PoC.
- Normal maker offers have their own sizing policy, including a minimum quote
  notional of 10 token units. That is not a minimum user swap: a one-USDC user
  operation may consume part of a larger maker order. Actual maker exposure,
  available capacity and target cover still require reconciliation.

Software preparation can continue without public funding. Ticket 05 remains
incomplete until its full acceptance criteria and the owner's separate-funding
condition are satisfied. Separate tasks and their dependencies are recorded in
the [blocker tickets](../../.scratch/ts-usdc-cross-j-poc/map.md#blocker-tickets):
public CLI (08), the funded restore launcher (09), capital/gas plan (10) and separately
approved funding (11), followed by final preparation (05) and public proof (06).

The [financial CLI](usdc-poc-execution.md) now provides public configuration,
distinct run identities, same-WAL recovery and finite payer/nonce grants, with
private-chain execution evidence. It does not supply missing public liquidity
or approve spending. Its explicit history RPC role uses archive state separately
from the current Runtime RPC. Refresh the retained preflight and capital packet
against the selected executable candidate before funding approval.

Ticket 10 now has a separate [capital/gas decision packet](usdc-poc-capital-plan.md)
with refreshed chain observations, unchanged operator credit exposure, unsigned
funding calls and proposed native limits. Its completion means preparation only:
funding authority is still absent, and conditional funding estimates do not
complete this ticket's executable quote or full journey/recovery cost checks.
The packet now budgets five sequential one-USDC runs, with 5 USDC in the target
Hub reserve and a separate 5-USDC user budget. Repeatable run identities and
per-run evidence belong to 08; quote/backing checks and cumulative journey gas
for the series remain required here. Operator funding is once per series.

## Read-only commands

Load RPC credentials through the existing protected env file. No command below
uses its deployment private key to sign a transaction.

```sh
POC_RUNTIME_421614_RPC=https://sepolia-rollup.arbitrum.io/rpc \
  bun --env-file=/Users/nick/.config/xln/testnet-deployer.env \
  jurisdictions/scripts/usdc-cross-j-preflight/index.ts
```

Exit `2` means a completed observation with explicit blockers; exit `1` means
verification failed. The operation writes `public/preflight.json` privately.
The expected current result is blocked, with no spending approval.

```sh
bun run stand:status
POC_RUNTIME_421614_RPC=https://sepolia-rollup.arbitrum.io/rpc \
  bun run stand:run --reason poc-public-preparation --timeout-ms 180000 -- \
  bun --env-file=/Users/nick/.config/xln/testnet-deployer.env \
  jurisdictions/scripts/usdc-cross-j-preflight/operators/local-operators.ts
```

The operator probe first verifies that the prepared identities remain unfunded.
It rejects funded identities before starting fresh stores. After separate funding,
restore the recorded Runtime directories and their WAL through canonical startup;
this fresh preparation probe cannot replace their financial state.

The only local entry point is `http://localhost:8080`: `/rpc`, `/rpc2` and
`/relay`. Hub/MM process endpoints are internal. The gateway allowlist rejects
signing, transaction submission and chain-mutation methods before transport.

The archive RPC authenticates historical deployment origin and artifacts. The
explicitly selected runtime RPC independently checks current code, bindings,
USDC registration and balances. Their endpoint fingerprints and observation
points are recorded. There is no automatic endpoint failover. The official
[Arbitrum chain information](https://docs.arbitrum.io/chain-info) identifies the
selected runtime endpoint; its pruned historical state cannot replace archival
deployment verification.

## Funding and native-gas preparation

User principal remains exactly `1_000_000` source units. Funding either Hub and
meeting MM credit/capital requirements are separate operator operations. Their
amounts must be reconciled with an actual executable quote before completing
ticket 05. Source and target Hub reserves are currently zero.

The read-only report estimates source-user token funding/approval and the
operator approvals used before direct E2R contributions to Hub reserves.
Each call records its payer, destination, calldata, amount and chain point.
It does not add an unnecessary ERC20 transfer through a Hub/MM wallet to the
canonical operator-to-Hub reserve contribution.

These are **proposed allocation envelopes**, in ETH, not measured total costs or
approved spending limits:

| Chain            | Payer          | Normal | Recovery reserved | Total |
| ---------------- | -------------- | -----: | ----------------: | ----: |
| Ethereum Sepolia | Funding wallet |  0.010 |                 0 | 0.010 |
| Ethereum Sepolia | User           |  0.030 |             0.050 | 0.080 |
| Ethereum Sepolia | Hub            |  0.030 |             0.050 | 0.080 |
| Ethereum Sepolia | MM             |      0 |             0.030 | 0.030 |
| Arbitrum Sepolia | Funding wallet |  0.005 |                 0 | 0.005 |
| Arbitrum Sepolia | User           |  0.010 |             0.015 | 0.025 |
| Arbitrum Sepolia | Hub            |  0.020 |             0.020 | 0.040 |
| Arbitrum Sepolia | MM             |      0 |             0.030 | 0.030 |

The proposed chain totals are `0.200` and `0.100` ETH, including recovery.
Internal ETH top-ups move this capital between payers; they are not additional
gas expenditure. USDC principal and operator liquidity are excluded.

Full E2R/R2C, cover, bilateral C2R/R2E and forced-recovery estimates remain
incomplete. No public cumulative spending authority is approved. Ticket 08's
normal-flow controller reserves finite nonce windows and their worst-case fees;
the proposed table does not automatically become that controller's manifest.
Forced dispute/recovery calls require separate preparation and authority. Current adapter
defaults are 20% gas headroom, a 200-gwei per-gas fee ceiling and a 12.5% minimum
replacement bump; explicit environment settings are recorded separately. These
per-transaction settings cannot certify the proposed cumulative envelopes.
Pending liability, replacements and recovery must fit the approved payer limit.

Arbitrum estimates include NodeInterface components. Its L1 poster component is
already represented inside the total gas estimate: do not add it twice.
An observed zero L1 estimate is not a permanent zero-cost assumption. See the
[official fee-estimation guide](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas).

## Runtime fixes exercised by preparation

Catalog publication metadata is projected to the four exact `importJ` bindings
before admission; the WAL decoder remains strict. Public Hub/MM token plans use
the admitted registry, including a base MM identity for a single-token Cross-J
market. Development token defaults stay on development chains.

The Ethereum header verifier includes `blockAccessListHash` and `slotNumber` in
canonical order, matching [go-ethereum's Header](https://github.com/ethereum/go-ethereum/blob/master/core/types/block.go).
A captured Sepolia header reproduces the original failure and now verifies;
mutated commitments still fail to retain the authentic block hash.

A watcher with no relevant local Entity preserves its cursor until an Entity
exists. The owning real-chain regression verifies bounded header reads before
import and restoration of funded reserves after 2,000 additional blocks. It does
not skip history or accept an unproven snapshot.

Refresh the preparation after funding or any change to the candidate, endpoint,
calldata, payer, signed terms or relevant chain state. Public execution remains
blocked until ticket 05 is complete and the owner approves numeric ETH limits.
