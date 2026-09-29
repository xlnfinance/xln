// vocabulary.ts — the VOCABULARY artifact: one frozen name→value map per
// (capability-set, config) tuple. `buildVocabulary` walks the set once, deps-first
// (C3), minting every symbol via the same per-kind bind dispatch as capability
// assembly (`contractOf`, requiresConfig doors, alias/declarative/native/rosetta/
// door/keyword/value, `associateCapability`, `bindCapabilityDefines` Pass-2 bake)
// — writing into freezable Maps, not a live env frame.
//
// LIVE SCRATCH FRAME (`bakeEnv`): `bindCapabilityDefines` (Pass 2) evaluates real
// scheme (`evalScheme(scope, "(define tmp <body>)")`) and reads back via
// `scope.get` — an interpreter round-trip. Classifier reads already-bound names.
//
// NULL-ROOTED, SELF-CONTAINED (docs/environments.md §HERMETIC): `bakeEnv` is a
// null-parent scratch (`ResolvingAmbient.root`). Caller folds `BASE_ROSTER` into
// `capabilities` before calling (`generator-exec.ts` `execStateViaVocabulary`), so
// the base stdlib is an ordinary C3 member of THIS tuple — baked deps-first in the
// same loop. By the time a dependent's `symbol.define` bakes, its deps (and free
// base names) are already direct bindings on `bakeEnv`. No parent-chain fallback
// onto a realm singleton: ambient ≠ lexical/global scope. Scratch discarded after
// build; only the Vocabulary maps survive.
//
// MEMO: keyed on the FULL transitive closure (deps included), not just the caller's
// root list — same capability OBJECTS hit the same cache regardless of root order.
// Nested WeakMaps, one level per capability in own-name-sorted order (total order;
// closure walk rejects two different objects sharing a name), terminated by config
// object IDENTITY. Fresh-but-deep-equal config builds an unshared second Vocabulary.
// Memo stores the in-flight PROMISE so concurrent callers await one build.
//
// Bare `{ fn }` capabilities are rejected at the type level (`SymbolDeclaration`
// union) — no runtime refusal door.
import { z } from "zod";
import invariant from "tiny-invariant";
import { EnvCapability, type SymbolDeclaration } from "../common/capability.js";
import {
  contractOf,
  isAliasDef,
  isDeclarativeDef,
  missingRequiresConfig,
  requiresConfigNeeds,
  requiresConfigReason,
  collectRequiresConfigDegraded,
  mergeDegraded,
} from "../common/capability-internals.js";
import { buildDegradationInfo, collectDegraded, type DegradedCapability } from "../common/degradation.js";
import { bindCapabilityDefines } from "../common/symbols/define-bake.js";
import type { AEntity, DefineSymbolDef, DefineSyntaxSymbolDef, RosettaSymbolDef } from "../common/symbols/_bake.js";
import type { AliasSymbolDef } from "../common/symbols/alias.js";
import type { PreludeBindTarget } from "../common/kernel.js";
import { linearizeDag } from "../common/dag-linearize.js";
import type { EvalSchemeInto } from "../common/scheme-env.js";
import { associateCapability } from "../run/CallCtx.js";
import { AKernelKeyword } from "../values/AKernelKeyword.js";
import { DoorProcedure } from "../values/primitives/ACallable.js";
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import { ARosettaProcedure } from "../values/primitives/ARosettaProcedure.js";
import {
  AliasTargetError,
  AssembleCycleError,
  AssembleLinearizationError,
  SymbolKeyMismatchError,
  VocabularyCapabilityConflictError,
} from "../errors.js";
import { type AmbientValue, type EnvWithInternals, ResolvingAmbient } from "./AmbientRuntime.js";

/** One symbol vocabulary, built ONCE per (capability-set, config) tuple — see module
 *  header. Contents are immutable minted values or baked closures over the frozen
 *  maps (FV-law sharing, define-bake.ts) — safe to share by reference across every
 *  `RunContext` of this tuple. */
export interface Vocabulary {
  /** Runtime vocabulary — every non-preludeOnly name, C3 last-write-wins. */
  readonly map: ReadonlyMap<string, AmbientValue>;
  /** Assembly-time-only names (docs/environments.md §PRELUDE) — resolvable from a
   *  capability's OWN prelude text, never the runtime map. Overlaid onto the
   *  per-run prelude scope by `assemble-run.ts`, never the user-facing chain. */
  readonly preludeOnly: ReadonlyMap<string, AmbientValue>;
  /** Capabilities that lowered degraded, C3 root-first order. */
  readonly degraded: readonly DegradedCapability[];
  /** Every `.spec.prelude` in the closure, DEPS-FIRST, identity-deduped (diamond
   *  DAG once). Collected here; executed once per run by `assembleRun` — that single
   *  pass IS the single-execution law. */
  readonly preludes: readonly { readonly capability: EnvCapability; readonly text: string }[];
  readonly configsByCapability: ReadonlyMap<object, unknown>;
}

// ── memo: nested WeakMap by (closure sorted by name) → config identity ──────────
interface MemoNode {
  readonly children: WeakMap<EnvCapability, MemoNode>;
  readonly byConfig: WeakMap<object, Promise<Vocabulary>>;
}
const freshNode = (): MemoNode => ({ children: new WeakMap(), byConfig: new WeakMap() });
const rootMemo: MemoNode = freshNode();
/** Stands in for `config === undefined` in the terminal WeakMap (object keys only). */
const NO_CONFIG_SENTINEL: object = {};

/** Locale-independent code-unit comparator — same rationale as
 *  `CompiledResolutionChain.ts` `byCodeUnit`. Names never equal here (`onRevisit`). */
function byName(a: EnvCapability, b: EnvCapability): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function memoized(
  sortedClosure: readonly EnvCapability[],
  config: object | undefined,
  build: () => Promise<Vocabulary>,
): Promise<Vocabulary> {
  let node = rootMemo;
  for (const cap of sortedClosure) {
    let child = node.children.get(cap);
    if (child === undefined) {
      child = freshNode();
      node.children.set(cap, child);
    }
    node = child;
  }
  const key = config ?? NO_CONFIG_SENTINEL;
  let promise = node.byConfig.get(key);
  if (promise === undefined) {
    promise = build();
    node.byConfig.set(key, promise);
  }
  return promise;
}

// Map-backed PreludeBindTarget — mirrors EVERY bind into bakeEnv too (header).
function makeBindTarget(
  mainMap: Map<string, AmbientValue>,
  preludeOnlyMap: Map<string, AmbientValue>,
  bakeEnv: EnvWithInternals<ResolvingAmbient>,
): (def: AEntity) => PreludeBindTarget {
  return (def) => ({
    set: (name: string, value: unknown) => {
      bakeEnv.bind(name, value as AmbientValue);
      // STORED value — raw `__env__` read, not `.get()`
      // (which quotes APair for host; vocabulary must hold chain-lookup shape).
      const stored = bakeEnv.__env__[name];
      const target = "preludeOnly" in def && def.preludeOnly ? preludeOnlyMap : mainMap;
      target.set(name, stored);
      return stored;
    },
  });
}

/** Bind into main map + bakeEnv — kinds that skip `bindTarget` (kernel keywords, value tail). */
function bindDirect(
  mainMap: Map<string, AmbientValue>,
  bakeEnv: EnvWithInternals<ResolvingAmbient>,
  name: string,
  value: unknown,
): void {
  bakeEnv.bind(name, value as AmbientValue);
  mainMap.set(name, bakeEnv.__env__[name]);
}

/** Process one capability's `symbols`: Pass 1 (non-define kinds) then Pass 2
 *  (define/defineSyntax bake). Returns this capability's merged degraded entry, if any. */
async function processCapability(
  cap: EnvCapability,
  config: object | undefined,
  mainMap: Map<string, AmbientValue>,
  preludeOnlyMap: Map<string, AmbientValue>,
  bakeEnv: EnvWithInternals<ResolvingAmbient>,
  evalScheme: EvalSchemeInto,
): Promise<{ configuration: Record<string, unknown>; degraded: DegradedCapability | undefined }> {
  const capabilityName = cap.name;
  const spec = cap.spec;
  const symbolsRec = (spec.symbols ?? {}) as Record<string, SymbolDeclaration>;

  const schema = spec.configuration ? z.object(spec.configuration as Record<string, z.ZodTypeAny>) : z.object({});
  const configuration = schema.parse(config ?? {}) as Record<string, unknown>;
  // requiresConfig auto-door fires unconditionally (D2, common/degradation.ts).
  const degradation = buildDegradationInfo(capabilityName);

  const bind = makeBindTarget(mainMap, preludeOnlyMap, bakeEnv);
  const defineEntries: [string, DefineSymbolDef | DefineSyntaxSymbolDef][] = [];
  const ownNames = new Set<string>();

  for (const [name, rawDef] of Object.entries(symbolsRec)) {
    ownNames.add(name);

    let def: SymbolDeclaration = rawDef;
    const viaAlias = isAliasDef(rawDef);
    if (viaAlias) {
      const targetDef = symbolsRec[(rawDef as AliasSymbolDef).target];
      if (targetDef === undefined) {
        throw new AliasTargetError(capabilityName, name, (rawDef as AliasSymbolDef).target, "missing-target");
      }
      if (isAliasDef(targetDef)) {
        throw new AliasTargetError(capabilityName, name, (rawDef as AliasSymbolDef).target, "chained-alias");
      }
      def = targetDef;
    }

    if (isDeclarativeDef(def)) {
      if (def.kind === "define" || def.kind === "define-syntax") {
        defineEntries.push([name, def]);
        continue;
      }
      // "macro": raw transformer (routes through bind for preludeOnly).
      bind(def).set(name, def.macro);
      continue;
    }

    if (def instanceof ANativeProcedure) {
      const contract = def.contract;
      if (contract === undefined) throw new Error(`${capabilityName}: ${name} bound ANativeProcedure has no contract`);
      if (!viaAlias && contract.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, contract.name);
      if (contract.kind === "native") {
        const missingNative = missingRequiresConfig(contract.requiresConfig, configuration);
        if (missingNative !== undefined) {
          bind(contract).set(
            name,
            new DoorProcedure(
              degradation.door(
                name,
                requiresConfigNeeds(missingNative),
                requiresConfigReason(missingNative, contract.doc),
              ),
            ),
          );
          continue;
        }
        associateCapability(def, cap, cap.nativeReadsRunResources());
        bind(contract).set(name, def);
        continue;
      }
      associateCapability(def, cap, cap.producesRunResources());
      bind(contract).set(name, def);
      continue;
    }

    if (def instanceof ARosettaProcedure) {
      const contract = def.contract as RosettaSymbolDef;
      if (!viaAlias && contract.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, contract.name);
      const missingRosetta = missingRequiresConfig(contract.requiresConfig, configuration);
      if (missingRosetta !== undefined) {
        bind(contract).set(
          name,
          new DoorProcedure(
            degradation.door(
              name,
              requiresConfigNeeds(missingRosetta),
              requiresConfigReason(missingRosetta, contract.doc),
            ),
          ),
        );
        continue;
      }
      associateCapability(def, cap, cap.producesRunResources());
      bind(contract).set(name, def);
      continue;
    }

    if (def instanceof DoorProcedure) {
      if (!viaAlias && def.door.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, def.door.name);
      if (def.door.cause === undefined) {
        (def.door as { cause?: { owner: string; needs: readonly never[] } }).cause = {
          owner: capabilityName,
          needs: [],
        };
      }
      bind(def.door).set(name, def);
      continue;
    }

    if (def instanceof AKernelKeyword) {
      if (!viaAlias && def.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, def.name);
      bindDirect(mainMap, bakeEnv, name, def);
      continue;
    }

    // Bare-Fn arm rejected by SymbolDeclaration type; unreachable under checked capabilities.
    invariant(
      typeof def !== "function",
      `EnvCapability "${capabilityName}": symbol "${name}" is a bare function — the bare-Fn authoring arm is retired.`,
    );

    // symbol.value — bound directly (never via bind).
    const valueEntity = contractOf(def);
    if (!viaAlias && valueEntity !== undefined && valueEntity.name !== name) {
      throw new SymbolKeyMismatchError(capabilityName, name, valueEntity.name);
    }
    bindDirect(mainMap, bakeEnv, name, def as AmbientValue);
  }

  if (defineEntries.length > 0) {
    await bindCapabilityDefines({
      capabilityName,
      ownNames,
      entries: defineEntries,
      deps: spec.deps ?? [],
      env: bakeEnv,
      scope: bakeEnv,
      bindTarget: bind,
      evalScheme,
    });
  }

  const degraded = mergeDegraded(
    collectDegraded(capabilityName, symbolsRec),
    collectRequiresConfigDegraded(capabilityName, symbolsRec, configuration),
  );

  return { configuration, degraded };
}

/** Build (or reuse memoized) {@link Vocabulary} for `capabilities` + `config`.
 *  C3 deps-first (self overwrites dep); scratch frame mirrors binds so Pass-2 bake
 *  sees the same visibility. Result frozen + memoized by (closure, config) identity. */
export async function buildVocabulary(
  capabilities: readonly EnvCapability[],
  config: object | undefined,
  evalScheme: EvalSchemeInto,
): Promise<Vocabulary> {
  const { order, byName: closureByName } = linearizeDag(capabilities, {
    onRevisit: (existing, candidate) => {
      if (existing !== candidate) throw new VocabularyCapabilityConflictError(candidate.name);
    },
    onCycle: (path) => {
      throw new AssembleCycleError(path);
    },
    onInconsistent: (owner) => {
      throw new AssembleLinearizationError(owner);
    },
  });

  const sortedClosure = [...closureByName.values()].toSorted(byName);
  return memoized(sortedClosure, config, () => buildFresh(order, closureByName, config, evalScheme));
}

async function buildFresh(
  order: readonly string[],
  byNameMap: ReadonlyMap<string, EnvCapability>,
  config: object | undefined,
  evalScheme: EvalSchemeInto,
): Promise<Vocabulary> {
  const mainMap = new Map<string, AmbientValue>();
  const preludeOnlyMap = new Map<string, AmbientValue>();
  const configsByCapability = new Map<object, unknown>();
  const degradedByName = new Map<string, DegradedCapability | undefined>();
  const preludes: { capability: EnvCapability; text: string }[] = [];
  // Null-rooted scratch — resolves against THIS build's static core only (header).
  const bakeEnv = ResolvingAmbient.root("vocabulary-bake") as EnvWithInternals<ResolvingAmbient>;

  // Deps-first (self overwrites dep); each capability fully (Pass 1 + 2) before next.
  for (const name of [...order].toReversed()) {
    const cap = byNameMap.get(name)!;
    const { configuration, degraded } = await processCapability(
      cap,
      config,
      mainMap,
      preludeOnlyMap,
      bakeEnv,
      evalScheme,
    );
    configsByCapability.set(cap, configuration);
    degradedByName.set(name, degraded);
    if (cap.spec.prelude !== undefined) preludes.push({ capability: cap, text: cap.spec.prelude });
  }

  // Degraded fold = C3 `order` root-first — NOT the deps-first apply walk above.
  const degraded: DegradedCapability[] = [];
  for (const name of order) {
    const d = degradedByName.get(name);
    if (d !== undefined) degraded.push(d);
  }

  return Object.freeze({
    map: mainMap,
    preludeOnly: preludeOnlyMap,
    degraded,
    preludes,
    configsByCapability,
  });
}
