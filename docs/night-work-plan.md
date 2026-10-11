# Current xln execution handoff

Owner priority on 2026-10-11: redesign the React wallet with one bounded Opus
consultation. Backing and signed credit now sit next to the balance; compact
actions precede the charts, secondary actions use More, tutorial details disclose.
All amounts still use committed projections/deriveDelta. Equal $100 segments
measure the same width in all seven visible bars; 320px buttons do not overflow.
Browser evidence: `.logs/crisis-20261011/wallet-design-{desktop,mobile}.jpg`.
An independent demo wallet has 200 USDC: 100 collateral-backed plus 100 unsecured,
after actual reserve-to-Account funding on the running local chain. This is not
a restore of the owner's earlier 699.85 USDC Tour wallet. Editing the Vite entry
caused a reload; that older mnemonic wallet now needs its recovery phrase.
Do not reload the current demo or rebuild served runtime files during preview.
Fix next: guided-demo recovery requests a random phrase users may never have saved;
reserve faucet also displayed PROXY_UPSTREAM_TIMEOUT:5000 after crediting 100 USDC.
No repeated faucet request was made after that ambiguous result.

The unfinished Rust lending parity work is preserved separately, uncommitted.
The current TS lending vector passes with partial repayment and signed expiry;
Rust authorization/wire fields are partially ported, not compiled or parity-proven.
Do not include that work or the six foreign Rust files in the UI checkpoint.

## Current SHA

Latest source checkpoint: `cd345aafd`, main, 2026-10-11; documentation may follow.
The three books now have sibling `paybook`, `swapbook`, `lendbook` module paths in
TypeScript and Rust; retired directories and imports are removed. Full check
passes (38 source gates, 25.807s), 26 existing Rust book tests and two shared TS
book tests pass. The same 108-frame production WAL is byte-exact before/after
through TS W1/W4. This proves the move, not modern lending parity in Rust.
Evidence: `.logs/crisis-20261011/books-*` and
`withdrawal-react/books-comparison.json`. Rust tests ran with the six unrelated
dirty Rust files retained, not a clean-checkout claim. No push.

Previous checkpoint `079c101cc` isolates Lendbook and fixes queued withdrawals. Related tests
564/564, six SIGKILLs across seven processes, three browser journeys and all
108 TS W1/W4 replay frames pass. Full check: 38 source gates plus short/outer
gates pass. Evidence: `.logs/crisis-20261011/withdrawal-*` and
`withdrawal-react/queue-comparison.json`; transcript
`bfeef7065f24d509bf1a0280093e47bb9bd99e59b9c257076b6b38382439efbc`.

Latest owner instruction: all three books must have consistent names and module
boundaries in TS and Rust, deleting retired paths. Rust freeze is lifted for
that refactor and the books' financial parity; TS remains the launch engine.
Rust baseline `cargo check -p xln-rscore-entity-kernel --all-targets --locked`
passes in 7.47s. Its lending still uses the old saver allocation/credit-grant
semantics; a module rename alone is not financial parity. Preserve the six
unrelated dirty Rust files (baseline patch in
`.logs/crisis-20261011/books-foreign-rust-before.patch`).
`8c5ef2793` implements partial repayment; `5a2025a81` validates Account access once
and lowers non-null assertion debt from 617 to 616. Earlier `87f860bd1` and
`494b162cc` repair release fixtures, remove saver allocation and charge actual
elapsed loan interest. Not pushed.
Preserve unrelated frozen Rust changes, HANDOFF.md, output/ and tmp/.
TS launch engine, React only, Ethereum same-J. Work solo. The owner's explicit
Opus design request permitted one packet-only response on `bc75c6a4cdfc48870f997beefc3663ec24f7941d`:
`wallet-design-opus-20261011`, requested `anthropic/claude-opus-5` via pi/OpenRouter,
reported cost USD 0.1476725, completed. No recurring grant or further calls.

All six owner choices are resolved: term and demand savings; lending above deposits
inside signed bank facilities; withdrawal order by maturity then request admission;
actual-time interest; partial repayment interest-first; automatic draws inside
borrower approval. One signed obligation mechanism; no saver-loan allocation.
Credit limits bound unsecured risk. Only collateral secures recovery. Testnet key
management/funding/deployment is authorized. Mainnet is open participation; exact
build promotion and mainnet signatures remain owner-controlled.

## Last green command

Latest: `bun run check` -> `.logs/crisis-20261011/books-check-final.log`;
`cargo test -p xln-rscore-entity-kernel --lib --locked book::` -> 26 pass;
production replay W1/W4 -> 108/108 exact, matching `079c101cc`.

Owner preview is running via the canonical `bun run dev`, TS engine, dedicated
`db/owner-preview-20261011`, stand holder PID 51040 (verify before use).
React URL: `http://localhost:5183/`. Browser tab 18 has a disposable tour wallet
with 100 test USDC received, zero captured console errors. Do not reset its data
or start another heavy stand while the owner is trying it. The current dev
launcher still exposes Svelte at 8080; unify the advertised React entry without
weakening singleton/port ownership or adding a second launcher.

Method review, 16:22 UTC: closed the book-path migration through immutable WAL
comparison and full check before starting another refactor. Updated the existing
improvement loop with the owner's Japanese-inspired quality direction. Retained
the generator-path failure and folder-width reduction as evidence; no new gates.

Earlier partial-repayment candidate (historical evidence):

- Related suite: 562 tests, 448,491 assertions, 46 files, 33.88s.
- Production Depository/transformer: 65 cases; partial claims in both directions,
  fractional carry, offline debtor and unsecured shortfall included.
- Gas frontier: 16/16; 80 claims finalize at 3,930,280 / 5M gas; 18 full-width
  claims at 3,552,680 / 5M. Do not report whole-test gas as one transaction.
- React: three real browser journeys, zero skips/retries/page errors, 41.43s.
  Partial repayment followed by full settlement conserves money exactly.
- Real recovery: five SIGKILLs across six processes; fractional interest,
  remaining principal, saver independence and duplicate outbox delivery survive.
- Fresh production WAL: all R/E/A roots and ordered outputs exact for 108 frames
  through TS W1/W4. Transcript digest
  `1d625ebbcd2212037c1326174fba51433706aaf88ec2c34c522df9fe39f84cff`.
- Runtime, contract-test and UI types pass. Full check passes: two short gates,
  38 source gates (28,653ms), three outer gates. The first check rejected one new
  non-null assertion. Reusing the validated Account removed it and one older
  assertion; the stricter ratchet passes. All 108 replay frames remain exact
  before/after that source-only guard change.

Partial payments mutate the same root-bound Account covenant. Interest accrues on
remaining principal, carries its fractional numerator and never compounds. The
original maturity/late endpoint stays fixed. Each repayment signs the previous
claim hash: stale retries cannot debit twice. The bank book uses the same pure
settlement function. Principal repayment replenishes the signed facility.

This is a fresh-domain ABI cutover. Old coupon-only claims and six-field repayment
worker tuples reject, not migrate silently. Artifacts/TypeChain are synchronized.
Of nine artifacts only DeltaTransformer bytecode changes: runtime 7,867 -> 8,326
bytes; keccak
`0xf0b6c12143a14da9143b650dbb23895da3b01482dc352c2bb90b5ef76cf01b98`.
Other bytecode/ABI templates are identical; build metadata/AST ids differ.

## First red command/error

No remaining partial-repayment L1/L2 or full source-check failure.
Demand savings are not implemented. Due/request-ordered withdrawal servicing
is implemented and verified at `079c101cc`; see the newer evidence above.

The integrated runtime release gate still reaches the frozen cross-J fixture
mismatch after 77 tests. Its first difference is dispute ProofBody hashing:
read-only reconstruction proves the frozen vector uses the old three-component
stock batch ABI; current production has the fourth loans component. Financial
roots match at the first boundary. Do not edit root rscore/ or regenerate golden
hashes to conceal this. Reconcile the TS release vectors with the explicit Rust
freeze after the production banking path is complete.

The prior 1,000-user stand committed 20,000 payments with zero pending ACKs but
needed 26,183ms against the 25,000ms acceptance window. No valid TPS claim.
Do not resume speculative performance changes or relax the gate.

## Artifact path

`.logs/crisis-20261011/partial-{related,contract-full,gas,crash-verified,wire-ui}.log`,
`partial-bytecode-review.json`, `partial-check-final.log`, and `partial-react/`
browser/replay evidence.
Durable evidence index: `docs/evidence/crisis-20261011.json`.

## Next single command

`bun run stand:status` before any heavy work; the owner preview currently holds it.
Next implementation: verify the first Rust lending divergence against current TS
vectors. The owner also delegates demand-rate design: prospective
variable rates, earned interest preserved, one signed accrual mechanism.
Do not repeat unchanged green gates without a new concern.

Sepolia runner: `/Users/zigota/.config/xln/sepolia-deployer/run.ts`.
Address `0x4a009FaaA692DE8f66d70b53E785Ae0f7a307902`; key stays in macOS Keychain.
After funding, current-bytecode dry-run, deploy, secured exit and debt proof.
The owner answered the CAPTCHA confirmation with an instruction to complete
funding autonomously. Ghostchain verification completed and its UI reported
success, but receipt `0x77e02ca76d2a1b929ad16a849968e326125c1c2b085671e0354af7f60ab88a1e`
has status 0: the faucet sent 21,000 gas; the current RPC estimate is 207,391.
Balance remains zero. The PoW faucet verification also completed, then rejected
the connection as a hosting IP range. No mining started; no restriction bypassed.
Zalalena image input hit a browser coordinate limitation; Google/Metana require
a login absent from the current session. Do not retry these unchanged failures.
Quicknode's revised FAQ says no mainnet balance is needed, but its UI still
rejects this empty signer. Latest check at the partial-repayment checkpoint still
shows 0 ETH on chain 11155111; `partial-sepolia-status.log`. No public deployment.

## Remaining final gates

Demand savings, book refactor/financial parity, integrated TS release vectors, valid 1,000-user
live load; funded public Sepolia current-bytecode identity and three real-clock
exit paths including an offline-wallet watchtower; immutable tested source/config/
artifacts and recovery/rollback package. Local checkpoints are not release candidates.
