# React routed Move evidence

The current React wallet could not send to Bob's Account with H2 unless Alice
also had an Account with H2. The destination selector incorrectly reused the
sender's spendable Account list. The first current-wallet regression failed
before signing at that missing H2 option (43.724s).

The selector now uses discovered Entity summaries for a remote recipient, only
on the active Entity's exact chain and Depository. It excludes the recipient
itself, rejects unknown/unqualified stacks, and clears the old destination when
the recipient changes. A new counterparty must be explicitly selected. Discovery
supplies destinations, never signing authority. Own-account funding and source
Accounts retain the existing undisputed local Account list. Runtime transitions,
financial formulas, contracts, frozen core and WAL format are unchanged. The
existing canonical stack parser is exported through the public Runtime module.

## Observed results

- Three strict isolated mesh browser cases pass: own reserve/Account53.545s
  including build, remote/external43.337s, round-trips40.303s. All browser issue
  counters are zero. Both real embedded wallets initialize and use the live mesh.
- All13 original money operations remain, including both round-trips. Two
  independent cases additionally fund8USDC of collateral through the visible
  Reserve-to-Account flow. This is necessary because the initial100USDC Account
  funding is peer credit; credit alone does not permit collateral withdrawal.
- Every step checks all six wallet balances, exact source debit/destination
  credit, Account capacity changes and empty pending/batch work. Their combined
  balances stay320USDC. This is a wallet-balance invariant, not a total-supply claim.
- Each draft leaves balances unchanged before broadcast. ERC20 allowance starts
  at zero, equals the explicitly approved amount, and is consumed. The retired
  unlimited-approval UI is not restored. Direct external transfer leaves the
  Entity nonce unchanged.
- Fourteen actual batch receipts bind the exact Entity, successive nonce,
  Depository address and mined transaction/block hash; each nonce has exactly
  one non-removed event and successful receipt. Both round-trips assert their
  intermediate balance returns to its starting value.
- Focused L1:9/9,29 assertions,0.314s. Full UI TypeScript check:exit0,6.395s.
  Owned browser-test diagnostics are now0 (4.725s); prior40 old-reader errors
  are removed with the retired Svelte test implementation.

[Integer balances and receipts](proof.json), [exact commands/exits/log hashes](results.json).
Full traces, screenshots and preserved original source are under
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/routed-move/`.
Clean-SHA browser/check/push evidence is recorded in `routed-move-publication.json`
in that autonomy artifact root. The unchanged asset-faucet cases remain in the
same suite and retain their prior evidence.

## Preserved failures and limits

The original test first failed at retired Svelte controls (37.488s). Its React
port exposed the missing destination, then the full13-step chain exceeded the
ordinary60s budget both with a rebuild (60.823s) and cached artifacts (60.699s).
It is now three independent cases; all operations and financial assertions are
retained, not a shortened soak or an aggregate-suite pass. The first split case
correctly refused withdrawal without collateral (52.594s); its real funding
prerequisite is now explicit. An unavailable parser export and three new typed
reader diagnostics were also fixed; all failed logs are retained.

Integrated release/full browser, public Sepolia/operator/rollback, uninterrupted
one-hour soak and MacBook catch-up remain open. No mainnet, TPS or parity claim.
