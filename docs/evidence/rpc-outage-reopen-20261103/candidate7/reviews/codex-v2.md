# Codex bounded review — reopen-review-v2

Model: **gpt-6.1-sol**, inherited from root; one AI family. Fresh known-answer smoke2: intended bigint multiplication17×19; broken addition36n, fixed multiplication323n, BUG/FIX CONFIRM. This review is not three-AI quorum, release approval or independent product acceptance.

**Result: BUG: CONFIRM and FIX: CONFIRM for all six bounded claims.** The v1 ownership/rollback counterexamples are corrected in this immutable candidate. No remaining concrete blocker was identified within the reviewed source and stated scope. Evidence limitations remain below; green receipts were not substituted for source reasoning.

No live ~/xln source, tests, stands, external models, P1 nodes, source edits or denied diagnostic campaign were accessed. Only this private report was written.

## Immutable identity

Base SHA `019d45beb5954e77fe806d643845f6a4dca4fa82`.29/29 owned source hashes match. Of v1's27 files,22 are byte-identical; five changed (j-adapter-restore,j-rpc-replace,network,chain-catchup,chain-catchup.test), plus runtime-jadapter helper and replacement-races test are newly included in this snapshot.

Verified SHA256 pins:

- Whole patch: `4db7876efd33548fe1cec168de500ac5a73d45c4113ba90408f67886e88c346c`.
- Source manifest: `0c25323a63a2de8df4fd576c33859cdb895b7a954c8b0622f5e4bd0bf243e8ba`.
- Focused since-v1 delta: `2106208f64293e116eff89837daef636aa989d0edc7f2d38b8e24910ce8fe038`.

All source references below mean this packet's **owned/** paths. Unchanged semantic observations from the earlier immutable v1 review are retained only for the22 hash-identical files; fresh changed-file reasoning is recorded separately.

## Per-claim verdicts

| Claim | BUG | FIX | Independent source basis |
| --- | --- | --- | --- |
|1Offline local wallet reopen|CONFIRM|CONFIRM|Gate.tsx:290-333,358-368 passes null stack for existing authenticated password/device unlock. hosted.ts:402-413 checks seed-derived Runtime identity and actual local primary Entity/J state;502-505 locks/clears on failure. adapter.ts:158-163 uses the canonical main/recovery path with opt-in unavailable-transport tolerance, never a second store/reader.|
|2Wrong chain503/504 classified transient|CONFIRM|CONFIRM|rpc-network.ts:10-20 throws ethers INVALID_ARGUMENT on actual/configured mismatch. j-adapter-restore.ts:190-196 only tolerates the existing transient startup category under explicit options; address/chain/receipt-policy assertions are outside that catch. Concrete wrong-chain31338/503/504 and absent-code cases remain hard failures.|
|3Same-env and stale-session catch-up|CONFIRM|CONFIRM|chain-catchup.ts:36-40 now rejects a false session **before** updating activeCatchup. Symbols still supersede older same-session waits. hosted.ts:309-345 captures targets for every local Entity jurisdiction, holds missing adapters/errors closed, and starts relay before readiness; existing probe/error paths check ownership. network.ts:52-53 no longer starts catch-up after session loss.|
|4Verified independent EVM RPC|CONFIRM|CONFIRM|j-rpc-replace.ts:76-104 validates existing RPC-backed EVM identity, HTTP URL, explicit session/lifecycle authority and candidate endpoint without publishing it.105-124 orders newer verified attempts and synchronously merges accepted URL with attachment.125-135 closes rejected candidates, preserves original+cleanup errors and releases claims. Committed rpcs/roots are not assigned.|
|5Settings remount URL|CONFIRM|CONFIRM|Networks.tsx:35-46 displays the exact jurisdiction's accepted infrastructure binding. In v2 that map is no longer provisional and cannot be globally rolled back by a failed concurrent repair. It fixes remount display following successful repair; reload still requires reselecting the ephemeral RPC.|
|6Exact secondary EOA before signing/replay|CONFIRM|CONFIRM|replay.ts:171-184 verifies checkpoint/frame linkage and prepares keys before actual replay apply, including no-tail tip; live-restore.ts:42-48 threads callback before rehydrate; bootstrap.ts:123 prepares again before live loop. wallet-signers.ts:12-25 and keys.ts:19-25 register only exact seed/address matches and share the backup resolver. No durable field or implicit EOA derivation was introduced.|

## Re-evaluated v1 AMEND cases

###AConcurrent map rollback and live adapter consistency

`core/runtime/recovery/j-adapter-restore.ts:112-114,158-164` accepts the candidate URL explicitly and uses it before any accepted override/published RPC. `j-rpc-replace.ts:94-104` verifies that private candidate. There is no tentative global map publication and no whole-map rollback.

For different jurisdictionsA/B: B's successful publication stays in the infrastructure map; A's later failure only closes its own candidate. When A later succeeds, lines119-123 copy the **then-current** accepted map and set only A's exact canonical jurisdiction ref. No await separates map creation, adapter attachment and map assignment, so a different JS request cannot interleave inside that publication step.

The new real-RPC regression `j-rpc-replace-races.test.ts:77-97` exercises B-success/A-late-wrong-chain failure and preserves B plus the canonical state hash. This agrees with the source transaction boundary rather than proving it by test count alone.

###BLatest verified wins; latest failed does not win

Sequence scope is `WeakMap<RuntimeReplica, Map<canonicalJurisdictionRef,sequence>>` at `j-rpc-replace.ts:13-30`. Each pending request has a monotonically ordered bigint ID. `sequence.verified` advances only after the complete endpoint checks and current owner check (103-107), not at request start.

- If newer requestB verifies/applies while olderA is still connecting, A's assertCurrent at104 rejects because requestA<verifiedB. It closesA without detachingB or changing the map.
- If laterB fails verification, verified remains unchanged; still-validA may finish. This preserves the intended latest-*verified* semantics, not merely latest-started request semantics.
- If A already detached the previous adapter and awaits its close at113 while B verifies/applies, A repeats assertCurrent at118, recognizes B's newer verification and closes only candidateA. It cannot attachA overB after retirement finishes.
- A failed new endpoint against an already accepted current adapter never reaches retirement; current adapter and binding stay intact.

Real-RPC tests at99-118,141-159,161-174 cover late old success, later failure while an older valid repair waits, and accepted-current failure respectively. The after-retirement-await branch was checked by source interleaving; the supplied race tests do not hold a real close operation to exercise that particular await.

Claim records persist while any operation in that canonical identity is pending, including candidate cleanup. finally releases once; zero pending removes that identity's sequence and an empty outer map is removed. Thus a sequence cannot reset while an older operation still needs to compare against its newer verified peer. There is no durable state or ever-growing global ID registry.

###CLock/switch cancellation, including retirement await

`assertReplacementOwner` at33-42 refuses a false explicit ownership predicate, paused watchers, persistence quiescing or paused persistence. It runs before connecting87, after candidate verification104 and after any old-adapter close await118. `ui/src/runtime/network.ts:52` supplies exact current-env identity;53 checks again before invoking catch-up.

A candidate whose session was lost during connection is closed without attachment/publication. If ownership is lost while retirement close awaits, the second check still prevents post-lock attachment; the rejected candidate closes and the operation releases its claim. The retired adapter may already have closed at that point, which is consistent with locking/quiescing that Runtime; the patch does not promise to restore a closed capability into a revoked session.

The source additionally catches candidate-close failure and throws AggregateError containing original+cleanup errors (125-130). Old-adapter close failure remains explicitly logged, after stopWatching, so an already-verified replacement can still recover from an unreachable retired endpoint. This is bounded cleanup behavior, not a fabricated close success.

The real-RPC session-loss regression120-139 controls verification completion using only the fixture's Anvil child. It does not interact with persistent P1 nodes.

###DStale catch-up cannot steal another wallet's token

`chain-catchup.ts:37` returns false without assigning activeCatchup when the caller no longer owns the session. The test at `chain-catchup.test.ts:23-50` starts a current fence operation, makes a false-session claim, then proves the current operation still starts its transport and opens actual Runtime readiness. Existing same-env supersession remains separately covered.

A late successful repair also has its UI caller's `getEmbeddedEnv()===env` check at network.ts:53, so that known stale caller no longer reaches catch-up. Both protections are useful: cancellation at the operation and refusal at the claim boundary.

## Authority, roots and fences retained

- Replacement uses a live capability map and live adapter registry only. No assignment to committed JReplica.rpcs, chain identity, contract addresses, WAL/checkpoint or financial balances was introduced. The owner chooses a new transport to the same configured EVM stack.
- Native tron-rpc-attested policy remains explicitly rejected at j-rpc-replace.ts:83-84. URL credentials/non-HTTP schemes reject at44-54. This does not establish native TVM recovery.
- Candidate verification is chain-ID + configured address + code-presence verification. It is not independent public-chain consensus validation or a runtime-bytecode-fingerprint guarantee. Neither source nor review should claim that stronger proof.
- Every local Entity contributes a finalized target at hosted.ts:315-327; missing adapter fails with readiness held closed. Symbol/session checks prevent stale opening or stale error publication. openAfterChainCatchup starts transport while fenced, then opens readiness. The successful repaired target is not a reason to ignore the second imported Entity jurisdiction.
- The optional signer hook remains host-owned and ephemeral. Exact local eReplica/importReplica EOA matching precedes registration; peer validators and arbitrary public EOAs do not become local keys. Unknown matches remain unregistered and original signing rejection remains. Existing backup recovery uses the same path resolver.
- No new format reader, fallback, signer inventory persistence or financial formula was introduced in the scoped patch.

## Receipts read; not rerun

The RED history remains intact:

- `reopen-lifetime-races-red.log`:4pass/4fail,44assertions; the four named ownership/rollback races are actually failing there.
- `reopen-l1-green3.log`:22pass/0fail,101assertions, including those corrected cases and failed-latest/accepted-current controls.
- Scoped runtime/UI types6 logs show the exact TypeScript invocations; root reports both exit0. QA5 build is root-reported exit0. I did not rerun either build or typecheck.
- Root subsequently reported O1run15 terminal exit0 and authorized its targeted receipt read. `o1-run15/stand/wallet-results.json` independently reports1expected/0unexpected/0skipped/0flaky,38.076297s. SHA256 `201ae1e0b623664bb5de284ca373496289e8c1a978b64dd924b37e99b32185af`.

O1run15 is exact QA5 evidence according to root's source/build binding; I confirmed the supplied source and terminal test report, not independent fetched artifact bytes. The unchanged owning test repairs both RPCs, starts a25h dispute, performs the separate own-reserve external100USDC control, reloads/password-unlocks, repairs both RPCs again and recovers disputed/observed/reserve0/collateral state. It is **not Account payout/finalization**, nativeTRON, physical-domain independence, diagnostic-off shipped behavior, full-root comparison by the browser assertion or whole release approval. The successful lower-layer replay tests separately compare canonical state hashes.

Fresh full check3 remains root-owned; candidate4's earlier full check does not certify candidate5. Separate required different-AI reviews, normal financial/browser/recovery checks and release authority still apply. No P1 action, signing request, timing change or external-model authorization is implied.

Recommended next action: finish fresh candidate5 full check3 and the remaining exact-model review legs against this same immutable source; keep mandatory product/finality evidence open until actually observed.
