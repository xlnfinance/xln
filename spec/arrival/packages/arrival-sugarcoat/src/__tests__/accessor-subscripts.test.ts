import { describe, expect, it } from "vitest";

import { decodeAccessor, encodeAccessor, accessorStepLetters, type PairStep } from "../sugarcoat-render.js";
import { schemeToSugarcoat } from "../sugarcoat-render.js";
import { readSugarcoatExpr, R7RS_ACCESSOR_DEPTH } from "../sugarcoat-read.js";
import { printScheme } from "../sugarcoat-render.js";

const render = (scheme: string): string => schemeToSugarcoat(scheme).trim();
const read = (sugarcoat: string, accessorDepth?: number): string =>
  printScheme(readSugarcoatExpr(sugarcoat, { accessorDepth }));

// The whole `c[ad]+r` family, swept — not just the linear car/cdr/cadr/caddr.
describe("pair-accessor decomposition", () => {
  it("decode∘encode = id over the family", () => {
    for (const w of ["car", "cdr", "cadr", "cddr", "caar", "cdar", "cadar", "caddr", "caadr", "cadadr", "cddddr"]) {
      const steps = decodeAccessor(w);
      expect(steps, w).not.toBeNull();
      expect(encodeAccessor(steps!)).toBe(w);
    }
  });

  it("rejects non-accessor heads", () => {
    for (const w of ["cr", "c", "cxr", "list", "cadr-ish", "ccar", "cara"]) {
      expect(decodeAccessor(w), w).toBeNull();
    }
  });

  it("step letter-cost matches the word length", () => {
    for (const w of ["car", "cadr", "caddr", "cddddr", "caadr", "cadadr"]) {
      const letters = decodeAccessor(w)!.reduce((n, s) => n + accessorStepLetters(s), 0);
      expect(letters, w).toBe(w.length - 2); // strip leading `c` + trailing `r`
    }
  });
});

describe("render: scheme accessor → sugarcoat subscripts", () => {
  const cases: Array<[string, string]> = [
    ["(car x)", "x[0]"],
    ["(cdr x)", "x[1:]"],
    ["(cadr x)", "x[1]"],
    ["(caddr x)", "x[2]"],
    ["(cadddr x)", "x[3]"],
    ["(cddddr x)", "x[4:]"],
    // mixed combos — the new reach beyond the linear family
    ["(caar x)", "x[0][0]"],
    ["(cdar x)", "x[0][1:]"],
    ["(caadr x)", "x[1][0]"],
    ["(cadadr x)", "x[1][1]"],
  ];
  for (const [scheme, sugarcoat] of cases) {
    it(`${scheme} → ${sugarcoat}`, () => expect(render(scheme)).toBe(sugarcoat));
  }
});

describe("read: sugarcoat subscripts → fused accessor (default r7rs mode)", () => {
  const cases: Array<[string, string]> = [
    ["x[0]", "(car x)"],
    ["x[1:]", "(cdr x)"],
    ["x[0][0]", "(caar x)"],
    ["x[1][0]", "(caadr x)"],
    ["x[1][1]", "(cadadr x)"],
    // fusion capped at 4 letters: [0][1][2] = caddadar (7) splits into nested words
    ["x[0][1][2]", "(caddr (cadar x))"],
    // a single inherently-deep subscript is NOT split (splitting breaks round-trip);
    // only ever arises from rendering an already-non-standard stored word.
    ["x[4]", "(caddddr x)"],
    ["x[5]", "(cadddddr x)"],
  ];
  for (const [sugarcoat, scheme] of cases) {
    it(`${sugarcoat} → ${scheme}`, () => expect(read(sugarcoat)).toBe(scheme));
  }

  it("uses the r7rs cap (4) by default", () => {
    expect(R7RS_ACCESSOR_DEPTH).toBe(4);
  });
});

describe("read: unbounded mode fuses any chain into one word", () => {
  const cases: Array<[string, string]> = [
    ["x[0][1][2]", "(caddadar x)"],
    ["x[0][0][0][0][0]", "(caaaaar x)"],
    ["x[1][0]", "(caadr x)"],
  ];
  for (const [sugarcoat, scheme] of cases) {
    it(`${sugarcoat} → ${scheme}`, () => expect(read(sugarcoat, Infinity)).toBe(scheme));
  }
});

// The guarantee we make: not full textual lensing but CYCLIC idempotence — viewing
// a sugarcoat form, folding to scheme, and re-rendering returns the SAME sugarcoat text.
describe("cyclic idempotence: sugarcoat → scheme → sugarcoat", () => {
  for (const mode of [
    { name: "default", depth: undefined },
    { name: "unbounded", depth: Infinity },
  ] as const) {
    for (const sugarcoat of ["x[0]", "x[1:]", "x[0][0]", "x[1][0]", "x[1][1]", "x[0][1][2]", "x[4:]", "x[2][3:]"]) {
      it(`${sugarcoat} (${mode.name})`, () => {
        const scheme = read(sugarcoat, mode.depth);
        expect(render(scheme)).toBe(sugarcoat);
      });
    }
  }
});

// And the inverse class: a stored scheme accessor word normalizes to its readable
// representative and stays put under scheme → sugarcoat → scheme (equal?-class collapse).
describe("idempotence: scheme accessor → sugarcoat → scheme", () => {
  for (const word of ["car", "cdr", "cadr", "caddr", "caar", "cdar", "caadr", "cadadr"]) {
    it(`(${word} x)`, () => {
      const sugarcoat = render(`(${word} x)`);
      // default mode re-fuses to a single word for any word ≤ 4 letters
      expect(read(sugarcoat)).toBe(`(${word} x)`);
    });
  }
});

// `(car (car x))` collapsing to `caar` is honest, not a round-trip break: nested
// accessor CALLS are an equal?-equivalent spelling of the fused word.
describe("nested accessor calls fuse on the sugarcoat side", () => {
  it("(car (car x)) renders as x[0][0]", () => {
    expect(render("(car (car x))")).toBe("x[0][0]");
  });
  it("which reads back to the fused caar", () => {
    expect(read("x[0][0]")).toBe("(caar x)");
  });
});

// Defensive: the subscript reader rejects nonsense numeric indices.
describe("subscript validation", () => {
  it("rejects [0:] (drop 0 is not an accessor)", () => {
    expect(() => read("x[0:]")).toThrow();
  });
});

// The SAME bracket surface carries access-by-key: a `:keyword` index is the
// recommended STATIC form `(:k obj)`; any other identifier/string is the DYNAMIC
// form `(@ obj key)`. Integer vs keyword vs identifier is the only discriminator —
// the index's shape alone, so pair-access and key-access never collide.
describe("key access reuses the subscript surface", () => {
  describe("render: scheme → sugarcoat", () => {
    const cases: Array<[string, string]> = [
      ["(:verdict f)", "f[:verdict]"], // static keyword-as-fn
      ["(@ f key)", "f[key]"], // dynamic, variable key
      ['(@ f "name")', 'f["name"]'], // dynamic, string key
      ["(car (:verdict f))", "f[:verdict][0]"], // key then pair
      ["(:verdict (car f))", "f[0][:verdict]"], // pair then key
      ["(:b (:a f))", "f[:a][:b]"], // key then key
    ];
    for (const [scheme, sugarcoat] of cases) {
      it(`${scheme} → ${sugarcoat}`, () => expect(render(scheme)).toBe(sugarcoat));
    }
  });

  describe("read: sugarcoat → scheme", () => {
    const cases: Array<[string, string]> = [
      ["f[:verdict]", "(:verdict f)"],
      ["f[key]", "(@ f key)"],
      ['f["name"]', '(@ f "name")'],
      ["f[:verdict][0]", "(car (:verdict f))"], // key breaks the pair run
      ["f[0][:verdict]", "(:verdict (car f))"],
      ["f[:a][:b]", "(:b (:a f))"],
      // a key interrupts c[ad]+r fusion — the pairs on each side fuse independently
      ["f[0][1][:k][1][0]", "(caadr (:k (cadar f)))"],
      // and the depth cap still applies AFTER a key: [2][3] is 7 letters > 4, so it splits
      ["f[:k][2][3]", "(cadddr (caddr (:k f)))"],
    ];
    for (const [sugarcoat, scheme] of cases) {
      it(`${sugarcoat} → ${scheme}`, () => expect(read(sugarcoat)).toBe(scheme));
    }
  });

  // Cyclic idempotence holds across the mixed pair/key surface too.
  describe("cyclic idempotence: sugarcoat → scheme → sugarcoat", () => {
    for (const sugarcoat of ["f[:verdict]", "f[key]", 'f["name"]', "f[:verdict][0]", "f[0][:verdict]", "f[:a][:b]"]) {
      it(sugarcoat, () => expect(render(read(sugarcoat))).toBe(sugarcoat));
    }
  });
});

// Type sanity: PairStep is the shared currency between the three faces.
const _step: PairStep = { pull: 0 };
void _step;
