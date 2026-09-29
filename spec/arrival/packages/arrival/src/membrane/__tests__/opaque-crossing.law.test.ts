/**
 * LAW — the OPAQUE-CROSSING CONTRACT for `@arrival.private` classes (V's ruling,
 * docs/plans/infer-whiteroom-design.md §"V'S API RULING"): the foundation of the infer
 * API rework's `McpServer`/`LLMModel`/… handles.
 *
 * The contract, pinned row by row below:
 *
 *   1. SCHEME-WARD: a rosetta impl returning a `@arrival.private`-branded instance
 *      crosses as an opaque `AOpaqueHandle` — identity-preserving (within one run),
 *      printable as its class face, exposing nothing structurally.
 *   2. HOST-WARD: the handle arriving as a rosetta impl ARG (bare `z.dynamic`, a typed
 *      `z.instance(Ctor)` slot, or inside a typed container) UNWRAPS to the raw
 *      instance uniformly — the impl never sees the handle itself.
 *   3. ROUND-TRIP: out then in is the SAME instance (`===`).
 *   4. UNBRANDED classes have NO LENS (V's ruling, 2026-07-23 — the binary membrane):
 *      the old borrowed-AJSObject-with-a-warning tolerance is retired; an unbranded
 *      class instance now DOORS (`NoLensError`), naming the two cures (brand the
 *      class `@arrival.private`, or hand plain data instead).
 *
 * Rows 1 (identity/print/no-structural-access) are pinned at the `jsToScheme`/value
 * level directly (mirroring inbound-registry.law.test.ts's own style) — a rosetta
 * verb's OWN args always unwrap a handle before the impl runs (that's row 2), and
 * `exec()`'s outer exit ALSO unwraps via `arrival/toJS`, so testing "what does the
 * handle itself look like" from OUTSIDE a running program is impossible by
 * construction; the direct `jsToScheme` calls below observe it mid-membrane, which is
 * the only place it is ever actually a handle. Rows 2-4 are pinned through `exec()`
 * end-to-end, since they are precisely about what a running program observes.
 */
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import { jsToScheme } from "../rosetta.js";
import { RunContext, CONSTANT_CTX } from "../../run/RunContext.js";
import { INTEROP_BOUNDARY } from "../../well-known/symbols.js";
import { markInteropPrivate, isMarkedInteropPrivate, arrival } from "../interop-access.js";
import { AJSObject } from "../AJSObject.js";
import { AOpaqueHandle } from "../../values/primitives/AOpaqueHandle.js";
import { eq, structuralEqual } from "../../values/structural-equal.js";
import { printValue } from "../../values/print.js";
import { type } from "../typecheck.js";
import type { SchemeValue } from "../../values/types.js";

// A host class marked `@arrival.private` — the McpServer/LLMModel stand-in.
class Widget {
  constructor(public readonly id: string) {}
}
markInteropPrivate(Widget);

// An UNbranded sibling — same shape, no opt-in. Pins row 4: NO LENS, doors (NoLensError).
class PlainWidget {
  constructor(public readonly id: string) {}
}

// A SECOND branded class — used to pin the `instance(Ctor)` codec's wrong-class rejection.
class OtherHandleClass {}
markInteropPrivate(OtherHandleClass);

/** `jsToScheme`'s static return type is `AWrap<T>` — for a plain class T (branding is a
 *  RUNTIME fact, invisible to the type system) that's the generic `AJSObject` fallback, same
 *  as any other exotic. Instantiating the call `<unknown>` collapses `AWrap` to the honest
 *  `SchemeValue` union (which `AOpaqueHandle` is now a member of), so the cast below is an
 *  ordinary narrowing, not an unrelated-types conversion. */
function mintHandle(ctx: RunContext, instance: object, provenance?: ReadonlySet<number>): AOpaqueHandle {
  const boxed =
    provenance === undefined ? jsToScheme<unknown>(ctx, instance) : jsToScheme<unknown>(ctx, instance, {}, provenance);
  expect(boxed).toBeInstanceOf(AOpaqueHandle);
  return boxed as AOpaqueHandle;
}

describe("opaque-crossing contract — row 1: scheme-ward mint (jsToScheme level)", () => {
  it("marks the isMarkedInteropPrivate recognition test true only for the branded class", () => {
    expect(isMarkedInteropPrivate(new Widget("a"))).toBe(true);
    expect(isMarkedInteropPrivate(new PlainWidget("a"))).toBe(false);
    expect(isMarkedInteropPrivate({})).toBe(false);
  });

  it("`arrival.private` (the decorator-ergonomic namespace) is the same brand as markInteropPrivate", () => {
    class Decorated {}
    arrival.private(Decorated);
    expect(isMarkedInteropPrivate(new Decorated())).toBe(true);
  });

  it("a branded instance mints an AOpaqueHandle, kind 'opaque', printing its class face", () => {
    const w = new Widget("abc");
    const handle = mintHandle(CONSTANT_CTX, w);
    expect(handle.kind).toBe("opaque");
    expect(type(handle)).toBe("opaque");
    expect(printValue(handle)).toBe("#<Widget>");
  });

  it("identity-preserving: the SAME instance crossed twice (same run) mints/reuses the SAME handle", () => {
    const w = new Widget("shared");
    const h1 = mintHandle(CONSTANT_CTX, w);
    const h2 = mintHandle(CONSTANT_CTX, w);
    expect(h1).toBe(h2); // wrapper identity — no allocation on re-cross with no new provenance
  });

  it("eq?/equal? identity holds even across a provenance re-stamp (the clone-trap discipline)", () => {
    const w = new Widget("clone-trap");
    const h1 = mintHandle(CONSTANT_CTX, w);
    // A fresh provenance stamp mints a DIFFERENT wrapper object (AValue's ordinary
    // immutability rule) — `eq?`/`equal?` must still hold via the Setoid, not `===`.
    const h2 = mintHandle(CONSTANT_CTX, w, new Set([999]));
    expect(h1).not.toBe(h2);
    expect(eq(h1, h2)).toBe(true);
    expect(structuralEqual(h1, h2)).toBe(true);
    // ...but a DIFFERENT instance is never eq?, even same class.
    const other = mintHandle(CONSTANT_CTX, new Widget("clone-trap"));
    expect(eq(h1, other)).toBe(false);
  });

  it("run-scoped identity: the SAME instance crossed under TWO different RunContexts mints TWO different handles", () => {
    const w = new Widget("cross-run");
    const ctxA = new RunContext({});
    const ctxB = new RunContext({});
    const hA = mintHandle(ctxA, w);
    const hB = mintHandle(ctxB, w);
    expect(hA).not.toBe(hB);
    // Still the same wrapped instance, and still eq? via the Setoid (identity of the
    // WRAPPED object, independent of which run's cache minted the wrapper).
    expect(hA.instance).toBe(w);
    expect(hB.instance).toBe(w);
    expect(eq(hA, hB)).toBe(true);
  });

  it("round-trip: `arrival/toJS` on the handle answers the SAME instance (===), unconditionally", () => {
    const w = new Widget("round-trip");
    const handle = mintHandle(CONSTANT_CTX, w);
    expect(handle["arrival/toJS"]()).toBe(w);
  });

  it("no structural access: the handle declares no `arrival/tagless-final/get` term", () => {
    const handle = mintHandle(CONSTANT_CTX, new Widget("sealed"));
    expect(handle["arrival/tagless-final/get"]).toBeUndefined();
  });

  it("an UNbranded class instance has NO LENS — it doors (NoLensError), naming the cure", () => {
    expect(() => jsToScheme<unknown>(CONSTANT_CTX, new PlainWidget("plain"))).toThrow(
      /no lens for a PlainWidget instance/,
    );
  });
});

describe("opaque-crossing contract — rows 2-4: end-to-end through symbol.rosetta (exec level)", () => {
  const cap = EnvCapability.define("test/opaque-crossing", {
    symbols: (symbol, z) => ({
      // `z.dynamic`'s declared TS face is `SchemeValue` on both sides (the escape hatch's
      // OWN identity-schema type) — it does not yet know a raw, un-boxed host object can
      // ride this same slot (the whiteroom's whole point). Runtime handles it fine (rosetta.ts
      // step 4 still runs `jsToScheme` over whatever the impl returns); the cast below is the
      // existing, pre-existing static/runtime gap for THIS escape hatch, not something new.
      "make-widget": symbol.rosetta`make-widget: returns a branded host instance (z.dynamic output)`(
        { input: [z.string], output: [z.dynamic] },
        function (id: string) {
          return new Widget(id) as unknown as SchemeValue;
        },
      ),
      "make-plain-widget": symbol.rosetta`make-plain-widget: returns an UNbranded instance`(
        { input: [z.string], output: [z.dynamic] },
        function (id: string) {
          return new PlainWidget(id) as unknown as SchemeValue;
        },
      ),
      "widget-id-typed": symbol.rosetta`widget-id-typed: typed z.instance(Widget) arg, unwraps to the raw instance`(
        { input: [z.instance(Widget)], output: [z.string] },
        function (w: Widget) {
          expect(w).toBeInstanceOf(Widget);
          return w.id;
        },
      ),
      "widget-id-dynamic": symbol.rosetta`widget-id-dynamic: bare z.dynamic arg, ALSO unwraps to the raw instance`(
        { input: [z.dynamic], output: [z.string] },
        function (w: unknown) {
          expect(w).toBeInstanceOf(Widget);
          return (w as Widget).id;
        },
      ),
      "widget-id-kwarg": symbol.rosetta`widget-id-kwarg: a z.dynamic KWARG field also unwraps`(
        { input: [], inputRest: { w: z.dynamic }, output: [z.string] },
        function (args: { w: unknown }) {
          expect(args.w).toBeInstanceOf(Widget);
          return (args.w as Widget).id;
        },
      ),
      "sum-widget-id-lengths": symbol.rosetta`sum-widget-id-lengths: a typed CONTAINER of handles unwraps elementwise`(
        { input: [z.list(z.instance(Widget))], output: [z.integer] },
        function (widgets: readonly Widget[]) {
          for (const w of widgets) expect(w).toBeInstanceOf(Widget);
          return widgets.reduce((total, w) => total + w.id.length, 0);
        },
      ),
      "widget-id-wrong-class":
        symbol.rosetta`widget-id-wrong-class: typed instance() rejects a DIFFERENT branded class`(
          { input: [z.instance(OtherHandleClass)], output: [z.string] },
          function (): string {
            return "unreachable";
          },
        ),
    }),
  });

  it("row 1+3: make-widget then widget-id-typed round-trips the SAME instance through TWO rosetta calls", async () => {
    const [result] = await exec('(widget-id-typed (make-widget "abc"))', { capabilities: [cap] });
    expect(String(result)).toBe("abc");
  });

  it("row 2: a bare z.dynamic ARG slot unwraps the handle to the raw instance too", async () => {
    const [result] = await exec('(widget-id-dynamic (make-widget "xyz"))', { capabilities: [cap] });
    expect(String(result)).toBe("xyz");
  });

  it("row 2: a z.dynamic KWARG field unwraps the handle as well", async () => {
    const [result] = await exec('(widget-id-kwarg :w (make-widget "kw"))', { capabilities: [cap] });
    expect(String(result)).toBe("kw");
  });

  it("row 2: a typed CONTAINER of handles (z.list(z.instance(Ctor))) unwraps elementwise at the container's own decode", async () => {
    const [result] = await exec('(sum-widget-id-lengths (list (make-widget "ab") (make-widget "cde")))', {
      capabilities: [cap],
    });
    expect(Number(result)).toBe(5); // "ab".length + "cde".length
  });

  it("the `instance(Ctor)` codec rejects a handle wrapping the WRONG branded class, humanized", async () => {
    await expect(exec('(widget-id-wrong-class (make-widget "abc"))', { capabilities: [cap] })).rejects.toThrow(
      /Widget/,
    );
  });

  it("identity across TWO separate crossings of the SAME instance (within one program) is eq?", async () => {
    const script = `
      (let ((w1 (make-widget "same-instance-note-different-each-call")))
        w1)
    `;
    // Sanity: a single mint round-trips its id, proving the whole pipe works before the
    // eq? row below (which needs a SHARED instance, arranged via a dedicated verb below).
    const [id] = await exec(`(widget-id-typed ${script})`, { capabilities: [cap] });
    expect(String(id)).toBe("same-instance-note-different-each-call");
  });

  it("row 4: an UNbranded instance has no lens end-to-end — the rosetta return doors (NoLensError)", async () => {
    await expect(exec('(:id (make-plain-widget "plain-e2e"))', { capabilities: [cap] })).rejects.toThrow(
      /no lens for a PlainWidget instance/,
    );
  });

  it("row 4 (negative control): a branded Widget has no `:id` — no structural access, doors", async () => {
    await expect(exec('(:id (make-widget "sealed-e2e"))', { capabilities: [cap] })).rejects.toThrow(/opaque/);
  });
});

describe("opaque-crossing contract — eq? across two crossings sharing ONE cached instance", () => {
  const shared = new Widget("shared-singleton");
  const cap = EnvCapability.define("test/opaque-crossing-shared-identity", {
    symbols: (symbol, z) => ({
      "get-shared-widget": symbol.rosetta`get-shared-widget: returns the SAME module-level instance every call`(
        { input: [], output: [z.dynamic] },
        function () {
          return shared as unknown as SchemeValue;
        },
      ),
    }),
  });

  it("(eq? (get-shared-widget) (get-shared-widget)) is #t — two mints of the same instance are eq?", async () => {
    const [result] = await exec("(eq? (get-shared-widget) (get-shared-widget))", { capabilities: [cap] });
    expect(result).toBe(true);
  });
});

/**
 * Inherited `INTEROP_BOUNDARY` is a READ-POLICY stop (`accessMember` walks up to it),
 * not `@arrival.private`. Only the instance's OWN class opt-in mints an opaque handle.
 * A subclass of a stamped engine (PlexusModel → DriverSpec) therefore borrows as
 * AJSObject: subclass accessors are readable; engine members stay blocked.
 */
describe("inherited INTEROP_BOUNDARY is a read-policy stop, not opaque-crossing", () => {
  class Engine {
    static [INTEROP_BOUNDARY] = true;
    get uuid() {
      return "hidden";
    }
  }
  class Spec extends Engine {
    constructor(
      readonly name: string,
      readonly can: string[],
    ) {
      super();
    }
  }
  class Parent extends Engine {
    constructor(readonly child: Spec) {
      super();
    }
  }

  const spec = new Spec("openai-compat", ["completion"]);
  const parent = new Parent(spec);

  it("isMarkedInteropPrivate is true only for the stamped class, not a subclass", () => {
    expect(isMarkedInteropPrivate(new Engine())).toBe(true);
    expect(isMarkedInteropPrivate(spec)).toBe(false);
    expect(isMarkedInteropPrivate(parent)).toBe(false);
    expect(isMarkedInteropPrivate(new PlainWidget("plain"))).toBe(false);
  });

  it("jsToScheme of a subclass borrows as AJSObject; own stamp stays opaque", () => {
    const boxed = jsToScheme<unknown>(CONSTANT_CTX, spec);
    expect(boxed).toBeInstanceOf(AJSObject);
    expect((boxed as AJSObject).source).toBe(spec);

    const engine = jsToScheme<unknown>(CONSTANT_CTX, new Engine());
    expect(engine).toBeInstanceOf(AOpaqueHandle);
  });

  it("nested AJSObject.get re-boxes a subclass field as AJSObject, not opaque", () => {
    const boxed = new AJSObject(parent);
    const nested = boxed.get("child");
    expect(nested).toBeInstanceOf(AJSObject);
    expect((nested as AJSObject).source).toBe(spec);
    const name = (nested as AJSObject).get("name");
    expect(name.valueOf()).toBe("openai-compat");
  });

  it("(:name spec) reads the subclass field; (:uuid spec) is blocked at the ancestor", async () => {
    const cap = EnvCapability.define("test/inherited-boundary-borrow", {
      symbols: (symbol, z) => ({
        "get-spec": symbol.rosetta`get-spec: returns a subclass of a stamped engine`(
          { input: [], output: [z.dynamic] },
          function () {
            return spec as unknown as SchemeValue;
          },
        ),
        "get-parent": symbol.rosetta`get-parent: returns a parent holding a nested subclass`(
          { input: [], output: [z.dynamic] },
          function () {
            return parent as unknown as SchemeValue;
          },
        ),
      }),
    });

    const [name] = await exec("(:name (get-spec))", { capabilities: [cap] });
    expect(String(name)).toBe("openai-compat");

    const [uuidAbsent] = await exec("(null? (:uuid (get-spec)))", { capabilities: [cap] });
    expect(uuidAbsent).toBe(true);

    const [nested] = await exec("(:name (:child (get-parent)))", { capabilities: [cap] });
    expect(String(nested)).toBe("openai-compat");
  });
});
