/**
 * Reader doors — Parser rejects with a teaching code. The eBNF is a sampling
 * CFG, so it MAY accept these (over-accept is allowed). Tests pin Parser
 * rejection and record the eBNF decision; they fail only if Parser starts
 * accepting the string (the door moved).
 */
export const DOORS: ReadonlyArray<{
  readonly name: string;
  readonly input: string;
  readonly code: string;
}> = [
  { name: "dict-odd-arity", input: "{:a}", code: "E-DICT-ODD-ARITY" },
  { name: "dict-odd-arity-trailing-key", input: "{:a 1 :b}", code: "E-DICT-ODD-ARITY" },
  { name: "dict-infix", input: "{a * b}", code: "E-DICT-INFIX-BANNED" },
  { name: "dict-infix-plus", input: "{1 + 2}", code: "E-DICT-INFIX-BANNED" },
  { name: "dict-bad-key-symbol", input: "{a 1}", code: "E-DICT-BAD-KEY" },
  { name: "dict-glued-suffix", input: "{a:1}", code: "E-DICT-BAD-KEY" },
  { name: "dict-dup-key", input: "{:a 1 :a 2}", code: "E-DICT-DUP-KEY" },
  { name: "dict-dup-string-keyword", input: '{:a 1 "a" 2}', code: "E-DICT-DUP-KEY" },
  { name: "unquote-before-close-dict", input: "{:a ,}", code: "E-EXPECTING-DATUM" },
  { name: "vec-dot", input: "[a . b]", code: "E-LITERAL-DOT" },
  { name: "dict-dot", input: "{:a . 1}", code: "E-LITERAL-DOT" },
  { name: "hash-vector-dot", input: "#(a . b)", code: "E-LITERAL-DOT" },
  { name: "bytevector-dot", input: "#u8(1 . 2)", code: "E-LITERAL-DOT" },
];
