// idiom-routing — B8 + Tier-C "doors we owe" (benchmark-defect-register.md). A model
// reaching for a capability that sounds standard but isn't bound here (`require`,
// `read-all`) hits a bare "Unbound variable" and burns a round rediscovering the
// native form. This is a DISJOINT, name-exact gate from `suggestFromVocabulary`'s
// fuzzy typo matching (that gate stays untouched — GATING load-bearing constraint
// in unbound-variable.ts: a hint fires only for a close miss of a name that EXISTS
// in vocabulary; these idioms exist in NO vocabulary, so they would never fire
// through it) — a small hardcoded table of known dead-end idioms, same family as
// the existing `SYNTH_NAMES` (car/cdr) seed.
//
// Honesty constraint: only names that are TRULY unbound in the default env belong in
// IDIOM_ROUTES. A live host door (e.g. `with-input-from-file` in env/r7rs/host.ts) must
// NOT dual-path through idiom routing — resolution hits the door; unbound-variable never
// runs for that name.
//
// Racket `#:name` used to be an idiom door ("drop the `#`"); it now mints as the
// keyword `:name` at ASymbol construction (identical to arrival's spelling) and never
// reaches unbound-variable. See racket-hash-colon-keywords.test.ts.

import { describe, expect, it } from "vitest";
import { exec } from "../../eval/generator-exec.js";
import { unboundVariableError } from "../../unbound-variable.js";
import { PurityError } from "../../errors.js";

describe("unboundVariableError — idiom routing (B8: Racket #:kwargs retired)", () => {
  it("#:name is no longer an unbound-variable routing target (it's a keyword)", () => {
    // Pure helper with no mint: still the plain wall for the raw string.
    const err = unboundVariableError("#:query");
    expect(err.message).toBe("Unbound variable `#:query'");
    expect(err.enriched).toBe(false);
  });

  it("LIVE: #:query self-evaluates as the keyword :query (not unbound)", async () => {
    const [same] = await exec("(eq? #:query :query)");
    expect(same).toBe(true);
  });

  it("an ordinary unbound name is unaffected (idiom gate is name-exact, not a false-positive net)", () => {
    const err = unboundVariableError("csv-content");
    expect(err.message).toBe("Unbound variable `csv-content'");
    expect(err.enriched).toBe(false);
  });
});

describe("unboundVariableError — idiom routing (Tier C: require / file IO dead-ends)", () => {
  it("(require ...) routes to the bound parsers instead of a bare wall", () => {
    const err = unboundVariableError("require");
    expect(err.message).toMatch(/parse-json/);
    expect(err.message).toMatch(/detect-parse/);
    expect(err.enriched).toBe(true);
  });

  it("read-all routes to the same no-file-IO explanation", () => {
    const err = unboundVariableError("read-all");
    expect(err.message).toMatch(/detect-parse/);
    expect(err.enriched).toBe(true);
  });

  it("LIVE: (require 'scheme/parse-json) throws the routing hint through real exec", async () => {
    await expect(exec("(require 'scheme/parse-json)")).rejects.toThrow(/parse-json/);
  });

  // Dual-path honesty: with-input-from-file is a LIVE host door (env/r7rs/host.ts),
  // not an unbound idiom. Resolution must hit the door; idiom routing must not claim it.
  it("with-input-from-file is NOT an idiom route (live host door owns the teaching)", () => {
    const err = unboundVariableError("with-input-from-file");
    // Without vocabulary, plain wall — no detect-parse idiom enrichment, because the
    // name is not in IDIOM_ROUTES. (In a real env it never reaches unbound-variable.)
    expect(err.message).toBe("Unbound variable `with-input-from-file'");
    expect(err.enriched).toBe(false);
  });

  it("LIVE: (with-input-from-file) fires the host purity door, not unbound-variable", async () => {
    try {
      await exec("(with-input-from-file)");
      throw new Error("expected with-input-from-file to throw");
    } catch (e) {
      const direct = e instanceof PurityError;
      const viaCause = (e as { cause?: unknown })?.cause instanceof PurityError;
      expect(direct || viaCause).toBe(true);
      const message = (e as Error)?.message ?? String(e);
      expect(message).toMatch(/with-input-from-file/);
      expect(message).toMatch(/no file ports|filesystem tool|is not available/i);
      expect(message).not.toMatch(/Unbound variable/);
    }
  });
});

describe("unboundVariableError — idiom routing (free unquote / JS-comma footgun)", () => {
  it("unquote routes to the free-comma / quasiquote teaching", () => {
    const err = unboundVariableError("unquote");
    expect(err.message).toMatch(/quasiquote/);
    expect(err.message).toMatch(/list 1 2 3/);
    expect(err.enriched).toBe(true);
  });

  it("unquote-splicing routes similarly", () => {
    const err = unboundVariableError("unquote-splicing");
    expect(err.message).toMatch(/quasiquote/);
    expect(err.enriched).toBe(true);
  });

  it("LIVE: free ,x throws the unquote door (not a bare wall)", async () => {
    await expect(exec(",59")).rejects.toThrow(/Unbound variable `unquote'.*quasiquote/s);
  });

  it("LIVE: free unquote call-head stamps the form on the scheme stack", async () => {
    try {
      await exec("(unquote 59)");
      throw new Error("expected throw");
    } catch (e) {
      const err = e as Error & { schemeStack?: { code: unknown }[] };
      expect(err.message).toMatch(/unquote/);
      expect(Array.isArray(err.schemeStack) && err.schemeStack.length > 0).toBe(true);
      // Innermost frame is the applied form — hosts print this in the run-error strip.
      const top = err.schemeStack![err.schemeStack!.length - 1]!;
      expect(String(top.code)).toMatch(/unquote/);
      expect(String(err)).toMatch(/Scheme Stack Trace/);
    }
  });
});
