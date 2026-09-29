/**
 * The membrane crossing table — F3 (docs/test-suite-architecture.md F3).
 *
 * ONE row per value type, BOTH directions, exit convention as a single column —
 * this table structurally cannot say "strings exit boxed, booleans exit raw"
 * without the contradiction appearing in a diff (P4). R1 RULED (2026-07-09,
 * docs/RULINGS.md): uniform plain-JS exit via the simple exec flow;
 * containers exit as lazy ref-tracking proxies (observationally plain JS — R9).
 * Exit LAW CELLS asserting these ruled forms go it.fails against today's
 * boxed-exit implementation until the uniform-exit change lands.
 */
export interface CrossingRow {
  readonly type: string;
  /** JS value entering scheme space (jsToScheme) becomes… */
  readonly entryForm: string; // e.g. "AExact" | "AInexact" | "AString" | "borrowed AJSArray" | "VOID (refused, warn)"
  /** scheme value exiting to JS (toJS/toJS) becomes… R1-gated. */
  /** ruled by R1: uniform plain-JS exit (containers = lazy ref-tracking proxy) */
  readonly exitForm: string;
  /** is a round-trip promised (P9)? if false, one-way projection only */
  readonly roundTrip: boolean;
}

export const CROSSINGS: readonly CrossingRow[] = [
  { type: "boolean", entryForm: "ABool", exitForm: "boolean", roundTrip: true },
  { type: "safe-int number", entryForm: "AExact", exitForm: "number", roundTrip: true },
  { type: "float number", entryForm: "AInexact", exitForm: "number", roundTrip: true },
  // Host bigint DOORS (NoLensError kind `"bigint"`) — same spirit as unique-symbol.
  // Exact numbers are safe-int ratios; convert with Number/bigintToNumber in safe range
  // (or pass inexact/string) before re-crossing. Codecs that speak bigint on the host
  // face (`z.bigint`) encode to AExact BEFORE the membrane.
  { type: "bigint", entryForm: "DOOR (no lens — NoLensError)", exitForm: "n/a", roundTrip: false },
  { type: "string", entryForm: "AString", exitForm: "string", roundTrip: true },
  { type: "null", entryForm: "ANil (nil)", exitForm: "[] (the empty list's array face)", roundTrip: false }, // asymmetric BY LAW: ingress permissive (null→nil), egress canonical (nil→[]) — V ruling 2026-07-13
  { type: "undefined", entryForm: "AVoid (lens, no warn)", exitForm: "undefined", roundTrip: true },
  {
    type: "registered symbol (Symbol.for)",
    entryForm: "ASymbol",
    exitForm: "opaque symbol mapping (design pending, todo-ledgered)",
    roundTrip: false,
  },
  // V's ruling (2026-07-23): the warn-and-void middle tier is retired — a unique
  // symbol has no lens (no portable identity), so it DOORS (NoLensError) instead of
  // silently degrading to #void.
  { type: "unique symbol", entryForm: "DOOR (no lens — NoLensError)", exitForm: "n/a", roundTrip: false },
  { type: "array", entryForm: "borrowed AJSArray", exitForm: "raw source array", roundTrip: true },
  { type: "plain object", entryForm: "AJSObject (lazy)", exitForm: "raw source object", roundTrip: true },
  {
    type: "Uint8Array/ArrayBuffer/DataView",
    entryForm: "raw passthrough (named superset: FFI identity)",
    exitForm: "raw",
    roundTrip: true,
  },
  // Bare Promise doors (jsToSchemeAsyncDoor). A Promise VALUE inside a structure never
  // reaches the router: the holding container settles it lazily on entry read
  // (pending-entry.ts; the inbound-registry law owns those rows).
  {
    type: "Promise",
    entryForm: "DOOR (bare Promise — AsyncCrossingError); structure entries settle lazily",
    exitForm: "n/a",
    roundTrip: false,
  },
  // Residual exotics (an unbranded class instance / Map / Date / RegExp / Set …): formerly a
  // SILENT raw leak, then a warn-and-borrow AJSObject — V's ruling (2026-07-23) retires that
  // tolerance tier too: no lens exists for an unbranded class instance, so it DOORS
  // (NoLensError) — mark it `@arrival.private` to cross as an opaque handle, or hand plain
  // data instead. (A host `Error` is its OWN declared lens, carved out — see
  // error-object-exit.law.test.ts.)
  {
    type: "exotic object (class instance)",
    entryForm: "DOOR (no lens — NoLensError; mark @arrival.private or hand plain data)",
    exitForm: "n/a",
    roundTrip: false,
  },
  // FUNCTION — V's ruling (2026-07-24): host fn inbound = LENS (reverse membrane),
  // completing the callable bifunctor `hostProjectionOf` already gave the OTHER
  // direction (rosetta.ts's FOREIGN_LENS_CLAIMS function row). Asymmetric like "null"
  // above: scheme→host wrapper→scheme DOES round-trip to the ORIGINAL callable
  // (`eq?`, ACallable.ts's `WRAPPER_ORIGIN` re-admission), but host fn→scheme
  // callable→host wrapper does NOT return the SAME fn object — a genuine marshal
  // wrapper must exist to cross args/result at call time. The SAME host fn crossing
  // in twice DOES answer the same callable (`eq?`, run-scoped mint-or-reuse), just
  // not the identical raw fn on the way back out.
  {
    type: "function (borrowed)",
    entryForm: "ARosettaProcedure (reverse-membrane lens: args scheme→js, result js→scheme; mint-or-reuse per run)",
    exitForm: "region-scoped wrapper (reverse-membrane, hostProjectionOf) [re-admits to ORIGINAL callable on re-entry]",
    roundTrip: false,
  },
  {
    type: "proper list (scheme→JS only)",
    entryForm: "n/a",
    exitForm: "lazy array proxy (R9, one-way, P9)",
    roundTrip: false,
  },
  {
    type: "dotted pair (scheme→JS only)",
    entryForm: "n/a",
    exitForm: "lazy array proxy, tail folded (R9, one-way, P9)",
    roundTrip: false,
  },
  {
    type: "native vector (scheme→JS only)",
    entryForm: "n/a",
    exitForm: "lazy array proxy (R9, one-way, P9)",
    roundTrip: false,
  },
  {
    type: "native dict (scheme→JS only)",
    entryForm: "n/a",
    exitForm: "lazy object proxy (R9, one-way, P9)",
    roundTrip: false,
  },
] as const;

/** Forbidden crossings — every row must THROW with a teaching message (P5). */
export interface ViolationRow {
  readonly name: string;
  readonly act: string; // description of the violating call
  readonly door: RegExp; // the taught message
}

export const VIOLATIONS: readonly ViolationRow[] = [
  {
    name: "bare Promise into jsToScheme",
    act: "jsToScheme(ctx, Promise.resolve(1))",
    door: /bare Promise cannot cross/,
  },
  { name: "raw JS value into toJS", act: "toJS(42 as never)", door: /already JS/ },
  { name: "membrane write", act: "AJSObject.set(...)", door: /writes are banned/ },
  { name: "membrane delete", act: "AJSObject.delete(...)", door: /mutations are banned/ },
] as const;
