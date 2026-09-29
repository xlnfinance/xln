/**
 * Incremental, table-driven FSM tokenizer. The Parser drives it through `peek()`/`skip()` (one token
 * of lookahead, never the whole string), so a streaming or partial parse never re-lexes from the top.
 *
 * Rule ORDERING is the disambiguation strategy: rules concatenate `_rules` → `_brackets` →
 * specials → `_symbol_rules`, symbols last — a delimiter like `(`/`{` is claimed as a bracket
 * before the symbol rules could absorb it (adding a new bracket delimiter is a one-line
 * widening of the bracket char-class).
 */
import invariant from "tiny-invariant";
import { eof } from "../values/primitives/EOF.js";
import { ParseError, Unterminated } from "../errors.js";
import { directives, hash_literals, parsable_contants } from "./lexical-grammar.js";
import * as specials from "./specials.js";
import { LexerState } from "../well-known/symbols.js";

/**
 * FSM transition row: `[char_re, prev_re, next_re, from_state, to_state]`. A row fires when the
 * current char matches `char_re`, the neighbours match `prev_re`/`next_re` (null = any), AND the
 * machine is in `from_state` (null = stateless). `to_state` null means the token is COMPLETE at this
 * char — that null-terminator contract is what `next_token` and `literal_rule` both rely on.
 */
type LexerRule = [RegExp | string, RegExp | string | null, RegExp | string | null, symbol | null, symbol | null];

interface LexerInternals {
  _i: number;
  _whitespace: boolean;
  _col: number;
  _newline: number;
  _line: number;
  _state: symbol | null;
  _next: number | null;
  _token: string | null;
  _prev_char: string;
}

// null neighbour-constraint = wildcard; a string constraint is an exact char compare, not a regex.
function match_or_null(re: RegExp | string | null, char: string): boolean {
  if (re === null) {
    return true;
  }
  if (typeof re === "string") {
    return char === re;
  }
  return !!char.match(re);
}

export class Lexer {
  // FSM state markers — interned in well-known/symbols.ts so a syntax-extension
  // (or a second Lexer evaluation) can name the same states.
  static readonly string = LexerState.string;
  static readonly string_escape = LexerState.string_escape;
  static readonly symbol = LexerState.symbol;
  static readonly comment = LexerState.comment;
  static readonly character = LexerState.character;
  static readonly bracket = LexerState.bracket;
  static readonly b_symbol = LexerState.b_symbol;
  static readonly b_symbol_ex = LexerState.b_symbol_ex;
  static readonly b_comment = LexerState.b_comment;
  static readonly i_comment = LexerState.i_comment;
  static readonly l_datum = LexerState.l_datum;
  static readonly dot = LexerState.dot;
  // `,` is a token boundary: R7RS §7.1.1 classes it a delimiter (it is unquote syntax),
  // and the collection literals need `1,` to lex as `1` + `,` (JSON-gravity separators,
  // see reader/Parser.ts read_literal_elements). Symbols containing a comma still exist
  // via `|pipe syntax|`, exactly like every other delimiter char.
  static readonly boundary = /^$|[\s()[\]{}',]/;
  static _brackets: LexerRule[] = [[/[()[\]{}]/, null, null, null, null]];
  // Symbol rules MUST concatenate last — a delimiter is claimed as a bracket/special before these
  // greedy `\S` catch-alls can swallow it (the disambiguation strategy, see the file header).
  static _symbol_rules: LexerRule[] = [
    [/\S/, Lexer.boundary, Lexer.boundary, null, null],
    [/\S/, Lexer.boundary, null, null, Lexer.symbol],
    [/\S/, null, Lexer.boundary, null, null],
    [/\S/, null, null, null, Lexer.symbol],
    [/\S/, null, Lexer.boundary, Lexer.symbol, null],
  ];
  // Memoized once: reader/specials.ts is a frozen literal (no runtime syntax extensions),
  // so the assembled list is permanently valid — never needs invalidation.
  static _rulesCache: LexerRule[] | null = null;
  // Class-internal: the source text being lexed. Installed via Object.defineProperty
  // in the constructor. `private` is compile-time only (the defineProperty + runtime
  // shape are unchanged); it just blocks cross-module reads, of which there are none.
  private readonly __input__!: string;

  // Last token's meta, snapshotted on peek() — a parser extension reads it to recover source position.
  __token__?: { token: string; col: number; offset: number; line: number };
  private _i!: number;
  private readonly _whitespace!: boolean;
  private _col!: number;
  private _newline!: number;
  private _line!: number;
  private _state!: symbol | null;
  private _next!: number | null;
  private _token!: string | null;
  private readonly _prev_char!: string;

  constructor(input: string, { whitespace = false } = {}) {
    Object.defineProperty(this, "__input__", {
      value: input.replaceAll("\r", ""),
      configurable: true,
      enumerable: true,
    });
    const internals: LexerInternals = {
      _i: 0,
      _whitespace: whitespace,
      _col: 0,
      _newline: 0,
      _line: 0,
      _state: null,
      _next: null,
      _token: null,
      _prev_char: "",
    };
    for (const name of Object.keys(internals) as (keyof LexerInternals)[]) {
      Object.defineProperty(this, name, {
        configurable: false,
        enumerable: false,
        get() {
          return internals[name];
        },
        set(value: LexerInternals[typeof name]) {
          (internals[name] as LexerInternals[typeof name]) = value;
        },
      });
    }
  }

  static _rules: LexerRule[] = [
    // char_re prev_re next_re from_state to_state
    // string
    [/"/, null, null, Lexer.string, null],
    [/"/, null, null, null, Lexer.string],
    [/"/, null, null, Lexer.string_escape, Lexer.string],
    [/\\/, null, null, Lexer.string, Lexer.string_escape],
    [/./s, /\\/, null, Lexer.string_escape, Lexer.string],

    // #b/#d/#x/#o/#e/#i: lexer doesn't distinguish which, only that it's not a vector literal (#u8(...))
    [/#/, null, /[bdxoei]/i, null, Lexer.symbol],

    // characters
    [/#/, null, /\\/, null, Lexer.character],
    [/\\/, /#/, /\s/, Lexer.character, Lexer.character],
    // Boundary chars (and `"`) as `#\` payload must not terminate at `\`.
    // Else `#\'` lexes as `#\` plus a quote with no datum.
    [/\\/, /#/, /[()[\]{}'",]/, Lexer.character, Lexer.character],
    [/\s/, /\\/, null, Lexer.character, null],
    [/\S/, null, Lexer.boundary, Lexer.character, null],

    // comment
    [/;/, /^$|[^#]/, null, null, Lexer.comment],
    [/\n/, ";", null, Lexer.comment, null],
    [/[\s\S]/, null, /\n/, Lexer.comment, null],
    [/\s/, null, null, Lexer.comment, Lexer.comment],

    // block comment
    [/#/, null, /\|/, null, Lexer.b_comment],
    [/\s/, null, null, Lexer.b_comment, Lexer.b_comment],
    [/#/, /\|/, null, Lexer.b_comment, null],

    // inline comments
    [/#/, null, /;/, null, Lexer.i_comment],
    [/;/, /#/, null, Lexer.i_comment, null],

    // datum label
    [/#/, null, /\d/, null, Lexer.l_datum],
    [/=/, /\d/, null, Lexer.l_datum, null],
    [/#/, /\d/, null, Lexer.l_datum, null],

    // dot directly followed by comma, e.g. `(a .,b)` — dot ends as its own token
    [/\./, Lexer.boundary, /,/, null, null],

    // block symbols
    [/\|/, null, null, null, Lexer.b_symbol],
    [/\s/, null, null, Lexer.b_symbol, Lexer.b_symbol],
    [/\|/, null, Lexer.boundary, Lexer.b_symbol, null],
    [/\|/, null, /\S/, Lexer.b_symbol, Lexer.b_symbol_ex],
    [/\S/, null, Lexer.boundary, Lexer.b_symbol_ex, null],
  ];

  static get rules() {
    if (Lexer._rulesCache !== null) {
      return Lexer._rulesCache;
    }
    const parsable = [...Object.keys(parsable_contants), ...directives, ...hash_literals];
    const tokens = [...specials.names(), ...parsable].toSorted((a, b) => {
      return b.length - a.length || a.localeCompare(b);
    });

    // Syntax-extension tokens sharing the first char after `#` share a symbol; sorting
    // longest-first ensures the longer token's rule is tried before the shorter one's.
    const special_rules = tokens.reduce((acc: LexerRule[], token) => {
      let sym: symbol;
      let after: RegExp | null = null;
      if (token[0] === "#") {
        if (token.length === 1) {
          sym = Symbol.for(token);
        } else {
          if (hash_literals.includes(token)) {
            after = Lexer.boundary;
          }
          sym = Symbol.for(token[1]);
        }
      } else {
        sym = Symbol.for(token);
      }

      return [...acc, ...Lexer.literal_rule(token, sym, null, after)];
    }, []);

    Lexer._rulesCache = [...Lexer._rules, ...Lexer._brackets, ...special_rules, ...Lexer._symbol_rules];
    return Lexer._rulesCache;
  }

  static literal_rule(
    string: string,
    sym: symbol,
    p_re: RegExp | null = null,
    n_re: RegExp | null = null,
  ): LexerRule[] {
    invariant(string.length > 0, "Lexer: invalid literal rule");
    if (string.length === 1) {
      return [[string, p_re, n_re, null, null]];
    }
    const rules: LexerRule[] = [];
    for (let i = 0, len = string.length; i < len; ++i) {
      const char_re = string[i];
      const prev_re = string[i - 1] || p_re;
      const next_re = string[i + 1] || n_re;
      let from_state: symbol | null;
      let to_state: symbol | null;
      if (i === 0) {
        from_state = null;
        to_state = sym;
      } else if (i === len - 1) {
        from_state = sym;
        to_state = null;
      } else {
        from_state = sym;
        to_state = sym;
      }
      rules.push([char_re, prev_re, next_re, from_state, to_state]);
    }
    return rules;
  }

  get(name: keyof LexerInternals): LexerInternals[keyof LexerInternals] {
    return (this as unknown as LexerInternals)[name];
  }

  set<K extends keyof LexerInternals>(name: K, value: LexerInternals[K]): void {
    (this as unknown as LexerInternals)[name] = value;
  }

  token(meta = false) {
    if (meta) {
      let line = this._line;
      if (this._whitespace && this._token === "\n") {
        --line;
      }
      return {
        token: this._token,
        col: this._col,
        offset: this._i,
        line,
      };
    }
    return this._token;
  }

  peek(meta = false) {
    if (this._i >= this.__input__.length) {
      return eof;
    }
    if (this._token) {
      Object.defineProperty(this, "__token__", {
        value: this.token(true),
        configurable: true,
        enumerable: true,
      });
      return this.token(meta);
    }
    const found = this.next_token();
    if (found) {
      this._token = this.__input__.substring(this._i, this._next!);
      // Snapshot unconditionally — every freshly-scanned token becomes the `__token__` a parser
      // extension (or `Parser._getLocation()`) reads back for source position. A conditional
      // snapshot (only when `__token__` is unset) records just the instance's first token, then
      // reports every later form's start from a stale offset inside an earlier form.
      Object.defineProperty(this, "__token__", {
        value: this.token(true),
        configurable: true,
        enumerable: true,
      });
      return this.token(meta);
    }
    return eof;
  }

  skip() {
    if (this._next !== null) {
      this._token = null;
      this._i = this._next;
    }
  }

  match_rule(
    rule: LexerRule,
    { prev_char, char, next_char }: { prev_char: string; char: string; next_char: string },
  ): boolean {
    const [re, prev_re, next_re, state] = rule;
    invariant(rule.length === 5, `Lexer: Invalid rule of length ${rule.length}`);
    switch (true) {
      case typeof re === "string" ? re !== char : !char.match(re):
      case !match_or_null(prev_re, prev_char):
      case !match_or_null(next_re, next_char):
      case state !== this._state:
        return false;
      default:
        return true;
    }
  }

  next_token() {
    if (this._i >= this.__input__.length) {
      return false;
    }
    let start = true;
    loop: for (let i = this._i, len = this.__input__.length; i < len; ++i) {
      const char = this.__input__[i];
      const prev_char = this.__input__[i - 1] || "";
      const next_char = this.__input__[i + 1] || "";
      if (char === "\n") {
        ++this._line;
        const newline = this._newline;
        if (this._state === null) {
          // track newline start for col calc; only outside a token (e.g. not mid-string)
          this._newline = i + 1;
        }
        if (this._whitespace && this._state === null) {
          this._next = i + 1;
          this._col = this._i - newline;
          return true;
        }
      }
      if (start && this._state === null && /\s/.test(char)) {
        if (this._whitespace) {
          if (/\s/.test(next_char)) {
            continue;
          } else {
            this._next = i + 1;
            this._col = this._i - this._newline;
            return true;
          }
        } else {
          this._i = i + 1;
          continue;
        }
      }
      start = false;
      // Nested block comments `#| ... #| ... |# ... |#` (R7RS 2.2 requires nesting).
      // The declarative rule table can't count depth, so handle it here with an
      // explicit counter and return the whole thing as one token.
      if (this._state === null && char === "#" && next_char === "|") {
        let depth = 1;
        let j = i + 2;
        const len2 = this.__input__.length;
        while (j < len2 && depth > 0) {
          const c = this.__input__[j];
          const n = this.__input__[j + 1];
          if (c === "#" && n === "|") {
            depth++;
            j += 2;
          } else if (c === "|" && n === "#") {
            depth--;
            j += 2;
          } else {
            if (c === "\n") {
              ++this._line;
            }
            j++;
          }
        }
        if (depth > 0) {
          // ran off the end without closing — fall through to the unterminated
          // handling below by leaving the lexer in the b_comment state.
          this._state = Lexer.b_comment;
          break loop;
        }
        // `j` now points just past the final `|#`
        this._next = j;
        this._col = this._i - this._newline;
        this._state = null;
        return true;
      }
      for (const rule of Lexer.rules!) {
        if (this.match_rule(rule, { prev_char, char, next_char })) {
          const next_state = rule.at(-1) ?? null;
          this._state = next_state as symbol | null;
          if (this._state === null) {
            this._next = i + 1;
            this._col = this._i - this._newline;
            return true;
          }
          continue loop;
        }
      }
      // No rule matched: fine mid-token (char just accumulates), else a real syntax error.
      if (this._state === null) {
        throw new ParseError(
          `Invalid Syntax at line ${this._line + 1}\n${this.__input__.split("\n")[this._line]}`,
          undefined,
          "E-LEXER-SYNTAX",
        );
      }
      continue;
    }
    // Ignore comment state here: a trailing comment can be the last thing in a file, with no newline after it.
    if (![null, Lexer.comment].includes(this._state)) {
      const line_number = this.__input__.slice(0, Math.max(0, this._newline)).match(/\n/g)?.length ?? 0;
      const line = this.__input__.slice(Math.max(0, this._newline));
      if (this.__input__[this._i] === "#") {
        throw new ParseError(
          `Invalid Syntax at line ${line_number + 1}: invalid token ${this.__input__.slice(Math.max(0, this._i)).replace(/^([^\s()[\]{}]+).*/, "$1")}`,
          undefined,
          "E-LEXER-INVALID-TOKEN",
        );
      }
      throw new Unterminated(`Invalid Syntax at line ${line_number + 1}: Unterminated expression ${line}`);
    }
  }
}
