/**
 * Packrat matcher for `@inhuman.tools/arrival/grammar.ebnf`.
 *
 * Interprets the ISO 14977 subset documented in that file's header: named
 * rules, ordered `|`, concatenation `,`, optional `[ ]`, greedy `{ }`, quoted
 * terminals, `?/regex/` sticky specials. `(* *)` comments. The matcher strips
 * `\r` the same way Lexer does, so differential tests share one source face.
 *
 * `{ X }` that matches the empty string is a metalanguage error — it would
 * loop. A `?/regex/` that can match empty is rejected at compile.
 */
export type Expr =
  | { readonly t: "alt"; readonly xs: readonly Expr[] }
  | { readonly t: "seq"; readonly xs: readonly Expr[] }
  | { readonly t: "opt"; readonly x: Expr }
  | { readonly t: "rep"; readonly x: Expr }
  | { readonly t: "name"; readonly name: string }
  | { readonly t: "lit"; readonly s: string }
  | { readonly t: "re"; readonly re: RegExp; readonly source: string };

export type Grammar = {
  readonly start: string;
  readonly rules: ReadonlyMap<string, Expr>;
};

export type MatchResult = {
  readonly ok: boolean;
  readonly pos: number;
};

class EbnfSyntaxError extends Error {
  constructor(message: string, readonly line: number, readonly col: number) {
    super(`${message} at ${line}:${col}`);
    this.name = "EbnfSyntaxError";
  }
}

type Tok =
  | { k: "id"; v: string }
  | { k: "lit"; v: string }
  | { k: "re"; v: string }
  | { k: "sym"; v: string };

function locOf(text: string, i: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let p = 0; p < i; p++) {
    if (text[p] === "\n") {
      line++;
      col = 1;
    } else col++;
  }
  return { line, col };
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  const fail = (msg: string) => {
    const { line, col } = locOf(text, i);
    throw new EbnfSyntaxError(msg, line, col);
  };
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(" && text[i + 1] === "*") {
      const end = text.indexOf("*)", i + 2);
      if (end < 0) fail("unterminated (* comment *)");
      i = end + 2;
      continue;
    }
    if (c === "?" && text[i + 1] === "/") {
      i += 2;
      const start = i;
      while (i < n) {
        if (text[i] === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (text[i] === "/" && text[i + 1] === "?") break;
        i++;
      }
      if (i >= n) fail("unterminated ?/regex/");
      out.push({ k: "re", v: text.slice(start, i) });
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      let v = "";
      while (i < n && text[i] !== q) {
        if (text[i] === q && text[i + 1] === q) {
          v += q;
          i += 2;
          continue;
        }
        v += text[i];
        i++;
      }
      if (i >= n) fail("unterminated terminal");
      i++;
      out.push({ k: "lit", v });
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const start = i;
      i++;
      while (i < n && /[A-Za-z0-9-]/.test(text[i])) i++;
      out.push({ k: "id", v: text.slice(start, i) });
      continue;
    }
    if ("=|,;[]{}()".includes(c)) {
      out.push({ k: "sym", v: c });
      i++;
      continue;
    }
    fail(`unexpected ${JSON.stringify(c)}`);
  }
  return out;
}

function parseRules(text: string): Map<string, Expr> {
  const toks = tokenize(text);
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const loc = () => {
    // Token stream has no source index; metalanguage errors at this layer
    // name the token instead.
    return peek() ? `${peek()!.k}:${"v" in peek()! ? (peek() as { v: string }).v : ""}` : "eof";
  };
  const expect = (k: Tok["k"], v?: string) => {
    const t = peek();
    if (!t || t.k !== k || (v !== undefined && t.v !== v)) {
      throw new EbnfSyntaxError(`expected ${v ?? k}, got ${loc()}`, 0, 0);
    }
    return take();
  };

  function parseExpr(): Expr {
    const xs: Expr[] = [parseTerm()];
    while (peek()?.k === "sym" && peek()?.v === "|") {
      take();
      xs.push(parseTerm());
    }
    return xs.length === 1 ? xs[0]! : { t: "alt", xs };
  }
  function parseTerm(): Expr {
    const xs: Expr[] = [parseFactor()];
    while (peek()?.k === "sym" && peek()?.v === ",") {
      take();
      xs.push(parseFactor());
    }
    return xs.length === 1 ? xs[0]! : { t: "seq", xs };
  }
  function parseFactor(): Expr {
    const t = peek();
    if (!t) throw new EbnfSyntaxError("unexpected eof in factor", 0, 0);
    if (t.k === "sym" && t.v === "[") {
      take();
      const x = parseExpr();
      expect("sym", "]");
      return { t: "opt", x };
    }
    if (t.k === "sym" && t.v === "{") {
      take();
      const x = parseExpr();
      expect("sym", "}");
      return { t: "rep", x };
    }
    if (t.k === "sym" && t.v === "(") {
      take();
      const x = parseExpr();
      expect("sym", ")");
      return x;
    }
    if (t.k === "id") {
      take();
      return { t: "name", name: t.v };
    }
    if (t.k === "lit") {
      take();
      if (t.v.length === 0) throw new EbnfSyntaxError("empty terminal", 0, 0);
      return { t: "lit", s: t.v };
    }
    if (t.k === "re") {
      take();
      let re: RegExp;
      try {
        re = new RegExp(t.v, "uy");
      } catch (e) {
        throw new EbnfSyntaxError(`invalid regex ${JSON.stringify(t.v)}: ${String(e)}`, 0, 0);
      }
      return { t: "re", re, source: t.v };
    }
    throw new EbnfSyntaxError(`unexpected factor ${loc()}`, 0, 0);
  }

  const rules = new Map<string, Expr>();
  while (i < toks.length) {
    const name = expect("id") as { k: "id"; v: string };
    expect("sym", "=");
    const expr = parseExpr();
    expect("sym", ";");
    if (rules.has(name.v)) throw new EbnfSyntaxError(`duplicate rule ${name.v}`, 0, 0);
    rules.set(name.v, expr);
  }
  if (!rules.has("program")) throw new EbnfSyntaxError("missing start rule program", 0, 0);
  for (const [name, expr] of rules) {
    walk(expr, (node) => {
      if (node.t === "name" && !rules.has(node.name)) {
        throw new EbnfSyntaxError(`undefined nonterminal ${node.name} (in ${name})`, 0, 0);
      }
      if (node.t === "re") {
        node.re.lastIndex = 0;
        const probe = node.re.exec("x");
        // Empty-match check: run at end of a dummy. Sticky at 0 on "" .
        node.re.lastIndex = 0;
        const empty = node.re.exec("");
        if (empty && empty[0].length === 0) {
          throw new EbnfSyntaxError(`regex ${JSON.stringify(node.source)} matches empty (in ${name})`, 0, 0);
        }
        void probe;
      }
    });
  }
  return rules;
}

function walk(expr: Expr, visit: (e: Expr) => void): void {
  visit(expr);
  switch (expr.t) {
    case "alt":
    case "seq":
      for (const x of expr.xs) walk(x, visit);
      break;
    case "opt":
    case "rep":
      walk(expr.x, visit);
      break;
    default:
      break;
  }
}

export function parseEbnf(text: string): Grammar {
  return { start: "program", rules: parseRules(text) };
}

export function ruleNames(grammar: Grammar): readonly string[] {
  return [...grammar.rules.keys()];
}

export function referencedNames(grammar: Grammar): ReadonlySet<string> {
  const out = new Set<string>();
  for (const expr of grammar.rules.values()) {
    walk(expr, (node) => {
      if (node.t === "name") out.add(node.name);
    });
  }
  return out;
}

export function matchGrammar(grammar: Grammar, input: string): MatchResult {
  const src = input.replaceAll("\r", "");
  const n = src.length;
  const memo = new Map<string, number | null>();

  function nameAt(name: string, pos: number): number | null {
    const key = `${name}@${pos}`;
    if (memo.has(key)) return memo.get(key)!;
    const expr = grammar.rules.get(name);
    if (!expr) return null;
    memo.set(key, null); // cycle → fail this path
    const got = exprAt(expr, pos);
    memo.set(key, got);
    return got;
  }

  function exprAt(expr: Expr, pos: number): number | null {
    switch (expr.t) {
      case "name":
        return nameAt(expr.name, pos);
      case "lit": {
        if (src.startsWith(expr.s, pos)) return pos + expr.s.length;
        return null;
      }
      case "re": {
        expr.re.lastIndex = pos;
        const m = expr.re.exec(src);
        if (!m || m.index !== pos || m[0].length === 0) return null;
        return pos + m[0].length;
      }
      case "seq": {
        let p = pos;
        for (const x of expr.xs) {
          const npos = exprAt(x, p);
          if (npos === null) return null;
          p = npos;
        }
        return p;
      }
      case "alt": {
        for (const x of expr.xs) {
          const npos = exprAt(x, pos);
          if (npos !== null) return npos;
        }
        return null;
      }
      case "opt": {
        const npos = exprAt(expr.x, pos);
        return npos === null ? pos : npos;
      }
      case "rep": {
        let p = pos;
        for (;;) {
          const npos = exprAt(expr.x, p);
          if (npos === null) return p;
          if (npos === p) {
            throw new Error(`ebnf: empty repeat at ${p} — production matches empty string`);
          }
          p = npos;
        }
      }
      default: {
        const _never: never = expr;
        return _never;
      }
    }
  }

  const end = nameAt(grammar.start, 0);
  if (end === null) return { ok: false, pos: 0 };
  if (end !== n) return { ok: false, pos: end };
  return { ok: true, pos: end };
}

export function accepts(grammar: Grammar, input: string): boolean {
  return matchGrammar(grammar, input).ok;
}
