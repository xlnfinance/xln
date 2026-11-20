# TS USDC Cross-J PoC: design interview

Status: implementing
Source baseline: `b2dceb3438ff2582cee0c5741fe4a0528f5cbd26`

## Destination

Deposit exactly `1_000_000` source USDC atomic units on Ethereum Sepolia,
execute the complete source amount through the canonical TypeScript Cross-J
path, and prove the resulting net external payout on Arbitrum Sepolia.

Existing authority: [retained Cross-J decisions](../../docs/research/sepolia-arbitrum-cross-j.md).
Owner-operated Hub/MM, separate destination prefunding, native-gas accounting
and financial recovery criteria remain as already accepted there.

## Decision tree

- Canonical TypeScript PoC: accepted by the owner.
  - Q1, financial journey: accepted.
    - Deposit -> Account funding -> Cross-J with MM -> collateral cover as
      required -> external withdrawal.
    - A separate Pay between two users belongs to a subsequent scenario.
  - Q2, economics policy: accepted.
    - Use ordinary effective signed Hub tariffs and executable MM pricing.
    - The net payout budget is accepted in Q5. Actual quotes and signed
      tariffs still require preparation against the selected runtime candidate.
  - Q3, user identity isolation: accepted.
    - A dedicated PoC vault, with the existing wallet's per-stack signer
      derivation and lazy Entity creation.
    - One user Runtime owns distinct source and target signer/Entity identities.
    - Hub/MM identities and operator capital remain separate from the user.
  - Q4, external recipient: accepted.
    - Use the user's target-jurisdiction signer EOA (address B).
  - Q5, net payout budget: accepted.
    - For this test rehearsal: minimum external payout of
      `850_000` target USDC units; total source-to-payout difference at most
      `150_000` units, including quote pricing and token fees.
    - Native gas is separate. These are accepted rehearsal limits, not
      protocol caps or a measured executable quote.
  - Q6, user credit exposure: accepted.
    - Explicit per-Account credit required for this rehearsal,
      with target credit equal to the selected required gross target quote and no
      automatic increase. Do not copy the wallet's 10,000-token grant silently.
    - Operator Hub/MM credit and reserves are separate prerequisites.
  - Execution host: accepted, owner decision 2026-11-16.
    - The current computer may run implementation, builds, tests, Runtime and
      agents. The owner removed the repository's Studio-only execution rule;
      AGENTS.md records the new host policy.
    - Branch, financial authority, verification and external-review rules remain
      governed by AGENTS.md.
  - Q7, native-gas spending authority: accepted.
    - Prepare gas estimates and payer identities on both
      networks, including cover and recovery; obtain explicit native-gas
      spending limits before public financial execution.
    - Current production per-gas and replacement caps do not establish a
      cumulative budget for the complete PoC.
  - Q8, required markets for the next implementation stage: accepted, owner 2026-11-17.
    - Confirmed premise in the prior candidate: USDC-only MM lifecycle was blocked by mandatory
      same-J quote health even though its Cross-J route planner accepts USDC
      on both stacks. Funding alone cannot fix that predicate.
    - Accepted answer: keep the PoC on the existing USDC-only stacks; derive
      required market readiness from the selected configuration. Preserve all
      Account/credit/authentication/quote-depth checks and whole-product same-J
      acceptance. Do not add WETH merely to satisfy startup.
    - First patch is limited to MM startup/readiness/finalization and a full
      committed-quote lifecycle regression, tracked in ticket 07. Additional
      same-J assets, public CLI and funding are outside that patch.
    - Dependent follow-up: concrete operator credit/quote exposure and funding
      plan after implementation scope is agreed. Q1-Q7 and existing financial
      authority remain accepted; no public spending is authorized by Q8.

## Current frontier

On 2026-11-19 the owner closed [05](issues/05-public-preflight-and-gas-plan.md)
and [06](issues/06-public-sepolia-arbitrum-proof.md) for one observed public
1-USDC demo on the separately funded `fresh-UbkYJm` stand. Five receipts
confirmed the complete journey and a payout of 0.899801 USDC on Arbitrum
Sepolia. The working-tree digest, five-slot authority and WAL replay are
retained in the [public evidence](../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-executed.json).

The [post-demo scope](spec.md#scope-after-the-accepted-demo) keeps the verified
one-run CLI from ticket 16 and focuses remaining PoC work on ticket 15. The
nonce-conflict diagnostic in ticket 17 stays in the backlog.

- [14](issues/14-five-run-and-recovery-gas-plan.md) owns the five-run plan and
  cumulative recovery gas. The selected capital baseline is a 1-USDC source
  Hub buffer, 5 USDC of target Hub reserve and five 1-USDC user deposits.
- [15](issues/15-clean-candidate-public-proof.md) owns public proof on a clean
  committed candidate and the self-contained signed Cross-J trace.
- [16](issues/16-supervised-one-usdc-cli-run.md) owns the supervised CLI run
  on a funded stand and the payout and backing check before the first approval.
- [17](issues/17-read-only-usdc-run-status.md) owns read-only run inspection
  from exact receipts and the original WAL after interruption or expiry.
- The original stand's [six funding receipts](../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-publicjson)
  remain under [11](issues/11-separate-operator-funding.md). It has a confirmed
  1/5-USDC reserve allocation and 0.001/0.0001-ETH signer topups. The owner paused
  [12](issues/12-public-rpc-capacity-and-funded-catchup.md) with authenticated
  observation of that funding and exact restore of the original stores pending.
  General RPC optimization remains in the [separate research](../../docs/runtime/rpc-catchup-optimization.md).

The [specification](spec.md) retains the financial outcome and release
evidence standard. Refresh quote, signed tariff, liquidity, credit and payer
caps before each newly authorized public run. Existing Cross-J deadlines,
recovery and authenticated relay semantics remain canonical.

Production reference: [hosted wallet bootstrap](../../ui/src/runtime/hosted.ts).
Credit reference: [Cross-J capacity planning](../../core/runtime/swap-cmd/swap-command-plan.ts).
Gas reference: [staged funding checks](../../docs/deployment/usdc-reserve-roundtrip.md#checks-and-outputs).

## Interview completion

Q1-Q8 are accepted, including the owner's confirmation of the narrow first
patch. Public financial execution requires the prepared
quote, signed tariffs, liquidity and approved numeric ETH limits. Execution
host, branch, verification and financial authority remain governed by AGENTS.md
and the explicit owner decisions above.

## Blocker tickets

| Ticket                                                    | Deliverable                                                        | Dependencies and status |
| --------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------- |
| [05](issues/05-public-preflight-and-gas-plan.md)          | Public single-run preparation                                      | Complete                |
| [06](issues/06-public-sepolia-arbitrum-proof.md)          | Observed public 1-USDC demo                                        | 04 and 05, complete     |
| [07](issues/07-usdc-only-mm-bootstrap.md)                 | USDC-only MM startup through committed Cross-J depth               | Complete locally        |
| [08](issues/08-public-financial-cli.md)                   | Public configuration and authorized execution in the canonical CLI | Complete locally        |
| [09](issues/09-funded-runtime-restore.md)                 | Start and restore funded Runtimes                                  | 04, complete locally    |
| [10](issues/10-operator-capital-and-gas-plan.md)          | Capital and unsigned operator funding plan                         | 07, plan prepared       |
| [11](issues/11-separate-operator-funding.md)              | Original operator funding and canonical observation                | 09, 10 and 12, open     |
| [12](issues/12-public-rpc-capacity-and-funded-catchup.md) | Restore original funded Runtimes and observe existing deposits     | 09, paused              |
| [13](issues/13-public-report-exact-nonce-receipts.md)     | Exact nonce-based public receipt reporting                         | Complete locally        |
| [14](issues/14-five-run-and-recovery-gas-plan.md)         | Five-run and recovery gas budget                                   | 11, open                |
| [15](issues/15-clean-candidate-public-proof.md)           | Clean committed public proof and signed Cross-J trace              | 04, 05 and 06, open     |
| [16](issues/16-supervised-one-usdc-cli-run.md)            | Supervised one-USDC CLI run with pre-approval checks               | Complete locally        |
| [17](issues/17-read-only-usdc-run-status.md)              | Read-only status for interrupted or completed runs                 | P3 deferred             |

Ticket 12 uses the existing funding receipts under the original Runtime
identities. Following the single-run closure, its outstanding observation
blocks the original-stand work in 11 and 14. Ticket completion records
evidence. Public spending requires a separate grant for the exact run.
