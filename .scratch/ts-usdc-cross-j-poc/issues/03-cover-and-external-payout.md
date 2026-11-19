# 03: Cover the target claim and withdraw at least 0.85 USDC

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: 02 - Execute the full source USDC amount through the MM

**What to build:** complete the same local headless journey by obtaining target
collateral and withdrawing the net amount to the user's target signer EOA,
address B. The operator can prove an actual external token-balance increase
after ordinary exchange pricing and token fees.

## Acceptance criteria

- [x] Use the gross target claim produced by ticket 02 and actual target Hub
  reserve funding through token/reserve operations. Keep operator capital and
  native gas funds separate from the user's one-USDC source deposit.
- [x] Request collateral through the canonical production path using the
  effective versioned, signed Hub tariff and fee authorization. Reconcile the
  gross claim, prepaid fee and net collateral without duplicating fee formulas
  or counting a fee twice.
- [x] Require authenticated J observation of collateral funding and committed
  Account evidence. Check reserve debt and spendability constraints before
  treating any amount as withdrawable.
- [x] Use the existing destination settlement and continuation through C2R and
  R2E to address B, with canonical signing and WAL/outbox ordering. A direct
  reserve probe cannot replace this Account-to-external path.
- [x] Prove that address B's actual withdrawal-attributable balance increase is
  at least 850_000 target atomic units and the difference from the 1_000_000
  source deposit is at most 150_000 units. Use exact integer accounting and the
  normal effective tariffs and executable MM price.
- [x] Preserve receipts and identified chain-height token, reserve and Account
  observations. Reconcile actual native costs by payer and chain separately,
  including applicable Arbitrum fee components when that adapter is exercised.
- [x] Completion has no source remainder, unresolved Pulls, pending bilateral
  ACKs or unsecured remainder of the user's received claim. Partial settlement,
  cancellation or a quoted receive amount cannot satisfy the external payout.
- [x] Demonstrate tickets 01-03 as one reproducible real-node financial journey
  and run the focused owning checks, adding the smallest regression for any
  observed production divergence.

## Verification

Completed locally on 2026-11-16. One reproducible real-node run deposited
1,000,000 source units, fully exchanged them for a 999,900 target claim, prepaid
100,099 in signed-policy cover fees and withdrew 899,801 to the target signer
EOA. The 100,199 source-to-payout difference satisfies the 150,000 limit.

The operator independently contributed 999,900 actual target ERC20 units via a
signed E2R batch. Reserve, Depository token custody and operator token changes
reconcile exactly. Seven source/target receipts retain raw transaction/log data;
native balances reconcile per payer and chain. Target user reserve, collateral,
unsecured outgoing claim, Pulls, workspace and continuations finish empty.
Both user/Hub Account heads and Hanko match; no bilateral ACK remains pending.

The [complete local report](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#external-payoutjson)
binds the dirty base SHA to eleven executable source/test hashes. The measured
boot-through-payout journey took 17,835 ms. The CLI establishes environment
before Runtime import and rejects a non-isolated storage root. All four closed
user stores were verified in the isolated directory and retained privately with
the vault for recovery work. The report is evidence, not a recovery authority.

Final owning checks: 147 tests passed, zero failures, 1,671 assertions. Final
`bun run check` passed 3 short, 38 source and 10 soundcheck gates, including
frozen-core and runtime types. See the [operator guide](../../../docs/runtime/usdc-poc.md)
for the complete command and evidence boundaries.

This is local EVM evidence on chains 31337/31338. Public testnet execution,
Arbitrum fee components, interrupted recovery and clean committed release
acceptance remain outside this ticket's demonstrated outcome.
