# 10: Prepare an explicit operator-capital and payer-specific gas decision

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: 07 - Finalize USDC-only MM bootstrap through committed Cross-J quotes

## Problem

Signed operator credit defaults to USD 2,000,000 notional, public reserve
readiness checks only a positive amount, and normal maker offers have their
own sizing policy. None establishes the actual capital or gas required for
this one-USDC journey. Current draft ETH allocations are unapproved envelopes,
not complete measured costs.

## Acceptance criteria

- [x] Distinguish actual USDC wallet funds, on-chain Hub reserves/collateral,
      bilateral credit exposure and executable maker offer depth for each chain.
      Explain which obligations require funding and which only grant credit.
- [x] Calculate required capital from the actual configured maker policy,
      selected one-USDC route, effective signed tariffs and target cover/backing.
      Keep maker minimum offer size separate from user minimum execution size.
- [x] Present existing operator credit/quote exposure and any proposed change
      explicitly. Do not silently reduce defaults or present a credit allowance as
      a required token deposit. Obtain the owner's decision for a changed policy.
- [x] Inventory current funds at identified chain points and prepare concrete
      unsigned funding calls with payer, recipient, asset, amount and destination
      reserve. Keep operator capital separate from the user's one-USDC principal.
- [x] Estimate funding gas by payer/chain, including Arbitrum components and
      replacement assumptions. Prepare limits for approval before ticket 11;
      distinguish measured estimates, conditional estimates and missing estimates.
- [x] Identify the remaining journey/recovery cost estimates required by 05.
      Refresh funding-dependent quote and estimate observations after 11; never
      require a funded executable quote to authorize its prerequisite funding.
- [x] Bind the decision packet to the executable/configuration candidate and
      current observations. No public broadcast occurs in this ticket.

## Comments

Prepared 2026-11-17: [capital/gas decision](../../../docs/runtime/usdc-poc-capital-plan.md)
and [unsigned evidence packet](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-capital-planjson).
Completion means the plan is prepared, not approved. Existing credit and maker
sizing are unchanged; no changed-policy decision was executed. Owner-selected
planning revision: five sequential forward runs, each depositing exactly 1 USDC.
Proposed operator capital is 1 USDC in the source Hub reserve and 5 USDC in the
target Hub reserve. The source amount retains the earlier discretionary buffer;
it is not a measured requirement. The user's separate 5-USDC budget funds five
individual one-USDC runs outside ticket 11. Projected total payout is 4.499005
USDC, leaving 0.500995 USDC of target Hub reserve if terms remain unchanged.
The unchanged nine-level maker projection is about 208,000 USDC per direction,
against 2,000,000-USDC credit grants per side; this is not fully backed by the
proposed five-run funding.

Read-only verification: 2 chains, 6 prepared identities, 4 empty on-chain Account
collateral positions, 2 canonical offline restores, 2 signed user tariffs and
2 operator Accounts. Four funding calls have current RPC estimates; two E2R
gas caps remain explicitly conditional on authorized Hanko/allowance. Full
journey/recovery estimates remain in 05. Funding-payer fee caps proposed for
approval are 0.002 ETH on Ethereum and 0.0002 ETH on Arbitrum; including native
Hub topups, maximum funder outflows are 0.003 / 0.0003 ETH respectively. These
are ceilings, not measured total cost or spending authority.

All 69 executable candidate source/configuration hashes stayed unchanged during
the observations; only documentation/evidence was edited. Final checks validate
packet arithmetic, exact principal/fee/payout bounds, unsigned batch decode,
tariff equality, local links and the diff. Public broadcasts and new funding
Hanko authorizations: 0. The five-run revision refreshes four exact funding-call
estimates and two identified funder/Hub balance observations, decodes both
unsigned deposits and approvals, and recomputes both Hanko signing digests.
The two E2R gas caps stay conditional. Per-run principal/payout constraints and
the five-row reserve ledger are checked; unchanged source hashes permit reuse
of the prior executable validation. Tickets 05, 06 and 11 remain incomplete.
Ticket 08 can proceed before public funding and must support repeated runs
with distinct operation identities and per-run recovery/evidence.

Preparing a plan does not approve it. Ticket 11 requires explicit amounts and
numeric native-gas authority from the owner. Full-journey authority remains a
separate prerequisite for 06. This ordering avoids a dependency cycle through 05.

References: [preflight guide](../../../docs/runtime/usdc-poc-preflight.md),
[Hub reserves](../../../core/orchestrator/hub/node/hub-reserves.ts),
[MM offer policy](../../../core/orchestrator/market-maker/node/mm-node-core.ts).

Ticket-11 update, 2026-11-17: the separate bounded executor is implemented and
verified locally. The [refreshed unsigned proposal](../../../docs/evidence/ts-usdc-cross-j-poc/operator-funding-proposal.json)
now binds that candidate, current sealed-stack checks, funder nonce domains,
Hub recipients, unsigned calls and four current gas estimates. Its manifest is
unapproved; the [funding guide](../../../docs/runtime/usdc-poc-operator-funding.md)
records the exact allocations and limits. The older ticket-10 observations above
remain historical planning evidence. Public funding and 05/06/11 are incomplete.
