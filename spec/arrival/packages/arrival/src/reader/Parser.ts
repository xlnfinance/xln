/**
 * Lexer token stream → Scheme data — the single text→datum entry point (evaluator,
 * analysis tools, and MCP all read through here).
 *
 * LOCATION CHANNEL: every node this parser mints gets its `SourceLocation` threaded at
 * CONSTRUCTION time (`location` constructor param on every value class — AValue.ts) —
 * never via a downstream mutation. A location is either passed to the constructor of a
 * freshly-minted node, or (re-stamp case: an already-built cell needing a DIFFERENT span)
 * obtained via `.withLocation(loc)`, which mints a new instance rather than writing
 * through the slot. Body sites tagged `// mirror` are re-stamp calls; every leaf/container
 * literal (string/number/char/vector/bytevector/dict) is located — not just APair spines.
 * SYMBOLS stay deliberately excluded (interning identity is load-bearing — see
 * parsing.ts's `parse_symbol`).
 *
 * LITERAL GRAMMAR: `[…]` vector / `{…}` dict inline literals (§LITERALS), their
 * position-scoped comma/colon separators (§COMMA), the suffix-keyword flip (§SUFFIX-FLIP),
 * the curly-infix ban (§INFIX), and the E-DICT-* / E-BRACKET-* / E-LITERAL-* door taxonomy
 * (§ERRORS) are the model of `docs/grammar.md`. Formal productions:
 * `grammar.ebnf` (`@inhuman.tools/arrival/grammar.ebnf`). Bodies here point there
 * rather than restate it; E-DICT-INFIX-BANNED (§INFIX) is detected in `make_dict_literal`.
 *
 * NESTING CAP: `_enterNesting` bounds native-stack descent so pathological input throws
 * `ParseError`, not a host `RangeError` (see `maxNestingDepth`). STRICT PAIRING: a close
 * delimiter must match its opener's expected char (see `_exitNesting`).
 *
 * Reader extensions (the quote family, the `specials` registry) expand at PARSE time.
 */
import { DatumReference } from "./DatumReference.js";
import { foldcase_string } from "./foldcase.js";
import * as specials from "./specials.js";
import {
  is_builtin,
  is_bytevector_literal,
  is_directive,
  is_literal,
  is_special,
  is_symbol_extension,
  is_vector_literal,
} from "./token-guards.js";
import { EOF, eof } from "../values/primitives/EOF.js";
import { ParseError, type SourceLocation, Unterminated } from "../errors.js";
import { Lexer } from "./Lexer.js";
// These deps form an import cycle with the value/eval modules; ES6 live bindings
// resolve it, since they're referenced only inside methods, not at module-eval time.
import { ABytevector } from "../values/primitives/ABytevector.js";
import { AVector } from "../values/primitives/AVector.js";
import { parse_argument } from "./parsing.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { APair, __tieKnot } from "../values/primitives/APair.js";
import { EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { isUnquoteForm, suffixKeyName } from "./dict-grammar.js";
import { ADict, staticDictKey } from "../values/primitives/ADict.js";
import type { AListAlike, SchemeValue } from "../values/types.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import invariant from "tiny-invariant";

// Nesting-depth cap: rejects deep input at PARSE time before it overflows the
// native JS stack. `_read_object`/`read_list` recurse one frame per open delimiter,
// so uncapped input throws a host `RangeError` (uncatchable by sandbox `guard`)
// instead of a Scheme `ParseError`. O(1) check — `_state.parentheses` IS the live
// descent depth. Cap sits below the most fragile consumer's overflow floor (a
// recursive evaluator overflows ~3,500) and far above any real s-expression depth.
const maxNestingDepth = 2000;

export interface TokenMeta {
  token: string;
  col: number;
  offset: number;
  line: number;
}

interface ParserOptions {
  meta?: boolean;
  formatter?: (token: TokenMeta) => TokenMeta;
  /** Source identifier (filename / module path) stamped onto every location this
   *  parser produces — so a throw inside a required module reads as `file:line`. */
  source?: string;
  /** Strict (R7RS-faithful) parse — rejects loose-mode reader tolerances like
   *  `#void`/`#null`. Defaults false (loose), the studio default. */
  strict?: boolean;
}

function defaultFormatter(token: { token: string; col: number; offset: number; line: number }) {
  return token;
}

export class Parser {
  // Re-exported so callers can `instanceof Parser.Unterminated` without importing from ./errors.
  public static readonly Unterminated = Unterminated;

  __lexer__!: Lexer;
  private readonly _formatter!: (token: TokenMeta) => TokenMeta;
  private readonly _meta!: boolean;
  private readonly _source?: string;
  private readonly _strict!: boolean;
  private _refs!: (SchemeValue | Promise<SchemeValue>)[];
  // `parentheses` is the live descent depth (nesting-cap counter); `brackets` is the
  // open-delimiter stack holding each open's EXPECTED close char, so a close must
  // match its opener (strict pairing) — `(` pairs `)`, `{` pairs `}`.
  private readonly _state!: { parentheses: number; brackets: string[]; fold_case: boolean };

  constructor({ meta = false, formatter = defaultFormatter, source, strict = false }: ParserOptions = {}) {
    Object.defineProperty(this, "_formatter", {
      value: formatter,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_source", {
      value: source,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_meta", {
      value: meta,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_strict", {
      value: strict,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_refs", {
      value: [],
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_state", {
      value: {
        parentheses: 0,
        brackets: [],
        fold_case: false,
      },
      configurable: true,
      enumerable: false,
    });
  }

  parse(arg: string | AString) {
    if (arg instanceof AString) {
      arg = arg.toString();
    }
    Object.defineProperty(this, "__lexer__", {
      value: new Lexer(arg),
      configurable: true,
      enumerable: true,
    });
  }

  async peek() {
    let token;
    while (true) {
      token = this.__lexer__.peek(true);
      if (token === eof) {
        return eof;
      }
      if (this.is_comment(token!.token)) {
        this.skip();
        continue;
      }
      if (is_directive(token!.token)) {
        this.skip();
        if (token!.token === "#!fold-case") {
          this._state.fold_case = true;
        } else if (token!.token === "#!no-fold-case") {
          this._state.fold_case = false;
        }
        continue;
      }
      if (token!.token === "#;") {
        this.skip();
        if (this.__lexer__.peek() === eof) throw new Unterminated("syntax error: eof found after comment");
        await this._read_object();
        continue;
      }
      break;
    }
    token = this._formatter(token);
    if (this._state.fold_case) {
      token.token = foldcase_string(token.token);
    }
    if (this._meta) {
      return token;
    }
    return token.token;
  }

  reset() {
    this._refs.length = 0;
    // Each top-level datum starts balanced; clear any descent state a prior throw
    // (e.g. a mismatched bracket) left behind, so stale depth can't leak a false
    // pairing error into the next read.
    this._state.parentheses = 0;
    this._state.brackets.length = 0;
  }

  skip() {
    this.__lexer__.skip();
  }

  _getLocation(): SourceLocation | undefined {
    const meta = this.__lexer__.__token__;
    if (!meta) return undefined;
    return {
      line: meta.line + 1, // 0-indexed → 1-indexed
      col: meta.col,
      offset: meta.offset,
      // Stamped filename for `file:line` frames; undefined for sourceless parses.
      source: this._source,
    };
  }

  async read() {
    const token = await this.peek();
    this.skip();
    return token;
  }

  match_datum_label(token: string) {
    const m = token.match(/^#(\d+)=$/);
    return m?.[1] ?? null;
  }

  match_datum_ref(token: string) {
    const m = token.match(/^#(\d+)#$/);
    return m?.[1] ?? null;
  }

  /**
   * Enter one nesting level. Increments the live descent depth and throws a
   * Scheme-level ParseError if it would exceed the cap — called at every open
   * delimiter (list, vector literal, bytevector literal) BEFORE recursing, so
   * we bail before the native JS stack overflows. See `maxNestingDepth`.
   */
  private _enterNesting(expectedClose: string) {
    this._state.brackets.push(expectedClose);
    if (++this._state.parentheses > maxNestingDepth) {
      throw new ParseError(`input nesting depth exceeded ${maxNestingDepth}`, this._getLocation());
    }
  }

  /**
   * Leave one nesting level on a close delimiter, enforcing STRICT PAIRING: the
   * close must match the char its opener pushed (`(`→`)`, `{`→`}`). A close with
   * an empty stack is unmatched; a close of the wrong type is mismatched. Both
   * throw a ParseError rather than silently rebalancing — the rejected alternative
   * that would accept `(a]` and a stray `)`.
   */
  private _exitNesting(closeToken: string, loc?: SourceLocation) {
    const expected = this._state.brackets.pop();
    if (expected === undefined) {
      throw new ParseError(`unexpected '${closeToken}'`, loc ?? undefined, "E-BRACKET-UNEXPECTED");
    }
    if (closeToken !== expected) {
      throw new ParseError(
        `mismatched bracket: expected '${expected}' but found '${closeToken}'`,
        loc ?? undefined,
        "E-BRACKET-MISMATCH",
      );
    }
    --this._state.parentheses;
  }

  // `[` / `]` are NOT interchangeable list delimiters: s-expressions use `(`…`)` only.
  // `[`…`]` is a VECTOR literal, `{`…`}` a DICT literal (see _read_object). SRFI-105
  // curly-infix n-expressions are BANNED (R6): this reader has no curly-infix mode;
  // `{a * b}`-shaped forms door via make_dict_literal's infix-intent heuristic instead
  // of silently misparsing.
  is_open(token: string) {
    return token === "(";
  }

  is_close(token: string) {
    return token === ")";
  }

  is_curly_open(token: string) {
    return token === "{";
  }

  is_curly_close(token: string) {
    return token === "}";
  }

  async read_list(openLoc?: SourceLocation, { dotted = true }: { dotted?: boolean } = {}): Promise<AListAlike> {
    // ACCUMULATE-THEN-CONSTRUCT (readonly-slot contract): collect the elements (+ each cell's
    // location) left-to-right, then build the spine in ONE right fold — no in-place tail
    // append. The improper dot-tail seeds the fold. An element may be a DatumReference
    // placeholder (`#0#` before its label resolves) — reader-internal, patched by
    // `_resolve_pair` via the knot door before any form leaves the reader; the per-cell cast
    // below is that documented channel.
    //
    // `openLoc` (the `(` branch passes it) is the HEAD cell's location; minting the head's
    // ctx from it directly is the MIRROR CHANNEL agreement (see preamble).
    const items: Array<{ node: unknown; loc: ReturnType<Parser["_getLocation"]> }> = [];
    let tail: unknown = nil;
    let dot = false;
    while (true) {
      const token = await this.peek();
      if (token === eof) {
        break;
      }
      if (typeof token === "string" && this.is_close(token)) {
        this._exitNesting(token, this._getLocation());
        this.skip();
        break;
      }
      // Capture location BEFORE reading the object
      const loc = this._getLocation();
      if (token === "." && items.length > 0) {
        if (!dotted) {
          throw new ParseError("'.' not allowed in a vector", loc ?? undefined, "E-LITERAL-DOT");
        }
        if (dot) throw new ParseError("more than one element after dot", loc ?? undefined, "E-DOT-EXTRA-ELEMENT");
        this.skip();
        tail = await this._read_object();
        if (tail === eof) {
          throw new Unterminated("Expecting expression, eof found");
        }
        dot = true;
      } else {
        if (dot) throw new ParseError("more than one element after dot", loc ?? undefined, "E-DOT-EXTRA-ELEMENT");
        items.push({ node: await this._read_object(), loc });
      }
    }
    let chain: unknown = tail;
    for (let i = items.length - 1; i >= 0; i--) {
      const loc = i === 0 ? (openLoc ?? items[i].loc) : items[i].loc;
      const cell = new APair(items[i].node as SchemeValue, chain as SchemeValue, EMPTY_PROVENANCE, loc);
      chain = cell;
    }
    return chain as AListAlike;
  }

  /**
   * Gather the flat datum sequence between `[`…`]` / `{`…`}`, absorbing the position-
   * scoped comma/colon separators (the JSON-gravity tolerance). The full rule — comma-as-
   * separator vs R7RS unquote, the one lone JSON key `:` at an odd boundary, the tolerated
   * trailing separator — is `docs/grammar.md §COMMA` (why a GLUED `:1` is one keyword token
   * is §SUFFIX-FLIP).
   *
   * Local state: `separatorConsumed` / `colonConsumed` enforce the one-per-boundary budget.
   */
  private async read_literal_elements(closeToken: string, isMap: boolean, what: string): Promise<SchemeValue[]> {
    const elements: SchemeValue[] = [];
    let separatorConsumed = false;
    let colonConsumed = false;
    while (true) {
      const token = await this.peek();
      if (token === eof) {
        throw new Unterminated(`unterminated ${what} '${isMap ? "{" : "["}'`);
      }
      if (typeof token === "string" && token === closeToken) {
        this._exitNesting(closeToken, this._getLocation());
        this.skip();
        break;
      }
      if (token === ",") {
        // Separator position: something precedes, this boundary hasn't consumed one yet,
        // and (maps) the preceding elements form complete pairs. Otherwise it's unquote —
        // fall through to _read_object, which reads the `,`-prefixed form.
        const separatorPosition = elements.length > 0 && !separatorConsumed && (!isMap || elements.length % 2 === 0);
        if (separatorPosition) {
          separatorConsumed = true;
          this.skip();
          continue;
        }
      }
      if (token === ":" && isMap && elements.length % 2 === 1 && !colonConsumed) {
        // The verbatim-JSON key colon (`{"a": 1}`): one lone `:` token at the odd
        // boundary is absorbed. Anywhere else `:` reads as a plain datum.
        colonConsumed = true;
        this.skip();
        continue;
      }
      if (token === ".") {
        throw new ParseError(`'.' not allowed in a ${what}`, this._getLocation(), "E-LITERAL-DOT");
      }
      const node = await this._read_object();
      if (node === eof) {
        throw new Unterminated(`unterminated ${what} '${isMap ? "{" : "["}'`);
      }
      elements.push(node as SchemeValue);
      separatorConsumed = false;
      colonConsumed = false;
    }
    return elements;
  }

  /**
   * Validate + mint the `{…}` dict-literal node. Key admissibility (`:keyword` /
   * `"string"` / trailing-colon `key:` / unquote form), even arity, and duplicate-key
   * rejection follow the E-DICT-* taxonomy in `docs/grammar.md §ERRORS`; the
   * suffix-keyword flip is `suffixKeyName` (dict-grammar.ts). Validation lives here, not
   * in dict-grammar, because the errors need ParseError + source location.
   *
   * The flip REPLACES the original key in the element sequence, so every downstream face
   * (code-position `(dict …)` lowering, quasiquote, the quoted-data ADict face) sees one
   * canonical spelling.
   */
  private make_dict_literal(elements: SchemeValue[], loc: SourceLocation | undefined): SchemeValue {
    // §INFIX (RULINGS.md R6): the curly-infix ban — a `{a * b}`-shaped datum is doored,
    // never silently misparsed. Checked FIRST, before key validation reads the same shape
    // into its less-specific E-DICT-BAD-KEY. The fire condition below (odd length ≥ 3,
    // symbol at index 1, AND a non-key head — index 0 rejected by staticDictKey /
    // suffixKeyName / isUnquoteForm) is what guards the genuine-dict false positive
    // `{:a foo :b}` (odd arity, key-shaped head — not infix); §INFIX has the full
    // "operand operator operand" vs "key value key" argument.
    const head = elements[0];
    const headLooksLikeKey = suffixKeyName(head) !== null || staticDictKey(head) !== null || isUnquoteForm(head);
    if (elements.length % 2 === 1 && elements.length >= 3 && elements[1] instanceof ASymbol && !headLooksLikeKey) {
      const op = String(elements[1]);
      throw new ParseError(
        `\`{…}\` is a dict literal, not an infix expression — this reader has no curly-infix ` +
          `mode (SRFI-105 n-expressions are not supported here). '${op}' in the middle position ` +
          `looks like an infix operator; if you meant (${op} …), write the s-expression directly. ` +
          `A dict literal needs alternating :keyword/value pairs, e.g. {:a 1 :b 2} — see ` +
          `E-DICT-BAD-KEY/E-DICT-ODD-ARITY below for that grammar. Infix/neoteric syntax ` +
          `(where \`{a * b}\` DOES mean (* a b)) lives in arrival-sugarcoat, not core arrival.`,
        loc,
        "E-DICT-INFIX-BANNED",
      );
    }
    // Key validation runs BEFORE the arity check (covers a trailing unpaired key too):
    // a key token is judged the moment it completes, arity only after — so `{a:1}` doors
    // as the BAD KEY it is, not as odd arity (the more specific error wins).
    const seen = new Set<string>();
    for (let i = 0; i < elements.length; i += 2) {
      const suffixKey = suffixKeyName(elements[i]);
      if (suffixKey !== null) {
        // The flip — canonicalize to the keyword twin, keeping the ORIGINAL key token's
        // parse ctx (its exact leaf location), not the dict's `{` location.
        elements[i] = new ASymbol(`:${suffixKey}`);
      }
      const keyDatum = elements[i];
      const key = staticDictKey(keyDatum);
      if (key === null) {
        if (isUnquoteForm(keyDatum)) continue; // quasiquote-substituted key — validated post-substitution
        // Teaching door. The glued JSON form `{a:1}` lexes as ONE symbol token `a:1`
        // (only a space after the colon splits it) — call that shape out explicitly.
        const shown = String(keyDatum);
        const glued = keyDatum instanceof ASymbol && /^[^:\s]+:[^:]/.test(shown);
        throw new ParseError(
          `dict literal key must be a :keyword, a "string", or a name with a trailing colon (name:), ` +
            `got ${shown} — write {:name "Ada"}, {name: "Ada"} or {"name" "Ada"}; ` +
            `for computed keys use (dict …)${
              glued ? ` (${shown} is glued — add a space after the colon: {${shown.replace(":", ": ")}})` : ""
            }`,
          loc,
          "E-DICT-BAD-KEY",
        );
      }
      if (seen.has(key)) {
        throw new ParseError(
          `duplicate dict literal key :${key} — each key may appear once (:${key} and "${key}" are the same key)`,
          loc,
          "E-DICT-DUP-KEY",
        );
      }
      seen.add(key);
    }
    if (elements.length % 2 !== 0) {
      throw new ParseError(
        `dict literal {…} has ${elements.length} element(s) — expected alternating key value pairs, ` +
          `e.g. {:name "Ada" :age 36} (a key is missing its value)`,
        loc,
        "E-DICT-ODD-ARITY",
      );
    }
    return ADict.fromLiteralForms(elements, loc);
  }

  async read_value(loc?: SourceLocation) {
    const token = await this.read();
    invariant(token !== eof, "Parser: Expected token eof found");
    return parse_argument(token, this._strict, loc);
  }

  is_comment(token: string) {
    return token.match(/^;/) || (token.match(/^#\|/) && token.match(/\|#$/));
  }

  // Public entry: reads one datum and resolves any R7RS datum labels (#n=/#n#), marking cycles so a
  // self-referential literal terminates instead of looping during later traversal.
  async read_object(): Promise<SchemeValue | EOF> {
    this.reset();
    const read = await this._read_object();
    // `_read_object` may hand back a reader-internal DatumReference (a `#n#` label);
    // unwrap it to the value it points at. `valueOf()` is `any`, so pin the result
    // to the public datum union here.
    const object: SchemeValue | EOF = read instanceof DatumReference ? read.valueOf() : read;
    if (this._refs.length > 0 && !(object instanceof EOF)) {
      const resolved = await this._resolve_object(object);
      if (resolved instanceof APair) {
        resolved.mark_cycles();
      }
      return resolved;
    }
    return object;
  }

  balanced(): boolean {
    return this._state.parentheses === 0;
  }

  ballancing_error(expr: SchemeValue, prev: SchemeValue): never {
    const count = this._state.parentheses;
    let e: Error & { __code__?: string[] };
    if (count < 0) {
      e = new Error("Parser: unexpected parenthesis");
      e.__code__ = [`${String(prev)})`];
    } else {
      e = new Error("Parser: expected parenthesis but eof found");
      const re = new RegExp(String.raw`\){${count}}$`);
      e.__code__ = [String(expr).replace(re, "")];
    }
    throw e;
  }

  // Resolves nested reader-internal DatumReference placeholders inside a freshly parsed
  // datum. APair is the only structure the reader emits that can carry a nested ref, so
  // it's the sole recursive case; every other SchemeValue is a leaf and passes through
  // (a top-level ref is already unwrapped by read_object before this runs).
  async _resolve_object(object: SchemeValue): Promise<SchemeValue> {
    if (object instanceof APair) {
      return this._resolve_pair(object);
    }
    return object;
  }

  async _resolve_pair(pair: AListAlike): Promise<AListAlike> {
    // Datum-label resolution IS the knot-tying case: `#0=(1 #0#)` closes a cycle no
    // construction order can express, so the placeholder patch goes through the door
    // (one of its three named consumers). Patch-not-recurse on the resolved branch keeps
    // the walk cycle-safe (the resolved value may BE an ancestor of this walk).
    if (pair instanceof APair) {
      if (pair.car instanceof DatumReference) {
        __tieKnot(pair, "car", (await pair.car.valueOf()) as SchemeValue);
      } else if (pair.car instanceof APair) {
        await this._resolve_pair(pair.car);
      }
      if (pair.cdr instanceof DatumReference) {
        __tieKnot(pair, "cdr", (await pair.cdr.valueOf()) as SchemeValue);
      } else if (pair.cdr instanceof APair) {
        await this._resolve_pair(pair.cdr);
      }
    }
    return pair;
  }

  // Internal read of one datum. Broader than the public `read_object` return: this may
  // hand back a reader-internal `DatumReference` (a `#n#` label placeholder) which
  // `read_object` resolves away before exposing the value — so DatumReference is part of
  // this signature but deliberately excluded from the public SchemeValue union.
  async _read_object(): Promise<SchemeValue | EOF | DatumReference> {
    const token = await this.peek();
    if (token === eof) {
      return token;
    }
    const loc = this._getLocation();
    if (is_special(token)) {
      if (is_vector_literal(token)) {
        this.skip();
        this._enterNesting(")");
        const list = await this.read_list(undefined, { dotted: false });
        // R7RS literals are immutable — AVector itself has no mutation surface
        // (vector-set!/fill! are notImplemented stubs), so no freeze is needed. Shallow
        // cdr-walk collects elements as the honest `SchemeValue[]` the vector holds —
        // `APair.to_array` returns the deliberately-`unknown[]` cons payload, which
        // `AVector` can't accept.
        const items: SchemeValue[] = [];
        for (let node: unknown = list; node instanceof APair; node = node.cdr) {
          items.push(node.car);
        }
        return new AVector(items, EMPTY_PROVENANCE, loc);
      }
      if (is_bytevector_literal(token)) {
        this.skip();
        this._enterNesting(")");
        const list = await this.read_list(undefined, { dotted: false });
        // Immutable, same rationale as the vector literal case above.
        if (list instanceof ANil) {
          return new ABytevector(new Uint8Array(0), EMPTY_PROVENANCE, loc);
        }
        const arr = list.to_array(false) as number[];
        return new ABytevector(
          new Uint8Array(arr.map((v) => (typeof v === "number" ? v : Number(v)))),
          EMPTY_PROVENANCE,
          loc,
        );
      }
      // Only builtin prefixes expand here; no parse-time user macros.
      const special = specials.get(token);
      const builtin = is_builtin(token);
      this.skip();
      let expr: any;
      const is_symbol = is_symbol_extension(token);
      // A quote-family prefix dangling against a close delimiter (e.g. the trailing-
      // unquote `{:a ,}`, or `')`) is a MISSING DATUM — door it here, BEFORE the datum
      // read, or the stray-close machinery throws its less-teaching error first. Any
      // close counts, not just `)` (the literals brought `]`/`}` into datum position).
      const peeked = await this.peek();
      const was_close = typeof peeked === "string" && [")", "]", "}"].includes(peeked);
      if (was_close && is_literal(token)) {
        throw new ParseError(`Parse Error: expecting datum after '${token}'`, loc ?? undefined, "E-EXPECTING-DATUM");
      }
      const object = is_symbol ? undefined : await this._read_object();
      if (object === eof) {
        throw new Unterminated("Expecting expression, eof found");
      }
      // Every registered special is BUILTIN reader syntax (quote/quasiquote/unquote, #(...),
      // #u8(...), #attachment) expanding into a list the interpreter evaluates later — no
      // user-registered reader macros exist (that would require evaluating at parse time).
      invariant(builtin, () => `Parse Error: non-builtin reader extension ${special.symbol} is unsupported`);
      // `object` may still be a DatumReference placeholder here — the reader-internal
      // channel `_resolve_pair` patches before the form leaves the reader.
      if (is_literal(token)) {
        // INNER cell (`(object . ())`, the quoted argument's own spine) carries `loc`
        // too — quote-family prefix location threaded at construction on BOTH cells
        // (see AValue.ts location channel).
        const inner = new APair(object as SchemeValue, nil, EMPTY_PROVENANCE, loc);
        expr = new APair(special.symbol, inner, EMPTY_PROVENANCE, loc);
      } else {
        expr = new APair(special.symbol, object as SchemeValue, EMPTY_PROVENANCE, loc);
      }
      return expr;
    }
    const ref = this.match_datum_ref(token);
    if (ref !== null) {
      this.skip();
      invariant((+ref) in this._refs, `Parse Error: invalid datum label #${ref}#`);
      return new DatumReference(ref, this._refs[+ref] as SchemeValue);
    }
    const ref_label = this.match_datum_label(token);
    if (ref_label !== null) {
      this.skip();
      this._refs[+ref_label] = this._read_object() as SchemeValue | Promise<SchemeValue>;
      return this._refs[+ref_label] as SchemeValue | Promise<SchemeValue>;
    } else if (token === "[") {
      // `[…]` VECTOR literal (Clojure/JSON array shape). The node is an immutable AVector
      // (a parsed literal is shared AST — quote hands it out as immutable data, like
      // `#(…)`) carrying `evalElements`: in code position the evaluator evaluates the
      // elements (lowering to `(vector …)` — see evaluator.ts), unlike the R7RS
      // constant `#(…)`. NOT an interchangeable list delimiter: `(a b]` stays an error.
      this._enterNesting("]");
      this.skip();
      const elements = await this.read_literal_elements("]", false, "vector literal");
      const vec = new AVector(elements, EMPTY_PROVENANCE, loc);
      vec.evalElements = true;
      return vec;
    } else if (token === "]") {
      // A stray/mismatched `]` (read_literal_elements consumes its own close). Always
      // throws — same contract as the `}` / `)` stray-close branches below.
      this._exitNesting(token, loc ?? undefined);
    } else if (this.is_curly_open(token)) {
      this._enterNesting("}");
      this.skip();
      // `{…}` DICT literal — the ONLY `{}` grammar (R6: no curly-infix mode, no flag reads
      // `{}` any other way): `{:k v …}` ≡ `(dict :k v …)` in code position, data under
      // quote. See read_literal_elements (comma rule) / make_dict_literal (key doors,
      // including the infix-intent ban).
      const elements = await this.read_literal_elements("}", true, "dict literal");
      return this.make_dict_literal(elements, loc ?? undefined);
    } else if (this.is_curly_close(token)) {
      // Stray/mismatched `}` (read_literal_elements consumes its own close) — e.g. a `}`
      // inside a `(` list. _exitNesting always throws here; the post-chain throw below
      // makes the non-return explicit for the type checker.
      this._exitNesting(token, loc ?? undefined);
    } else if (this.is_close(token)) {
      // Stray/mismatched `)` — e.g. a `)` inside `{…}`, or a top-level close with
      // nothing open. Strict pairing rejects it; _exitNesting throws here too.
      this._exitNesting(token, loc ?? undefined);
    } else if (this.is_open(token)) {
      this._enterNesting(")");
      this.skip();
      let list = await this.read_list(loc);
      if (loc && list instanceof APair) {
        list = list.withLocation(loc); // mirror re-stamp (preamble MIRROR CHANNEL)
      }
      return list;
    } else {
      // Leaf literals (symbol/string/number/char): `loc` — computed above for this very
      // token — finally has somewhere to go. These classes have no location slot; the
      // parse ctx is their FIRST source identity (the ~18-site PARSE-CTX-CANDIDATE set).
      return this.read_value(loc);
    }
    // Unreachable for a well-formed token: every value-producing case above returns and
    // the two stray-close cases throw via _exitNesting. Kept as an explicit terminal so
    // the function is total without widening the return type to include `undefined`.
    throw new ParseError(`unexpected token '${token}'`, loc ?? undefined);
  }
}
