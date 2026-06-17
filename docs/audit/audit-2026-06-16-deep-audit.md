# Deep audit — contracts / runtime / frontend (2026-06-16)

Goal: less code, more secure, more stable. Findings are ranked by severity.
Every "delete" candidate below was verified to have **zero** import/dispatch/test
references unless noted. Audit only — no code changed.

## Summary

| Category | Lines | Risk |
|---|---|---|
| Dead contract files (5) | ~307 | safe delete |
| Dead/legacy runtime files (4 dead + 2 test-only) | ~682 | safe delete (migrate 2 tests) |
| Dead frontend components (10) | ~2275 | verify-then-delete |
| Dead functions in live files | ~130 | safe delete |
| **Total deletable** | **~3400** | |

Plus 1 latent contract bug (silently-dead OZ hook) and several low-severity items.

---

## ⚠️ HEADLINE FINDING

### H1 — Off-chain hanko verifier is MORE permissive than on-chain (HIGH, precondition-gated)
**Divergence:** the runtime accepts entity signatures that the jurisdiction contract
would reject — the classic "off-chain trust exceeds on-chain enforceability" gap.

- On-chain `EntityProvider.verifyHankoSignature` requires **two** thresholds per claim
  (`EntityProvider.sol:848,853`):
  - `eoaVotingPower >= threshold` (EOA-signer weight **alone**), AND
  - `totalVotingPower >= threshold` (EOA + nested-entity "assume-yes" weight).
- Off-chain `recoverHankoEntities` (`runtime/hanko/core.ts:456`) checks **only**
  `totalVotingPower >= claim.threshold` — EOA + nested weight combined. There is no
  separate EOA-only gate.
- `verifyHankoForHash` (`runtime/hanko/signing.ts:454`) does not close the gap:
  - the `expectedAddresses.length > 0` branch checks each recovered EOA is *in* the
    board but never that EOA weight meets threshold (`signing.ts:611-619`);
  - the self-contained branch sums `signerWeightSum` over **all** slots with
    `memberIndex >= numPlaceholders` (`signing.ts:626-633`) — that includes the
    claim/nested-entity zone, so it is not an EOA-only sum either.

**Impact:** a counterparty whose board crosses `threshold` only with nested-entity
("assume-yes") weight — EOA weight alone `< threshold` — can produce a hanko that:
- **passes** our off-chain `verifyHankoForHash` → we commit their frame / store their
  dispute seal and advance bilateral state, but
- **fails** on-chain `verifyHankoSignature` → in a dispute we cannot enforce their
  signed proof. Asymmetric: they can still present our (chain-valid) signatures.
Net: the victim advances state believing it is enforceable, and loses the on-chain
forcing recourse → fund-loss risk in adversarial settlement.

**Precondition (why not "critical" today):** exploit requires a **multi-member /
nested-entity board** opening an account, with signed EOA weight below threshold.
Today's accounts use **single-signer lazy entities** (threshold 1, one EOA) handled
by the sound hot path at `signing.ts:484-518`, where `eoaVotingPower == totalVotingPower`
— no divergence. But hanko's entire purpose is hierarchical M-of-N; this gap becomes
live the moment nested/multisig entities transact. Fix before that.

**Fix:** mirror the on-chain rule off-chain — in `recoverHankoEntities` compute
`eoaVotingPower` (signer-zone weight only) and require it `>= threshold` independently,
and/or have `verifyHankoForHash` enforce an EOA-only threshold in both branches. This
is the one place where off-chain and on-chain signature semantics MUST be identical.

---

## CONTRACTS

### C1 — `EntityProvider._afterTokenTransfer` is silently dead (LATENT BUG, medium)
- `jurisdictions/contracts/EntityProvider.sol:1018`
- Installed OZ is **5.4.0**, which routes all balance changes through `_update(...)`.
  OZ 5.x has **no `_afterTokenTransfer` hook**. The function is not marked
  `override` and is **never called**.
- Effect: `totalControlSupply` / `totalDividendSupply` are NOT maintained on any
  future mint/burn. Harmless *today* only because supply is fixed at registration
  and there is no burn path — but `_validateControlProposer` divides by
  `totalControlSupply`, so any future mint/burn path silently corrupts governance math.
- Fix: delete the dead hook, or re-implement by overriding `_update`.

### C2 — Dead contract files (~307 lines, safe delete)
Not imported by any contract, deploy script, or test:
- `ECDSA.sol` (98) — EntityProvider has its own `_recoverSigner`.
- `IDepository.sol` (33)
- `IDeltaTransformer.sol` (81)
- `console.sol` (54)
- `Token.sol` (41) — `interface Token`, unreferenced.

### C3 — Dead dispute-verification path (low)
- `Account.verifyFinalDisputeProofHanko` (`Account.sol:172-184`) has no callers;
  the live counter-dispute path uses `verifyDisputeProofHanko` (`Depository.sol:890`).
- `MessageType.FinalDisputeProof` (`Types.sol:212`) exists only to feed that dead
  function. Delete both together.

### C4 — Stale interface `IEntityProvider.sol` (low)
- Imported by `Account.sol`, but only `verifyHankoSignature` is used.
- `registerEntity`, `getEntity`, `proposeNewBoard` do not match the real
  implementation names (`registerNumberedEntity`, `getEntityInfo`, `proposeBoard`)
  and declare `verifyHankoSignature` as non-view while the impl is `view`.
  Misleading; trim to the one function actually consumed.

### C5 — Legacy struct fields carried in calldata (low, ABI change)
Documented as legacy/reserved; removing them shrinks dispute/batch calldata:
- `Settlement.entityProvider`, `Settlement.hankoData` (`Types.sol:136-137`)
- `Batch.hub_id` (`Types.sol:204`)
- `FinalDisputeProof.disputeUntilBlock` (`Types.sol:124`)

### C6 — `DeltaTransformer.cleanSecret` reverts on fresh chains (very low)
- `DeltaTransformer.sol:309`: `block.number - 100000` underflows (0.8 checked) when
  `block.number < 100000` (fresh anvil). Gas-refund convenience only; gate with
  `block.number > 100000` before subtracting.

### C7 — `applySwap` int-cast can wrap on adversarial signed state (very low)
- `DeltaTransformer.sol:235-236`: `int(swap.addAmount * fillRatio / MAX_FILL_RATIO)`.
  `int(uint)` does not revert on overflow; a value > 2^255 wraps negative. This is
  signed ProofBody state (self-harm only), and deltas are bounded elsewhere by
  collateral+credit limits, so impact is bounded. Consider `SafeCast.toInt256`.

### C8 — `onERC1155Received` auto-registers tokens (very low / griefing)
- `Depository.sol:1152`: a stray ERC1155 transfer (not via `_externalTokenToReserve`)
  still pushes a `_tokens` entry. No fund inflation (does not credit reserves), but
  grows `_tokens` unboundedly. Acceptable; noting for completeness.

### C9 — HashLadder calldata duplicate logic (cleanup, low)
- `HashLadder.sol` keeps memory + calldata twins (`verifyPartial`/`verifyPartialCalldata`,
  `buildCommitment`/`buildCommitmentCalldata`, `partialRootFromReveals*`, `verify`,
  `verifyCalldata`, `revealForNibble`). Production `DeltaTransformer` uses only
  `verifyFull` + `verifyPartial`; the calldata variants exist solely for
  `HashLadderHarness` tests. Internal unused funcs are stripped from bytecode, so
  this is source-level dedup only.

---

## RUNTIME

### R1 — Superseded HTLC handlers (delete; ~298 lines)
`htlc-resolve.ts` unified reveal/timeout/cancel (its own header says
"Replaces: htlc_reveal, htlc_timeout, htlc_cancel"). Production dispatch
(`account-tx/apply.ts`) only routes `htlc_lock` and `htlc_resolve`:
- `account-tx/handlers/htlc-cancel.ts` (64) — **zero callers anywhere**. Delete.
- `account-tx/handlers/htlc-reveal.ts` (145) — only `hold-underflow-guards.test.ts`. Migrate test → delete.
- `account-tx/handlers/htlc-timeout.ts` (89) — only `hold-underflow-guards.test.ts`. Migrate test → delete.

### R2 — Other dead runtime files (~384 lines, verify-then-delete)
- `crypto-webcrypto.ts` (104) — zero references.
- `jadapter/batch-helpers.ts` (47) — zero references.
- `jurisdiction-factory.ts` (233) — exports `createXlnomy`/`exportXlnomy`, neither
  imported anywhere (frontend uses its own `XlnomyLike`); the file's own error string
  says real chains should use `createJAdapter()` from jadapter. Confirm no
  remaining dynamic use, then delete.

### R3 — Dead function `generateAccountProof` (delete; ~76 lines)
- `account-consensus.ts:1303-1378` — no callers (comment: "for future J-Machine
  integration"). It is the only consumer of the single-signer `signAccountFrame`
  inside account-consensus; removing it lets that import drop too.

### R4 — `runtime/cli.ts` standalone REPL (judgment)
- Not imported; runs directly via `bun runtime/cli.ts`. Keep only if still used as a
  dev tool, otherwise delete. Not counted in totals.

### R5 — `market-snapshot.ts:130 updatedAt: Date.now()` (verify, low)
- All other `Date.now()` hits are transport/loop infra (allowed). Verify this
  `updatedAt` never enters a consensus-hashed structure; if it does, it's a
  determinism violation per CLAUDE.md and must use `env.timestamp`.

### R7 — Runtime/contract batch-limit divergence on `revealSecrets` (BUG, medium-stability)
- The contract enforces `MAX_BATCH_SECRET_REVEALS = 32` (`Depository.sol:93`, checked
  in `_assertBatchBounds:362`), but the runtime preflight does **not** mirror it:
  - `J_BATCH_CONTRACT_LIMITS` (`j-batch.ts:172-180`) has no `maxSecretReveals`.
  - `getJBatchContractLimitIssue` (`j-batch.ts:208-236`) never checks `revealSecrets.length`.
  - `batchAddRevealSecret` (`j-batch.ts:1089`) only calls `requireBatchRoom` (the
    total-ops cap of 50), not a per-array guard.
- Effect: a batch accumulating **33–50** reveal secrets (under the 50 total cap)
  passes all runtime validation, then **reverts on-chain with E10**. Under a busy
  hub resolving many concurrent HTLCs this is reachable → a stuck/failing J-batch
  submission (stability, not fund loss).
- This is the only reachable gap: the other per-array contract limits not mirrored
  (`reserveToReserve`/`collateralToReserve`/`externalTokenToReserve`/
  `reserveToExternalToken` = 64) all exceed the 50 total cap and are unreachable.
- Fix: add `maxSecretReveals: 32` to `J_BATCH_CONTRACT_LIMITS`, check it in
  `getJBatchContractLimitIssue`, and have `batchAddRevealSecret` call
  `requireArrayRoom('revealSecrets', …, 32)`.

### R9 — `createSettlementHashWithNonce` hardcodes empty debt-forgiveness (low, fail-closed)
- `proof-builder.ts:501` always encodes `forgiveDebtsInTokenIds: []`, but the contract
  hashes `s.forgiveDebtsInTokenIds` (`Account.sol:355`). A settlement that actually
  forgives debt, signed via this helper, would produce a hash that does **not** match
  on-chain → signature rejected (fail-closed, no fund loss), but the cooperative
  settlement silently can't be finalized. If debt-forgiveness settlements are a real
  path, thread the actual `forgiveDebtsInTokenIds` through this helper.
- (Common no-forgiveness path verified byte-correct against the contract encoding:
  tuple field order, `MessageType.CooperativeUpdate=0`, canonical `leftEntity:rightEntity`
  account key.)

### R10 — Dead, misleadingly-named `calculateHtlcFee` (delete, very low)
- `htlc-utils.ts:18` `calculateHtlcFee` returns amount-after-fee (forward amount), not the
  fee — but has **no production callers** (the real fee helper is `calculateHtlcFeeAmount`).
  Dead + misleading; delete it. Fee math itself is sound (positive guard, fee≥amount throw).

### R8 — `AccountSettled` reserve guard skips legitimate zero (low, currently masked)
- `entity-tx/j-events.ts:496` sets local reserve only `if (ownReserve)`. When a
  settlement drives a reserve to exactly **0** and `ownReserve` normalizes to `0n`/`0`
  (falsy), the handler skips the write and logs `reserve_missing`, leaving a stale
  non-zero local reserve.
- Currently masked: the contract always co-emits `ReserveUpdated` (handled at
  `j-events.ts:461-470` with no truthiness guard) on the same balance change, which
  corrects the value. Still a latent correctness smell — prefer an explicit
  `ownReserve !== undefined && ownReserve !== null` check instead of truthiness.

### R6 — PRIOR CRITICAL FINDING NOW RESOLVED (no action)
- The 2026-06-12 cross-j dispute-gate self-block (memory:
  `audit-2026-06-12-dispute-gate-breaks-crossj-salvage`) is **fixed**.
  `dispute.ts:338-373` now folds evidence txs (`pull_resolve`/`swap_resolve`) into
  dispute arguments instead of blocking on them, and `pendingFrameBlocksDisputeArguments`
  only blocks on non-evidence argument-changing txs. Memory note updated.

---

## FRONTEND (~2275 lines dead, verify-then-delete)

10 components/modules with **zero** import references in `src` (none are SvelteKit
route files, so they require explicit imports that do not exist):

| File | Lines |
|---|---|
| `lib/components/Embed/IsolatedScenarioPlayer.svelte` | 452 |
| `lib/components/Network/ProfileForm.svelte` | 424 |
| `lib/components/Network/ProfileCard.svelte` | 308 |
| `lib/components/Admin/AdminPanel.svelte` | 258 |
| `lib/components/Entity/SwapPairToolbar.svelte` | 206 |
| `lib/components/Entity/shared/DeltaTokenList.svelte` | 160 |
| `lib/view/3d/EntityObject.ts` | 157 |
| `lib/components/Entity/SwapOrderModeRail.svelte` | 147 |
| `lib/stores/jurisdictionStore.ts` | 98 |
| `lib/utils/runtimeFrameProcessor.ts` | 65 |

Recommend a quick `bun run check` + build after removal to confirm no string-based
(dynamic `import()`) references exist.

### F1 — God components far exceed the <300-line guideline (refactor, "less code")
The bulk of frontend size is concentrated in a few monoliths. Splitting these is the
highest-leverage move toward the "less code" goal and reduces re-render/merge risk:
| File | Lines |
|---|---|
| `lib/components/Entity/EntityPanelTabs.svelte` | 7899 |
| `lib/view/panels/Graph3DPanel.svelte` | 6057 |
| `lib/components/Entity/SwapPanel.svelte` | 4083 |
| `lib/components/Landing/LandingPage.svelte` | 3171 |
| `lib/components/Settings/EntitySettingsPanel.svelte` | 2900 |
- `jurisdictionStore.ts` (orphan, R/F dead list) is also a store nobody imports —
  confirms the dead-store finding.
- Frontend is otherwise clean: only 6 `@ts-ignore`/`TODO`-class markers total.

### F2 — Misc runtime dedup (low)
- `entity-tx/handlers/settle.ts:827 userAutoApprove` is a no-op wrapper around
  `settlement-ops.ts:146 userAutoApprove` (imported as `userAutoApproveByDiff`).
  Have `canAutoApproveWorkspace` + the two `scenarios/settle*.ts` import the real one
  directly and drop the wrapper.
- `jadapter/batch-helpers.ts` (R2 dead) also duplicates `buildSingleSignerHanko` and
  `prepareSignedBatch` from the live `hanko/batch.ts` — deleting it removes the dup.
- Scenario helpers (`findReplica`, `assert`, `assertBilateralSync`, `processJEvents`,
  `getOffdelta`) are copy-pasted across 10+ `scenarios/*.ts` instead of imported from
  `scenarios/helpers.ts` (known, test infra, low priority).

### F3 — Duplicate frontend utils (dedup, low; one consistency risk)
Same-named helpers defined in two files each — consolidate into one util:
- `isAccountLeftPerspective` — `Entity/entity-panel-model.ts` + `Entity/shared/account-token-details.ts`
  ⚠️ left/right perspective logic; if the copies diverge the UI shows wrong payer/payee.
- `normalizeEntityId` — `utils/entityReplica.ts` + `Entity/payment-routing.ts`
- `formatEntityId` — `utils/format.ts` + `view/components/entity/shared/formatters.ts`
- `getGossipProfiles` — `utils/entityNaming.ts` + `Entity/entity-panel-model.ts`
- `formatTimestamp`, `getNetworkByChainId` — also duplicated across 2 files each.
- (Frontend otherwise clean: no `eval`/`innerHTML`/raw-BigInt-JSON; `@ts-ignore` all justified;
  `.svelte` `Number(bigint)/Number(divisor)` uses are display-only, no consensus impact.)
- **Scenario-helper duplication (test infra, low priority but high count):** `findReplica`,
  `assert`, `processJEvents` are each copy-pasted in **~6** `scenarios/*.ts` files
  (`getOffdelta`, `processUntil`, `assertBilateralSync`, `converge` ~2× each) instead of
  imported from `scenarios/helpers.ts`. Consolidating removes hundreds of duplicated lines.

### F4 — Frontend state-mutation safety (verified across ALL .svelte files)
A repo-wide scan of **every** `.svelte` file found **zero** direct mutations of runtime
financial/consensus state (`deltas.set`, `accounts.set`, `reserves.set`, `offdelta=`,
`collateral=`, `eReplicas.set`). The UI is strictly read/display; all state changes flow
through runtime input channels. This is the property that makes the unread UI-rendering
panels safe to exclude from line-by-line review — they cannot affect fund safety or
consensus regardless of their rendering logic.

### Coverage note
Deeply read & verified sound: `account-consensus.ts` (full), `entity-consensus.ts`
(BFT commit/precommit/propose), `cross-jurisdiction.ts` (atomic-swap fill accounting),
`dispute.ts` readiness gate, `j-batch.ts` limits, all core contracts. Stub/TODO sweep
across runtime+contracts: clean (no banned workarounds in production paths).

---

## Off-chain ↔ on-chain encoding parity (all verified byte-consistent)
Every signature/authorization hash the runtime builds was checked against the exact
Solidity encoding. All match — so H1 is purely a *verification-rule* gap, not an
encoding artifact that would coincidentally block the bad signature earlier:
| Hash | Runtime | Contract | Result |
|---|---|---|---|
| DisputeProof msg | `proof-builder.ts:383` | `Account.sol:165` | ✅ types+order+MsgType=1 |
| CooperativeUpdate settle | `proof-builder.ts:493` | `Account.sol:355` | ✅ (except R9 forgiveDebts) |
| Batch hanko | `j-batch.ts:660` (`solidityPacked`) | `Account.sol:149` (`encodePacked`) | ✅ |
| Watchtower counter-dispute | `recovery/crypto.ts:169` | `Depository.sol:256` | ✅ field order + domain string |
| Domain strings | `XLN_DEPOSITORY_HANKO_V1`, `XLN_WATCHTOWER_COUNTER_DISPUTE_V1` | identical | ✅ |

## Notes on what was NOT found (reassurance)
- Bilateral consensus (`account-consensus.ts`) is robust: frame-chain `prevFrameHash`
  linkage, hanko verification with entity-id binding, strict bilateral-field
  comparison (offdelta/limits/allowances/holds), and sender-hash recomputation are
  all present and correctly ordered.
- Hanko flashloan-governance EOA-threshold guard (`EntityProvider.sol:848`) holds.
- Flashloan aggregation-by-tokenId and return/burn checks
  (`Depository._processBatch`) are correct.
- Dispute nonce model (strictly-greater, set-not-increment) is consistent across
  `Account.sol` and `Depository.sol`.
- **Collateral / "God Mode" defense is robust.** Direct `reserve_to_collateral` txs are
  hard-blocked (`account-tx/handlers/reserve-to-collateral.ts`). The only collateral
  path is `j_event_claim` → `tryFinalizeAccountJEvents` (`entity-tx/j-events-account.ts:123,147`),
  which finalizes a collateral change ONLY when **both** sides independently observed the
  same `(jHeight, jBlockHash)` AND the event multisets match. A single party cannot forge
  collateral; replay-guarded by `lastFinalizedJHeight` + `jEventChain` dedup.
- **Reserve crediting is replay/reorg-safe.** `ReserveUpdated`/`AccountSettled` set
  absolute balances (idempotent); the RPC watcher (`jadapter/rpc.ts`) uses log dedup
  (`_seenLogs`), a persisted block cursor (`helpers.ts:getWatcherStartBlock`), and
  confirmation-depth reorg protection.
- **Settlement conservation** (`settlement-ops.ts:126`) enforces
  `leftDiff+rightDiff+collateralDiff==0` per diff, matching `Account.sol:370`; every
  compiled op preserves it.
- **Transport is a dumb pipe** — relay/p2p carry opaque entity inputs; authenticity is
  end-to-end via hanko verified at the consensus layer, not at transport. No transport
  auth bypass possible (a forged relay message becomes an entityInput that consensus
  rejects on hanko failure).
- **Determinism holds** in the auto-trigger layer: `entity-crontab.ts` uses only
  `replica.state.timestamp` (no `Date.now`/`Math.random`/real timers in RJEA flow).
