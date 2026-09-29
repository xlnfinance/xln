// ANativeProcedure — host-JS CONTOUR callable (native / sequence / tagless / define).
// Own module so NativeSymbolDef lives next to the class that stamps it.

import { AValue } from "./AValue.js";
import type { MembraneExit, SchemeBounceMarker, SchemeValue } from "../types.js";
import type { CallCtx } from "../../run/CallCtx.js";
import type {
  CacheClass,
  CallbackRoles,
  DefineSymbolDef,
  MetadataRecord,
  ProvenanceRole,
  SequenceSymbolDef,
  TaglessGuardSymbolDef,
  TaglessSymbolDef,
} from "../../common/symbols/_bake.js";
import type { EmitRule, RefPolicy } from "../../emit/emit-rule.js";
import type { ZodTypeAny } from "zod";

/** Local CallResult / Arity / CallableImpl — no runtime import of ACallable (cycle with re-exports). */
export interface Arity {
  readonly min: number;
  readonly max: number | null;
}
type CallResult = SchemeValue | SchemeBounceMarker | Promise<SchemeValue>;
export type CallableImpl = (args: readonly SchemeValue[], callCtx: CallCtx) => CallResult;

type AnyFn = (...args: any[]) => unknown;

/** Native symbol def: impl over scheme values, no validation. Identity schemas for .d.ts harvest. */
export interface NativeSymbolDef {
  readonly kind: "native";
  readonly name: string;
  readonly doc?: string;
  readonly in: ZodTypeAny;
  readonly out: ZodTypeAny;
  readonly impl: AnyFn;
  /** See `Contract.type` (`_bake.ts`). */
  readonly type?: string;
  /** See `Contract.preludeOnly`. */
  readonly preludeOnly?: boolean;
  /** See `Contract.requiresConfig` — bind loop auto-mints a config-gated door. */
  readonly requiresConfig?: readonly (string | readonly string[])[];
  /** Resolved provenance role (`contract.provenance ?? "pipe"`). Non-optional after bake. */
  readonly provenance: ProvenanceRole;
  /** Resolved cache class — optional; absent = regenerateable. */
  readonly cacheClass?: CacheClass;
  /** Resolved per-lambda-arm callback roles; undefined when no z.lambda arm. */
  readonly callbackRoles?: CallbackRoles;
  /** Compiler harvest — see `Contract.emit`. */
  readonly emit?: EmitRule;
  /** See `Contract.narrows`. */
  readonly narrows?: { readonly witness: string };
  /** See `Contract.refPolicy` — authored value; harvest resolves `"shim"` default. */
  readonly refPolicy?: RefPolicy;
  readonly metadata?: MetadataRecord;
}

/**
 * Def bags stamped by factories that mint ANativeProcedure.
 * Primary is {@link NativeSymbolDef}; sequence/tagless/define share this class until kind-split.
 */
export type ANativeProcedureContract =
  | NativeSymbolDef
  | SequenceSymbolDef
  | TaglessSymbolDef
  | TaglessGuardSymbolDef
  | DefineSymbolDef;

const callableEquals = (self: object, other: unknown): boolean => other === self;

function displayName(name: string | symbol): string {
  return typeof name === "symbol" ? name.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1") : name;
}

// Linked from ACallable.ts after hostProjectionOf is defined.
let hostProjectionOf: (self: ANativeProcedure, exit?: MembraneExit) => unknown = () => {
  throw new Error("ANativeProcedure: host projection not linked (ACallable.ts not loaded)");
};
/** ACallable.ts module-init only. */
export function _linkNativeHostProjection(fn: (self: ANativeProcedure, exit?: MembraneExit) => unknown): void {
  hostProjectionOf = fn;
}

/** Host-JS CONTOUR primitive — stays in the value algebra (no membrane encode/decode). */
export class ANativeProcedure extends AValue {
  readonly kind = "procedure" as const;
  readonly name: string | symbol;
  readonly arity: Arity;
  /**
   * Baked contour def. Native factory stamps {@link NativeSymbolDef}; sequence/tagless/define
   * stamp their own kind. Undefined only for synthetic test/host mints with no harvest bag.
   */
  readonly contract: ANativeProcedureContract | undefined;
  readonly provenanceRole?: ProvenanceRole;
  readonly cacheClass?: CacheClass;
  readonly callbackRoles?: CallbackRoles;
  readonly #impl: CallableImpl;

  constructor(opts: {
    name: string | symbol;
    arity: Arity;
    contract?: ANativeProcedureContract;
    impl: CallableImpl;
    provenanceRole?: ProvenanceRole;
    cacheClass?: CacheClass;
    callbackRoles?: CallbackRoles;
  }) {
    super();
    this.name = opts.name;
    this.arity = opts.arity;
    // Contract freezes at construct; remint via `_withDeclarationFields`.
    this.contract = opts.contract === undefined ? undefined : Object.freeze(opts.contract);
    this.provenanceRole = opts.provenanceRole;
    this.cacheClass = opts.cacheClass;
    this.callbackRoles = opts.callbackRoles;
    this.#impl = opts.impl;
  }

  /** Declaration-site re-mint (`_bake.ts` withContractFields/withCallbackRoles ONLY): the
   *  contract freezes at construction, so the declaration channel builds a NEW instance
   *  around the same #impl instead of stamping in place. */
  _withDeclarationFields(contract: ANativeProcedureContract, callbackRoles?: CallbackRoles): ANativeProcedure {
    return new ANativeProcedure({
      name: this.name,
      arity: this.arity,
      contract,
      impl: this.#impl,
      provenanceRole: this.provenanceRole,
      cacheClass: this.cacheClass,
      callbackRoles: callbackRoles ?? this.callbackRoles,
    });
  }

  ["arrival/toJS"](exit?: MembraneExit): unknown {
    return hostProjectionOf(this, exit);
  }
  ["arrival/print"](): string {
    return `#<procedure:${displayName(this.name)}>`;
  }
  withProvenance(): SchemeValue {
    return this;
  }
  ["arrival/tagless-final/apply"](args: readonly SchemeValue[], callCtx: CallCtx): CallResult {
    return this.#impl(args, callCtx);
  }
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return callableEquals(this, other);
  }
}
