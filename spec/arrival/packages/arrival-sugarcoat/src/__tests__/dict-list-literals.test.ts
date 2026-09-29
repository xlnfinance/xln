import { describe, expect, it } from "vitest";

import { schemeToSugarcoat, printScheme, parseSexprs, nodeEq } from "../sugarcoat-render.js";
import { readSugarcoatExpr, readSugarcoat } from "../sugarcoat-read.js";

const render = (scheme: string, opts = {}): string => schemeToSugarcoat(scheme, opts).trim();
const read1 = (sugarcoat: string): string => printScheme(readSugarcoatExpr(sugarcoat));
const canon = (scheme: string): string => printScheme(parseSexprs(scheme)[0]);
const roundtrip = (scheme: string, opts = {}): string => printScheme(readSugarcoatExpr(render(scheme, opts)));

describe("dict {} (even kv) vs n-expr {} (odd operand·op·operand)", () => {
  it("empty {} is dict", () => {
    expect(read1("{}")).toBe("(dict)");
    expect(render("(dict)")).toBe("{}");
  });
  it("even pairs read as dict", () => {
    expect(read1("{:a 1 :b 2}")).toBe("(dict :a 1 :b 2)");
    expect(read1('{name: "Ada" age: 36}')).toBe('(dict :name "Ada" :age 36)');
  });
  it("renders dict as braces", () => {
    expect(render("(dict :a 1 :b 2)")).toBe("{:a 1 :b 2}");
  });
  it("n-expr still wins on odd op alternation", () => {
    expect(read1("{a + b}")).toBe("(+ a b)");
    expect(read1("{a and b}")).toBe("(and a b)");
    expect(read1("{a == b or c == d}")).toBe("(or (equal? a b) (equal? c d))");
    expect(render("(+ a b)")).toBe("{a + b}");
  });
  it("single-form curly unwraps (SRFI-105)", () => {
    expect(read1("{x}")).toBe("x");
    expect(read1("{(f x)}")).toBe("(f x)");
  });
  it("nested dict inside n-expr", () => {
    expect(read1("{d == {:a 1}}")).toBe("(equal? d (dict :a 1))");
  });
  it("broken infix is a door, not a silent dict", () => {
    // Neither silently becomes a dict. Odd non-infix / truncated infix land on the
    // close-check or odd/even door (both name the operator vocabulary).
    expect(() => readSugarcoat("{a + b c}")).toThrowError(/infix operator|ambiguous|broken/i);
    expect(() => readSugarcoat("{a b c}")).toThrowError(/infix operator|ambiguous|broken/i);
  });
  it("round-trips dict and mixed forms", () => {
    for (const s of ["(dict)", "(dict :a 1)", "(dict :a 1 :b 2)", "(equal? d (dict :k v))", "(and p (dict :ok #t))"])
      expect(roundtrip(s)).toBe(canon(s));
  });
  // Legacy block form still folds (I-expression kwarg head).
  it("legacy dict block form still reads", () => {
    const got = readSugarcoat("dict\n  a: 1\n  b: 2")[0]!;
    expect(nodeEq(got, parseSexprs("(dict :a 1 :b 2)")[0]!)).toBe(true);
  });
});

describe("list [] free-standing vs tight subscript", () => {
  it("free [] is list", () => {
    expect(read1("[]")).toBe("(list)");
    expect(read1("[1 2 3]")).toBe("(list 1 2 3)");
    expect(read1("[:a :b]")).toBe("(list :a :b)");
  });
  it("renders list as brackets", () => {
    expect(render("(list)")).toBe("[]");
    expect(render("(list 1 2 3)")).toBe("[1 2 3]");
  });
  it("tight subscript still peels", () => {
    expect(read1("xs[0]")).toBe("(car xs)");
    expect(read1("f[:verdict]")).toBe("(:verdict f)");
    expect(render("(car xs)")).toBe("xs[0]");
  });
  it("list as an argument is free, not a subscript", () => {
    expect(read1("(f [1 2])")).toBe("(f (list 1 2))");
    expect(render("(f (list 1 2))")).toBe("(f [1 2])");
  });
  it("list of dicts", () => {
    expect(read1("[{:a 1} {:b 2}]")).toBe("(list (dict :a 1) (dict :b 2))");
    expect(render("(list (dict :a 1) (dict :b 2))")).toBe("[{:a 1} {:b 2}]");
  });
  it("round-trips", () => {
    for (const s of ["(list)", "(list 1 2 3)", "(list (dict :a 1))", "(map f (list 1 2))"])
      expect(roundtrip(s)).toBe(canon(s));
  });
});
