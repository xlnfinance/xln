// overridable.test.ts — the `arrival/overridable` capability through the ONE consumer door:
// `exec(src, { capabilities: [overridableCapability], config: { params } })`. The capability
// validates its own `params` slice of the shared config bag; `overridable/resolve` is an
// ORDINARY RUNTIME verb (no preludeOnly assembly-time bridge left to test) — the macro is pure
// ergonomics over it, and calling the verb directly from user code is a supported, undecorated
// path.
//
// "plain define plus validation": an override validates against the declared type when one is
// supplied by the host; the in-form default validates against the SAME type when none is — a
// bad default is exactly as loud as a bad override.

import { describe, expect, it } from "vitest";

import { execState, type ExecOptions } from "../../../eval/generator-exec.js";
import { AExact } from "../../../values/primitives/AExact.js";
import { AString } from "../../../values/primitives/AString.js";
import { APair } from "../../../values/primitives/APair.js";
import { overridableCapability } from "../../overridable/overridable.js";

const capabilities = [overridableCapability];

// This whole file calls `arrival/toJS` directly on exec results (`.["arrival/toJS"]()`)
// — a boxed-state concern (RULINGS.md R1). Local `exec` shadows the barrel export with
// the COMPLEX tier (execState) so every call site below is unchanged and still reads
// the boxed SchemeValue[] it always did. (Several cells in this file still fail —
// baseline-pre-existing, unrelated to R1: `overridable/resolve`'s `nameSym.toString()`
// stringifies the sz.symbol codec's native-Symbol decode as "Symbol(arrival membrane
// symbol: X)" instead of the bare name, so a config.params[bindingName] override lookup
// never matches. This wrapper only restores the boxed-result access this file always
// used — it does not touch that pre-existing bug.)
async function exec(code: string, options?: ExecOptions) {
  return (await execState(code, options)).values.slice();
}

describe("arrival/overridable — plain define plus validation, through the consumer door", () => {
  it("a host-supplied override wins over the in-form default, and validates", async () => {
    const result = await exec(`(define/overridable city (s/string) "Berlin") city`, {
      capabilities,
      config: { params: { city: "Paris" } },
    });
    expect((result.at(-1) as AString)["arrival/toJS"]()).toBe("Paris");
  });

  it("default fallback: absent params ⇒ the in-form default fires (and validates)", async () => {
    const result = await exec(`(define/overridable city (s/string) "Berlin") city`, {
      capabilities,
      config: { params: {} },
    });
    expect((result.at(-1) as AString)["arrival/toJS"]()).toBe("Berlin");
  });

  it("config-less lower succeeds (`params` defaults to {}) — every in-form default fires", async () => {
    const result = await exec(`(define/overridable city (s/string) "Berlin") city`, {
      capabilities,
      // no config at all — the shared-bag posture: lower({ config: undefined }) parses to {}.
    });
    expect((result.at(-1) as AString)["arrival/toJS"]()).toBe("Berlin");
  });

  it("multiple inputs in one program resolve independently (override + default mixed)", async () => {
    const result = await exec(
      `(define/overridable city (s/string) "Berlin")
       (define/overridable country (s/string) "France")
       (list city country)`,
      { capabilities, config: { params: { city: "Paris" } } },
    );
    const list = result.at(-1) as APair<any, any>;
    expect(list.to_array().map((v) => (v as AString)["arrival/toJS"]())).toEqual(["Paris", "France"]);
  });

  it("a bad OVERRIDE throws legibly, naming the binding, the declared type, and the source", async () => {
    await expect(
      exec(`(define/overridable age (s/number) 30) age`, {
        capabilities,
        config: { params: { age: "not-a-number" } },
      }),
    ).rejects.toThrow(/define\/overridable age: expected number, got "not-a-number" \(from an environment override\)/);
  });

  it("a bad DEFAULT throws exactly as loud as a bad override — validated the same", async () => {
    await expect(
      exec(`(define/overridable age (s/number) "thirty") age`, {
        capabilities,
        config: { params: {} },
      }),
    ).rejects.toThrow(/define\/overridable age: expected number, got "thirty" \(from the in-form default\)/);
  });

  it("an unrecognized type tag DOORS with the binding name, not a silent passthrough", async () => {
    await expect(
      exec(`(define/overridable age "not-a-real-type" 30) age`, {
        capabilities,
        config: { params: {} },
      }),
    ).rejects.toThrow(/define\/overridable age: unrecognized type tag/);
  });

  it("a bare NAME in tag position is not a type reference — it's an unbound variable, same as anywhere else", async () => {
    // `type` splices UNQUOTED into the macro's expansion: `(overridable/resolve 'age ,type ,default)`.
    // A bare symbol there evaluates as an ordinary variable reference, same as any other position —
    // there is no notion of a "named type" to resolve against. s/* calls — (s/string), (s/enum ...),
    // … — are the only legal type expressions; an undefined identifier just bites unbound, before
    // `overridable/resolve` ever runs. Same rule the static type-lens enforces at compile time.
    await expect(
      exec(`(define/overridable age NotARealType 30) age`, { capabilities, config: { params: {} } }),
    ).rejects.toThrow(/^Unbound variable `NotARealType'$/);
  });

  it("a tag that lowers to an EMPTY schema DOORS (no silent permissive passthrough)", async () => {
    // An unknown list `kind` and an empty list both fall through `tagToJsonSchema` to `{}`,
    // which `z.fromJSONSchema` would turn into a PERMISSIVE validator (accept anything) —
    // the exact silent passthrough this capability promises never to do. Both must door,
    // naming the binding, rather than silently accepting an unvalidated override.
    await expect(
      exec(`(define/overridable x '("frobnicate" 1) 5) x`, {
        capabilities,
        config: { params: { x: "literally anything" } },
      }),
    ).rejects.toThrow(/define\/overridable x: unrecognized type tag/);
    await expect(
      exec(`(define/overridable x '() 5) x`, { capabilities, config: { params: { x: "anything" } } }),
    ).rejects.toThrow(/define\/overridable x: unrecognized type tag/);
  });

  it("an `/optional`-suffixed tag is tolerated (the suffix is inert here) — validation still applies", async () => {
    const result = await exec(`(define/overridable size (s/optional (s/number)) 10) size`, {
      capabilities,
      config: { params: {} },
    });
    expect((result.at(-1) as AExact)["arrival/toJS"]()).toBe(10);
  });

  it("`overridable/resolve` is a real RUNTIME verb — callable directly by user code, no sealing", async () => {
    const result = await exec(`(overridable/resolve 'city (s/string) "Berlin")`, {
      capabilities,
      config: { params: { city: "Paris" } },
    });
    expect((result.at(-1) as AString)["arrival/toJS"]()).toBe("Paris");
  });
});

// s/* is the only place types appear explicitly — `arrival/overridable` no longer carries its
// own hand-rolled scalar subset; every type tag, scalar leaf (`s/string`/`s/number`/`s/integer`/
// `s/boolean`) or structured composite, lowers through the SAME `tagToJsonSchema` +
// `z.fromJSONSchema` bridge `schemaToZod` (arrival-chain) uses. `deps: [schemaCapability]`
// (declared on `overridableCapability` itself) means `(s/enum …)`/`(s/object …)` resolve here
// with no extra wiring at the test's own capability list.
describe("arrival/overridable — structured s/* forms: enum, object, optional", () => {
  it("(s/enum ...) as a type tag validates an override against the enum's values", async () => {
    const result = await exec(`(define/overridable tier (s/enum "free" "pro") "free") tier`, {
      capabilities,
      config: { params: { tier: "pro" } },
    });
    expect((result.at(-1) as AString)["arrival/toJS"]()).toBe("pro");
  });

  it("(s/enum ...) rejects a value outside the declared set — legible, names the binding", async () => {
    await expect(
      exec(`(define/overridable tier (s/enum "free" "pro") "free") tier`, {
        capabilities,
        config: { params: { tier: "enterprise" } },
      }),
    ).rejects.toThrow(/define\/overridable tier: expected one of \["free","pro"\], got "enterprise"/);
  });

  it("(s/object ...) as a type tag validates a structured override field-by-field", async () => {
    const result = await exec(
      `(define/overridable profile
         (s/object (s/field/string "name") (s/field/integer "age"))
         "unused")
       (@ profile "name")`,
      {
        capabilities,
        config: { params: { profile: { name: "Maya", age: 30 } } },
      },
    );
    expect((result.at(-1) as AString)["arrival/toJS"]()).toBe("Maya");
  });

  it("(s/object ...) rejects an override missing a required field", async () => {
    await expect(
      exec(
        `(define/overridable profile
           (s/object (s/field/string "name") (s/field/integer "age"))
           "unused")
         profile`,
        { capabilities, config: { params: { profile: { name: "Maya" } } } },
      ),
    ).rejects.toThrow(/define\/overridable profile: expected/);
  });

  it("a nested (s/optional ...) field inside (s/object ...) is genuinely optional", async () => {
    const withBio = await exec(
      `(define/overridable profile
         (s/object (s/field/string "name") (s/field "bio" (s/optional (s/string))))
         "unused")
       (@ profile "bio")`,
      { capabilities, config: { params: { profile: { name: "Maya", bio: "hi" } } } },
    );
    expect((withBio.at(-1) as AString)["arrival/toJS"]()).toBe("hi");

    // Omitting the /optional field still validates — the object schema doesn't require it.
    const withoutBio = await exec(
      `(define/overridable profile
         (s/object (s/field/string "name") (s/field "bio" (s/optional (s/string))))
         "unused")
       (@ profile "name")`,
      { capabilities, config: { params: { profile: { name: "Maya" } } } },
    );
    expect((withoutBio.at(-1) as AString)["arrival/toJS"]()).toBe("Maya");
  });

  it("scalar error cases stay legible: unrecognized tag, bad override, bad default", async () => {
    // Unrecognized bare tag — still DOORS with the binding name (now via tagToJsonSchema/
    // z.fromJSONSchema failing to build a validator, not a hand-rolled switch default).
    await expect(
      exec(`(define/overridable age "not-a-real-type" 30) age`, { capabilities, config: { params: {} } }),
    ).rejects.toThrow(/define\/overridable age: unrecognized type tag/);

    // Bad override — same "expected X, got Y (from an environment override)" shape.
    await expect(
      exec(`(define/overridable age (s/number) 30) age`, { capabilities, config: { params: { age: "nope" } } }),
    ).rejects.toThrow(/define\/overridable age: expected number, got "nope" \(from an environment override\)/);

    // Bad default — validated exactly as loud as a bad override.
    await expect(
      exec(`(define/overridable age (s/number) "thirty") age`, { capabilities, config: { params: {} } }),
    ).rejects.toThrow(/define\/overridable age: expected number, got "thirty" \(from the in-form default\)/);
  });
});

// Rows below go through `{ capabilities: [overridableCapability], config: { params } }`
// — the door `execState`'s router uses for the capability. There is no `ExecOptions.override`
// sugar.
describe("define/overridable through capabilities+config — the door the override sugar wrapped", () => {
  // No manual `jsToScheme`, no `env.set` — the capability's own `overridable/resolve` verb
  // boxes at the membrane, no ceremony.
  it("a param binds, boxed at the membrane, no ceremony", async () => {
    const result = await exec(`(define/overridable city (s/string) "Berlin") city`, {
      capabilities,
      config: { params: { city: "Paris" } },
    });
    expect((result.at(-1) as AString)["arrival/toJS"]()).toBe("Paris");
  });

  it("structured data crosses seamlessly — the README shape, without jsToScheme", async () => {
    const users = [
      { name: "john", priority: 15 },
      { name: "mary", priority: 5 },
    ];
    const result = await exec(
      `(define/overridable users (s/array (s/object (s/field/string "name") (s/field/number "priority"))) '())
       (map (lambda (u) (@ u "name")) users)`,
      { capabilities, config: { params: { users } } },
    );
    // The validated array crosses as a VECTOR (arrays ↔ vectors at the membrane),
    // so map returns a vector — read it back through the standard JS projection.
    const names = (result.at(-1) as { "arrival/toJS"(): unknown })["arrival/toJS"]();
    expect(names).toEqual(["john", "mary"]);
  });

  it("absent key ⇒ the in-form default fires (a param is per-name, not all-or-nothing)", async () => {
    const result = await exec(
      `(define/overridable city (s/string) "Berlin")
       (define/overridable country (s/string) "Germany")
       (list city country)`,
      { capabilities, config: { params: { city: "Paris" } } },
    );
    const list = result.at(-1) as APair<any, any>;
    expect(list.to_array().map((v) => (v as AString)["arrival/toJS"]())).toEqual(["Paris", "Germany"]);
  });

  it("a param validates against the declared type — same door as any other config.params value", async () => {
    await expect(
      exec(`(define/overridable age (s/number) 30) age`, {
        capabilities,
        config: { params: { age: "not-a-number" } },
      }),
    ).rejects.toThrow(/define\/overridable age: expected number, got "not-a-number" \(from an environment override\)/);
  });
});
