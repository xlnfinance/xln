import { describe, expect, it } from "vitest";

import { arrivalGrammar, ebnfHref, ebnfSource, GRAMMAR_EXPORT } from "./load.js";
import { referencedNames, ruleNames } from "./match.js";

describe("@inhuman.tools/arrival/grammar.ebnf", () => {
  it("resolves the public package export", () => {
    expect(GRAMMAR_EXPORT).toBe("@inhuman.tools/arrival/grammar.ebnf");
    expect(ebnfHref()).toMatch(/grammar\.ebnf$/);
    expect(ebnfSource().length).toBeGreaterThan(0);
  });

  it("parses as a closed grammar with start program", () => {
    const g = arrivalGrammar();
    expect(g.start).toBe("program");
    expect(g.rules.has("program")).toBe(true);
  });

  it("defines every referenced nonterminal", () => {
    const g = arrivalGrammar();
    const defined = new Set(ruleNames(g));
    for (const name of referencedNames(g)) {
      expect(defined.has(name), `undefined ${name}`).toBe(true);
    }
  });

  it("reaches every defined nonterminal from program", () => {
    const g = arrivalGrammar();
    const seen = new Set<string>(["program"]);
    const stack = ["program"];
    while (stack.length > 0) {
      const name = stack.pop()!;
      const expr = g.rules.get(name);
      if (!expr) continue;
      const walk = (node: typeof expr): void => {
        if (node.t === "name" && !seen.has(node.name)) {
          seen.add(node.name);
          stack.push(node.name);
        }
        if (node.t === "alt" || node.t === "seq") for (const x of node.xs) walk(x);
        if (node.t === "opt" || node.t === "rep") walk(node.x);
      };
      walk(expr);
    }
    const unused = ruleNames(g).filter((n) => !seen.has(n));
    expect(unused, `unreachable ${unused.join(", ")}`).toEqual([]);
  });

  it("uses quoted terminals for Scheme brackets (ISO meta stays meta)", () => {
    const src = ebnfSource();
    expect(src).toMatch(/'\{'/);
    expect(src).toMatch(/'\['/);
    expect(src).toMatch(/'\('/);
  });

  it("does not mention Sugarcoat productions", () => {
    const src = ebnfSource();
    expect(src).not.toMatch(/\bit\b.*anaphor/i);
    expect(src).not.toMatch(/I-expression|method-dot|at-expr/);
  });
});
