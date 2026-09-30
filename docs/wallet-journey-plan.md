# xln wallet: user journey and acceptance

## JEA walkthrough and failure acceptance — owner update 2026-09-30

The new React UI must explain existing finance through J/E/A and demonstrate
funding → payment → same-J/cross-J swap → withdrawal → recovery after hub failure.
This advances [MML](intro.md#mission) by making a useful financial relationship
provable and disputable. The walkthrough requirements below are pending work,
not acceptance evidence for the historical runs in this document.

- Explain the three protections using the user's actual account: signed proof
  and unilateral dispute; chosen secured/unsecured backing with soft/hard limits;
  Delta Transformer conditions protecting value in motion. Derive displayed
  amounts and capacity from canonical runtime projections.
- Show a funded payment and swap with exact counterparty, asset/J identity,
  fees, terminal receipts and balances. Then make the hub unavailable and
  demonstrate actual J finalization and withdrawal of the secured entitlement.
- Show any unsecured remainder as a receivable, with its real enforcement scope.
  Read the signed dispute policy and actual J deadline; show response window,
  finalization eligibility and completed recovery separately. Use the
  [accepted exposure schedule](launch-design.md#accepted-automatic-exposure-schedule)
  only after signed-policy and cross-J evidence rules are implemented and verified.
- Existing Svelte frontend E2E must cover the same path and all three protections,
  with exact balances, collateral/debt result, duplicate-delivery safety and
  reload/recovery invariants. Start from the existing payment/swap, cross-J and
  dispute suites; a broadcast dispute start or a skipped finality case is not
  a completed recovery test.

Current code sums both parties' response windows (hub 1 h + user 24 h = 25 h).
Owner intent is hub response within 1 h for a user-started dispute. Keep that
intent separate from observed implementation until the accepted timing policy
and its cross-J recovery boundary are implemented and verified.
Reaction protection applies to every dispute type; portable cross-J locks also
require time for valid evidence to reach and be accepted by the sibling J.
UI walkthrough implementation and fresh E2E execution remain subsequent tasks.

## Historical journey evidence — 2026-09-10

Working plan dated 2026-09-10. Starting point: main `a64d3a340` plus the
then-unfinished recovery and receipt-reading changes. This is an acceptance
plan, not readiness evidence. The owner selected the first user: a person
sending money to another person. The selected hour's result is two new React
wallets, a transfer and reload with exact balances.

## Product outcome

Without engineering help, a new user creates a wallet, receives test money,
pays another new user, swaps assets and returns after reload with the same
confirmed funds and history. They understand the amount, recipient, fee,
status and recovery method. React is the primary interface; Svelte preserves
the same financial path. A hub is a Runtime with the hub role; xln is a network
of Runtimes.

## Eight user-journey checks

| Step           | User action                                                                | Acceptance criterion                                                                                                                                                                                                       | Current evidence                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Creation    | Opens the entry screen, enters name and password                           | Creation first, saved wallets below. BrainVault passes 24 words into shared import. The original password encrypts local storage. Recovery phrase appears hidden and is revealed by Show. Remote Runtime remains available | Partially implemented; full criterion not passed                                                                                                                             |
| 2. First login | Waits for a new wallet to become ready                                     | Real RAdapter, existing long chain, verified synchronization without resetting the chain or increasing deadlines                                                                                                           | Passed: Home in 23.337 s at 193219 blocks                                                                                                                                    |
| 3. First funds | Clicks the Home faucet                                                     | Exactly 100 USDC received; committed balance, no pending Account proposal                                                                                                                                                  | Passed: 2.021 s after Home                                                                                                                                                   |
| 4. Receiving   | Second new user opens Receive and shares address/request with the first    | Sender sees correct recipient; invalid input and a revoked quote cannot submit a payment                                                                                                                                   | Two new wallets checked; Bob explicitly prepared Receive for 25 USDC and the address was recognized. Invalid amounts/address and revoked quote passed separate E2E in 30.2 s |
| 5. Payment     | Sender checks amount and fee, then confirms                                | Sender loses amount plus actual fee; recipient receives the exact amount. Both sides reach terminal status with matching evidence and empty queues. Double click cannot create a second payment                            | Passed: Alice to Bob 25 USDC; fee 0.000025; Alice 74.999975, Bob 125. Matching hashlock, one receipt each, empty queues                                                      |
| 6. Swap        | Selects assets, reviews terms and confirms                                 | Both amounts and fees match committed states; terminal status, no stuck hold. Same-J and Cross-J checked separately                                                                                                        | Same-J passed: debit 99.999996 USDC, gross 0.039992 WETH, fee 0.0000039992 WETH; exact net and history survive reload. Cross-J remains unproven                              |
| 7. Return      | Reloads both wallets, enters password only                                 | Identity preserved; prior frames and roots match, current balances exact; no duplicate payment, swap or history                                                                                                            | Payment and same-J swap balances, identity, Account roots and history matched after reload in bounded runs. Combined single-process latency remains unresolved               |
| 8. Recovery    | Selects existing recovery phrase and enters 12/24 words in a fresh profile | Canonical identity matches. CLI BrainVault, React and Svelte agree for identical inputs; available committed data recovers through the existing path                                                                       | Not proven on current candidate                                                                                                                                              |

Fully passed: **5/8 (62.5%) of this journey's criteria** (steps 2–5 and 7). This is not a mainnet
readiness percentage. Supporting tests do not close an entire step.

New evidence: [proof.json](evidence/wallet-transfer-20260911/proof.json).
Three bounded runs passed: Alice preparation 28.2 s, Bob 28.6 s, transfer and
reload of both real databases 26.8 s. The original combined 50-second test
remains red: `/tmp/xln-payment-paged-history.log`. Its deadline was not raised.
Focused recovery/key tests: 18/18, 112 assertions.

## Selected hour's result

**3/3 checks passed:** two new wallets funded, payment confirmed by both sides,
balances and Account roots preserved after reload. Preparation and the money
phase use separate processes, transferring actual IndexedDB/WAL between them.
This proves the financial scenario; slow combined login remains unresolved.

Same-J swap and reload now pass: [swap proof](evidence/wallet-swap-20260911/proof.json). Next: shared wallet creation and recovery; Cross-J swap remains a separate acceptance check. Every rerun must pass or
produce a new cause. Repeated failure without new evidence requires a changed
hypothesis. Before completion: focused tests, real browser, `bun run check`,
diff review and a separate scoped commit. Do not push.

## Following stages and engineering constraints

After bilateral payment/reload: swap, then shared creation and recovery in both
interfaces. Check wrong passwords/phrases, unavailable peers, repeated clicks
and reload during unfinished work alongside each action: clear rejection,
no false success and no additional debit.

Then run existing TS scenarios with H1 on TS or Rust without rewriting scenario
logic. First fix the contradiction between primary-jurisdiction-only and waiting
for Cross-J routes in the native stand. On one immutable WAL compare every R/E/A
root and ordered output for TS W1/W4 and Rust W1/W4; fix the first divergence.
Then live Rust J watcher to Entity to batch to receipt, production and cfg(test)
Rust builds, and full React/Svelte E2E. Replay does not replace live proof.

Work alone, one heavy stand under stand-lock, on main, preserving unrelated
changes, user wallets and the devnet. Do not change the protocol for speed.
TPS must meet AGENTS.md criteria. User value counts unique completed economic
operations, never repeated hops through hubs.

After technical acceptance, the owner walks the journey without engineering
help; their feedback determines the next external milestone. This plan neither
performs nor authorizes deployment or publication.
