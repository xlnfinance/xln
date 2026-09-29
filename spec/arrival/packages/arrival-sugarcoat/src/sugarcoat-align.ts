/**
 * Sugarcoat ↔ Scheme SPAN ALIGNMENT — the coordinate half of the bifunctor.
 *
 * sugarcoat-render stamps Scheme spans on parsed nodes (parseSexprs); sugarcoat-read
 * stamps sugarcoat spans on the nodes it reads (for the parameter hints). Both
 * trees are STRUCTURALLY EQUAL by the round-trip law (read(render(x)) ≡ x), so
 * a lockstep walk pairs every node that carries a span on both sides — and
 * that pairing IS the sugarcoat↔Scheme position mapping, recovered entirely from
 * metadata the two transforms already produce. Nothing here re-derives layout.
 *
 * The Scheme text aligned against is the CANONICAL REPRINT of the sugarcoat
 * buffer (readSugarcoat → printScheme), not the studio's stored Scheme — the two
 * may differ in formatting bytes, but a consumer that round-trips spans
 * through THIS reprint (e.g. an IDE backend that takes the text per call)
 * never sees the difference.
 *
 * Coverage is honest, not total: sugarcoat spans exist only where sugarcoat-read
 * could stamp them (single-physical-line tokens), and synthetic atoms (the
 * `lambda` behind `=>`, the `equal?` behind `==`, accessors behind `[0]`)
 * have no sugarcoat text of their own. Unpaired regions degrade by containment —
 * a query inside one lifts to the nearest enclosing pair.
 */

import { readSugarcoat } from "./sugarcoat-read.js";
import { parseSexprs, printScheme, type Node } from "./sugarcoat-render.js";

/** One paired node: the same datum's span in both projections. `exact` means
 *  both sides are the SAME atom text (so positions translate offset-precise);
 *  inexact pairs (lists, glyph-swapped atoms) translate by containment only. */
export interface SugarcoatSpanPair {
  sugarcoatStart: number;
  sugarcoatEnd: number;
  schemeStart: number;
  schemeEnd: number;
  exact: boolean;
}

export interface SugarcoatAlignment {
  /** Canonical Scheme reprint of the sugarcoat buffer — the text to hand to any
   *  Scheme-coordinate consumer (language service, runtime, …). */
  scheme: string;
  pairs: SugarcoatSpanPair[];
  /** Sugarcoat position → Scheme position, through EXACT atom pairs only —
   *  token precision or nothing (inclusive of the atom's end, where a typing
   *  cursor sits). A position on sugar (glyphs, elided parens, whitespace)
   *  returns null; position consumers (hover/completion/goto) should degrade
   *  rather than answer about the wrong token. */
  toScheme(sugarcoatPos: number): number | null;
  /** Scheme span → sugarcoat span. Offset-exact within an exact atom; otherwise
   *  the innermost containing pair's whole sugarcoat span; null when uncovered. */
  toSugarcoat(schemeStart: number, schemeLength: number): { start: number; length: number } | null;
}

const isAtomNode = (n: Node): n is { atom: string; str?: boolean; span?: readonly [number, number] } => "atom" in n;

/** Lockstep walk: pair spans wherever BOTH trees carry one. The trees are
 *  equal by construction; a shape mismatch (defensive) just stops descending
 *  that branch rather than failing the whole alignment. */
function collectPairs(sugarcoat: Node, scheme: Node, out: SugarcoatSpanPair[]): void {
  const sAtom = isAtomNode(sugarcoat);
  const cAtom = isAtomNode(scheme);
  if (sAtom !== cAtom) return;
  if (sugarcoat.span && scheme.span) {
    const exact = sAtom && cAtom && sugarcoat.atom === scheme.atom && !!sugarcoat.str === !!scheme.str;
    out.push({
      sugarcoatStart: sugarcoat.span[0],
      sugarcoatEnd: sugarcoat.span[1],
      schemeStart: scheme.span[0],
      schemeEnd: scheme.span[1],
      exact,
    });
  }
  if (sAtom || cAtom) return;
  const a = sugarcoat.list;
  const b = scheme.list;
  if (a.length !== b.length) return;
  for (let i = 0; i < a.length; i++) collectPairs(a[i], b[i], out);
}

/** Innermost pair containing the query — smallest span on the queried side. */
function innermost(
  pairs: SugarcoatSpanPair[],
  contains: (p: SugarcoatSpanPair) => boolean,
  sizeOf: (p: SugarcoatSpanPair) => number,
): SugarcoatSpanPair | null {
  let best: SugarcoatSpanPair | null = null;
  for (const p of pairs) {
    if (!contains(p)) continue;
    if (best === null || sizeOf(p) < sizeOf(best)) best = p;
  }
  return best;
}

/**
 * Align a sugarcoat buffer against its own canonical Scheme reprint. Returns null
 * when the sugarcoat text doesn't parse (mid-edit) — the consumer keeps its last
 * good answers, exactly like the save-back path keeps its last good Scheme.
 */
export function alignSugarcoatScheme(sugarcoatText: string): SugarcoatAlignment | null {
  let sugarcoatForms: Node[];
  try {
    sugarcoatForms = readSugarcoat(sugarcoatText);
  } catch {
    return null;
  }
  const scheme = sugarcoatForms.map((f) => printScheme(f)).join("\n\n");
  const schemeForms = parseSexprs(scheme);
  if (schemeForms.length !== sugarcoatForms.length) return null;

  const pairs: SugarcoatSpanPair[] = [];
  for (let i = 0; i < sugarcoatForms.length; i++) collectPairs(sugarcoatForms[i], schemeForms[i], pairs);

  const toScheme = (sugarcoatPos: number): number | null => {
    // Inclusive end: a typing cursor at an atom's end still belongs to it.
    const p = innermost(
      pairs,
      (q) => q.exact && q.sugarcoatStart <= sugarcoatPos && sugarcoatPos <= q.sugarcoatEnd,
      (q) => q.sugarcoatEnd - q.sugarcoatStart,
    );
    if (p === null) return null;
    return p.schemeStart + Math.min(sugarcoatPos - p.sugarcoatStart, p.schemeEnd - p.schemeStart);
  };

  const toSugarcoat = (schemeStart: number, schemeLength: number): { start: number; length: number } | null => {
    const end = schemeStart + schemeLength;
    const p = innermost(
      pairs,
      (q) => q.schemeStart <= schemeStart && end <= q.schemeEnd,
      (q) => q.schemeEnd - q.schemeStart,
    );
    if (p === null) return null;
    if (p.exact) return { start: p.sugarcoatStart + (schemeStart - p.schemeStart), length: schemeLength };
    return { start: p.sugarcoatStart, length: p.sugarcoatEnd - p.sugarcoatStart };
  };

  return { scheme, pairs, toScheme, toSugarcoat };
}
