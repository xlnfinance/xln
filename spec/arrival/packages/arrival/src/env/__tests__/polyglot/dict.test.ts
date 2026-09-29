import { describe, expect, it, beforeAll } from "vitest";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";
import { execOverFrame as exec } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";

/**
 * The runtime `dict` constructor — the canonical open-key map form
 * `(dict :k v …)`, paired with the `(:key d)` accessor. Round-trips:
 * construct with `dict`, read back with the keyword accessor.
 *
 * Evaluated against a fresh capability-assembled env (freshEnv), not the stdlib
 * `env` singleton — so the test tracks `dict`/`:key` by capability, surviving the
 * husk dissolution that is relocating these off global_env.
 */
describe("dict constructor", () => {
  let env: ResolvingAmbient;
  beforeAll(async () => {
    env = await freshEnv();
  });

  it("(:key (dict :k v …)) reads back the constructed values", async () => {
    const [a] = await exec(`(:a (dict :a 1 :b 2))`, { env });
    expect(Number((a as { valueOf: () => unknown }).valueOf())).toBe(1);

    const [b] = await exec(`(:b (dict :a 1 :b 2))`, { env });
    expect(Number((b as { valueOf: () => unknown }).valueOf())).toBe(2);
  });

  it("(dict) with no pairs is an empty object", async () => {
    const [n] = await exec(`(:missing (dict))`, { env });
    // accessor on an absent key returns nil — whose JS face is [] (nil-as-array,
    // V 2026-07-13); accept the boxed ANil (valueOf → undefined) or the [] face.
    const face = (n as { valueOf?: () => unknown })?.valueOf?.() ?? n;
    expect(face == null || (Array.isArray(face) && face.length === 0)).toBe(true);
  });
});

// `dict?` — the missing predicate for the native dict type (r7rs/equality.ts). A
// real gap (we shipped the type with no predicate for it), not a design omission —
// see equality.ts's comment at the binding site. Mirrors readMember's own
// record-vs-class-instance disambiguation (membrane.ts).
describe("dict? predicate", () => {
  let env: ResolvingAmbient;
  beforeAll(async () => {
    env = await freshEnv();
  });

  const truthy = async (src: string): Promise<string> => {
    const [r] = await exec(`(if ${src} "yes" "no")`, { env });
    return String(r);
  };

  it("#t for a (dict ...) constructed value", async () => {
    expect(await truthy('(dict? (dict "a" 1))')).toBe("yes");
    expect(await truthy("(dict? (dict))")).toBe("yes");
  });

  // The reader must route `{...}` through the dict-literal node (`ADict`'s
  // literalForms).
  it("#t for a {...} reader dict-literal (quoted, the ADict literalForms node)", async () => {
    expect(await truthy("(dict? '{:a 1})")).toBe("yes");
  });

  it("#f for a list, string, vector, number, boolean, or nil", async () => {
    expect(await truthy("(dict? (list 1 2))")).toBe("no");
    expect(await truthy('(dict? "str")')).toBe("no");
    expect(await truthy("(dict? (vector 1 2))")).toBe("no");
    expect(await truthy("(dict? 5)")).toBe("no");
    expect(await truthy("(dict? #t)")).toBe("no");
    expect(await truthy("(dict? '())")).toBe("no");
  });
});
