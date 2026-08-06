# Canonicity/Readability Audit Findings (xln core)

Ordered by (LOC removed x confidence) descending. Net ~317 LOC removed; all deletions/merges, no additions.

## 1. IDeltaTransformer.sol is a dead interface
file: jurisdictions/contracts/IDeltaTransformer.sol:1-87
code: `interface IDeltaTransformer { ... applyBatch ... encodeBatch ... revealSecret ... hashToBlock ... hashToTimestamp }`
why: No .sol imports it; DeltaTransformer.sol declares `contract DeltaTransformer { }` without `is IDeltaTransformer`. "Candidate for ERC standardization" is aspirational, not a live trust boundary. SINGLE CANONICAL PRODUCTION PATH forbids unused surfaces.
fix: Delete file; regenerate typechain.
loc: -87
breaks: Only dead typechain stubs. Reviewer: `rg "IDeltaTransformer" jurisdictions/contracts/` returns nothing.
confidence: 70

## 2. Token.sol is a dead ERC20-style interface
file: jurisdictions/contracts/Token.sol:1-41
code: `interface Token { function totalSupply() ... balanceOf ... transfer ... transferFrom ... approve ... allowance ... event Transfer ... event Approval ... decimals }`
why: No .sol imports `Token.sol` (`rg "import.*Token\.sol" jurisdictions/` returns nothing). Depository.sol defines its own inline `IERC20`. Parallel/unused interface alongside the live inline IERC20.
fix: Delete file; regenerate typechain.
loc: -41
breaks: Only dead typechain stubs. Reviewer: `rg "import.*Token\.sol" jurisdictions/` returns nothing.
confidence: 75

## 3. IDepository.sol is a dead interface; Depository duplicates ReserveMint
file: jurisdictions/contracts/IDepository.sol:1-33
code: `interface IDepository { event ReserveUpdated(...); struct ReserveMint { bytes32 entity; uint tokenId; uint amount; } ... _reserves ... mintToReserve ... processBatch ... adminRegisterExternalToken }`
why: No .sol imports IDepository; Depository.sol declares `contract Depository is ReentrancyGuardLite` with its own literal-duplicate `struct ReserveMint` (lines 34-39). No production .ts uses the typechain IDepository type.
fix: Delete file; regenerate typechain.
loc: -33
breaks: Only dead typechain stubs. Reviewer: `rg "is IDepository|import.*IDepository\.sol" jurisdictions/` returns nothing.
confidence: 75

## 4. Dead re-export chain of MAX_RUNTIME_J_* through 3 layers
file: runtime/runtime/loop-routing.ts:33-36,273-276 (also loop.ts:1-6,174-177 and composition.ts:117-120,177-180)
code: `import { MAX_RUNTIME_J_INPUTS, MAX_RUNTIME_J_TXS, MAX_RUNTIME_J_TXS_PER_JURISDICTION, MAX_RUNTIME_J_INPUT_BYTES, ... } from './input-validation';` ... `MAX_RUNTIME_J_INPUTS, MAX_RUNTIME_J_TXS, MAX_RUNTIME_J_TXS_PER_JURISDICTION, MAX_RUNTIME_J_INPUT_BYTES,` (in return object)
why: The 4 constants are imported and re-exported in createRuntimeRoutingApi/createRuntimeLoopApi return objects but never used in function bodies. Grep for `.MAX_RUNTIME_J_INPUTS|api.MAX_RUNTIME|loopApi.MAX|routingApi.MAX` returns zero consumer matches. Same dead re-export in loop.ts and composition.ts. Test imports directly from input-validation.ts.
fix: Remove the 4 constants from imports and return objects in loop-routing.ts, loop.ts, composition.ts (keep validateRuntimeInputShapeAndLimits where used).
loc: -22
breaks: A caller reading runtimeLoopApi.MAX_RUNTIME_J_INPUTS would break. Reviewer: `rg "\.MAX_RUNTIME_J_INPUTS|\.MAX_RUNTIME_J_TXS"` returns only input-validation.ts and the three re-export files.
confidence: 95

## 5. encryptForValidatorManifest and decryptForLocalValidator are test-only wrappers
file: runtime/protocol/htlc/multi-recipient.ts:130-144 and 252-269
code: `export const encryptForValidatorManifest = async (plaintext: string, ...) => encryptBytesForValidatorManifest(new TextEncoder().encode(plaintext), ...);` ... `export const decryptForLocalValidator = async (ciphertext, ...) => new TextDecoder().decode(await decryptBytesForLocalValidator(ciphertext, ...));`
why: Grep for both names returns only `__tests__/multisig-htlc-validator-encryption.test.ts` and the defining file. Production callers (envelope.ts, htlc-onion-post-commit.ts) import only the `*Bytes*` variants. Thin TextEncoder/TextDecoder adapters with no production caller.
fix: Delete both functions. Update test to call `*Bytes*` variants with TextEncoder/TextDecoder at ~6 call sites.
loc: -24
breaks: Only the test file. Reviewer: `rg "encryptForValidatorManifest|decryptForLocalValidator" runtime/ --glob '!**/__tests__/**'` returns only the deleted definitions.
confidence: 85

## 6. deriveDisputeFinalization and DisputeFinalization are test-only batch helpers
file: runtime/protocol/dispute/finalization.ts:63-67 and 221-235
code: `export type DisputeFinalization = Readonly<{ tokens: readonly DisputeTokenFinalization[]; tokenCount: number; allTokensConserved: boolean; }>;` ... `export function deriveDisputeFinalization(inputs: readonly DisputeTokenFinalizationInput[]): DisputeFinalization { ... }`
why: Grep for both returns only `__tests__/dispute-finalization.test.ts` and the defining file. Production callers import only `deriveDisputeTokenFinalization` and `DisputeTokenFinalization`. Batch wrapper (duplicate-token check + aggregation) is test convenience.
fix: Move both into the test file (or inline the 2 callers there). Production file keeps only deriveDisputeTokenFinalization and its input/output types.
loc: -16
breaks: Only the test file. Reviewer: `rg "deriveDisputeFinalization|\bDisputeFinalization\b" runtime/ --glob '!**/__tests__/**'` returns only the deleted definitions.
confidence: 85

## 7. proof-body.ts re-exports 8 unused typechain types alongside the one live ProofBodyStruct
file: runtime/protocol/dispute/proof-body.ts:11-24
code: `export type { ProofBodyStruct, ProofBodyStructOutput, TransformerClauseStruct, TransformerClauseStructOutput, AllowanceStruct, AllowanceStructOutput, FinalDisputeProofStruct, FinalDisputeProofStructOutput } from '...Depository.ts';` ... `export type { DeltaTransformer } from '...DeltaTransformer.ts';`
why: Grep shows only `ProofBodyStruct` is imported by callers (j-events.ts, evidence-retention.ts, state-clone.ts). proof-builder.ts imports TransformerClauseStruct and DeltaTransformer directly from typechain-types, NOT through this re-export. The other 7 names have zero external importers.
fix: Collapse to `export type { ProofBodyStruct } from '...Depository.ts';` and delete the DeltaTransformer re-export block.
loc: -10
breaks: Nothing. Reviewer: `rg "from ['\"].*dispute/proof-body['\"]"` and inspect each import — none reference the removed names.
confidence: 95

## 8. Dead type and deadline re-exports in account/consensus/index.ts
file: runtime/account/consensus/index.ts:75-86
code: `export type { AccountConsensusFrameResult, AccountSwapOfferCreated, HandleAccountInputResult, ProposeAccountFrameResult } from './types';` ... `export { getIncomingAccountDeadlineViolation, HTLC_ENFORCEMENT_RESERVE_MS, isHtlcSecretEnforcementWindowClosed };` ... `export type { AccountInputSecurityContext };`
why: Grep for `from ['"].*account/consensus['"]` shows external files only import applyAccountInput, proposeAccountFrame, computeFrameHash. Every consumer of these types/constants imports directly from ./types or ./deadline-policy. None of these 5 types or 4 deadline symbols are imported through the index re-export.
fix: Delete lines 75-81, 85, 86 (and drop isWithinAccountFrameBounds on line 88 if verified dead).
loc: -9
breaks: A consumer wanting HandleAccountInputResult/HTLC_ENFORCEMENT_RESERVE_MS from the barrel would fail to compile; reviewer runs `bun run check` and greps `from '.*account/consensus'`.
confidence: 95

## 9. measureRuntimeFrameCloneBytes is dead in production
file: runtime/runtime/frame/clone.ts:49-55
code: `export const measureRuntimeFrameCloneBytes = (source: RuntimeReplica): number => encodeBuffer(buildCanonicalRuntimeStateSnapshot(source)).byteLength;`
why: Grep (excluding __tests__/) returns zero call sites. Only consumer is `__tests__/storage-config.test.ts`. The two imports on lines 8-9 exist solely to feed it.
fix: Delete lines 8-9 and 49-55; change line 2 to `import type { RuntimeInput } from '../types';` (drop RuntimeReplica). Test inlines the one-liner.
loc: -9
breaks: `__tests__/storage-config.test.ts` import on line 12 fails until the test inlines the one-liner. Reviewer greps measureRuntimeFrameCloneBytes (excluding __tests__) and confirms zero hits.
confidence: 85

## 10. DisputeConfig interface in proof-body.ts is a dead duplicate
file: runtime/protocol/dispute/proof-body.ts:142-149
code: `export interface DisputeConfig { leftDisputeDelay: number; rightDisputeDelay: number; }`
why: Grep for DisputeConfig across all .ts files returns only proof-body.ts. The canonical dispute config is the inline anonymous type in `runtime/types/account.ts:242-245` (`disputeConfig: { leftDisputeDelay: number; rightDisputeDelay: number; }`), which every consumer uses. Named interface is a parallel/unused type definition.
fix: Delete the JSDoc comment and the DisputeConfig interface (lines 142-149).
loc: -8
breaks: Nothing — no caller imports DisputeConfig from proof-body.ts. Reviewer: `rg "\bDisputeConfig\b" runtime/ --glob '!**/proof-body.ts'` returns no matches.
confidence: 95

## 11. Useless 1:1 wrapper around buildCrossJurisdictionAdmissionFillNoticeOutput
file: runtime/entity/consensus/cross-j-fill-ack.ts:34-40
code: `export const buildCrossJurisdictionFillNoticeOutput = (currentEntityState, accountId, tx): EntityInput | null => { return buildCrossJurisdictionAdmissionFillNoticeOutput(currentEntityState, accountId, tx); };`
why: Identical signature to the private `buildCrossJurisdictionAdmissionFillNoticeOutput` (lines 1-32) and only delegates. The private fn has exactly one caller — this wrapper. Public name call sites: frame-tx-effects.ts:47, frame-application.ts:767; private name has zero other callers.
fix: Rename `buildCrossJurisdictionAdmissionFillNoticeOutput` to `buildCrossJurisdictionFillNoticeOutput`, add `export`, delete lines 34-40.
loc: -7
breaks: None — both call sites use the public name with the same args. Reviewer greps `buildCrossJurisdictionAdmissionFillNoticeOutput` (should be 0 after rename).
confidence: 95

## 12. AppliedRuntimeInput duplicates RuntimeInputApplyResult
file: runtime/runtime/frame/input-reducer.ts:57-67
code: `export type AppliedRuntimeInput = { entityOutbox: RoutedEntityInput[]; mergedInputs: RoutedEntityInput[]; jOutbox: JInput[]; appliedRuntimeInput: RuntimeInput; reliableIngressCommits: ReliableIngressCommit[]; immediateReliableReceipts: Array<{ runtimeId: string; receipt: ReliableDeliveryReceipt; }> };`
why: `RuntimeInputApplyResult` (apply.ts:28-37) declares the same five fields with identical types. `AppliedRuntimeInput` is exactly that plus `mergedInputs`. Two sources of truth for the apply-result contract drift silently.
fix: `export type AppliedRuntimeInput = RuntimeInputApplyResult & { mergedInputs: RoutedEntityInput[]; };` with `import type { RuntimeInputApplyResult } from './apply';`
loc: -7
breaks: Nothing — AppliedRuntimeInput remains a supertype of RuntimeInputApplyResult, so the reducer stays assignable to RuntimeFrameApplyDeps.applyRuntimeInput. Reviewer diffs the two type bodies.
confidence: 85

## 13. assertEntityStateRootCache is a test-only export in production code
file: runtime/entity/consensus/state-root.ts:557-564
code: `export const assertEntityStateRootCache = (state: EntityState): string => { const incremental = computeCanonicalEntityConsensusStateHash(state); const cold = computeCanonicalEntityConsensusStateHashCold(state); if (incremental !== cold) { throw new Error(...); } return incremental; };`
why: Grep shows the only callers are `__tests__/settlement-transition.test.ts:426,472`. No production import. The same invariant already runs in production gated by `XLN_ENTITY_STATE_ROOT_AUDIT` (state-root.ts:496-499). A test-only oracle in the production module is a parallel path SINGLE CANONICAL PRODUCTION PATH forbids.
fix: Delete the export. Tests inline: `const root = computeCanonicalEntityConsensusStateHash(s); expect(root).toBe(computeCanonicalEntityConsensusStateHashCold(s));`.
loc: -8 (production); -6 net (tests +2 lines across 2 sites)
breaks: Two test lines need rewriting; behavior identical. Reviewer: `rg "assertEntityStateRootCache"` returns only the 2 test sites, then 0 after edit; `bun run check` green.
confidence: 70

## 14. readTokenDelta iterates the whole deltas Map instead of using Map.get
file: runtime/account/swap-inbound-plan.ts:47-52
code: `const readTokenDelta = (account: AccountState, tokenId: number) => { for (const [candidateTokenId, delta] of account.deltas.entries()) { if (candidateTokenId === tokenId) return delta; } return null; };`
why: `account.deltas` is a `Map<number, Delta>` (per AccountState), so `account.deltas.get(tokenId)` is the canonical O(1) lookup. The hand-rolled linear scan is a compatibility-style fallback that hides the data structure and adds 6 lines for one Map.get. Not a trust-boundary duplicate; a needless wrapper around a single primitive.
fix: Delete the helper and inline `account.deltas.get(input.tokenId)` at both call sites (lines 95, 181), or replace the body with `return account.deltas.get(tokenId) ?? null;`.
loc: -6
breaks: If deltas were ever a non-Map iterable this would break, but AccountState.deltas is typed `Map<number, Delta>` and state-validation.ts enforces Map instance. Reviewer: `bun run check` plus `rg "readTokenDelta" runtime` confirms only two call sites.
confidence: 92

## 15. Duplicated SwapOfferResult type in swap-offer.ts and commit.ts
file: runtime/account/tx/handlers/swap-offer.ts:15-20 and runtime/account/tx/handlers/swap-offer/commit.ts:11-16
code: `type SwapOfferResult = { success: boolean; events: string[]; error?: string; swapOfferCreated?: SwapOfferEvent; };` (identical in both files)
why: Two byte-identical type definitions in the same swap_offer pipeline. `handleSwapOffer` (swap-offer.ts:44) just `return commitSwapOffer(...)` — its declared return type `Promise<SwapOfferResult>` is structurally the same as commitSwapOffer's return. SwapOfferEvent is imported into swap-offer.ts solely to spell this redundant type. Same trust boundary (Account bilateral commit).
fix: In commit.ts change `type SwapOfferResult` → `export type SwapOfferResult`. In swap-offer.ts delete lines 15-20 and the SwapOfferEvent import, add `import type { SwapOfferResult } from './swap-offer/commit';`.
loc: -6
breaks: If the two types ever diverge, handleSwapOffer would silently return a shape callers don't expect. Reviewer: `bun run check` — the only callers are mutation.ts:225 and tests; both rely on structural typing.
confidence: 88

## 16. Orphan section header + docstring at EOF (dead code)
file: runtime/entity/consensus/frame-application.ts:1418-1422
code: `// === HELPER FUNCTIONS ===` ... `/** * Calculate quorum power based on validator shares */`
why: File ends at line 1423 with a section banner and a JSDoc block for a function body that does not exist. `applyRuntimeOwnedEntityFrame` (line 1404) is the last real export. This is the residue of a deleted helper; it confuses readers and doc tools.
fix: Delete lines 1418-1422 (and the trailing blank line 1417 if present).
loc: -5
breaks: Nothing — pure comment deletion. Reviewer: `bun run check` and `rg "quorum power" runtime/` returns 0.
confidence: 98

## 17. deterministicEntityTimestamp duplicated 5x across cross-j handlers
file: runtime/entity/tx/handlers/cross-j-book-order.ts:51 (also cross-j-setup.ts:42, cross-j-salvage.ts:30, cross-j-sweep.ts:29, cross-j-clear.ts:38)
code: `const deterministicEntityTimestamp = (state: EntityState, env: EntityRuntimeContext): number => Number(state.timestamp || env.state.timestamp || 0);`
why: The same 2-line function is copy-pasted in 5 in-scope files. It is already exported from `runtime/orderbook/cross-j-orderbook.ts:26` and consumed by orderbook-admission.ts and frame-application.ts, so a canonical shared copy exists. Five private clones mean a bug in the timestamp fallback order must be fixed in 5 places; a reviewer scanning one file cannot know whether the others match.
fix: In each of the 5 files, delete the local `const deterministicEntityTimestamp` and import it from the shared `../../../orderbook/cross-j-orderbook` module. The shared copy has `env?` optional but every call site passes env, so the signature is compatible.
loc: -5
breaks: If any call site relied on env being required (it is not — the shared copy makes it optional), TypeScript would still accept the call. Reviewer: `rg "const deterministicEntityTimestamp"` and confirm zero remaining local defs.
confidence: 92

## 18. cloneRoutedOutputWithCachedIdentity is a trivial wrapper with a misleading name
file: runtime/runtime/delivery/identity.ts:31-33
code: `export const cloneRoutedOutputWithCachedIdentity = <T extends RoutedEntityInput>(output: T): T => { return structuredClone(output) as T; };`
why: The function body is a single `structuredClone` call. The name "WithCachedIdentity" implies it caches an identity, but it clones the whole output and caches nothing. Two callers (pending.ts:742, plan.ts:34) could call `structuredClone(output)` directly. The wrapper obscures intent and adds an indirection layer.
fix: Delete the export (lines 31-33). In pending.ts:742 and plan.ts:34 replace `cloneRoutedOutputWithCachedIdentity(output)` with `structuredClone(output)`. Remove the imports.
loc: -5
breaks: Nothing behavioral. Reviewer: confirm the two call sites now call structuredClone(output) and the import is gone.
confidence: 90

## 19. cancelOrderbookOfferIfPresent is a single-use wrapper around removeBookOrderById
file: runtime/entity/tx/handlers/cross-j-clear.ts:41
code: `const cancelOrderbookOfferIfPresent = (state, accountId, offerId, storageChanges): boolean => removeBookOrderById(state, \`${accountId}:${offerId}\`, storageChanges);`
why: The function is called exactly once (line 131) and does nothing but forward to `removeBookOrderById`, which is already imported on line 11. The wrapper adds a name, a parameter list, and a template-literal construction that the caller could inline. It is the only "private helper" in the file that wraps exactly one already-imported function with no branching.
fix: Delete the function (lines 41-46). Replace the call site `const removedFromBook = cancelOrderbookOfferIfPresent(newState, accountId, orderId, storageChanges);` with `const removedFromBook = removeBookOrderById(newState, \`${accountId}:${orderId}\`, storageChanges);`.
loc: -5
breaks: If a second call site is added later it would need to duplicate the template literal — but no second site exists today (grep confirms one caller). Reviewer: `rg "cancelOrderbookOfferIfPresent"` and confirm zero remaining references.
confidence: 88

## 20. Dead isAccountBusinessTx and isArgumentChangingAccountTx exports
file: runtime/account/consensus/dispute-policy.ts:35-39
code: `export const isAccountBusinessTx = (txType: string): boolean => !isAccountControlTx(txType);` and `export const isArgumentChangingAccountTx = (txType: string): boolean => isAccountBusinessTx(txType);`
why: Grep for `isAccountBusinessTx|isArgumentChangingAccountTx` across the repo (excluding tests) returns only the definitions in dispute-policy.ts. No file imports either name. `isArgumentChangingAccountTx` is also a pure forwarder to `isAccountBusinessTx`, itself just `!isAccountControlTx`.
fix: Delete both exports.
loc: -4
breaks: Nothing imports them; reviewer greps the repo for both names and confirms zero import sites outside the defining file.
confidence: 95

---

## Notes on deliberate duplication (checked, NOT flagged)

- `HankoCodec.sol` vs `HankoEncoding.sol`: NOT duplicate encoding. `HankoCodec` is a deliberately stateless audit surface; `runtime/scripts/check-onchain-hanko-ast.ts` enforces every `HankoCodec` function is `external pure` and calls `HankoEncoding` exactly once, and that no production contract AST references `HankoCodec`. Enforced trust boundary.
- `runtime/protocol/htlc/test-secret-capability.ts`: NOT test-only. Despite the `test-` name, it is imported by production code (payment-admission.ts:32, frame/clone.ts:5). The Symbol-based capability is the production mechanism that prevents secret leakage through JSON/structuredClone/WS/WAL.
- `HashLadder.sol` memory/calldata function pairs: deliberate Solidity gas optimization (avoids memory-copy of calldata args). Not duplication.
- `assertReliableEvidenceCompatible` (delivery/identity.ts:486) vs `assertReliableLaneCompatible` (reliable-frontier.ts:225): near-identical lane/body/evidence conflict checks but operate on different types (`ReliableOutputIdentity` with `order`/`variantOrder` vs `ReliableDeliveryIdentity` with `height`/`logIndex`) and emit different error codes. Sender-side routing vs receiver-side frontier — different trust boundaries per AGENTS.md.
- `fillRatio` (uint16) coexisting with exact numerator/denominator: verified on-chain dispute wire format vs off-chain precision. Two layers on purpose.
- previous-board grace on dispute start (Account.sol): documented trade-off, decided by the owner.
- direct-then-relay transport: availability policy, not a fallback.
