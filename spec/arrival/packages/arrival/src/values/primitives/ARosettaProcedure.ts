// ARosettaProcedure — host-JS MEMBRANE callable (rosetta / MCP / reverse-membrane lens).
// Bake state + apply ownership sit on the class, not a factory-local closure.
//
// The apply spine body cannot live here as a static import of scheme-zod:
// ACallable imports this module; scheme-zod imports ACallable — a value import of
// scheme-zod here would TDZ on ACallable class bindings (`z.instanceof`). Body
// installed once from symbols/rosetta.ts via `_installRosettaMembraneApply`.

import { AValue } from "./AValue.js";
import type { MembraneExit, SchemeBounceMarker, SchemeValue } from "../types.js";
import type { CallCtx } from "../../run/CallCtx.js";
import type { CacheClass, CallbackRoles, ProvenanceRole } from "../../common/symbols/_bake.js";
import type { ResourcePathFn } from "../../run/resource-paths.js";
import type { ZodTypeAny } from "zod";
import invariant from "tiny-invariant";

/** Local mirrors of ACallable Arity/CallResult/CallableImpl — no runtime import of ACallable. */
interface Arity {
  readonly min: number;
  readonly max: number | null;
}
type CallResult = SchemeValue | SchemeBounceMarker | Promise<SchemeValue>;
type CallableImpl = (args: readonly SchemeValue[], callCtx: CallCtx) => CallResult;

/** Bake-closed membrane state for a `symbol.rosetta` verb. */
export interface RosettaMembrane {
  readonly inSchema: ZodTypeAny;
  readonly outSchema: ZodTypeAny;
  /** Authored host body (decoded JS args → result). JS `this` is CallCtx at fire time. */
  readonly hostImpl: (this: CallCtx, ...args: unknown[]) => unknown;
  readonly carriesCallable: boolean;
  readonly kwargsShape?: Record<string, ZodTypeAny>;
  readonly checkDynamicSlots?: (decodedArgs: readonly unknown[]) => void;
  readonly unwrapOpaqueHandles?: (decodedArgs: readonly unknown[]) => readonly unknown[];
  readonly singleOut: boolean;
  readonly escapeSlots: readonly boolean[];
  /** `provenance === "pipe"` — forward input provenance instead of minting. */
  readonly forwards: boolean;
  /** `provenance === "sink"` — burst/cache penetration flag. */
  readonly sink: boolean;
  /** Authored `contract.output` vector (multi-out per-slot escape encode). */
  readonly outputSlots?: readonly unknown[];
  /** CQS query path producer — see Contract.queries / run/resource-paths.ts. */
  readonly queries?: ResourcePathFn;
  /** CQS effect path producer — see Contract.effects / run/resource-paths.ts. */
  readonly effects?: ResourcePathFn;
}

const callableEquals = (self: object, other: unknown): boolean => other === self;

function displayName(name: string | symbol): string {
  return typeof name === "symbol" ? name.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1") : name;
}

// Linked from ACallable.ts after hostProjectionOf is defined.
let hostProjectionOf: (self: ARosettaProcedure, exit?: MembraneExit) => unknown = () => {
  throw new Error("ARosettaProcedure: host projection not linked (ACallable.ts not loaded)");
};
/** ACallable.ts module-init only. */
export function _linkRosettaHostProjection(fn: (self: ARosettaProcedure, exit?: MembraneExit) => unknown): void {
  hostProjectionOf = fn;
}

/** Membrane apply body — installed from symbols/rosetta.ts (owns zod + membrane imports). */
export type RosettaMembraneApply = (
  proc: ARosettaProcedure,
  args: readonly SchemeValue[],
  callCtx: CallCtx,
) => CallResult;

let membraneApply: RosettaMembraneApply | undefined;
/** symbols/rosetta.ts module-init only. */
export function _installRosettaMembraneApply(fn: RosettaMembraneApply): void {
  membraneApply = fn;
}

/**
 * Host-JS MEMBRANE primitive. Apply is the spine for baked verbs (`#membrane`); host-fn
 * lens / hostFnToCallable / replay playback minters use `#hostApply`.
 */
export class ARosettaProcedure extends AValue {
  readonly kind = "procedure" as const;
  readonly name: string | symbol;
  readonly arity: Arity;
  readonly contract: unknown;
  readonly strategy: unknown;
  readonly provenanceRole?: ProvenanceRole;
  readonly cacheClass?: CacheClass;
  readonly callbackRoles?: CallbackRoles;
  /** Bake state for the membrane spine — read by the installed apply body. */
  readonly membrane: RosettaMembrane | undefined;
  readonly #hostApply: CallableImpl | undefined;

  constructor(
    opts: {
      name: string | symbol;
      arity: Arity;
      contract: unknown;
      strategy?: unknown;
      provenanceRole?: ProvenanceRole;
      cacheClass?: CacheClass;
      callbackRoles?: CallbackRoles;
      membrane?: RosettaMembrane;
      hostApply?: CallableImpl;
    },
    provenance?: ReadonlySet<number>,
  ) {
    // Light instance checks only — full axis shape asserts stay in the factory so this
    // module never imports `_bake` (that pulls scheme-zod → membrane → ACallable marshal TDZ).
    invariant(
      opts.membrane !== undefined || opts.hostApply !== undefined,
      "ARosettaProcedure: pass membrane (baked) or hostApply (lens/wrapper)",
    );
    if (opts.membrane !== undefined && opts.provenanceRole !== undefined) {
      const name = typeof opts.name === "string" ? opts.name : displayName(opts.name);
      invariant(
        (opts.provenanceRole === "pipe") === opts.membrane.forwards,
        `${name}: provenanceRole "${opts.provenanceRole}" disagrees with membrane.forwards=${opts.membrane.forwards}`,
      );
      invariant(
        (opts.provenanceRole === "sink") === opts.membrane.sink,
        `${name}: provenanceRole "${opts.provenanceRole}" disagrees with membrane.sink=${opts.membrane.sink}`,
      );
    }

    super(provenance);
    this.name = opts.name;
    this.arity = opts.arity;
    // Freeze at construct — same seal as native.
    this.contract =
      typeof opts.contract === "object" && opts.contract !== null ? Object.freeze(opts.contract) : opts.contract;
    this.strategy = opts.strategy;
    this.provenanceRole = opts.provenanceRole;
    this.cacheClass = opts.cacheClass;
    this.callbackRoles = opts.callbackRoles;
    this.membrane = opts.membrane;
    this.#hostApply = opts.hostApply;
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
    if (this.membrane !== undefined) {
      invariant(
        membraneApply !== undefined,
        "ARosettaProcedure: membrane apply not installed (symbols/rosetta.ts not loaded)",
      );
      return membraneApply(this, args, callCtx);
    }
    return this.#hostApply!(args, callCtx);
  }
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return callableEquals(this, other);
  }
}

/** Display name for teaching messages (keyword symbols print cleanly). */
export function rosettaDisplayName(name: string | symbol): string {
  return displayName(name);
}
