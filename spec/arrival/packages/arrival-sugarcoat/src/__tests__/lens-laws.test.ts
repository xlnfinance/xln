/**
 * Lens laws — the structural guarantees sugarcoat claims, as executable tests.
 *
 * README / sugarcoatToScheme doc law:
 *   GetPut AST:  ast(read(render(c))) ≡ ast(c)
 *   GetPut BYTE: sugarcoatToScheme(render(c), c) === c   (unedited view never dirty-saves)
 *
 * PutGet / cyclic view (quotient-lens fixed point on the surface):
 *   render(printScheme(read(s))) reaches a stable sugar representative of s
 *
 * Domain isolation:
 *   schemeToSugarcoat accepts scheme + polyglot supersets + free `[]`/`{}`,
 *   and re-enters already-sweet buffers via the sugar reader when needed
 *   (I-expr / `@{}` / `=>`). Never a quiet list/dict → bare-list zombie.
 *
 * What the pre-existing suite actually covered (and why the mode-override
 * corruption shipped green):
 *   ✓  GetPut AST via `printScheme(readSugarcoat(render(scheme)))` — many files
 *   ✓  PutGet cyclic for method-dot + accessor subscripts ONLY
 *   ✗  GetPut BYTE (`sugarcoatToScheme`) — one "does not throw", zero identity
 *   ✗  PutGet cyclic for free `[]` / even `{}` (dict/list surface)
 *   ✗  Double-render / scheme-parser-on-sugar isolation
 *   ✗  The promised "program corpus" (README / index.ts) — no corpus exists
 *
 * Composition diagram of the hole:
 *   scheme ─render→ sugar ─readSugarcoat→ scheme     ✓ tested
 *   scheme ─render→ sugar ─schemeToSugarcoat→ zombie  ✗ untested until here
 *                                    ↑
 *                     parseSexprs treats `[`≡`(`, `{`/`} ` as atom glue
 */

import { describe, expect, it } from "vitest";

import { schemeToSugarcoat, printScheme, parseSexprs, nodeEq, normalizePolyglot } from "../sugarcoat-render.js";
// Importing the reader registers it with schemeToSugarcoat (I-expr / @{} re-entry).
import { readSugarcoat, readSugarcoatExpr, sugarcoatToScheme } from "../sugarcoat-read.js";

const render = (scheme: string): string => schemeToSugarcoat(scheme);
const canon = (scheme: string): string => printScheme(parseSexprs(scheme)[0]!);
const readAst = (sugar: string): string =>
  readSugarcoat(sugar)
    .map((f) => printScheme(f))
    .join("\n");

/** Structural equality of scheme trees (print-normalized). */
const astEq = (a: string, b: string): boolean => {
  const fa = parseSexprs(a);
  const fb = parseSexprs(b);
  if (fa.length !== fb.length) return false;
  return fa.every((n, i) => nodeEq(n, fb[i]!));
};

// ── fixtures that exercise free-[] + even-{} together (the mode-override shape) ──

const LIST_OF_DICT = `(list (dict :form (quote notify) :level (quote error) :message "hi"))`;
const LIST_OF_DICTS = `(list (dict :a 1) (dict :b 2))`;
const NESTED = `(define f (lambda (x) (list (dict :a x :b (list 1 2)))))`;
const IF_ARMS = `(if #t (list (dict :k 1)) (list))`;

const CLASSIC_CORPUS = [
  LIST_OF_DICT,
  LIST_OF_DICTS,
  NESTED,
  IF_ARMS,
  `(list)`,
  `(dict)`,
  `(dict :a 1 :b 2)`,
  `(list 1 2 3)`,
  `(map f (list (dict :k v)))`,
  `(+ a b)`,
  `(and p q r)`,
  `(lambda (x) (* x 2))`,
];

const SUGAR_LIST_DICT_SURFACES = [
  "[]",
  "[1 2 3]",
  "{}",
  "{:a 1 :b 2}",
  "[{:a 1}]",
  "[{:a 1} {:b 2}]",
  "[{:form 'notify :level 'error :message \"hi\"}]",
];

// ═══════════════════════════════════════════════════════════════════════════
// Law 1 — GetPut AST  (well-covered elsewhere; keep a dict/list pin here)
// ═══════════════════════════════════════════════════════════════════════════

describe("lens law GetPut AST: read(render(c)) ≡ c", () => {
  for (const c of CLASSIC_CORPUS) {
    it(c, () => {
      const sugar = render(c);
      expect(astEq(readAst(sugar), c)).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Law 2 — GetPut BYTE  (CLAIMED in sugarcoatToScheme JSDoc + README; almost untested)
// ═══════════════════════════════════════════════════════════════════════════

describe("lens law GetPut BYTE: sugarcoatToScheme(render(c), c) === c", () => {
  for (const c of CLASSIC_CORPUS) {
    it(c, () => {
      const sugar = render(c);
      expect(sugarcoatToScheme(sugar, c)).toBe(c);
    });
  }

  it("preserves surrounding comments and hand formatting on unedited view", () => {
    const c = `;;; header\n\n(list (dict :a 1))\n\n;;; trailer\n`;
    const sugar = render(c);
    expect(sugarcoatToScheme(sugar, c)).toBe(c);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Law 3 — PutGet cyclic on list/dict surfaces
//          (method-dot + accessors already have this; dict/list did NOT)
// ═══════════════════════════════════════════════════════════════════════════

describe("lens law PutGet cyclic: render(read(s)) is a stable sugar for list/dict", () => {
  for (const s of SUGAR_LIST_DICT_SURFACES) {
    it(s, () => {
      // Correct composition: sugar → sugarcoat reader → scheme print → re-render.
      const scheme = printScheme(readSugarcoatExpr(s));
      const again = render(scheme).trim();
      // Re-reading the re-render recovers the same scheme AST (intent preserved).
      expect(astEq(readAst(again), scheme)).toBe(true);
      // And a second cycle is fixed: render∘read is idempotent on the AST.
      expect(astEq(readAst(render(printScheme(readSugarcoatExpr(again)))), scheme)).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Law 4 — Domain isolation: schemeToSugarcoat is NOT a sugar pretty-printer
//
// THIS is the structural hole. Every other test starts from scheme and
// re-enters sugar only via readSugarcoat. Nothing asserted that feeding the
// sweet surface back into schemeToSugarcoat (scheme parseSexprs) preserves
// intent. parseSexprs treats `[` ≡ `(`, and `{`/`}` as atom characters, so
// `[{:a 1}]` becomes a bare list of the atoms `{:a`, `1`, `}` — then re-emits
// as the zombie `({:a 1 })`. Intent flips: (list (dict …)) → ((dict …)).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Domain isolation — fixed by parse opener stamps + normalizePolyglot:
 * free `[]`/`{}` lower to `(list …)` / `(dict …)` before render, so re-feeding
 * a sweet buffer recovers the same scheme AST (no `({:form … })` zombie).
 */
describe("lens law domain isolation: re-render of sugar must not corrupt intent", () => {
  for (const c of [LIST_OF_DICT, LIST_OF_DICTS, NESTED, IF_ARMS]) {
    it(`double-render preserves AST of ${c}`, () => {
      const once = render(c);
      const twice = schemeToSugarcoat(once);
      expect(astEq(readAst(twice), c)).toBe(true);
    });
  }

  it("mode-override shape: list-of-notify-dict survives a re-render pass", () => {
    // harness/design/slash/mode-override.scm — sweet source re-entered via schemeToSugarcoat.
    // Uses `str` (not string-append): strTolerant modernizes string-append→str on the
    // first render; domain isolation cares about list/dict structure, not that rename.
    const scheme = `(list (dict :form (quote notify) :level (quote error) :message (str "unknown mode axis: " (format #f "~a" axis))))`;
    const once = render(scheme).trim();
    expect(once).toMatch(/^\[\{/); // sweet list-of-dict surface
    const twice = schemeToSugarcoat(once).trim();
    // Zombie signature we must never emit: bare parens + glued `{:form` atom.
    expect(twice).not.toMatch(/^\(\{:form/);
    expect(astEq(readAst(twice), scheme)).toBe(true);
    // Re-render is a fixed point on the recovered AST.
    expect(astEq(readAst(twice), readAst(once))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Law 5 — After normalize, free sugar delimiters agree with the sugar reader
//
// Raw parseSexprs still stamps `open` on free `[]`/`{}` (a bare container, not
// yet `(list …)`/`(dict …)`). Intent agreement is at the normalize boundary —
// the same path schemeToSugarcoat takes.
// ═══════════════════════════════════════════════════════════════════════════

describe("normalizePolyglot free []/{} agrees with sugarcoat reader", () => {
  it("free [] → (list …)", () => {
    const sugar = "[1 2 3]";
    const normalized = printScheme(normalizePolyglot(parseSexprs(sugar))[0]!);
    const sugarTree = printScheme(readSugarcoatExpr(sugar));
    expect(normalized).toBe(sugarTree);
  });

  it("even {} → (dict …)", () => {
    const sugar = "{:a 1 :b 2}";
    const normalized = printScheme(normalizePolyglot(parseSexprs(sugar))[0]!);
    const sugarTree = printScheme(readSugarcoatExpr(sugar));
    expect(normalized).toBe(sugarTree);
  });

  it("list-of-dict sugar surface", () => {
    const sugar = "[{:form 'notify :level 'error :message \"hi\"}]";
    const normalized = printScheme(normalizePolyglot(parseSexprs(sugar))[0]!);
    const sugarTree = printScheme(readSugarcoatExpr(sugar));
    expect(normalized).toBe(sugarTree);
  });
});
