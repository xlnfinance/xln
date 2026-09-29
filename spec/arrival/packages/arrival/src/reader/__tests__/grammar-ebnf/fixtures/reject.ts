/**
 * Structural rejects — the loose reader fails, and the eBNF must fail too.
 * Door cases (infix, odd dict, bad key) are fixtures/doors.ts, not here:
 * those may over-accept.
 */
export const REJECT: ReadonlyArray<{ readonly name: string; readonly input: string }> = [
  { name: "unterminated-list", input: "(a b" },
  { name: "unterminated-vec", input: "[1 2" },
  { name: "unterminated-dict", input: "{:a 1" },
  { name: "unterminated-vector-hash", input: "#(1 2" },
  { name: "unterminated-string", input: '"hello' },
  { name: "unterminated-bar", input: "|foo" },
  { name: "unterminated-block-comment", input: "#| oops" },
  { name: "unclosed-nested-block-comment", input: "#| outer #| inner |#" },

  { name: "stray-close-paren", input: ")" },
  { name: "stray-close-square", input: "]" },
  { name: "stray-close-curly", input: "}" },
  { name: "mismatch-paren-square", input: "(a]" },
  { name: "mismatch-square-paren", input: "[a)" },
  { name: "mismatch-curly-paren", input: "{:a 1)" },
  { name: "mismatch-paren-curly", input: "(a}" },
  { name: "extra-close", input: "(a b))" },
  { name: "list-then-stray-square", input: "(a) ]" },

  { name: "quote-eof", input: "'" },
  { name: "quasiquote-eof", input: "`" },
  { name: "unquote-eof", input: "," },
  { name: "unquote-splicing-eof", input: ",@" },
  { name: "quote-before-close", input: "(')" },
  { name: "unquote-before-close-list", input: "(,)" },
  { name: "quote-before-square-close", input: "[']" },

  { name: "datum-comment-eof", input: "#;" },
  { name: "datum-comment-then-eof-space", input: "#;   " },
  { name: "attachment-eof", input: "#attachment" },

  { name: "dot-trailing-no-datum", input: "(a .)" },
  { name: "dot-extra-element", input: "(a . b c)" },
  { name: "dot-second-dot", input: "(a . b . c)" },
];
