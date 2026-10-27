# Testnet credit officer

Enable `XLN_CREDIT_OFFICER_TESTNET=1` on the orchestrator. It starts a separate
Bun child at loopback `orchestrator port + 9`, after hub bootstrap. Both the
orchestrator and managed hubs proxy `/api/credit-officer/*` to it. Disabled is
the default; Ethereum and TRON mainnet chain IDs are rejected even if enabled.
The bank operator must publish ordinary lending terms and supply liquidity.

The wallet gets a UTC-day challenge, searches SHA-256 work in a worker, requests
approval, waits for committed facility evidence, then submits its existing
`lendingBorrow` command. Approval does not change credit limits, fund a loan,
publish bank terms or bypass Account risk/capacity checks.

`CREDIT_POLICY` owns dollar limits, work difficulty, testnet chains and tiers:
$50 base, $100 after 7 days/$100 settled outbound volume/1 on-time repayment,
$500 after 30 days/$1,000 volume/3 repayments. Borrower exposure and daily
facility issuance are capped at $500. Daily issuance is an approval budget;
the existing facility remains revolving, not a cap on gross payment turnover.

All values use integer USD micros and the canonical committed token catalog.
Exposure rounds up. One committed runtime read binds bank authority, the
borrower's Account, terms, loans and facilities. At most 500 signed Account
frames provide a conservative volume lower bound. Age uses only officer-owned
`firstSeenAt` per hub/borrower, persisted in SQLite after the first verified
committed read and retained across restarts; Account timestamps never prove age. Only committed
borrower-originated trusted source legs earn volume, not bank hops or self
transfers. On-time repayment comes from the committed loan book. Defaults,
disputes, overdue loans and changed Account epochs require manual review.
The optional on-chain balance signal is unused: idle balances prove neither
income nor repayment history. Work raises sybil cost; it does not prove identity.

Proofs bind hub, borrower, UTC day, token, amount, term and nonce. Verification
hashes once. SQLite `credit-officer.sqlite` belongs only to this external
service: FULL-synchronous transactions reserve allowance before authenticated
`lendingApprove` submission. Reused proofs remain rejected after restart;
ambiguous submissions retain their reservation. Financial recovery is still
owned solely by the hub's checkpoint/WAL and authenticated command frontier.
The service logs evidence and submission/denial separately. It fails closed
on unavailable reads, expired capability, storage errors or command failure.
Restart the orchestrator to mint a new 24-hour officer capability after expiry.
Officer startup failures are reported and trigger bounded officer-only cleanup; approval requests return HTTP 503 while hubs keep running.
Testnet accepts limits per address and advance mining of daily proofs; neither establishes unique borrower identity.

Tests: `bun test core/__tests__/orchestrator/credit-officer`.
Browser flow: with an enabled testnet stand, run
`bun run --cwd ui test:e2e tests/lending/e2e-credit-officer.spec.ts`.
This scenario performs both tutorial chapters and never skips them.

## Local validation (2026-10-27)

Uncommitted diff based on `747c12da59ae3453fc23d2fd6ebae12725acbbf2`.
Root, React and runtime TypeScript checks pass; soundcheck passes 10/10 gates;
folder-width and unused-surface pass. Runtime and React production builds pass.
Six policy/proof/committed-evidence tests pass (39 assertions). The seventh,
HTTP/RPC integration test, stops at socket creation with `EADDRINUSE` on port 0.
The browser scenario collects with the UI's Playwright CLI, but Chromium exits
at launch before any tutorial actions. `bun run check` stops in contract artifact
compilation: Hardhat's shared `compiler-download-list` mutex times out after
60 seconds. These failures are unresolved; this is not release certification.
