// name-escape — proves the scheme-name ⇄ TS-identifier lens: the round-trip law, a valid-identifier
// image, and identifier-safe fixed points. The lens is what lets a non-identifier grant symbol live
// as a dotted `_` member (`_.nil$question$`) so `typeof` walks it and the LSP autocompletes.
import { describe, expect, it } from "vitest";

import { escapeName, isTsIdentifier, unescapeName } from "../name-escape.js";

/** The R7RS-flavoured corpus of names a real grant env throws at the lens. */
const CORPUS = [
  "get_route", // already identifier-safe — a fixed point
  "getRoute",
  "get-route",
  "nil?",
  "set!",
  "list->vector",
  "string->number",
  "+",
  "-",
  "*",
  "/",
  "<=",
  ">=",
  "=",
  "1+", // a leading digit
  "1-",
  "char-alphabetic?",
  "call/cc",
  "%internal",
  "make-vector",
  "vector-ref",
  "even?",
  "$weird", // a literal `$` — escaped through `$dollar$`, still round-trips
];

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

describe("name-escape — the bifunctor lens", () => {
  it.each(CORPUS)("ROUND-TRIPS %j: unescapeName(escapeName(x)) === x", (name) => {
    expect(unescapeName(escapeName(name))).toBe(name);
  });

  it.each(CORPUS)("the IMAGE of %j is always a valid TS identifier", (name) => {
    expect(escapeName(name)).toMatch(TS_IDENTIFIER);
  });

  it.each(["get_route", "getRoute", "make_vector", "foo123", "_private"])(
    "%j is identifier-safe — a FIXED POINT (escape = id)",
    (name) => {
      expect(isTsIdentifier(name)).toBe(true);
      expect(escapeName(name)).toBe(name);
    },
  );

  it("encodes the documented named tokens (readable, not opaque)", () => {
    expect(escapeName("nil?")).toBe("nil$question$");
    expect(escapeName("get-route")).toBe("get$dash$route");
    expect(escapeName("+")).toBe("$plus$");
    expect(escapeName("set!")).toBe("set$bang$");
    expect(escapeName("list->vector")).toBe("list$dash$$gt$vector");
  });

  it("guards a LEADING digit (which cannot start an identifier) while keeping mid-name digits literal", () => {
    expect(escapeName("1+")).toBe("$1$$plus$");
    expect(escapeName("1+")).toMatch(TS_IDENTIFIER);
    expect(unescapeName("$1$$plus$")).toBe("1+");
    expect(escapeName("base64-decode")).toBe("base64$dash$decode");
  });

  it("escapes a literal `$` so the sigil never leaks ambiguity", () => {
    expect(escapeName("a$b")).toBe("a$dollar$b");
    expect(unescapeName("a$dollar$b")).toBe("a$b");
  });

  it.each(["for", "class", "new", "return", "if", "let", "do", "case", "var", "delete"])(
    "%j is an ECMAScript RESERVED WORD — never a fixed point; it must route through `_`, not print bare",
    (word) => {
      expect(isTsIdentifier(word)).toBe(false);
      // escapeName still round-trips it (no char needs escaping — the word is unescaped by
      // charFor, matching the round-trip law); the CALLER is what routes it through `_.`.
      expect(unescapeName(escapeName(word))).toBe(word);
    },
  );

  it.each(["any", "string", "number", "unknown", "type", "declare", "of", "as", "get", "set"])(
    "%j is a TS CONTEXTUAL (non-reserved) type-level keyword — stays a fixed point (`const «word» = 1` is valid TS)",
    (word) => {
      expect(isTsIdentifier(word)).toBe(true);
      expect(escapeName(word)).toBe(word);
    },
  );
});
