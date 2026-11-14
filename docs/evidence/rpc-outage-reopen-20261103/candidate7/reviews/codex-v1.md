# Codex bounded review — reopen-review-v1

Model: **gpt-6.1-sol**, inherited from root; one AI family. The prior known-answer smoke returned4n before/10n after, BUG/FIX CONFIRM. No different-AI or whole-product confirmation is claimed.

**Overall: AMEND. Six underlying bugs confirmed; fixes3 and4 retain concrete asynchronous ownership/rollback defects.** The other four narrow fixes are confirmed within the explicit limits below. A successful serial O1 run does not exercise these interleavings.

Reviewed only the immutable packet's claim/provenance/manifest/base/owned/working.patch and claim-named targeted proof files. No live ~/xln source, tests, stands, external models, P1 nodes, deployments or denied Cross diagnostic were accessed. Only this private report was written.

Base SHA `019d45beb5954e77fe806d643845f6a4dca4fa82`;27/27 owned hashes match; patch SHA256 `bff0ca51a290633d555e65909f5e891f3c4430ad715bdbca2beac14195000a05`; manifest SHA256 `9f6c7b38aadc4aa9d2c8b22132204a7a3b70adbb54a40577472b1c822a0e2103`; both verified. All source path/line references below are relative to this packet's **owned/** unless marked base/.

## Per-claim verdicts

| Claim | BUG | FIX | Reason |
| --- | --- | --- | --- |
|1Offline local reopen|CONFIRM|CONFIRM|Catalog is no longer required for password/device unlock; canonical local restore remains mandatory and missing wallet identity/state is rejected. Typed-transient tolerance is opt-in; integrity failures still propagate.|
|2Wrong chain503/504 misclassified|CONFIRM|CONFIRM|Chain mismatch now throws ethers INVALID_ARGUMENT instead of untyped text containing503/504. Specific preserved RED→GREEN errors agree with that source change; contract absence is not swallowed.|
|3Superseded catch-up ownership|CONFIRM|AMEND|Same-env old wait is invalidated correctly, but a stale closed-session invocation can still claim the module-global symbol and invalidate the current different wallet's catch-up.|
|4Independent verified EVM RPC|CONFIRM|AMEND|Serial chain/address/code validation preserves committed J state; tentative whole-map publication and whole-map rollback are not safe under concurrent repairs, and pending repairs are not tied to the wallet session's lifetime.|
|5Settings remount display|CONFIRM|CONFIRM|The narrow successful-serial/remount case now reads the existing live override. This does not cure claim4's corrupted/provisional map; the patch remains blocked on4. Reload requires repair again; no persisted override claim is supported.|
|6Secondary EOA before replay|CONFIRM|CONFIRM|Optional host hook is propagated to the verified checkpoint and each linked input before actual replay apply, plus before browser loop. Registration requires exact seed-derived EOA equality and reuses the backup resolver; no durable field or arbitrary EOA derivation was added.|

## Required amendment A — claim4 map transaction and adapter lifetime

**Paths:** `core/runtime/recovery/j-rpc-replace.ts:55-74,77-89`; UI reachability in `ui/src/components/Networks.tsx:49-66` (busy is per NetworkRpc component); `ui/src/runtime/network.ts:50-53` (no global serialization or ownership recheck).

Concrete different-jurisdiction counterexample, starting with override mapM:

1. RequestA for chainA saves previous=M, publishes M+A at lines56-59, then awaits endpoint verification.
2. The owner can submit chainB's independent Settings row whileA waits. RequestB saves M+A, publishes M+A+B, verifies and attaches adapterB successfully.
3. RequestA then fails (wrong chain, missing code or unavailable endpoint) and lines72-73 restoreM/delete the entire map. B's accepted binding is erased even though adapterB remains live.
4. Settings remount now displays B's old published/dead gateway and any later adapter reconstruction loses the validB override. No financial root changes are required to trigger this; it is a live capability rollback defect.

Concrete same-jurisdiction variant: A verifies slowly, B publishes URLB and attaches adapterB, thenA completes later and closesB/attachesA at77-89 while the override map still namesURLB. The API/UI can now reportB while the actual adapter isA. Remount or two entry points can defeat a per-component busy flag.

The URL map is also observable **before** verification (line59), so `NetworkRpc`'s map lookup at40-46 is a tentative selection during the await, not inherently an applied verified live binding. The normal serial success fixes the historical display bug but does not make this map a transaction.

Smallest correction direction: validate against a local candidate config without globally publishing it first, then atomically install the verified capability+its own current entry under one Runtime-owned serialization/attempt-ownership boundary. If staging in the map remains necessary, rollback must be entry/attempt-specific and must not erase a newer request or another jurisdiction's successful update. Preserve close-failure reporting and exact committed rpcs/roots. Do not treat a stale form's completion as authority to overwrite a newer repair.

**Session lifetime hole in the same operation:** `replaceNetworkRpc` captures env at51 before awaiting getXLN/core repair; `replaceJurisdictionRpc` has no ownership token/check after its awaits. If the user locks/switches wallets while verification is pending, adapter.close/drain can finish for that env, then lines77-89 attach a newly verified adapter to the disposed Runtime. At minimum, stale completion must close its candidate and make no live-map/adapter/view mutation. This is resource/liveness authority, not proof of a financial-signature exploit.

Suggested focused regressions before re-review (not run here): overlapping repairs for two networks withB successful thenA rejected preservesB; overlapping same-network repairs leave URL/adapter consistent with the accepted operation; lock/switch during a held verification closes the candidate and leaves the old env detached. Assert canonical state/rpcs unchanged throughout.

## Required amendment B — claim3 a stale caller can supersede the current session

**Paths:** `ui/src/runtime/chain-catchup.ts:34-40`; `ui/src/runtime/hosted.ts:309-314,352-353`; late caller at `ui/src/runtime/network.ts:50-53`.

Concrete sequence:

1. WalletA begins an RPC repair, then is locked; walletB opens and begins legitimate catch-up. B owns active symbolB and its fence is closed.
2. A's pending repair completes later and calls `resumeWalletChainCatchup(envA)`.
3. `claimChainCatchupOwnership(() => getEmbeddedEnv()===envA)` writes a new module-global active symbol **before** checking that predicate.
4. A's subsequent assertSessionOwned fails, soA cancels itself, but it has already invalidatedB's owns callback. B's valid wait now cancels and can never open its fence until another owner action starts catch-up.

The added same-env test at `chain-catchup.test.ts:23-60` proves supersession when both claims are current; it does not exercise a stale session trying to claim after the newer session.

Smallest correction: do not assign/replace activeCatchup for an invocation that no longer owns the session. Validate the current session before claiming (or make the ownership helper refuse a stale claim), and retain the post-await checks. A focused regression should createB's valid claim, attemptA's false-session claim, then assertB still owns and can finish. Claim4 session cancellation additionally removes the real late-RPC caller path.

Within one live session, the existing Symbol test is sound: claim occurs before first await, probe checks before reading/publishing, openAfterChainCatchup checks ownership after wait and starts transport before setting readiness, and stale completion/error handlers return without clearing the new view. Every local Entity owner contributes a target; missing adapter throws with fence held. These properties must remain after the amendment.

## Narrow confirmations and evidence limits

###1Offline boot and fail-closed local state

`ui/src/screens/Gate.tsx:290-333,358-368` passes stack=null for existing password/device wallets. Creation/import still require a discovered stack. `ui/src/runtime/hosted.ts:402-413` checks seed-derived runtime identity and refuses missing primary replica or no J replicas; it does not manufacture an empty replacement wallet. Error cleanup at502-505 locks/clears keys. Adapter options at `ui/src/runtime/adapter.ts:158-163` use the same xln.main and canonical storage.

`connectVerifiedJAdapter` catches startup only at `core/runtime/recovery/j-adapter-restore.ts:190-194` and returns null only with explicit tolerateUnreachable+hasRpcs+existing transient classifier. Address/chain/receipt-commitment checks remain after construction and outside that tolerant catch. Committed J replicas are normalized through the existing canonical snapshot; trusted RPCs live only in infrastructure. This packet does not include the unchanged classifier/factory internals, so this review confirms the changed boundary and concrete supplied cases, not every provider-specific nested error shape.

###2Typed chain mismatch

`core/jurisdiction/adapter/rpc/rpc-network.ts:10-20` uses assertArgument and still compares reported/configured chain IDs before returning. The preserved restore-503 RED shows plain chain mismatch503/504 incorrectly returning null; the new exact tests at `core/__tests__/runtime/lifecycle/j-rpc-replace.test.ts:99-111` expect INVALID_ARGUMENT for31338/503/504 and preserve no-code hard failure. The GREEN log supports those concrete runs. No change to J roots/rpcs appears in this function.

###4Validation that remains valid despite the concurrency blocker

`j-rpc-replace.ts:14-25` rejects non-HTTP(S) and URL credentials;44-52 requires an existing RPC-backed chain and explicitly rejects native tron-rpc-attested policy. The candidate is constructed from the same committed replica and checked for matching configured addresses/chain/receipt policy in j-adapter-restore; `j-rpc-replace.ts:92-103` independently reads network and nonempty code at configured contract addresses before retiring the old adapter. This is chain-ID/address/code-presence validation, not independently authenticated public-chain execution or expected runtime-bytecode fingerprint verification. The patch does not claim native TRON replacement.

###5Display scope

`ui/src/components/Networks.tsx:35-46` computes the displayed active RPC from the existing infrastructure override for the exact jurisdiction identity; it no longer resets display to the committed published gateway just because the component remounted. The O1 helper at `ui/tests/hub-outage.ts:131-145` repairs, waits for RPC verified/fence removal, navigates Home→Settings, then asserts the URL. The test repeats the two repairs after page reload at `e2e-hub-outage-exit.spec.ts:203-211`; it does not prove URL persistence across reload. Keeping this selection ephemeral is consistent with unchanged committed rpcs.

###6Keys and replay order

`core/storage/recovery/journal/replay.ts:169-191`: each frame hash/link is checked; checkpoint canonical state is additionally verified when a hook is present even if checkpoint==tip; checkpoint hook precedes any tail; a decoded linked journal's input is passed to the hook before replayRecoveryFrameJournals. Existing canonical final replay verification remains. `core/runtime/recovery/live-restore.ts:42-48` passes the hook before rehydrate; `core/runtime/replica/bootstrap.ts:123` calls it again before browser-loop start. Core never infers a wallet HD path.

`ui/src/runtime/wallet-signers.ts:12-25` enumerates only actual local eReplica signer EOAs and linked importReplica signer/config descriptors, skips exact already-registered keys, derives a candidate index, then batch-prewarms only matching labels. `ui/src/runtime/keys.ts:19-25` proves actualEOA==seed account0 or actualEOA==seed jurisdiction index. Unknown matches are left unregistered, so original missing-key rejection remains if signing needs them. Backup `recoverySigners` uses that same resolver and preserves its explicit unknown-derivation error. No private key is derived from a public EOA, peer validators are not treated as owned signers, and the new hook is not persisted.

The new real-WAL test at `wallet-signers.test.ts:15-119` clears the cache, covers materialized tip and actual sparse tail, imports secondary after primary and signs a profile update, then checks exact canonical state. The negative case122-169 checks wrong jurisdiction/foreign seed not granted and state hash unchanged. It does not explicitly exercise importReplica+first sign in the very same frame or a hook exception cleanup, but source ordering places the hook before the complete input apply. These are bounded test limits, not separate demonstrated defects.

## Targeted receipt checks

These were **read**, not rerun. O1 is QA4 with diagnostics and two EVM simulators; one labelled Tron is not native TVM.

- `restore-503-red.log`:7pass/2fail; wrong-chain503/504 incorrectly tolerated.
- `catchup-ownership-red.log`:3pass/1fail; old same-env ownership regression.
- `wallet-signers-profile-red.log`:0pass/1fail; actual signed profile replay fails MISSING_SIGNER_KEY at height3.
- `reopen-l1-green2.log`:16pass/0fail,79assertions. Types logs show the scoped commands; root supplies their exit0.
- O1run12:0expected/1unexpected/0skipped/0flaky,40.130469s; stale Tron-labelled EVM RPC display after remount.
- O1run13:0expected/1unexpected/0skipped/0flaky,39.969712s; missing secondary signer during readState replay.
- O1run14:1expected/0unexpected/0skipped/0flaky,36.283286s. Source test proves dispute START and own-reserve external control, then reload/password unlock + both RPC repairs; not Account payout/finalization, physical independence, diagnostic-off shipment or whole release. The test's post-reload financial assertion checks disputed/observed/reserve0/collateral unchanged; it does not itself compare a full pre/post committed Account root digest.

O1 wallet-results SHA256: run12 `6f13e86e374f61017517d450dfe32983203ac1d1e7bd32fe0051635f4a8ffcbe`; run13 `53b7c3e215db6a00a5f7d2cd318ecb0504c27c55f284c0c59c39762e3bcfce88`; run14 `634ee87b2c496fc6f860b3a7e8145866f98b01ab5ba8dd9abe6e4c29b3b97d8e`.

Fresh full check is root-owned ongoing and is not certified by this review. No P1 action or chain timing was inspected. Recommended next action: add the two concurrency/lifetime regressions above, fix the first demonstrated failed interleaving, then review a newly frozen packet and rerun the owning O1 boundary.
