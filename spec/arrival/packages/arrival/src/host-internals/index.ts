// `@inhuman.tools/arrival/host-internals` — the HOST-INTEGRATION tier: run-observability
// (effect log, run cache, read guard), burst/note/display sinks, the membrane's
// callable-crossing seam, the mid-run assembly kernel (`createRuntimeAssembler`, for a
// host-armed `configuration.extensionRegistry`), the structural `SchemeEnv` contract a
// pack types against, the concrete `AmbientRuntime` face sibling packages mint
// mid-run frames on, and the interop-sealing marks the whiteroom Blob-law needs.
// The `-internals` name is the no-stability-contract signal — a sibling contract between
// arrival core and packages that embed a run (runner-capability, llm-plane-arrival-chain,
// MCP/studio hosts), never the capability-authoring public surface.

// Interop sealing — `@arrival.private` (+ `markInteropBoundary`) marks a class opaque to
// a Scheme member-read (`(@ x :internal)` → nil).
export { arrival, markInteropPrivate, markInteropBoundary } from "../membrane/interop-access.js";

// Callable-crossing seam: the ONE invocation site for any JS caller resolving a scheme
// callable value, plus its guard. `is_applyable` is the structural twin (any value
// answering `arrival/tagless-final/apply`, including self-applying keywords).
export { applyCallback, type ACallable } from "../values/primitives/ACallable.js";
export { is_callable_value, is_applyable } from "../values/value-guards.js";

// Run-neutral evaluation context + the evaluator's per-frame contract.
export { CONSTANT_CTX, applyMembraneClosure, type MembraneClosure } from "../run/RunContext.js";
export { type EvalContext, type StackFrame } from "../eval/evaluator.js";

// RUN-READER DOOR — cross-cutting prerequisite for MCP DI: discovery takes run context,
// extracts each symbol whose owning capability is an mcp capability, renders it in
// prelude. `ownerOf` answers "who owns this minted symbol value"; `symbolsOwnedBy`
// composes it against a run's vocabulary into the consumer-shaped catalog/prelude query.
// Contract/introspection data still comes from `contractOf` (`/lsp-internals`) — this
// door is ownership only.
export { ownerOf, symbolsOwnedBy } from "../run/CallCtx.js";

// First-class run cache: a run's durable twin is (program, cache); `exec(src, { cache })`
// threads it onto RunContext; the baked rosetta membrane records/replays through it.
export { MemoryRunCache, canonicalJson, runCacheKey, type RunCache, type RunCacheEntry } from "../run/run-cache.js";

// Effect log + read guard: `exec(src, { effects, reads })` gathers sink penetrations
// instead of firing them and (with `reads` armed) checks the read-your-deferred-write
// invariant.
export { MemoryEffectLog, burst, BurstDrainError, type EffectEntry, type EffectLog } from "../run/effect-log.js";
export {
  MemoryReadTracker,
  checkReadWriteGuard,
  writeSetOfResourcePaths,
  ReadYourDeferredWriteError,
  type ReadEvent,
  type ReadTracker,
  type ReadGuard,
  type WriteSetResolver,
} from "../run/read-guard.js";

// Resource-path CQS: domain-lane temporal zoning. Ordinary runs always carry a path
// log; `exec(src, { resourcePaths, strictCQSstrings })` injects a spy / strict mode.
// `serializeResourcePath` is the host-footprint key encoding (writeSetOf).
export {
  MemoryResourcePathLog,
  applyResourcePathCqs,
  assertNoResourcePathProducers,
  findInterveningDoor,
  ResourcePathConflictError,
  ResourcePathDeclarationError,
  ResourcePathProducerError,
  ResourcePathRoleConflictError,
  ResourcePathShapeError,
  type ResourcePathFn,
  type ResourcePathLog,
  type ResourcePathEvent,
  type InterveningDoorWitness,
} from "../run/resource-paths.js";
export {
  pathsOverlap,
  anyPathOverlap,
  findOverlappingPair,
  serializeResourcePath,
  type ResourcePath,
} from "../run/path-algebra.js";

// Per-run model-facing note channel — a renderer mints one and drains it.
export { createNoteSink, createDisplaySink, type NoteSink, type DisplaySink } from "../run/note-sink.js";

// Structural env contract a pack/consumer types against. The concrete
// `AmbientRuntime` class (and `isAmbientRuntime`) live here too — sibling
// packages that mint mid-run frames (`arrival-modules` `require/extension`)
// need `.child` / `.bind` / the brand check. Privilege is this door, not a
// secret function.
export { type SchemeEnv } from "../common/scheme-env.js";
export {
  AmbientRuntime,
  isAmbientRuntime,
  type AmbientValue,
  type EnvWithInternals,
  type LexicalScopeInternals,
  type ResolvingAmbient,
} from "../env/AmbientRuntime.js";
export { type LexicalScopeWithInternals } from "../eval/LexicalScope.js";
// Per-run prelude-define frame + capability resource bag — `require/extension`
// copies pack prelude defines here; `require/register-extension` reads the
// loader's per-run registry off the same bag.
export { ensurePreludeDefineFrame } from "../env/assemble-run.js";
export { getCapabilityResources } from "../run/CallCtx.js";
// Bake/prelude eval into a concrete frame — mid-run packs and their tests.
export { execInFrame } from "../eval/generator-exec.js";

// Mid-run assembly kernel: `createRuntimeAssembler` applies host-registered `EnvPack`s
// onto an already-live env (backing a host-armed `configuration.extensionRegistry` —
// a genuinely different, mid-run operation from bootstrap assembly).
export {
  createRuntimeAssembler,
  type EnvPack,
  type PackContext,
  type PreludeBindTarget,
  type RuntimeAssembler,
} from "../common/kernel.js";
