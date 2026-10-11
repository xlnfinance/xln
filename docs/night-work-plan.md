# Current xln execution handoff

## Current SHA

HEAD before the partial-repayment checkpoint: `494b162cc`, main, 2026-10-11.
Local commits `87f860bd1` and `494b162cc` repair release fixtures, remove
saver-to-borrower allocation and charge actual elapsed loan interest. Not pushed.
Preserve unrelated frozen Rust changes, HANDOFF.md, output/ and tmp/.
TS only, React only, Ethereum same-J. Work solo; no external-model spend.

All six owner choices are resolved: term and demand savings; lending above deposits
inside signed bank facilities; withdrawal order by maturity then request admission;
actual-time interest; partial repayment interest-first; automatic draws inside
borrower approval. One signed obligation mechanism; no saver-loan allocation.
Credit limits bound unsecured risk. Only collateral secures recovery. Testnet key
management/funding/deployment is authorized. Mainnet is open participation; exact
build promotion and mainnet signatures remain owner-controlled.

## Last green command

Current partial-repayment candidate:

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
- Runtime, contract-test and UI types pass. Full check on the partial candidate
  is the next gate; the preceding checkpoint passed all 38 source/3 outer gates.

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

No remaining partial-repayment L1/L2 failure. Full source check is pending.
Demand savings and due/request-ordered payout servicing are not implemented.

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
`partial-bytecode-review.json`, and `partial-react/` browser/replay evidence.
Durable evidence index: `docs/evidence/crisis-20261011.json`.

## Next single command

`bun run check` on the checkpoint containing the synchronized artifacts.
Then implement demand savings and ordered payouts with the existing signed
obligation/close path; reproduce the first missing behavior before changing it.
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
rejects this empty signer. Latest chain check remains 0 ETH.

## Remaining final gates

Demand savings, ordered payouts, integrated TS release vectors, valid 1,000-user
live load; funded public Sepolia current-bytecode identity and three real-clock
exit paths including an offline-wallet watchtower; immutable tested source/config/
artifacts and recovery/rollback package. Local checkpoints are not release candidates.
