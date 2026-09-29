// The tokenizer: Lexer-driven string → token lifting + datum-comment (#;) stripping.
// Depends only on Lexer + eof + AString — cycle-neutral (Lexer imports neither this module
// nor the eval layer). `tokenize` is the one public entry; `tokens`/`strip_s_comments` are
// its private helpers.
import { Lexer } from "./Lexer.js";
import { eof } from "../values/primitives/EOF.js";
import { AString } from "../values/primitives/AString.js";
import invariant from "tiny-invariant";

// The lexer's per-token metadata record — the SHAPE the lexer's meta mode yields, not a
// Scheme value. (`Lexer.peek(true)` returns these; a token is reader-internal, never an
// AValue.) This is the canonical home for the type and its overload.
export interface TokenMeta {
  token: string;
  col: number;
  offset: number;
  line: number;
}

// `Lexer.peek` has no boolean overload, so `peek(true)`'s inferred return is the broad
// `EOF | TokenMeta | string | null` union even though meta mode always yields a TokenMeta.
// Narrow back to the real shape through a guard rather than a blind cast.
function isTokenMeta(value: unknown): value is TokenMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TokenMeta).token === "string" &&
    typeof (value as TokenMeta).col === "number"
  );
}

function tokens(str: string | AString): TokenMeta[] {
  if (str instanceof AString) {
    str = str.valueOf();
  }
  const lexer = new Lexer(str, { whitespace: true });
  const result: TokenMeta[] = [];
  while (true) {
    const token = lexer.peek(true);
    if (token === eof) {
      break;
    }
    invariant(isTokenMeta(token), "tokenize: lexer meta mode yielded a non-TokenMeta token");
    result.push(token);
    lexer.skip();
  }
  return result;
}

// `meta` is not a runtime flag the type system can branch on, so make it an overload: meta
// mode returns the lexer's `TokenMeta[]` records; default mode returns the cleaned `string[]`
// (whitespace-trimmed, comment-stripped).
export function tokenize(str: string | AString, meta: true): TokenMeta[];
export function tokenize(str: string | AString, meta?: false): string[];
export function tokenize(str: string | AString, meta = false): TokenMeta[] | string[] {
  if (str instanceof AString) {
    str = str.toString();
  }
  if (meta) {
    return tokens(str);
  } else {
    const result = tokens(str)
      .map(function (token) {
        // character literals `#\ ` and `#\newline` are meaningful whitespace — don't trim them
        if (token.token === String.raw`#\ ` || token.token == "#\\\n") {
          return token.token;
        }
        return token.token.trim();
      })
      .filter(function (token) {
        return token && !token.startsWith(";") && !/^#\|[\s\S]*\|#$/.test(token);
      });
    return strip_s_comments(result);
  }
}

function strip_s_comments(tokens: string[]): string[] {
  let s_count = 0;
  let s_start: number | null = null;
  const remove_list: [number, number][] = [];
  for (let i = 0; i < tokens.length; ++i) {
    const token = tokens[i];
    if (token === "#;") {
      if (["(", "["].includes(tokens[i + 1])) {
        s_count = 1;
        s_start = i;
      } else {
        remove_list.push([i, i + 2]);
      }
      i += 1;
      continue;
    }
    if (s_start !== null) {
      if ([")", "]"].includes(token)) {
        s_count--;
      } else if (["(", "["].includes(token)) {
        s_count++;
      }
      if (s_count === 0) {
        remove_list.push([s_start, i + 1]);
        s_start = null;
      }
    }
  }
  tokens = [...tokens];
  remove_list.reverse();
  for (const [begin, end] of remove_list) {
    tokens.splice(begin, end - begin);
  }
  return tokens;
}
