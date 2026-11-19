# Headless TypeScript USDC PoC

The [identity and funding-role record](usdc-poc-identities.md) preserves the
owner's current account separation and deferred external-wallet discussion.
The [operator-funding guide](usdc-poc-operator-funding.md) describes ticket 11's
prepared executor, separate approval packet and required Runtime observation.

The source-funding slice creates a dedicated vault and user Runtime, opens a
bilateral source Account and deposits exactly one six-decimal USDC through real
ERC20 and Depository operations. The extended scenario executes the full source
amount through the MM, covers the target Account claim and withdraws to the
target signer EOA.

## Run the source-funding slice

Run from the repository root on the owner-authorized current computer:

```sh
bun run stand:status
bun run stand:run --reason poc-source-account-funding --timeout-ms 180000 -- bun core/scripts/operations/production/local-prod-smoke.ts --source-account-funding
```

The existing stand owns its Anvil nodes, Hub/MM processes, authenticated relay
and isolated run root. The new user joins through production Runtime admission;
the host waits for jurisdiction commitment before importing the Entity.

The client accepts only a loopback API and chain 31337 for fixture funding.
The public Anvil genesis account transfers test tokens and ETH to the fresh
wallet. The user's own approval and E2R batch then consume exactly 1_000_000
token units. R2C moves the resulting reserve into its bilateral Account.

## What establishes success

- The user wallet moves from 1_000_000 to zero USDC units; final reserve is zero
  and committed outgoing collateral is exactly 1_000_000.
- The opposite Hub Runtime is queried through its production RuntimeAdapter.
  Account height and state hash must match, with neither side retaining a
  pending Account frame or mempool work.
- Three successful receipts cover approval, E2R and R2C. Raw receipts and
  transaction data, identified balance blocks and native fees are retained.
- Gas is reconciled separately for every actual payer. Existing loopback dev
  sponsorship pays R2C; this is not evidence of public-network gas authority.

The vault seed stays in its private run directory. Successful reports contain
public identities and financial evidence; failure reports contain the error,
known transaction references and committed reserve observations. Neither report
is a recovery authority. Runtime checkpoint/WAL/outbox remain authoritative.

## Run the Cross-J claim slice

```sh
bun run stand:status
bun run stand:run --reason poc-usdc-cross-final --timeout-ms 180000 -- bun core/scripts/operations/production/local-prod-smoke.ts --cross-j-swap
```

This extends the same source-funding journey. It reads real committed MM orders
from the owning Hub Runtime, selects an executable USDC quote with canonical
quantization and admits the target Entity in the same user Runtime. The target
user-to-Hub credit equals the required gross receive amount exactly.

The existing Runtime Cross-J command admits the signed intent through WAL.
Completion requires full execution of all 1_000_000 source units, zero route
remainders, closed Pulls and matching Account heads and cached Hanko on both
user/Hub sides. The report retains the maker quote, intent, close proofs,
deadlines and bilateral signatures while excluding private reveal preimages.

The [local Cross-J report](../evidence/ts-usdc-cross-j-poc/local-evidence.md#cross-swapjson)
records 1_000_000 source units exchanged for a 999_900-unit target claim on the
observed quote. This claim has no target collateral or external payout yet.
The two chains are local EVM fixtures 31337 and 31338; no public testnet
financial transaction is established by this result.

The final candidate passed 52 owning tests / 1,179 assertions and the complete
applicable check: 3 short gates, 38 source gates and 10 soundcheck gates,
including frozen-core and runtime types. Ticket 02 is complete locally.
The complete local journey below retains the current isolated user stores for
later recovery work, separately from the public report.

## Run the complete local financial journey

```sh
bun run stand:status
bun run stand:run --reason poc-usdc-payout-isolated --timeout-ms 180000 -- bun core/scripts/operations/production/local-prod-smoke.ts --external-payout
```

This includes source funding and Cross-J execution in one user Runtime. The
operator deposits 999,900 actual target ERC20 units into the Hub reserve using
its own signed batch. Operator token capital and gas remain separate from the
user's one-USDC source principal; the fixture's dev-minted reserve alone does
not establish this contribution.

The user requests cover using the opposite side's committed, versioned fee
policy and the canonical core fee function. In the retained run, gross target
claim 999,900 minus prepaid fee 100,099 yields 899,801 collateral units. The
observed policy is version 1: base fee 100,000, liquidity fee 1 bps, gas token
fee zero. The fee is charged once, before the Hub's R2C.

After authenticated J observation and bilateral commitment, the user proposes
C2R with an R2E continuation to its target signer address. The final on-chain
balance increase and the Depository-to-recipient ERC20 Transfer must both equal
899,801. The source-to-payout difference is 100,199, below the agreed 150,000
limit. The final user target reserve, Account collateral and unsecured outgoing
claim are zero; no user Pull, settlement workspace, continuation or bilateral
ACK remains. Both Account heads and cached Hanko match their Hub counterparts.

The [complete local report](../evidence/ts-usdc-cross-j-poc/local-evidence.md#external-payoutjson)
contains the fresh source-funding and Cross-J prefixes, seven chain receipts,
block-identified balances, signed tariff and bilateral evidence. It reconciles
reserve/custody movements and native costs by actual payer on each chain. The
target is a plain local EVM fixture; Arbitrum-specific fee components have not
been exercised. The measured complete boot/deposit/swap/cover/payout run took
17,835 ms; this is not swap latency or a public-network performance result.

The CLI establishes its isolated storage environment before importing Runtime
modules and rejects a different resolved storage root. The report names the
user Runtime ID and storage root. Its four closed stores (current state, WAL,
infra and history views) and private vault are retained under the ignored local
job directory. Seeds and reveal preimages are excluded from the public report.
This retention prepares recovery work; it does not prove interrupted recovery.

## Verification and evidence

The final candidate passed 147 owning tests / 1,671 assertions. The final
applicable aggregate check passed 3 short gates, 38 source gates and 10
soundcheck gates, including frozen-core and runtime types. The report binds the dirty candidate to
its base SHA and eleven executable source/test hashes; it is not clean
committed release evidence.

The earlier [source-only report](../evidence/ts-usdc-cross-j-poc/source-account-funding.json)
and [Cross-J claim report](../evidence/ts-usdc-cross-j-poc/local-evidence.md#cross-swapjson)
retain their historical candidates. Use the complete report for the current
01-03 journey.

Public execution still requires verified live stacks/assets, executable maker
liquidity, signed tariffs, target backing and owner-approved numeric ETH limits.
Interrupted recovery is ticket 04; live preflight and gas planning are ticket 05. Local completion does not establish Sepolia-to-Arbitrum execution.

## Recover interrupted journeys

```sh
bun run stand:status
bun run stand:run --reason poc-usdc-recovery-verified --timeout-ms 180000 -- bun core/scenarios/usdc-poc/recovery-run.ts
```

The matrix uses three sequential isolated real-node stands under one stand
lock. Every restart within a case uses its original vault, source deposit and
canonical stores. Reports never decide recovery actions. Runtime restores the
checkpoint and ordered WAL, verifies every replayed frame and republishes its
committed outbox. The driver continues accepted work from committed Account,
settlement and J-batch amounts; it does not quote or charge cover again.

| Case                  |                                                         SIGKILL cuts | Result                               |
| --------------------- | -------------------------------------------------------------------: | ------------------------------------ |
| Accepted effects      | 4: deposit, prepared Cross-J, prepaid cover fee, accepted withdrawal | 899,801 units externally paid        |
| Partial then full     |           2: after half-size book execution, after hash-ladder close | 899,900 units externally paid        |
| Expired partial clear |          2: after partial execution through TTL, after partial close | Partial clear, separately classified |

The partial cases replace one MM quote through its authenticated owner command
lane and normal bilateral clear, preserving the 18-Pull admission limit. Two
independently signed half-size quotes at price ticks 10,000 expose the partial
boundary. The ordinary signed Hub tariff still applies. The standard quote in
the first case uses ticks 9,999, explaining the different final payout.

All eight restores compare Runtime and Entity hashes, Account heads and cached
Hanko, and the ordered outbox digest. The retained run also committed 17 repeated
signed Account inputs, covering ACK and proposal delivery. Repetition preserves
the entire positional admission cohort. Chain nonces remain 2 for source E2R/R2C
and 1 for target C2R/R2E in both full-payout cases; seven receipts per case and
payer balances reconcile without duplicate deposit, cover fee or withdrawal.

The expired case leaves 499,993 source collateral units and a 500,007-unit target
claim, with no open user Pulls or pending bilateral ACK. Its book execution was
500,000 units; the canonical uint16 ladder ratio 32,768/65,535 projects the signed
claim to 500,007. Both quantities remain visible, following the existing
[ladder authority rules](../consensus-invariants.md). This remaining obligation
is explicitly **not** successful full-source execution or an external payout.
Both chains advance while the user is stopped; signed deadlines remain intact.
The matrix demonstrates recovery of the named cooperative/clear cuts, without
claiming a fresh late Source close or a forced L1 dispute after lost deadlines.

The [recovery report](../evidence/ts-usdc-cross-j-poc/local-evidence.md#interrupted-recoveryjson)
contains all eight before/after proofs, replay metadata, repeated-input digests,
financial receipts and the separate clear outcome. Twelve closed user stores
and three private vaults remain in the ignored job directory; vault files use
mode 0600. The measured sum of the three stand runs is 91,463 ms, including
bootstrap and expiry waiting. It is not transfer latency or a TPS measurement.

The final candidate passed 158 owning tests / 1,793 assertions across 13 files,
including real RPC crash-after-mining and nonce-reservation regressions. Final
`bun run check` passed 3 short, 38 source and 10 soundcheck gates, including
frozen-core, runtime types and the unchanged ESLint debt baseline. The report
binds the dirty base SHA to 22 executable source/test hashes. Public execution
remains subject to live preflight, gas planning and owner-approved numeric ETH
limits.

The [public preparation guide](usdc-poc-preflight.md) records the verified
USDC stacks, separate local operators and signed user Accounts. Ticket 05
remains incomplete until separate funding; no public Cross-J transfer or
native-gas spending authority has been established.
