// symbol.rosetta — host fn in JS-land (decoded via contract codecs). Per-tag factory
// re-assembled into `symbol` by `./index.ts`; shared types in `./_bake.js`.
//
// docs/environments.md §SYMBOL-KINDS — `rosetta` row (decode → validate → impl → encode →
// mint); §MEMBRANE-SEAM — bake-side crossing. docs/membrane.md §REGION — region-scope gate.
//
// Z.DYNAMIC-CALLABLE DOOR: a callable in a `z.dynamic` slot after the impl's first await
// (past withRegionScope's sync save/restore) binds DETACHED_SCOPE/CONSTANT_CTX and bypasses
// the effect burst. Ban bare callables at those slots; steer to `z.procedure` (sync marshal
// under live scope). Compile-time: CrossingContract bans ContourOnly (`z.schemeValue`).
// This runtime door guards what types cannot see — a callable VALUE in a legitimate dynamic slot.

import * as z from "../scheme-zod/index.js";
import { ZodError, ZodType } from "zod";
import { AOpaqueHandle } from "../../values/primitives/AOpaqueHandle.js";
import { is_callable_value } from "../../values/value-guards.js";
import {
  ARosettaProcedure,
  _installRosettaMembraneApply,
  rosettaDisplayName,
} from "../../values/primitives/ARosettaProcedure.js";
import { AValue, pointProvenance, unionProvenance } from "../../values/primitives/AValue.js";
import { attestDeep, freshIfSingleton } from "../../values/attestation.js";
import { jsToScheme } from "../../membrane/rosetta.js";
import { penetrateThroughCache } from "../../run/penetration.js";
import { applyResourcePathCqs } from "../../run/resource-paths.js";
import type { ResourcePath } from "../../run/path-algebra.js";
import { closeRegionScope, openRegionScope, withRegionScope } from "../../membrane/region-scope.js";
import { decodeKwargsStrict, drainDroppedKwargNotes } from "../kwargs-rejection.js";
import { formatPositionalRejection } from "./positional-rejection.js";
import type { SchemeValue } from "../../values/types.js";
import invariant from "tiny-invariant";
import { type CallCtx } from "../../run/CallCtx.js";
import { applyMembraneClosure } from "../../run/RunContext.js";
import {
  assertContractAxes,
  type BakeRuntimeOpts,
  collectKwargsObject,
  contractMayCarryCallable,
  type CrossingContract,
  type Impl,
  isSingleOutput,
  normalizeInputVector,
  normalizeVector,
  parseNameDoc,
  type RestSpec,
  type RosettaSymbolDef,
  topLevelSchemas,
  type VectorSpec,
} from "./_bake.js";
import { WorldFlipError } from "../../errors.js";

function isBareCallable(value: unknown): boolean {
  return typeof value === "function" || is_callable_value(value);
}

function dynamicCallableDoorMessage(symbolName: string, position: string): string {
  return (
    `${symbolName}: a callable argument crossed a z.dynamic slot (${position}) — declare this parameter ` +
    `z.procedure so its host-fn wrapper is minted at decode, synchronously, under the live region scope. ` +
    `A callable marshaled from a z.dynamic slot after an await binds a detached scope and can bypass the ` +
    `effect burst.`
  );
}

/** Bake-time: which top-level `inSchema` slots are bare `z.dynamic` (same shallow view as
 *  `contractMayCarryCallable`). Shared by callable-ban and opaque-handle unwrap.
 *  Shallow only — containers (`z.list(z.dynamic)`) are the recursion gap; a container with a
 *  real element codec unwraps at its own decode. `undefined` when none (zero cost). */
type DynamicSlotPositions =
  | { readonly kind: "kwargs"; readonly keys: readonly string[] }
  | { readonly kind: "all-positional" }
  | { readonly kind: "indices"; readonly indices: readonly number[] };

function dynamicSlotPositions(
  inSchema: z.ZodTypeAny,
  kwargsShape: Record<string, z.ZodTypeAny> | undefined,
): DynamicSlotPositions | undefined {
  if (kwargsShape) {
    const keys = Object.entries(kwargsShape)
      .filter(([, slot]) => z.lookupName(slot) === "dynamic")
      .map(([key]) => key);
    return keys.length === 0 ? undefined : { kind: "kwargs", keys };
  }
  const items = topLevelSchemas(inSchema);
  if (items === undefined) return undefined;
  // Homogeneous array: topLevelSchemas is one item standing for every position.
  if (items.length === 1) {
    return z.lookupName(items[0]) === "dynamic" ? { kind: "all-positional" } : undefined;
  }
  const indices = items.flatMap((item, i) => (z.lookupName(item) === "dynamic" ? [i] : []));
  return indices.length === 0 ? undefined : { kind: "indices", indices };
}

/** Runtime closure: ban bare callables at z.dynamic positions. One invariant per family. */
function buildDynamicSlotCheck(
  symbolName: string,
  positions: DynamicSlotPositions | undefined,
): ((decodedArgs: readonly unknown[]) => void) | undefined {
  if (positions === undefined) return undefined;
  switch (positions.kind) {
    case "kwargs":
      return (decodedArgs) => {
        const obj = decodedArgs[0] as Record<string, unknown>;
        invariant(
          positions.keys.every((key) => !isBareCallable(obj[key])),
          () => {
            const bad = positions.keys.filter((k) => isBareCallable(obj[k]));
            const position =
              bad.length === 1
                ? `keyword argument :${bad[0]}`
                : `keyword arguments ${bad.map((k) => `:${k}`).join(", ")}`;
            return dynamicCallableDoorMessage(symbolName, position);
          },
        );
      };
    case "all-positional":
      return (decodedArgs) => {
        invariant(
          decodedArgs.every((a) => !isBareCallable(a)),
          () => {
            const bad = decodedArgs.flatMap((a, i) => (isBareCallable(a) ? [i + 1] : []));
            const position = bad.length === 1 ? `argument ${bad[0]}` : `arguments ${bad.join(", ")}`;
            return dynamicCallableDoorMessage(symbolName, position);
          },
        );
      };
    case "indices":
      return (decodedArgs) => {
        invariant(
          positions.indices.every((i) => !isBareCallable(decodedArgs[i])),
          () => {
            const bad = positions.indices.filter((i) => isBareCallable(decodedArgs[i])).map((i) => i + 1);
            const position = bad.length === 1 ? `argument ${bad[0]}` : `arguments ${bad.join(", ")}`;
            return dynamicCallableDoorMessage(symbolName, position);
          },
        );
      };
  }
}

/** Host-ward unwrap for `z.dynamic` slots: decode is identity, so AOpaqueHandle would cross
 *  undecoded. Other slot kinds unwrap at their own codec. Same shallow scope as callable ban. */
function buildOpaqueHandleUnwrap(
  positions: DynamicSlotPositions | undefined,
): ((decodedArgs: readonly unknown[]) => readonly unknown[]) | undefined {
  if (positions === undefined) return undefined;
  const unwrap = (v: unknown): unknown => (v instanceof AOpaqueHandle ? v.instance : v);
  switch (positions.kind) {
    case "kwargs": {
      const { keys } = positions;
      return (decodedArgs) => {
        const obj = decodedArgs[0] as Record<string, unknown>;
        const next: Record<string, unknown> = { ...obj };
        for (const key of keys) next[key] = unwrap(obj[key]);
        return [next];
      };
    }
    case "all-positional":
      return (decodedArgs) => decodedArgs.map(unwrap);
    case "indices": {
      const idx = new Set(positions.indices);
      return (decodedArgs) => decodedArgs.map((a, i) => (idx.has(i) ? unwrap(a) : a));
    }
  }
}

/** WORLD-FLIP DOOR (ruling 2026-08-13): a rosetta impl's return is a JS-world value — an
 *  AValue there (bare, or nested in the plain arrays/objects jsToScheme recurses) would ride
 *  the owned-artifact pass-through and skip the membrane's mint. Crash explicitly instead.
 *  Runs BEFORE z.encode so coded slots teach the same cure as escape slots. */
function assertNoWorldFlip(symbolName: string, value: unknown, seen?: WeakSet<object>): void {
  if (value instanceof AValue) throw new WorldFlipError(symbolName, value.constructor.name);
  if (value === null || typeof value !== "object") return;
  const marked = seen ?? new WeakSet<object>();
  if (marked.has(value)) return;
  marked.add(value);
  if (Array.isArray(value)) {
    for (const element of value) assertNoWorldFlip(symbolName, element, marked);
    return;
  }
  // Plain objects only — a class instance crosses as an opaque handle and stays opaque.
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto === Object.prototype || proto === null) {
    for (const element of Object.values(value)) assertNoWorldFlip(symbolName, element, marked);
  }
}

/** Rosetta host fn in JS-land. Returns bare ARosettaProcedure.
 *  Slot bans on CrossingContract (`_bake.ts` §1.7). */
export function rosetta(tpl: TemplateStringsArray, ...sub: (string | number)[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: CrossingContract<I, O, Rest>,
    impl: Impl<I, O, Rest>,
    opts: BakeRuntimeOpts = {},
  ): ARosettaProcedure => {
    const inSchema = normalizeInputVector(contract.input, contract.inputRest);
    const outSchema = normalizeVector(contract.output);
    const singleOut = isSingleOutput(contract.output);
    // `dynamic` OUTPUT = no-transform escape hatch: skip z.encode so raw JS returns survive
    // (jsToScheme boxes after). `instance(Ctor)` is a real codec with its own encode — not here.
    const escapeSlots: readonly boolean[] = Array.isArray(contract.output)
      ? (contract.output as readonly unknown[]).map((slot) => z.lookupName(slot) === "dynamic")
      : [];
    // Default "source" mints; "pipe" forwards input provenance (step 3 of membrane apply).
    const provenance = contract.provenance ?? "source";
    const cacheClass = contract.cacheClass;
    // Path producers (CQS) — rosetta-only; stored on membrane for the apply chokepoint.
    const queries = contract.queries;
    const effects = contract.effects;
    // One aggregator, six doors (hermeticity audit E1): provenance-shape → cache-shape →
    // callback-roles → path-role-conflict doors (sink∧queries, effects-only⇒void) →
    // path-shape → slot-kinds, in that order — docs/environments.md §AXES.
    const callbackRoles = assertContractAxes(name, "rosetta", {
      inSchema,
      outSchema,
      provenance,
      cacheClass,
      declaredCallbackRoles: contract.callbackRoles,
      queries,
      effects,
    });
    const forwards = provenance === "pipe";
    // `opts.validate` has no effect on the rosetta path (rosetta always shape-checks via
    // its contract); it's honored only on `symbol.define`. The shared `BakeRuntimeOpts`
    // type accepts it for API symmetry.
    // Erase DecodedArgsWithRest → unknown[] once (same boundary as native's AnyFn).
    const rawImpl = impl as (...args: unknown[]) => unknown;

    // Region-scope gate: true only when input may hand the impl a live callable.
    const carriesCallable = contractMayCarryCallable(inSchema);

    const bakedInputRest: RestSpec = contract.inputRest;
    const kwargsShape =
      bakedInputRest !== undefined && !(bakedInputRest instanceof ZodType) ? bakedInputRest : undefined;

    const dynSlots = dynamicSlotPositions(inSchema, kwargsShape);
    const checkDynamicSlots = buildDynamicSlotCheck(name, dynSlots);
    const unwrapOpaqueHandles = buildOpaqueHandleUnwrap(dynSlots);

    return new ARosettaProcedure({
      name,
      arity: { min: 0, max: null },
      contract: {
        kind: "rosetta",
        name,
        doc,
        in: inSchema,
        out: outSchema,
        impl,
        provenance,
        cacheClass,
        callbackRoles,
        queries,
        effects,
        type: contract.type,
        preludeOnly: contract.preludeOnly,
        requiresConfig: contract.requiresConfig,
        emit: contract.emit,
        narrows: contract.narrows,
        refPolicy: contract.refPolicy,
        metadata: opts.metadata,
      } satisfies RosettaSymbolDef,
      provenanceRole: provenance,
      cacheClass,
      callbackRoles,
      membrane: {
        inSchema,
        outSchema,
        hostImpl: rawImpl as (this: CallCtx, ...args: unknown[]) => unknown,
        carriesCallable,
        kwargsShape,
        checkDynamicSlots,
        unwrapOpaqueHandles,
        singleOut,
        escapeSlots,
        forwards,
        sink: provenance === "sink",
        outputSlots: Array.isArray(contract.output) ? (contract.output as readonly unknown[]) : undefined,
        queries,
        effects,
      },
    });
  };
}

// Membrane apply body installed onto ARosettaProcedure. Lives here so ARosettaProcedure.ts
// stays out of the ACallable ↔ scheme-zod ↔ membrane cycle.

_installRosettaMembraneApply(async (proc, args, callCtx) => {
  const m = proc.membrane!;
  const name = typeof proc.name === "string" ? proc.name : rosettaDisplayName(proc.name);

  const inputAValues = args.filter((a): a is Extract<SchemeValue, AValue> => a instanceof AValue);
  const inputProvenance = unionProvenance(inputAValues);
  const inv = callCtx.invocation.currentInvocation;

  const scope = m.carriesCallable ? openRegionScope({ runCtx: callCtx.runCtx, dynSite: inv }) : undefined;
  let result: unknown;
  try {
    const decode = (): readonly unknown[] => {
      if (m.kwargsShape) {
        const decoded = decodeKwargsStrict(name, m.kwargsShape, collectKwargsObject(args));
        const dropped = drainDroppedKwargNotes(decoded);
        if (dropped !== undefined) {
          const sink = callCtx.runCtx.notes;
          for (const line of dropped) sink?.push(`${name}: ${line}`);
        }
        return [decoded];
      }
      try {
        return z.decode(m.inSchema, args) as readonly unknown[];
      } catch (error) {
        if (error instanceof ZodError) throw new Error(formatPositionalRejection(name, error, args, m.inSchema));
        throw error;
      }
    };
    let decodedArgs: readonly unknown[] = scope ? withRegionScope(scope, decode) : decode();
    if (m.unwrapOpaqueHandles) decodedArgs = m.unwrapOpaqueHandles(decodedArgs);
    m.checkDynamicSlots?.(decodedArgs);

    // CQS path producers (CrossingContract) — not to be confused with RunContext.effects
    // (burst EffectLog). Aliases keep the two axes out of the same mental register.
    const pathQueryFn = m.queries;
    const pathEffectFn = m.effects;
    // Order (R-O2): path fns → check vs prior E → record E → then cache/impl.
    // Runs whenever path producers are declared; log undefined (CONSTANT_CTX) ⇒
    // facility off after path fns still execute (shape/throw still apply).
    // Produced Q/E feed Phase 3b storage arms in penetrateThroughCache (I6–I8).
    let producedQueries: readonly ResourcePath[] = [];
    let producedEffects: readonly ResourcePath[] = [];
    if (pathQueryFn !== undefined || pathEffectFn !== undefined) {
      const produced = applyResourcePathCqs({
        verbName: name,
        decodedArgs,
        queries: pathQueryFn,
        effects: pathEffectFn,
        log: callCtx.runCtx.resourcePaths,
        strictCQSstrings: callCtx.runCtx.strictCQSstrings,
      });
      producedQueries = produced.queries;
      producedEffects = produced.effects;
    }

    const runCache = callCtx.runCtx.cache;
    const burstLog = callCtx.runCtx.effects;
    const runReads = callCtx.runCtx.reads;
    const fire = async (): Promise<unknown> =>
      applyMembraneClosure(callCtx.runCtx, () =>
        scope
          ? withRegionScope(scope, () => m.hostImpl.call(callCtx, ...decodedArgs))
          : m.hostImpl.call(callCtx, ...decodedArgs),
      );
    // Fast-path: no cache, no effect-log, and no path-derived storage work → bare fire.
    // Path Q/E with armed cache/effects must enter penetrateThroughCache (I6–I8).
    const needsPathStorage =
      (producedEffects.length > 0 && burstLog !== undefined) || (producedQueries.length > 0 && runCache !== undefined);
    result =
      runCache === undefined && burstLog === undefined && !needsPathStorage
        ? await fire()
        : await penetrateThroughCache(
            runCache,
            {
              symbolName: name,
              cacheClass: proc.cacheClass,
              sink: m.sink,
              rawArgs: args,
              pathQueries: producedQueries,
              pathEffects: producedEffects,
            },
            decodedArgs,
            fire,
            burstLog,
            runReads?.tracker,
          );
  } finally {
    if (scope) closeRegionScope(scope);
  }

  // World-flip door: the impl's return must be plain JS — boxing belongs to the membrane below.
  assertNoWorldFlip(name, result);

  let resultProvenance = inputProvenance;
  if (!m.forwards && inv && typeof inv.id === "number") {
    if (typeof inv.markProvenancePoint === "function") inv.markProvenancePoint();
    else inv.isProvenancePoint = true;
    resultProvenance = pointProvenance(inv.id);
  }

  if (m.singleOut) {
    const encoded = m.escapeSlots[0]
      ? result
      : (z.withMarshalCtx(callCtx.runCtx, () => z.encode(m.outSchema, [result])) as unknown[])[0];
    const boxed: unknown = jsToScheme(callCtx.runCtx, encoded, {}, resultProvenance);
    return (m.forwards ? boxed : attestDeep(freshIfSingleton(boxed))) as SchemeValue;
  }
  const resultVector = result as readonly unknown[];
  const outputSlots = m.outputSlots;
  const encoded = z.withMarshalCtx(callCtx.runCtx, () =>
    m.escapeSlots.some(Boolean) && outputSlots
      ? resultVector.map((v, i) =>
          m.escapeSlots[i] ? v : z.encode(normalizeVector([outputSlots[i] as never]), [v])[0],
        )
      : z.encode(m.outSchema, resultVector),
  ) as unknown[];
  return encoded.map((v) => {
    const boxed: unknown = jsToScheme(callCtx.runCtx, v, {}, resultProvenance);
    return m.forwards ? boxed : attestDeep(freshIfSingleton(boxed));
  }) as unknown as SchemeValue;
});
