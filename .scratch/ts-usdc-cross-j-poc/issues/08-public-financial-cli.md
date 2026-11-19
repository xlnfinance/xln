# 08: Run the canonical financial journey with verified public configuration

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: 03 - Cover the target claim and withdraw at least 0.85 USDC

## Problem

The working financial scenario requires local chain IDs 31337/31338, uses
Anvil genesis funding and signs the target batch with a fixed local domain.
It cannot execute the selected public journey unchanged. The preparation
gateway intentionally rejects signing and submission.

## Acceptance criteria

- [x] Configure the existing journey from the verified USDC catalogs for
      Ethereum Sepolia 11155111 and Arbitrum Sepolia 421614. Derive signing domains,
      contract addresses and token identity from validated configuration.
- [x] Use the dedicated user vault and per-jurisdiction signers. Keep operator
      funding separate; never use the Anvil genesis key on public networks.
- [x] Reuse canonical ingress, Cross-J, cover, C2R/R2E and recovery commands.
      Keep all financial formulas and transitions in their existing owners.
- [x] Keep preparation read-only. An execution invocation explicitly identifies
      the candidate, network, payer, calls and approved numeric ETH authority;
      missing, stale or insufficient authority rejects before broadcast.
- [x] Preserve exactly 1_000_000 source units, target signer EOA/address B,
      full-source execution, external payout >=850_000 and total difference <=150_000.
      Partial recovery or cancellation is never reported as complete execution.
- [x] Support the planned five sequential runs on the same persistent identities
      and Accounts. Give each run and financial intent a distinct identity;
      resume an interrupted run under its original identity without repeating
      funding. Prove each run using balance deltas and its own financial evidence,
      without resetting funded stores or confusing an earlier payout with a new one.
- [x] Verify the configured path locally with real chain operations and its
      rejection boundaries; run the applicable profile. Public proof belongs to 06.

## Comments

This is a separately selectable follow-up, outside the approved first patch 07.
Creating this ticket does not authorize public signing or transfers. Its
implementation can proceed without funded public identities.

Owner-selected planning budget: five sequential one-USDC deposits, a 5-USDC
target Hub reserve and the unchanged proposed source Hub buffer. Keep unspent
user principal at the funder; transfer one USDC per run. This is a budget plan,
not authority to execute five public transactions. Operator prefunding occurs
once in 11. Journey authority must bind the permitted run scope and cumulative
payer budgets; token prefunding alone does not establish native-gas sufficiency.

## Verification

Completed locally on 2026-11-17. The [operator guide](../../../docs/runtime/usdc-poc-execution.md)
documents read-only preparation, exact campaign approval, operators-only restore,
exclusive user-store ownership, per-run execution and same-WAL recovery. The
[retained evidence](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#public-financial-clijson)
binds base HEAD `b2dceb3438ff2582cee0c5741fe4a0528f5cbd26` to 87 executable/configuration
hashes and current contract-artifact hashes. This is a dirty local candidate,
not a clean release or public execution certificate.

Final focused checks: 20 tests, zero failures and 159 assertions across five
files. Five real private-chain runs each deposited 1,000,000 units and paid
899,801 to the target signer. Distinct run/order IDs share one user Runtime,
the same Accounts and WAL. Final target balance is 4,499,005; target Hub reserve
is 500,995. Payer nonces are source user 15, target user 5 and target Hub 5.
Run 2 was killed after accepted deposit work and run 4 after accepted withdrawal
work. Exact restored roots, Account heads/Hankos and ordered outbox digests
match; reconfirming run 1 after all five leaves nonces unchanged.

Unapproved, expired, changed-candidate, unfunded and sixth-run invocations reject.
Signed-wire regressions cover chain, payer, nonce window, gas/fee limits, hidden
operations, approval amount/spender, recipient and canonical right-side C2R.
Finite nonce reservations enforce the entire campaign's worst-case payer budget
without a mutable accounting sidecar. History RPC routes reject submission even
when the current RPC gateway has approved execution authority.

Related regression: the existing three-case recovery matrix passes with eight
restores, including partial execution and separately classified clear. Final
`bun run check` passes 3 short gates, 38 source gates and 10 soundcheck gates;
deployment TypeScript and scoped formatting pass. Frozen core is unchanged;
ESLint remains semantic=0, debt=315, with no added unused exports.

The selected public Arbitrum runtime RPC lacks old state; a real read-only probe
verified historical nonce/balance access through the explicit archive role.
Private Anvil chains with public chain IDs do not prove public Arbitrum Nitro
execution. Public financial broadcasts and new public spending approvals: zero.
Refresh ticket 10's older packet before requesting 11; tickets 11, 05 and 06
remain incomplete.

References: [source journey](../../../core/scenarios/usdc-poc/source-journey.ts),
[target payout](../../../core/scenarios/usdc-poc/external-payout.ts),
[preparation gateway](../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts).
