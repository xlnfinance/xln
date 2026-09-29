// F6 — Doors (docs/test-suite-architecture.md F6, P5 errors-as-doors). R6 ruling
// (docs/RULINGS.md): `{:key value}` won the brace grammar; SRFI-105
// curly-infix n-expressions (`{a * b}` → `(+ a b)`) are FORCE-ELIMINATED — the
// reader's curly-infix mode (`ParserOptions.curlyInfix`, `read_curly_elements`,
// `canonicalizeCurly`/`resolveNfx`/`FIXITY` in the now-deleted `reader/curly-infix.ts`)
// is gone entirely, not merely defaulted off. P14 named this the shadow feature: ~40
// invariants enforcing a mode `ExecOptions` could never enable (no production entry
// ever forwarded `curlyInfix`).
//
// This file absorbs the two live concerns the old `curly-infix.test.ts` covered:
//   1. the BAN DOOR — an n-expression-shaped `{…}` must throw a teaching ParseError
//      (`E-DICT-INFIX-BANNED`), never silently misparse as a dict and never resolve
//      infix precedence;
//   2. the DICT-LITERAL GRAMMAR rows that are `{…}`'s only remaining meaning (bad key /
//      odd arity / dup key / suffix-flip / vector literal non-regression).
// Drives `Parser` directly (reader-level; no exec/stdlib), mirroring the deleted file's
// own style — these are read-time ParseErrors, not evaluator PurityErrors, so the F6
// `exec()`-and-catch `door()` helper other doors/*.law.test.ts files use doesn't apply.
import { describe, expect, it } from "vitest";
import { Parser } from "../../reader/Parser.js";
import { EOF } from "../../values/primitives/EOF.js";
import { ADict } from "../../values/primitives/ADict.js";
import type { SchemeValue } from "../../values/types.js";

async function readOne(src: string, options?: ConstructorParameters<typeof Parser>[0]): Promise<SchemeValue> {
  const parser = new Parser(options);
  parser.parse(src);
  const datum = await parser.read_object();
  if (datum instanceof EOF) throw new Error(`expected a datum, got EOF for: ${src}`);
  return datum as SchemeValue;
}

/** A door "fires" iff a ParseError with the given `code` reaches the caller. */
async function bans(src: string): Promise<{ code: string | undefined; message: string }> {
  try {
    await readOne(src);
  } catch (e) {
    return { code: (e as { code?: string })?.code, message: (e as Error)?.message ?? String(e) };
  }
  throw new Error(`expected a ban door for: ${src}`);
}

// [name, source shaped like an SRFI-105 n-expression the old flag-on reader would have
// resolved]. Every row must door with E-DICT-INFIX-BANNED, never with a bare
// E-DICT-BAD-KEY/E-DICT-ODD-ARITY (those belong to genuine dict-shaped mistakes, tested
// separately below) and never resolve to an arithmetic result.
const INFIX_SHAPED_BANS: ReadonlyArray<readonly [name: string, src: string]> = [
  ["binary arithmetic (the R6 canonical example)", "{a * b}"],
  ["binary addition", "{a + b}"],
  ["same-operator n-ary run", "{a + b + c}"],
  ["longer same-operator run", "{a + b + c + d}"],
  ["nested infix-shaped operand", "{a * {b + c}}"],
  ["mixed-operator run (old resolveNfx precedence path)", "{4 + 5 * 6}"],
  ["named arithmetic operator (old FIXITY licensed op)", "{10 modulo 3 + 1}"],
  ["comparison operator (old any-single-operator rule)", "{a < b}"],
  ["boolean operator run", "{a && b && c}"],
  ["arbitrary symbol in operator position (old any-symbol rule)", "{a b c}"],
] as const;

describe("F6 doors — R6 infix-ban (`{a * b}`-shaped forms, table-driven)", () => {
  // Anti-vacuity floor (P16 drift alarm): a count change here means a row was added
  // or removed — update the table, don't just bump the number.
  it("table has the expected row count", () => {
    expect(INFIX_SHAPED_BANS.length).toBe(10);
  });

  it.each(INFIX_SHAPED_BANS)("%s → E-DICT-INFIX-BANNED, not silently resolved", async (_name, src) => {
    const { code, message } = await bans(src);
    expect(code).toBe("E-DICT-INFIX-BANNED");
    // Teaches: this is a dict grammar, points at the real dict-literal shape, and
    // names arrival-sugarcoat as the home of the syntax the user reached for.
    expect(message).toMatch(/dict literal/i);
    expect(message).toMatch(/curly-infix/i);
    expect(message).toMatch(/arrival-sugarcoat/i);
  });

  it("the ban door names the offending operator", async () => {
    const { message } = await bans("{a * b}");
    expect(message).toContain("'*'");
    expect(message).toContain("(* …)");
  });

  it("quoted infix-shaped forms still ban (the ban is a reader-time grammar fact, not a code-position lowering)", async () => {
    const { code } = await bans("'{a * b}");
    expect(code).toBe("E-DICT-INFIX-BANNED");
  });

  it("infix-shaped forms nested inside a normal list still ban", async () => {
    const { code } = await bans("(a {b + c} d)");
    expect(code).toBe("E-DICT-INFIX-BANNED");
  });

  it("the mode is gone, not defaulted off — `new Parser()` with no options at all still bans (no flag anywhere resurrects the old SRFI-105 resolution)", async () => {
    const parser = new Parser();
    parser.parse("{a * b}");
    await expect(parser.read_object()).rejects.toMatchObject({ code: "E-DICT-INFIX-BANNED" });
  });
});

describe("dict-literal grammar — what `{…}` actually parses (R6 survivors)", () => {
  it("a well-formed dict literal parses as a dict node", async () => {
    const datum = await readOne("{:a 1 :b 2}");
    expect(ADict.isDictLiteral(datum)).toBe(true);
  });

  it("bare-symbol key doors as E-DICT-BAD-KEY (2-element shape, not infix-banned — index 1 isn't a symbol)", async () => {
    const { code, message } = await bans("{a 1}");
    expect(code).toBe("E-DICT-BAD-KEY");
    expect(message).toMatch(/:keyword|"string"|trailing colon/);
  });

  it("a valid key with a dangling missing value doors as E-DICT-ODD-ARITY, not infix-banned (the false-positive guard: `foo` at index 1 is a VALUE, not an operator, because `:a` at index 0 IS key-shaped)", async () => {
    const { code } = await bans("{:a foo :b}");
    expect(code).toBe("E-DICT-ODD-ARITY");
  });

  it("duplicate keys door as E-DICT-DUP-KEY", async () => {
    const { code } = await bans("{:a 1 :a 2}");
    expect(code).toBe("E-DICT-DUP-KEY");
  });

  it("suffix-colon keys still flip to the keyword twin", async () => {
    const datum = await readOne("{flight_number: 42}");
    expect(ADict.isDictLiteral(datum)).toBe(true);
  });

  it("string keys with three odd string elements door as E-DICT-ODD-ARITY, not infix-banned (index 1 is a string, not a symbol)", async () => {
    const { code } = await bans('{"a" "b" "c"}');
    expect(code).toBe("E-DICT-ODD-ARITY");
  });

  it("`[…]` is unaffected — still a vector literal", async () => {
    const datum = await readOne("[1 2]");
    // Not a dict node, and not banned; the shape check is scoped to `{}` only.
    expect(ADict.isDictLiteral(datum)).toBe(false);
  });
});
