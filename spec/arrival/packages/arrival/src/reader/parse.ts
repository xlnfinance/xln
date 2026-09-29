// Reader entry — collects the Parser's datum stream. Self-contained leaf: the reader is
// env-free and evaluator-free, so exec imports it statically with no exec<->reader cycle.
import { Parser } from "./Parser.js";
import { eof } from "../values/primitives/EOF.js";
import type { AString } from "../values/primitives/AString.js";
import type { SchemeValue } from "../values/types.js";

// Reader input: raw source text (`string`/`AString`, `Parser.parse`'s input type) or a
// pre-seeded `Parser`. `arg instanceof Parser` reuses it; everything else is fed to a
// fresh one via `Parser.parse(arg)`.
type ParseInput = string | AString | Parser;

export const parse = async (arg: ParseInput, source?: string, strict = false): Promise<SchemeValue[]> => {
  let parser;
  if (arg instanceof Parser) {
    parser = arg;
  } else {
    parser = new Parser({ source, strict });
    parser.parse(arg);
  }
  const result: SchemeValue[] = [];
  let prev;
  while (true) {
    const expr = await parser.read_object();
    if (!parser.balanced()) {
      parser.ballancing_error(expr, prev);
    }
    if (expr === eof) {
      break;
    }
    prev = expr;
    result.push(expr);
  }
  return result;
};
