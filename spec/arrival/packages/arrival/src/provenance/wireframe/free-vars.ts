/**
 * Binding-aware free variables for wire-locality at emission:
 * `FV(body) ⊆ params ∪ prelude-names`. Not `referencedSymbols` (counts bound
 * locals + quoted data — wrong for hermetic demand).
 *
 * Scope-aware over CLASSIFIED_SPECIAL_FORMS + define/case/quasiquote. Unmodeled
 * heads walk as applications (over-approx FV — never miss a free name).
 * Excluded: keywords, gensyms, quoted/vector data.
 */

// Local duck Pair/Symbol (same per-file convention as prelude/slice).
type DuckPair = { car: unknown; cdr: unknown };
type DuckSymbol = { __name__: string | symbol };
const kindOf = (v: unknown): string | undefined =>
  v !== null && typeof v === "object" ? (v as { kind?: string }).kind : undefined;
const isPair = (v: unknown): v is DuckPair => kindOf(v) === "pair";
const isSymbol = (v: unknown): v is DuckSymbol => kindOf(v) === "symbol";

function nameOf(s: DuckSymbol): string | null {
  return typeof s.__name__ === "string" ? s.__name__ : null;
}

const isKeywordName = (name: string): boolean => name.length > 1 && name.startsWith(":");

function chainOf(n: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = n;
  while (isPair(cur)) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  if (kindOf(cur) !== "nil" && cur !== undefined && cur !== null) out.push(cur);
  return out;
}

function formalNames(formals: unknown): string[] {
  const out: string[] = [];
  if (isSymbol(formals)) {
    const n = nameOf(formals);
    if (n !== null) out.push(n);
    return out;
  }
  let cur: unknown = formals;
  while (isPair(cur)) {
    if (isSymbol(cur.car)) {
      const n = nameOf(cur.car);
      if (n !== null) out.push(n);
    }
    cur = cur.cdr;
  }
  if (isSymbol(cur)) {
    const n = nameOf(cur);
    if (n !== null) out.push(n); // dotted rest formal
  }
  return out;
}

export interface FreeVarsOptions {
  /** Cut subterms are opaque holes — not this body's FV. */
  readonly cuts?: ReadonlyMap<unknown, unknown>;
}

/** Free names in first-encounter order (drives wire param order). */
export function freeVars(form: unknown, opts: FreeVarsOptions = {}): Set<string> {
  const out = new Set<string>();
  const seen = new Set<unknown>();

  const walkBody = (body: unknown, bound: ReadonlySet<string>): void => {
    for (const f of chainOf(body)) walk(f, bound);
  };

  const walk = (n: unknown, bound: ReadonlySet<string>): void => {
    if (opts.cuts?.has(n)) return;
    if (isSymbol(n)) {
      const name = nameOf(n);
      if (name === null || isKeywordName(name)) return;
      if (!bound.has(name)) out.add(name);
      return;
    }
    if (!isPair(n)) return;
    if (seen.has(n)) return;
    seen.add(n);

    const head = n.car;
    if (isSymbol(head)) {
      const form_ = nameOf(head);
      if (form_ !== null && !bound.has(form_)) {
        switch (form_) {
          case "quote":
            return;
          case "quasiquote": {
            const arg = isPair(n.cdr) ? n.cdr.car : undefined;
            walkQuasi(arg, 1, bound);
            return;
          }
          case "lambda": {
            if (!isPair(n.cdr)) return;
            const params = formalNames(n.cdr.car);
            walkBody(n.cdr.cdr, new Set([...bound, ...params]));
            return;
          }
          case "let": {
            if (!isPair(n.cdr)) return;
            if (isSymbol(n.cdr.car)) {
              const loopName = nameOf(n.cdr.car);
              const afterName = n.cdr.cdr;
              if (!isPair(afterName)) return;
              const names: string[] = loopName === null ? [] : [loopName];
              for (const b of chainOf(afterName.car)) {
                if (isPair(b) && isSymbol(b.car)) {
                  const bn = nameOf(b.car);
                  if (bn !== null) names.push(bn);
                  if (isPair(b.cdr)) walk(b.cdr.car, bound);
                }
              }
              walkBody(afterName.cdr, new Set([...bound, ...names]));
              return;
            }
            const names: string[] = [];
            for (const b of chainOf(n.cdr.car)) {
              if (isPair(b) && isSymbol(b.car)) {
                const bn = nameOf(b.car);
                if (bn !== null) names.push(bn);
                if (isPair(b.cdr)) walk(b.cdr.car, bound);
              }
            }
            walkBody(n.cdr.cdr, new Set([...bound, ...names]));
            return;
          }
          case "let*": {
            if (!isPair(n.cdr)) return;
            let cur = new Set(bound);
            for (const b of chainOf(n.cdr.car)) {
              if (isPair(b) && isSymbol(b.car)) {
                if (isPair(b.cdr)) walk(b.cdr.car, cur);
                const bn = nameOf(b.car);
                if (bn !== null) cur = new Set([...cur, bn]);
              }
            }
            walkBody(n.cdr.cdr, cur);
            return;
          }
          case "letrec":
          case "letrec*": {
            if (!isPair(n.cdr)) return;
            const names: string[] = [];
            const inits: unknown[] = [];
            for (const b of chainOf(n.cdr.car)) {
              if (isPair(b) && isSymbol(b.car)) {
                const bn = nameOf(b.car);
                if (bn !== null) names.push(bn);
                if (isPair(b.cdr)) inits.push(b.cdr.car);
              }
            }
            const all = new Set([...bound, ...names]);
            for (const init of inits) walk(init, all);
            walkBody(n.cdr.cdr, all);
            return;
          }
          case "do": {
            if (!isPair(n.cdr)) return;
            const names: string[] = [];
            const laters: unknown[] = [];
            for (const b of chainOf(n.cdr.car)) {
              if (isPair(b) && isSymbol(b.car)) {
                const bn = nameOf(b.car);
                if (bn !== null) names.push(bn);
                const rest = chainOf(b.cdr);
                if (rest.length > 0) walk(rest[0], bound);
                for (const step of rest.slice(1)) laters.push(step);
              }
            }
            const inner = new Set([...bound, ...names]);
            for (const step of laters) walk(step, inner);
            walkBody(n.cdr.cdr, inner);
            return;
          }
          case "define": {
            if (!isPair(n.cdr)) return;
            const target = n.cdr.car;
            if (isPair(target)) {
              const fnName = isSymbol(target.car) ? nameOf(target.car) : null;
              const params = formalNames(target.cdr);
              const inner = new Set([
                ...bound,
                // eslint-disable-next-line unicorn/no-negated-condition -- include the define name only when it is a symbol
                ...(fnName !== null ? [fnName] : []),
                ...params,
              ]);
              walkBody(n.cdr.cdr, inner);
              return;
            }
            if (isSymbol(target)) {
              const dn = nameOf(target);
              const inner = dn === null ? bound : new Set([...bound, dn]);
              walkBody(n.cdr.cdr, inner);
              return;
            }
            break;
          }
          case "try": {
            // Explicit shape so catch/finally markers are not free names.
            // Catch var binds only its handlers.
            if (!isPair(n.cdr)) return;
            walk(n.cdr.car, bound);
            for (const clause of chainOf(n.cdr.cdr)) {
              if (!isPair(clause) || !isSymbol(clause.car)) continue;
              const marker = nameOf(clause.car);
              if (marker === "catch") {
                const rest = clause.cdr;
                if (!isPair(rest)) continue;
                const varSpec = rest.car;
                const varName = isPair(varSpec) && isSymbol(varSpec.car) ? nameOf(varSpec.car) : null;
                const inner = varName === null ? bound : new Set([...bound, varName]);
                walkBody(rest.cdr, inner);
              } else if (marker === "finally") {
                walkBody(clause.cdr, bound);
              }
            }
            return;
          }
          case "cond": {
            for (const clause of chainOf(n.cdr)) {
              if (!isPair(clause)) continue;
              const test = clause.car;
              if (!(isSymbol(test) && nameOf(test) === "else")) walk(test, bound);
              for (const bodyForm of chainOf(clause.cdr)) {
                if (isSymbol(bodyForm) && nameOf(bodyForm) === "=>") continue;
                walk(bodyForm, bound);
              }
            }
            return;
          }
          case "case": {
            const parts = chainOf(n.cdr);
            if (parts.length > 0) walk(parts[0], bound);
            for (const clause of parts.slice(1)) {
              if (!isPair(clause)) continue;
              walkBody(clause.cdr, bound);
            }
            return;
          }
          case "begin":
          case "if":
          case "when":
          case "unless":
          case "and":
          case "or":
          case "set!": {
            for (const el of chainOf(n.cdr)) walk(el, bound);
            return;
          }
          default:
            break;
        }
      }
    }
    for (const el of chainOf(n)) walk(el, bound);
  };

  /** Quasiquote: unquote at depth 1 re-enters expression space (R7RS nesting). */
  const walkQuasi = (n: unknown, depth: number, bound: ReadonlySet<string>): void => {
    if (!isPair(n)) return;
    if (seen.has(n)) return;
    seen.add(n);
    const head = n.car;
    if (isSymbol(head)) {
      const hn = nameOf(head);
      if (hn === "unquote" || hn === "unquote-splicing") {
        const arg = isPair(n.cdr) ? n.cdr.car : undefined;
        if (depth === 1) walk(arg, bound);
        else walkQuasi(arg, depth - 1, bound);
        return;
      }
      if (hn === "quasiquote") {
        const arg = isPair(n.cdr) ? n.cdr.car : undefined;
        walkQuasi(arg, depth + 1, bound);
        return;
      }
    }
    for (const el of chainOf(n)) walkQuasi(el, depth, bound);
  };

  walk(form, new Set<string>());
  return out;
}
