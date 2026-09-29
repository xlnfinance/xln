// symbol.define / symbol.defineSyntax — scheme-bodied declaration kinds (per-tag factory;
// shared types in ./_bake.js). docs/environments.md §SYMBOL-KINDS, §PRELUDE.
//
// This file owns STATIC SHAPE only (name/doc, in/out normalization, callable/constant split).
// FV law, eager-forward-ref, derived-role, evaluate-then-bind live in ./define-bake.js
// (capability.ts two-phase apply arm).

import { ZodType } from "zod";
import { buildSlotAdopter } from "../../membrane/adopt-spine.js";
import * as z from "../scheme-zod/index.js";
import {
  assertContractAxes,
  isSingleOutput,
  normalizeInputVector,
  normalizeVector,
  parseNameDoc,
  type BakeRuntimeOpts,
  type ContourContract,
  type Contract,
  type DefineSymbolDef,
  type DefineSyntaxSymbolDef,
  type RestSpec,
  type VectorSpec,
} from "./_bake.js";
import { assertNoResourcePathProducers } from "../../run/resource-paths.js";

/** Two overloads: Contract → procedure (ContourContract, no CrossingOnly); bare ZodType →
 *  constant (NoCrossingBrand — banned as bare z.dynamic/z.instance). */
type DefineFactory = {
  <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: ContourContract<I, O, Rest>,
    body: string,
    opts?: BakeRuntimeOpts,
  ): DefineSymbolDef;
  <const S extends z.ZodTypeAny>(
    contract: import("./_bake.js").NoCrossingBrand<S> & S,
    body: string,
    opts?: BakeRuntimeOpts,
  ): DefineSymbolDef;
};

/** `symbol.define\`name: description\`(contract, bodyString)` — scheme-bodied value/procedure.
 *  bodyString is the RHS expression (never a whole `(define name …)` form). */
export function define(tpl: TemplateStringsArray, ...sub: unknown[]): DefineFactory {
  const { name, doc } = parseNameDoc(tpl, sub);
  const impl = (
    contract: Contract<VectorSpec, VectorSpec, RestSpec> | z.ZodTypeAny,
    body: string,
    opts: BakeRuntimeOpts = {},
  ): DefineSymbolDef => {
    const isConstant = contract instanceof ZodType;
    if (!isConstant) {
      assertNoResourcePathProducers(name, "define", contract as { queries?: unknown; effects?: unknown });
    }
    // Constants → 0-ary-procedure convention so harvest/arity never special-case structurally;
    // only `callable` tells the bind arm which runtime shape to build.
    const inSchema = isConstant ? normalizeVector([]) : normalizeInputVector(contract.input, contract.inputRest);
    const outSchema = isConstant ? normalizeVector([contract]) : normalizeVector(contract.output);
    assertContractAxes(name, "define", { inSchema, outSchema });
    const procedureContract = isConstant ? undefined : (contract as Contract<VectorSpec, VectorSpec, RestSpec>);
    return {
      kind: "define",
      name,
      doc,
      in: inSchema,
      out: outSchema,
      callable: !isConstant,
      singleOut: isConstant ? true : isSingleOutput(procedureContract!.output),
      body,
      // Placeholder — resolved role derived at bake over the whole define set. define-bake
      // builds a derived copy; this singleton is never mutated.
      provenance: "pipe",
      adoptArgs: isConstant ? undefined : buildSlotAdopter(procedureContract!.input, procedureContract!.inputRest),
      declaredProvenance: procedureContract?.provenance,
      type: procedureContract?.type,
      preludeOnly: procedureContract?.preludeOnly,
      validate: opts.validate !== false,
      // Extension bag — data only; dynamic fields resolve at read time.
      metadata: opts.metadata,
    };
  };
  return impl as DefineFactory;
}

/** `symbol.defineSyntax\`name: description\`(bodyString, opts?)` — scheme-bodied macro.
 *  Contract-free; carries ternary macroAttribute. bodyString is a lambda over fexpr formals. */
export function defineSyntax(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return (body: string, opts: { macroAttribute?: "opaque" | "expression" | "binder" } = {}): DefineSyntaxSymbolDef => ({
    kind: "define-syntax",
    name,
    doc,
    body,
    // "opaque" default — under-report, never guess: unaudited macro contributes nothing to FV buckets.
    macroAttribute: opts.macroAttribute ?? "opaque",
  });
}
