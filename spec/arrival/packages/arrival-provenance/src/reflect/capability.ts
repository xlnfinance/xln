// arrivalReflectCapability — the "ask a finished run why" half of the discovery plane.
//
// No config, no deps BY DESIGN: it only ever READS provenance off a ResultHandle some other verb
// (`require/eval`/`require/call`) already minted — it never launches a run itself.
//
// Direct `symbol.rosetta` declarations (ad-hoc, no map over shared list). Each verb's fixed FIRST
// arg is a typed `z.instance(ResultHandle)` slot (`ResultHandle` is `@arrival.private`-branded —
// result-handle.ts's own marker) — the codec itself doors a non-handle argument (an opaque handle
// wrapping the wrong class) before the impl ever runs; `handle()` stays as a belt-and-suspenders
// runtime guard, now provably redundant on the typed path but still the honest fallback the
// verb-specific door text lives on. Trailing args (`node`, `:at path`, …) stay `inputRest:
// z.dynamic` — genuinely variable shape per verb. The `REFLECT_VERBS` list lives only for fn
// impls + metadata consumed by host dispatchReflect (mcp wire-safe path in discovery-run).

import { EnvCapability } from "@inhuman.tools/arrival";
import type { ImplThis } from "@inhuman.tools/arrival/capability";

import { attestOf, blastOf, circuitOf, dagOf, groundedOf, howOf, whereOf, whyOf } from "./handle-provenance.js";
import { is_result_handle, ResultHandle } from "./result-handle.js";

/** This capability's own `this` shape: no config, no resources (both type params default to
 *  `Record<string, never>`). Named here because every impl below is boundary-cast `as never`
 *  (the `z.instance(ResultHandle)` + `inputRest: z.dynamic` contract still isn't the plain
 *  `RosettaTag` shape `EnvCapability.define`'s automatic `this` inference expects), which defeats
 *  the automatic `this` inference otherwise threads — same hazard, same fix as
 *  `arrival-run/src/approval-capability.ts`'s `ApprovalConfig` note: an explicit `this:
 *  ImplThis<...>` restores typed `this.runCtx` without weakening the cast itself. */
type ReflectThis = ImplThis<Record<string, never>, Record<string, never>>;

function handle(v: unknown, verb: string): ResultHandle {
  if (!is_result_handle(v)) {
    throw new TypeError(
      `(${verb} …) expects a result handle from (require/eval …) / (require/call …), got ${typeof v}. ` +
        `Provenance is read off the handle a run hands back, not off a bare value.`,
    );
  }
  return v;
}

export const arrivalReflectCapability = EnvCapability.define("arrival/reflect", {
  symbols: (symbol, z) => ({
    why: symbol.rosetta`why: Lineage: the evidence/infer reads the value depended on (why-provenance).`(
      { input: [z.instance(ResultHandle)], inputRest: z.dynamic, output: [z.dynamic], type: "(h: ResultHandle): list" },
      function (this: ReflectThis, h: ResultHandle, ...rest: unknown[]) {
        return whyOf(handle(h, "why"), this.runCtx.signal) as never;
      } as never,
    ),
    where: symbol.rosetta`where: Source locations (head@line:col) of the derivation (where-provenance).`(
      { input: [z.instance(ResultHandle)], inputRest: z.dynamic, output: [z.dynamic], type: "(h: ResultHandle): list" },
      function (this: ReflectThis, h: ResultHandle, ...rest: unknown[]) {
        return whereOf(handle(h, "where"), this.runCtx.signal) as never;
      } as never,
    ),
    how: symbol.rosetta`how: A runnable Scheme slice that re-derives the value (how-provenance).`(
      {
        input: [z.instance(ResultHandle)],
        inputRest: z.dynamic,
        output: [z.dynamic],
        type: "(h: ResultHandle): string",
      },
      function (this: ReflectThis, h: ResultHandle, ...rest: unknown[]) {
        return howOf(handle(h, "how"), this.runCtx.signal) as never;
      } as never,
    ),
    dag: symbol.rosetta`dag: Console overview: the run's computation DAG as homoiconic sexpr (nodes + dataflow edges). Works on a PARTIAL trace too — a timed-out run's value is {__timeout__: #t, …} and (dag h) still shows how far it got.`(
      {
        input: [z.instance(ResultHandle)],
        inputRest: z.dynamic,
        output: [z.dynamic],
        type: "(h: ResultHandle): string",
      },
      function (this: ReflectThis, h: ResultHandle, ...rest: unknown[]) {
        return dagOf(handle(h, "dag"), this.runCtx.signal) as never;
      } as never,
    ),
    blast:
      symbol.rosetta`blast: Impact / blast radius: the dag node ids that re-fire if \`node\` changes — the causal FORWARD complement of (why h). \`node\` is a head@line:col id from (dag h).`(
        {
          input: [z.instance(ResultHandle)],
          inputRest: z.dynamic,
          output: [z.dynamic],
          type: "(h: ResultHandle, node: string): list",
        },
        function (this: ReflectThis, h: ResultHandle, ...rest: unknown[]) {
          // blastOf takes (h, node, signal); the rosetta receives (h, node) positionally.
          return blastOf(handle(h, "blast"), String(rest[0] ?? ""), this.runCtx.signal) as never;
        } as never,
      ),
    "result-value": symbol.rosetta`result-value: The value a run produced.`(
      {
        input: [z.instance(ResultHandle)],
        inputRest: z.dynamic,
        output: [z.dynamic],
        type: "(h: ResultHandle): unknown",
      },
      // result-value needs no signal; arrow ignores `this`. Handle gate still applies.
      (h: ResultHandle) => handle(h, "result-value").value as never,
    ),
    circuit:
      symbol.rosetta`circuit: Static attribution circuit — live when the handle carries a host-injected circuitProvider capability; otherwise throws, routing to (dag h)/(why h).`(
        {
          input: [z.instance(ResultHandle)],
          inputRest: z.dynamic,
          output: [z.dynamic],
          type: "(h: ResultHandle): sexpr",
        },
        function (this: ReflectThis, h: ResultHandle, ...rest: unknown[]) {
          return circuitOf(handle(h, "circuit"), this.runCtx.signal) as never;
        } as never,
      ),
    "grounded?":
      symbol.rosetta`grounded?: Grounding verdict over a handle's value, PER LEAF — the live static∧probe conjunction: content-attested / selection-attested / not-attestable per leaf; falls back to a fail-closed, trace-based ADVISORY (never a positive verdict) when the conjunction can't run for this handle.`(
        {
          input: [z.instance(ResultHandle)],
          inputRest: z.dynamic,
          output: [z.dynamic],
          type: "(h: ResultHandle): sexpr",
        },
        function (this: ReflectThis, h: ResultHandle, ...rest: unknown[]) {
          return groundedOf(handle(h, "grounded?"), this.runCtx.signal) as never;
        } as never,
      ),
    attest:
      symbol.rosetta`attest: The full attestation artifact over a handle, PER LEAF — same live verdicts as (grounded? h), plus a selection-attested leaf's vocabulary and a not-attestable leaf's reason. Evidence read off a native dict narrows and attests; the alist idiom (list (cons k v) …) is a primitives-materialization that conservatively seals not-attestable.`(
        {
          input: [z.instance(ResultHandle)],
          inputRest: z.dynamic,
          output: [z.dynamic],
          type: "(h: ResultHandle): sexpr",
        },
        function (this: ReflectThis, h: ResultHandle, ...rest: unknown[]) {
          return attestOf(handle(h, "attest"), this.runCtx.signal) as never;
        } as never,
      ),
  }),
});
