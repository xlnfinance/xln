/**
 * The static overridable substrate — the top-level `(define/overridable …)` node walk and the
 * pre-eval `foldSchemaTag`. Pure parse: no program is ever evaluated.
 */
import { describe, expect, it } from "vitest";

import { foldSchemaTag } from "../schema-fold.js";
import { extractOverridableForms, overridableFormsFromForms, extractRequires } from "../walk.js";

const SRC = `
(define/overridable tagline (s/string) "Build faster")
(define/overridable model (s/enum "gpt-4o" "claude-3") "gpt-4o")
(define/overridable retries (s/integer) 3)
(define/overridable verbose (s/boolean) #t)
(define plain (+ 1 2))
`;

describe("extractOverridableForms", () => {
  it("walks each top-level define/overridable, in declaration order", async () => {
    const forms = await extractOverridableForms(SRC);
    expect(forms.map((f) => f.name)).toEqual(["tagline", "model", "retries", "verbose"]);
  });

  it("ignores plain define — only overridable knobs are walked", async () => {
    const forms = await extractOverridableForms(`(define plain 1)\n(define/overridable x (s/string) "a")`);
    expect(forms.map((f) => f.name)).toEqual(["x"]);
  });

  it("skips an incomplete declaration (missing default — fixed 3-arity)", async () => {
    const forms = await extractOverridableForms(`(define/overridable x (s/string))`);
    expect(forms).toEqual([]);
  });

  it("returns [] on parse failure rather than throwing", async () => {
    expect(await extractOverridableForms("(define/overridable oops")).toEqual([]);
  });
});

describe("foldSchemaTag (over the walked typeNode, zero eval)", () => {
  it("folds each declared type to its canonical tagged-list form", async () => {
    const forms = await extractOverridableForms(SRC);
    const folded = forms.map((f) => foldSchemaTag(f.typeNode));
    expect(folded).toEqual([
      { ok: true, value: "string" },
      { ok: true, value: ["enum", "gpt-4o", "claude-3"] },
      { ok: true, value: "integer" },
      { ok: true, value: "boolean" },
    ]);
  });

  it("folds a nested s/array to an array tag", async () => {
    const [f] = await extractOverridableForms(`(define/overridable cfg (s/array (s/string)) (list))`);
    expect(foldSchemaTag(f!.typeNode)).toEqual({ ok: true, value: ["array", "string"] });
  });

  it("folds a quoted-list type literal", async () => {
    const [f] = await extractOverridableForms(`(define/overridable m '("enum" "a" "b") "a")`);
    expect(foldSchemaTag(f!.typeNode)).toEqual({ ok: true, value: ["enum", "a", "b"] });
  });

  it("reports {ok:false} for an unfoldable shape (a bare symbol reference)", async () => {
    const [f] = await extractOverridableForms(`(define/overridable x some-type "a")`);
    expect(foldSchemaTag(f!.typeNode)).toEqual({ ok: false });
  });
});

describe("overridableFormsFromForms", () => {
  it("is the pure (already-parsed) base, matching extractOverridableForms", async () => {
    const viaSource = await extractOverridableForms(SRC);
    expect(viaSource.map((f) => f.name)).toEqual(["tagline", "model", "retries", "verbose"]);
    // overridableFormsFromForms over an empty list is trivially empty.
    expect(overridableFormsFromForms([])).toEqual([]);
  });
});

describe("extractRequires", () => {
  it('lists top-level (require "path") strings in order', async () => {
    const requires = await extractRequires(`(require "config.scm")\n(require "shared.scm")\n(define x 1)`);
    expect(requires).toEqual(["config.scm", "shared.scm"]);
  });

  it("returns [] on parse failure", async () => {
    expect(await extractRequires("(require")).toEqual([]);
  });
});
