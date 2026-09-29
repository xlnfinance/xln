// symbol.sequence — ctx-aware contour op: impl gets scheme args + RunContext.
// Per-tag factory; shared types in ./_bake.js. docs/environments.md §SYMBOL-KINDS.

import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { type SchemeValue } from "../../values/types.js";
import { CallCtx } from "../../run/CallCtx.js";
import {
  assertContractAxes,
  type ContourContract,
  DecodedArgs,
  normalizeVector,
  parseNameDoc,
  type MetadataRecord,
  type SequenceImpl,
  type SequenceSymbolDef,
  type VectorSpec,
} from "./_bake.js";
import { assertNoResourcePathProducers } from "../../run/resource-paths.js";

/** Ctx-aware host op. Slot bans on ContourContract (`_bake.ts` §1.7). */
export function sequence(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec>(
    contract: ContourContract<I, O>,
    impl: SequenceImpl<I, O>,
    opts: { metadata?: MetadataRecord } = {},
  ): ANativeProcedure => {
    assertNoResourcePathProducers(name, "sequence", contract as { queries?: unknown; effects?: unknown });
    const inSchema = normalizeVector(contract.input);
    const outSchema = normalizeVector(contract.output);
    const provenance = contract.provenance ?? "pipe";
    const cacheClass = contract.cacheClass;
    const callbackRoles = assertContractAxes(name, "sequence", {
      inSchema,
      outSchema,
      provenance,
      cacheClass,
      declaredCallbackRoles: contract.callbackRoles,
    });
    // Erase to non-generic run shape (same boundary as rosetta's rawImpl).
    const run = function (this: CallCtx, ...args: readonly SchemeValue[]) {
      return impl(args as DecodedArgs<I, "scheme">, this.runCtx);
    } as SequenceSymbolDef["run"];
    return new ANativeProcedure({
      name,
      arity: { min: 0, max: null },
      contract: {
        kind: "sequence",
        name,
        doc,
        in: inSchema,
        out: outSchema,
        run,
        type: contract.type,
        provenance,
        cacheClass,
        callbackRoles,
        emit: contract.emit,
        narrows: contract.narrows,
        refPolicy: contract.refPolicy,
        metadata: opts.metadata,
      } satisfies SequenceSymbolDef,
      impl: (args, callCtx) => run.call(callCtx, ...args),
      provenanceRole: provenance,
      cacheClass,
      callbackRoles,
    });
  };
}
