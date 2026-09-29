// Not-callable doors (eval/evaluator.ts) — the two "operator position holds a
// non-callable value" sites, reworked per the MCP-Atlas error-corpus autopsy.
//
// Site 1 (a LITERAL directly in call-head position, e.g. `("tool/name" :x 1)` or
// `(42 :x 1)`): the raw invariant text (`Cannot apply object: <toString>`) echoed
// the string's own content back, reading exactly like a failed TOOL CALL instead
// of a syntax mistake — the corpus's #1 class. A quoted string now gets a
// dedicated door naming the actual mistake (a quoted name is data, never called);
// every other literal (number/vector/boolean/…) falls through to the shared
// not-callable door.
//
// Site 2 (a COMPUTED head that evaluates to a non-function, e.g. `((f x) y)` or
// Python-habit `print(x)` over-parenthesization — the corpus's #4 class): names
// the actual scheme-visible type instead of a raw `typeof`, and calls out the
// extra-parens common cause.
//
// Both sites are MODEL-REACHABLE (Rule 0: assert internally, validate at the
// boundary), so they now throw a plain `Error` door instead of `invariant()` —
// an `invariant()` failure prefixes "Invariant failed: ", which reads like an
// engine bug rather than a program mistake.
import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec.js";

const doorMessage = async (src: string): Promise<string> => {
  try {
    await exec(src);
  } catch (e) {
    return (e as Error)?.message ?? String(e);
  }
  throw new Error(`expected a not-callable door for: ${src}`);
};

describe("not-callable door — quoted string in call-head position", () => {
  it("names the mistake instead of echoing the string as if the call itself failed", async () => {
    const message = await doorMessage('("open-library/get_book_by_title" :title "Noa Noa")');
    expect(message).toMatch(/"open-library\/get_book_by_title" is a string, not a function/);
    expect(message).toMatch(/a quoted name is data, it is never called/);
    expect(message).toMatch(/Drop the quotes and call the symbol directly: \(open-library\/get_book_by_title …\)/);
  });

  it("fires identically for a string head inside a vector-wrapped call (reader artifact)", async () => {
    const message = await doorMessage('[("open-library/get_book_by_title" :title "Noa Noa")]');
    expect(message).toMatch(/is a string, not a function/);
  });

  it("does not merely re-echo the string in a way that reads as a tool-execution failure", async () => {
    const message = await doorMessage('("foo" 1 2)');
    // Old wording: `Cannot apply object: foo` — indistinguishable from a real tool
    // error. New wording must name the STRING/FUNCTION mismatch explicitly.
    expect(message).not.toMatch(/^Cannot apply/);
    expect(message).toMatch(/is a string, not a function/);
  });
});

describe("not-callable door — non-string literal in call-head position", () => {
  it("a number head names the type and gives the over-paren hint", async () => {
    const message = await doorMessage("(42 :x 1)");
    expect(message).toMatch(/number/);
    expect(message).toMatch(/not (a )?callable|is not a function/i);
    expect(message).toMatch(/extra parentheses/);
  });
});

describe("not-callable door — computed head evaluates to a non-function", () => {
  it("over-parenthesization: ((call)) applies f's RESULT, not f", async () => {
    const message = await doorMessage("(((lambda () 1)))");
    expect(message).toMatch(/extra parentheses/);
    expect(message).toMatch(/\(f x\)/);
  });

  it("names the actual scheme type (dict) rather than a raw 'object'", async () => {
    const message = await doorMessage("(((lambda () (dict :a 1))) :a)");
    expect(message).toMatch(/dict/);
    expect(message).not.toMatch(/Not callable: object$/);
  });

  it("names the actual scheme type (vector) rather than a raw 'object'", async () => {
    const message = await doorMessage("(((lambda () (vector 1 2 3))) 0)");
    expect(message).toMatch(/vector/);
  });
});
