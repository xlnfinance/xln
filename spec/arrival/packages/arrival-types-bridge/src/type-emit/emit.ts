/**
 * COPY-AS-CHUNK (constitution §4.5 — greenfield package, never shared imports).
 * Source: arrival/packages/mercury/src/types-emit.ts (already carrying
 * Adaptations from the source chunk:
 *   - imports re-homed: parse/desugar/nodes/names/scheme-scope → `../front/`
 *     (`parseSexprs` is `@inhuman.tools/arrival-syntax`, re-exported from `../front/parse`),
 *     stdlib → `./builtins.js` (roster-only reduction).
 *   - Law T: narrowing forms emit native `!`/`&&`/`||`/bare-call; other conditions
 *     coerce with `(expr !== false)` — Scheme truth (only `#f` is false).
 *   - `emitTypes` additionally accepts a pre-parsed forest (`readonly Node[]`).
 *
 * ── original module doc ──────────────────────────────────────────────────────
 *
 * types-emit — the TYPE-FAITHFUL Scheme→TS emitter for the type lens.
 *
 * Distinct from the RUN-faithful idiomatic emitters: this one emits virtual TS
 * that is *type-checked, never run*, against the
 * `@inhuman.tools/arrival-internals-types-prelude` prelude (`PRE`). Every builtin
 * (and host) application lowers to a bare ambient call
 * `encodeSchemeIdent(name)(…)` — e.g. `string$dash$append(…)`,
 * `null$qmark$(…)` — so TS checks it against a global `declare function`.
 * Pair accessors lower to ambient PRE calls (`car(x)`, `cdr(x)`, …) so a
 * wrong-typed arg bites as TS2345 on the arg atom (IDE contract C1). Native
 * index/slice collapse is the run compiler's job, not the type lens. Opaque
 * heads fall back to PRE's `sexpr<F>(…)`.
 *
 * Because we never run the output, binding forms lower to PURE TS BLOCK
 * STATEMENTS, not IIFEs — block-scoping is correct for type-checking and adds no
 * function boundary to distort control-flow analysis (by design; see the
 * type-lens README "Emitter contract").
 *
 * It REUSES the front-end (parse → desugar → scope) and produces a span lens:
 * every emitted construct records the IR span it came from, so a tsc diagnostic
 * at a TS offset lifts back onto the right `.scm` form.
 */
import { desugar } from "../front/desugar.js";
import {
  type Atom,
  head,
  isAtom,
  isBool,
  isKeyword,
  isList,
  isNil,
  isNumber,
  keywordName,
  type ListNode,
  type Node,
} from "../front/nodes.js";
import { parseSexprs } from "../front/parse.js";
import { resolveNames } from "../front/scheme-scope.js";
import { isBuiltin } from "./builtins.js";
import { encodeSchemeIdent } from "./scheme-ident.js";

/** One span-lens entry: a [tsStart, tsLength) range of the emitted TS that came
 *  from a [schemeStart, schemeLength) range of the source `.scm`. */
export interface Mapping {
  tsStart: number;
  tsLength: number;
  schemeStart: number;
  schemeLength: number;
}

export interface EmitTypesResult {
  ts: string;
  mappings: Mapping[];
  /** Indices (in source order) of top-level forms whose emit threw and degraded
   *  to an unmapped `unknown` placeholder — so the LSP/host can surface that a
   *  form is unanalyzed without the whole file blanking. */
  droppedForms: number[];
  /** See `Ctx.declaredNames`. */
  declaredNames: Map<string, string>;
}

/** A TS-identifier name (used unbracketed). Anything else is a bracketed string key. */
const TS_IDENT = /^[A-Z_$][\w$]*$/i;

/** Shared empty member set — the default when no host/narrows roster is injected. */
const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * The emit buffer: appends strings while tracking the running TS offset, and
 * records a {@link Mapping} whenever an emitted run carries an IR span. Spans are
 * `[start, end)` half-open (sugarcoat-render) → `schemeLength = end - start`.
 */
class Buf {
  private readonly parts: string[] = [];
  private len = 0;
  readonly mappings: Mapping[] = [];

  /** Append a literal TS chunk (no span). */
  raw(s: string): this {
    if (s.length > 0) {
      this.parts.push(s);
      this.len += s.length;
    }
    return this;
  }

  /** Append `s`, mapping its whole TS extent back to `node`'s IR span (if any). */
  spanned(s: string, node: Node | undefined): this {
    const span = node && (node as { span?: readonly [number, number] }).span;
    if (s.length > 0 && span) {
      this.mappings.push({
        tsStart: this.len,
        tsLength: s.length,
        schemeStart: span[0],
        schemeLength: span[1] - span[0],
      });
    }
    return this.raw(s);
  }

  get offset(): number {
    return this.len;
  }

  toString(): string {
    return this.parts.join("");
  }
}

/** Scope-resolved JS name for a bound identifier occurrence; `cleanName` for free
 *  refs / globals / builtins (absent from `nameOf`). */
type NameOf = Map<Atom, string>;

/**
 * Scan a forest for every identifier that is the target of a `(set! x …)`, by its
 * RESOLVED name — so its `const` declaration becomes a `let`. Reassignment must
 * type-check without widening every binding to `let`, so we only relax the ones
 * actually mutated.
 */
function collectSetBangNames(forest: readonly Node[], nameOf: NameOf): Set<string> {
  const out = new Set<string>();
  const visit = (n: Node): void => {
    if (!isList(n)) return;
    if (head(n) === "set!") {
      const target = n.list[1];
      // Always encode — must match emitName; do not use nameOf's cleanName ladder.
      if (isAtom(target)) out.add(encodeSchemeIdent(target.atom));
    }
    for (const c of n.list) visit(c);
  };
  for (const f of forest) visit(f);
  return out;
}

/** The per-program emit context (shared by every node walk). */
interface Ctx {
  buf: Buf;
  nameOf: NameOf;
  setVars: Set<string>;
  /**
   * Host-injected ambient members (sift's rosetta tools). A head in this set
   * lowers to a bare `encodeSchemeIdent(name)(…)` call exactly like a builtin —
   * so `typeof <encoded>` resolves against the host's ambient `declare function`
   * and `Parameters<…>` of the call narrows the argument slot. Empty by default.
   */
  hostMembers: ReadonlySet<string>;
  /** The narrowing-form grammar's base-case set — see `EmitTypesOptions.narrowsMembers`.
   *  Threaded exactly like `hostMembers`. */
  narrowsMembers: ReadonlySet<string>;
  /**
   * Heads whose Contract has a **record-shaped** `inputRest` (kwargs channel).
   * Only these collapse trailing `:k v` pairs into a trailing options object.
   * Everything else treats `:keyword` args as positional values (keyword-as-fn →
   * `(x) => x["k"]`). Mirrors runtime `normalizeInputVector`: plain-record rest
   * ⇒ kwargs; ZodType rest ⇒ variadic values.
   */
  kwargsMembers: ReadonlySet<string>;
  /** Require-path suffixes whose `(require "…")` result is a kwargs callable. Host-supplied. */
  kwargsRequireSuffixes: readonly string[];
  /** Emitted TS identifier → the ORIGINAL scheme source text it was minted from,
   *  populated at every `define`/`define/overridable` binding site (`emitDefine`).
   *  With {@link encodeSchemeIdent} the map is lossless/invertible, but we still
   *  record the mint site so completions can show the scheme spelling without a
   *  decode round-trip. */
  declaredNames: Map<string, string>;
  /**
   * Require-as-import: scheme path → TS binding for a virtual module's default
   * export. When set, `(require "path")` emits the binding (not `require("path")`)
   * so span mappings stay exact (no post-hoc string rewrite).
   */
  requireBindings: ReadonlyMap<string, string>;
  /** Demand harvest context (compose domains + lazy multi-arg formal shapes). */
  demandCtx: DemandHarvestCtx;
}

/** Shared state for binder demand harvest over one desugared forest. */
interface DemandHarvestCtx {
  forest: readonly Node[];
  composeDomains: ReadonlyMap<string, DemandShape>;
  fnFormalShapes: Map<string, Map<string, DemandShape>>;
  visiting: Set<string>;
}

/** Emit a single TS expression for `n` into `ctx.buf`. */
function emitExpr(n: Node, ctx: Ctx): void {
  if (isAtom(n)) return emitAtom(n, ctx);
  if (isList(n)) return emitList(n, ctx);
  // Defensive: an unexpected node shape degrades to a transparent `unknown`.
  ctx.buf.raw("(undefined as unknown)");
}

/**
 * Typelevel binding / free-ref name: always {@link encodeSchemeIdent} of the
 * scheme atom. Scope resolution (`nameOf`) is used only for *binding presence*
 * (shadow checks); the lossless encoding already prevents the cleanName
 * collisions that forced the lexical namer (`picked` vs `picked?`).
 */
function emitName(a: Atom, _ctx: Ctx): string {
  return encodeSchemeIdent(a.atom);
}

function emitAtom(a: Atom, ctx: Ctx): void {
  if (a.str) {
    ctx.buf.spanned(JSON.stringify(decodeString(a.atom)), a);
    return;
  }
  if (isBool(a)) {
    ctx.buf.spanned(a.atom === "#t" ? "true" : "false", a);
    return;
  }
  if (isNumber(a)) {
    ctx.buf.spanned(a.atom, a);
    return;
  }
  // Bare `:keyword` in value position = keyword-as-fn (field accessor eta).
  // Kwargs pairs never reach here — `emitArgs` peels them before emitting values.
  if (a.atom.length > 1 && a.atom.startsWith(":")) {
    emitKeywordAsFn(keywordName(a), a, ctx);
    return;
  }
  ctx.buf.spanned(emitName(a, ctx), a);
}

/**
 * Keyword-as-fn / field-accessor eta for HOF first args: `(map :score xs)`.
 *
 * Not a plain `(x) => x["k"]` (under map that becomes `(x: unknown) => any` and
 * bites "'x' is of type 'unknown'"). Not `A extends { k: any }` either — that
 * is *too* strict for HOFs: when the collection is `List<unknown>`, map asks
 * for `(a: unknown) => …`, and a constrained A is not assignable (contravariance).
 *
 * Unconstrained A + conditional return:
 *   `<A,>(x: A): A extends { score: infer S } ? S : unknown => (x as any)["score"]`
 * — accepts unknown from map; when A is a known row, return is A["score"].
 */
function emitKeywordAsFn(key: string, node: Node, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const kJson = JSON.stringify(key);
  // Type-position property: bare ident when legal, else quoted.
  const kType = TS_IDENT.test(key) ? key : kJson;
  ctx.buf.raw(`<A,>(x: A): A extends { ${kType}: infer S } ? S : unknown => (x as any)[${kJson}]`);
  recordSpan(ctx, start, node);
}

// The object-accessor family. A dict is a primitive object, so these all lower to
// NATIVE indexed access `(obj)["k"]…` — the fast TS path (no generic `keyof O`
// re-derivation per read, which made huge-object reads thrash), biting natively on
// a precise object and transparent on an opaque one (exactly the `(:field obj)`
// sugar). Grouped by arg shape (the runtime arg orders, grounded in ramda-functions.ts).
const ACCESSOR_OBJ_FIRST = new Set(["@"]); //                (@ obj :k)      → obj, key
const ACCESSOR_KEY_FIRST = new Set(["prop", "get", "access", "fetch"]); // (prop :k obj) → key, obj
const ACCESSOR_PATH = new Set(["path", "get-in", "navigate", "dig"]); //   (path KEYS obj) → keys, obj

/** A statically-extractable keyword sequence from `'(:a :b)` (quote) or
 *  `(list :a :b)`, else null — a dynamic path falls back to the generic call. */
function staticKeywordSeq(node: Node | undefined): string[] | null {
  if (!node || !isList(node) || isNil(node)) return null;
  const h = node.list[0];
  let items: readonly Node[];
  if (isAtom(h) && h.atom === "quote") {
    const inner = node.list[1];
    if (!inner || !isList(inner)) return null;
    items = inner.list;
  } else if (isAtom(h) && h.atom === "list") {
    items = node.list.slice(1);
  } else {
    return null;
  }
  const keys: string[] = [];
  for (const it of items) {
    if (!isKeyword(it)) return null;
    keys.push(keywordName(it));
  }
  return keys;
}

/** Lower an accessor head to native indexed access; false → caller emits the
 *  generic ambient call (dynamic key/path, or wrong arity). */
function tryEmitAccessor(hName: string, n: ListNode, ctx: Ctx): boolean {
  const a = n.list.slice(1);
  let obj: Node | undefined;
  let keys: string[] | null;
  if (ACCESSOR_OBJ_FIRST.has(hName)) {
    obj = a[0];
    keys = a[1] && isKeyword(a[1]) ? [keywordName(a[1])] : null;
  } else if (ACCESSOR_KEY_FIRST.has(hName)) {
    keys = a[0] && isKeyword(a[0]) ? [keywordName(a[0])] : null;
    obj = a[1];
  } else {
    keys = staticKeywordSeq(a[0]);
    obj = a[1];
  }
  if (keys === null || keys.length === 0 || obj === undefined) return false;
  const start = ctx.buf.offset;
  ctx.buf.raw("(");
  emitExpr(obj, ctx);
  ctx.buf.raw(")");
  for (const k of keys) ctx.buf.raw(`[${JSON.stringify(k)}]`);
  recordSpan(ctx, start, n);
  return true;
}

function emitList(n: ListNode, ctx: Ctx): void {
  if (isNil(n)) {
    ctx.buf.spanned("[]", n);
    return;
  }
  const h = n.list[0]!;

  // `(:field obj)` accessor → `(obj)["field"]`. Direct member access is checked
  // natively by TS against a precise dict (and is `unknown`-transparent on an
  // opaque row), so it bites on the field-access moat without a runtime helper.
  if (isKeyword(h)) {
    const obj = n.list[1];
    const start = ctx.buf.offset;
    ctx.buf.raw("(");
    if (obj) emitExpr(obj, ctx);
    else ctx.buf.raw("undefined as unknown");
    ctx.buf.raw(`)[${JSON.stringify(keywordName(h))}]`);
    recordSpan(ctx, start, n);
    return;
  }

  const hName = isAtom(h) && !h.str ? h.atom : undefined;
  if (hName !== undefined) {
    switch (hName) {
      case "quote":
        return emitQuote(n.list[1], ctx, n);
      case "lambda":
        return emitLambda(n, ctx);
      case "if":
        return emitIf(n, ctx);
      case "let":
      case "let*":
      case "letrec":
      case "letrec*":
        // A let in EXPRESSION position has no statement-block placement; type-
        // faithfully it is its body's value. We emit the body expression directly
        // (the binding forms are checked as a block only at statement position —
        // see emitTopLet). For an expression-position let, fall through to a
        // transparent value so the file never blanks. The common case (let at a
        // body/top position) is handled by emitStmt.
        return emitLetExpr(n, ctx);
      case "begin":
        return emitBeginExpr(n, ctx);
      case "dict":
        return emitDict(n, ctx);
      case "set!":
        return emitSetExpr(n, ctx);
      case "define":
      case "define/overridable":
        // An internal define in expression position is not meaningful here.
        ctx.buf.spanned("(undefined as unknown)", n);
        return;
    }
    // A locally-bound head (a user `(define (concat …))`) SHADOWS builtins, host
    // members, and accessors — standard scope: the user's definition wins over the
    // ambient name. `nameOf.get(h)` is set iff `h` resolves to a binding. Without
    // this, adding a builtin leaf for a common name (`concat`, `prop`, `get`)
    // silently captures a user's same-named function and breaks infer-from-consumers.
    // (Syntactic special forms above are reserved and not shadowed here.)
    const headBound = isAtom(h) && ctx.nameOf.get(h) !== undefined;
    if (!headBound) {
      // The object-accessor family → native indexed access (fast path). Falls
      // through to the generic call below when the key/path is dynamic.
      if (
        (ACCESSOR_OBJ_FIRST.has(hName) || ACCESSOR_KEY_FIRST.has(hName) || ACCESSOR_PATH.has(hName)) &&
        tryEmitAccessor(hName, n, ctx)
      ) {
        return;
      }
      // Builtin / host / c[ad]+r → ambient PRE call. (Accessors are in
      // isBuiltin; native `[0]`/`.slice` is run-compiler territory — type lens
      // needs TS2345 on the arg atom, IDE contract C1.)
      if (isBuiltin(hName) || ctx.hostMembers.has(hName)) return emitBuiltinCall(hName, n, ctx);
    }
  }

  // A non-builtin head: a local binding / free fn → direct call `f(a, b)`; an
  // opaque/computed head (e.g. `((car fns) x)`) → the `sexpr` fallback.
  return emitCall(h, n.list.slice(1), ctx, n);
}

/** Record a mapping covering `[start, buf.offset)` back to `node`'s span. */
function recordSpan(ctx: Ctx, start: number, node: Node): void {
  const span = (node as { span?: readonly [number, number] }).span;
  if (!span) return;
  const tsLength = ctx.buf.offset - start;
  if (tsLength > 0) {
    ctx.buf.mappings.push({ tsStart: start, tsLength, schemeStart: span[0], schemeLength: span[1] - span[0] });
  }
}

function emitBuiltinCall(name: string, n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  // Require-as-import: `(require "path")` → the imported default binding.
  if (name === "require" && n.list.length >= 2) {
    const pathNode = n.list[1];
    if (isAtom(pathNode) && pathNode.str) {
      const binding = ctx.requireBindings.get(pathNode.atom);
      if (binding !== undefined) {
        ctx.buf.raw(binding);
        recordSpan(ctx, start, n);
        return;
      }
    }
  }
  ctx.buf.raw(encodeSchemeIdent(name)).raw("(");
  emitArgs(n.list.slice(1), ctx, headTakesKwargs(name, ctx));
  ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

/** True iff `name` is a known kwargs head (record-shaped inputRest). */
function headTakesKwargs(name: string, ctx: Ctx): boolean {
  return ctx.kwargsMembers.has(name);
}

/** `(require "…<suffix>")` — host-declared kwargs callables (path + :k v rest). */
function isKwargsRequireForm(fn: Node, suffixes: readonly string[]): boolean {
  if (suffixes.length === 0) return false;
  if (!isList(fn) || isNil(fn) || fn.list.length !== 2) return false;
  if (!isAtom(fn.list[0]) || fn.list[0].atom !== "require") return false;
  const pathNode = fn.list[1];
  if (!isAtom(pathNode) || !pathNode.str) return false;
  const path = pathNode.atom;
  return suffixes.some((s) => path.endsWith(s));
}

/**
 * Names bound to a kwargs-require in this forest — local kwargs heads.
 * Merged with opts.kwargsMembers.
 */
function collectRequireKwargHeads(forest: readonly Node[], suffixes: readonly string[]): Set<string> {
  const heads = new Set<string>();
  if (suffixes.length === 0) return heads;
  const visit = (n: Node): void => {
    if (!isList(n) || isNil(n)) return;
    const h = n.list[0];
    if (isAtom(h) && !h.str && (h.atom === "define" || h.atom === "define/overridable")) {
      const nameNode = n.list[1];
      const val = h.atom === "define/overridable" ? n.list[3] : n.list[2];
      if (isAtom(nameNode) && !nameNode.str && val && isKwargsRequireForm(val, suffixes)) {
        heads.add(nameNode.atom);
      }
    }
    for (const c of n.list) visit(c);
  };
  for (const f of forest) visit(f);
  return heads;
}

/** A call whose head is NOT a builtin: a typed local / free fn → direct call;
 *  an opaque computed head → direct call when kwargs-shaped, else `sexpr`. */
function emitCall(fn: Node, args: Node[], ctx: Ctx, form: ListNode): void {
  const start = ctx.buf.offset;
  const kwargs =
    (isAtom(fn) && !fn.str && headTakesKwargs(fn.atom, ctx)) || isKwargsRequireForm(fn, ctx.kwargsRequireSuffixes);
  if (isAtom(fn) && !fn.str) {
    // Named head — direct call; kwargs collapse only when inputRest is a record.
    emitExpr(fn, ctx);
    ctx.buf.raw("(");
    emitArgs(args, ctx, kwargs);
    ctx.buf.raw(")");
  } else if (kwargs) {
    // Computed kwargs head (e.g. `(require "x.ext")` for a host suffix) — same call shape as named:
    // `fn({ key?, … })` after leading-positional→key promotion (see emitArgs).
    emitExpr(fn, ctx);
    ctx.buf.raw("(");
    emitArgs(args, ctx, true);
    ctx.buf.raw(")");
  } else {
    // Opaque non-kwargs head → typed-apply fallback (all args positional).
    ctx.buf.raw("sexpr(");
    emitExpr(fn, ctx);
    if (args.length > 0) {
      ctx.buf.raw(", ");
      emitArgs(args, ctx, false);
    }
    ctx.buf.raw(")");
  }
  recordSpan(ctx, start, form);
}

/**
 * Comma-separated argument expressions.
 *
 * `kwargs === true` (record-shaped `inputRest` on the head): trailing `:k v`
 * pairs collapse into one options object `{ k: v }` after positionals.
 *
 * `kwargs === false`: every arg is positional. A bare `:keyword` becomes
 * keyword-as-fn via {@link emitExpr} → `(x) => x["k"]`.
 */
function emitArgs(args: Node[], ctx: Ctx, kwargs: boolean): void {
  if (!kwargs) {
    for (const [idx, a] of args.entries()) {
      if (idx > 0) ctx.buf.raw(", ");
      emitExpr(a, ctx);
    }
    return;
  }
  const positional: Node[] = [];
  const kwPairs: [string, Node][] = [];
  let i = 0;
  while (i < args.length && !isKeyword(args[i])) positional.push(args[i++]!);
  while (i < args.length) {
    const k = args[i]!;
    if (!isKeyword(k)) {
      // Positional after a keyword is malformed; degrade transparently.
      positional.push(k);
      i += 1;
      continue;
    }
    const v = args[i + 1];
    kwPairs.push([keywordName(k), v ?? { atom: "#f" }]);
    i += 2;
  }
  // Prompt/kwargs call shape: one bag. A single leading positional is the call-site
  // identity (`key`) — demos historically wrote `(prompt cache-key :k v …)`. Promote
  // it into the object so TS sees one arg matching `(vars: { key?: string; … }) => …`,
  // not a free first positional (which 2554'd under a vars-only type). Explicit
  // `:key …` in kwPairs wins (no double-insert).
  const pairs: [string, Node][] = [...kwPairs];
  const hasExplicitKey = pairs.some(([k]) => k === "key");
  if (positional.length === 1 && !hasExplicitKey) {
    pairs.unshift(["key", positional[0]!]);
    positional.length = 0;
  }
  for (const [idx, p] of positional.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitExpr(p, ctx);
  }
  if (pairs.length > 0) {
    if (positional.length > 0) ctx.buf.raw(", ");
    ctx.buf.raw("{ ");
    for (const [idx, [k, v]] of pairs.entries()) {
      if (idx > 0) ctx.buf.raw(", ");
      // Typelevel keys stay scheme-spelled (quoted when needed) — not camelCase.
      ctx.buf.raw(`${tsKey(k)}: `);
      emitExpr(v, ctx);
    }
    ctx.buf.raw(" }");
  }
}

/** A safe object key: bare identifier, or quoted string for anything else. */
function tsKey(k: string): string {
  return TS_IDENT.test(k) ? k : JSON.stringify(k);
}

function emitDict(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const args = n.list.slice(1);
  // `(dict :k v …)` → `{ k: v, … }` — a DIRECT object literal type. A dict is a
  // special primitive (an object), NOT an alist of pairs: it has no car/cdr, so we
  // model it as the object it is, not via a `Dict<Pairs>` mapped remap over an
  // entry-tuple. TS infers the object literal's type directly — the fast path TS
  // optimizes — and reads (`(:k d)` / native index) resolve against it natively.
  // The mapped-remap form was ~1.5× costlier to construct and forced the giant
  // `keyof`/union machinery that made huge-JSON integration thrash. Keys use raw
  // `keywordName` (NOT cleanName) so they match the `(:field obj)` accessor's index
  // key (`obj["field"]`, emitList) — construct-key and read-key MUST agree.
  ctx.buf.raw("{ ");
  let first = true;
  for (let i = 0; i + 1 < args.length; i += 2) {
    const k = args[i]!;
    const key = isKeyword(k) ? keywordName(k) : isAtom(k) ? k.atom : "";
    if (!first) ctx.buf.raw(", ");
    first = false;
    ctx.buf.raw(`${tsKey(key)}: `);
    emitExpr(args[i + 1]!, ctx);
  }
  ctx.buf.raw(first ? "}" : " }");
  recordSpan(ctx, start, n);
}

function emitIf(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const [, c, a, b] = n.list;
  // Law T (truthiness), type side (§5.2/§5.3): the condition slot has its OWN
  // emission path, distinct from value position — see emitCondition. Every `if`,
  // wherever it sits, classifies its own condition independently (a nested
  // `(if (if a b c) x y)` wraps at both levels). The `(`/`" ? "` literals, arm
  // emission, and the outer recordSpan are Phase-0-identical.
  ctx.buf.raw("(");
  if (c) emitCondition(c, ctx);
  else ctx.buf.raw("undefined as unknown");
  ctx.buf.raw(" ? ");
  if (a) emitExpr(a, ctx);
  else ctx.buf.raw("(undefined as unknown)");
  ctx.buf.raw(" : ");
  if (b) emitExpr(b, ctx);
  else ctx.buf.raw("(undefined as unknown)");
  ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

/**
 * Law T's dispatcher — `if`'s condition slot.
 *
 * A narrowing form emits NATIVE so tsc's control-flow narrowing composes
 * (`null?` / `and` / `or` / `not` over predicates). Every other condition is
 * projected as a TS boolean via `expr !== false` — exact Scheme truthiness
 * (only `#f` is false; objects, 0, "", lists are truthy). No ambient
 * `__scmTruth` helper: an inline comparison is the coerce at the boundary
 * without an opaque `(x: unknown) => boolean` that erases type-predicate
 * information when mis-applied.
 *
 * Prior mistaken dual used `=== true` (boolean-only); that broke optional
 * accumulators `(let walk ((click #f)) (cond (click …)))` where click is
 * `#f | {…}`. Runtime walker already uses `!== false` (walk.ts Law T).
 *
 * The coerce records no span of its own: the nested expression already records
 * its spans; a diagnostic on `!== false` falls back to the enclosing `if`.
 */
function emitCondition(c: Node, ctx: Ctx): void {
  if (isNarrowingForm(c, ctx)) {
    emitNarrowingForm(c, ctx);
    return;
  }
  ctx.buf.raw("(");
  emitExpr(c, ctx); // value-position emission, then coerce to TS boolean
  ctx.buf.raw(" !== false)");
}

/**
 * The narrowing-form grammar (constitution §5.3, Law T's exemption made semantic):
 *
 *   NForm ::= App(sym flagged narrows, …) | (not NForm) | (and NForm…) | (or NForm…)
 *
 * ALL-OR-NOTHING: this test runs over the WHOLE condition tree before one byte is
 * emitted (emitCondition dispatches on its verdict) — a single non-flagged operand
 * anywhere fails the whole form, and the entire condition wraps as one
 * `(… !== false)` coerce around value-position lowering. A mixed clause thus loses
 * ALL narrowing rather than composing half-native, half-opaque text.
 *
 * `not`/`and`/`or` are recognized STRUCTURALLY by fixed name — never themselves
 * gated on `narrowsMembers` — only the base case (an arbitrary predicate
 * application) consults the harvested set. The shadow check applies uniformly to
 * `not`/`and`/`or` AND a bare predicate head, mirroring emitList's `headBound`
 * precedent: a user's `(define (not x) …)` shadows the grammar exactly as it
 * shadows ordinary builtin dispatch. `length > 1` excludes zero-arity
 * `(and)`/`(or)` — value forms, not guards; they wrap.
 */
function isNarrowingForm(n: Node, ctx: Ctx): boolean {
  if (!isList(n) || isNil(n)) return false;
  const h = n.list[0];
  if (!isAtom(h) || h.str || ctx.nameOf.get(h) !== undefined) return false; // shadow rule
  if (h.atom === "not") {
    const arg = n.list[1];
    return n.list.length === 2 && arg !== undefined && isNarrowingForm(arg, ctx);
  }
  if (h.atom === "and" || h.atom === "or") {
    return n.list.length > 1 && n.list.slice(1).every((arg) => isNarrowingForm(arg, ctx));
  }
  return ctx.narrowsMembers.has(h.atom);
}

/**
 * Native emission for a grammar-approved condition: `!`/`&&`/`||` composition over
 * bare ambient predicate calls, so tsc narrowing composes exactly as it already
 * does for one bare guard (`(if (not (null? xs)) (car xs) …)`,
 * `(if (and (pair? x) (pair? (cdr x))) …)` — the dominant guard shapes, §5.3).
 *
 * Each level records its OWN span (`recordSpan` here for `not`/`and`/`or`; the
 * leaf via emitBuiltinCall's own recordSpan — no duplicate entry), so the
 * Mapper's tightest-match lifts a diagnostic onto the innermost predicate call,
 * not the whole boolean expression. Every `and`/`or` level self-parenthesizes
 * unconditionally — this text is never human-read, so over-parenthesizing costs
 * nothing and kills precedence risk.
 */
function emitNarrowingForm(n: Node, ctx: Ctx): void {
  // emitCondition gates on isNarrowingForm, so a non-list can't reach here; the
  // re-narrow satisfies the checker and degrades transparently if it ever did.
  if (!isList(n)) return emitExpr(n, ctx);
  const h = n.list[0] as Atom; // guaranteed by isNarrowingForm's own guard
  const start = ctx.buf.offset;
  if (h.atom === "not") {
    ctx.buf.raw("!");
    emitNarrowingForm(n.list[1]!, ctx);
    recordSpan(ctx, start, n);
    return;
  }
  if (h.atom === "and" || h.atom === "or") {
    ctx.buf.raw("(");
    for (const [idx, arg] of n.list.slice(1).entries()) {
      if (idx > 0) ctx.buf.raw(h.atom === "and" ? " && " : " || ");
      emitNarrowingForm(arg, ctx);
    }
    ctx.buf.raw(")");
    recordSpan(ctx, start, n);
    return;
  }
  emitBuiltinCall(h.atom, n, ctx); // records its own span — no duplicate entry
}

/**
 * Unary list→element ops used in compose/pipe pipelines. Forward: List<T>→T;
 * reverse constraint wraps `List<…>`; result path indexes `[number]`.
 * (cdr is List→List — not in this set.)
 */
const PIPELINE_ELEM_OPS = new Set(["last", "first", "car", "second", "third", "cadr", "caddr", "cadddr"]);

/** One step of a pure unary pipeline (compose/pipe desugar, or hand-written). */
type PipelineStep =
  | { kind: "field"; key: string }
  /** `op` is the Scheme head (car/cadr/first/…) — used when joining list demands. */
  | { kind: "elem"; op: string };

/**
 * If `body` is a pure unary chain ending at `param` — only keyword accessors and
 * {@link PIPELINE_ELEM_OPS} — return steps in **application order** (innermost
 * first). Else null (fall back to an untyped arrow).
 *
 * `(compose :state last :versions)` desugars to
 * `(:state (last (:versions it)))` → steps `[{field:versions}, {elem}, {field:state}]`.
 */
function extractUnaryPipeline(body: Node, param: Atom): PipelineStep[] | null {
  // Walk outside-in, then reverse to application order.
  const outerFirst: PipelineStep[] = [];
  let cur: Node = body;
  for (;;) {
    if (isAtom(cur) && !cur.str && cur.atom === param.atom) {
      return outerFirst.length === 0 ? null : [...outerFirst].reverse();
    }
    if (!isList(cur) || cur.list.length !== 2) return null;
    const h = cur.list[0]!;
    const arg = cur.list[1]!;
    if (isKeyword(h)) {
      outerFirst.push({ kind: "field", key: keywordName(h) });
      cur = arg;
      continue;
    }
    if (isAtom(h) && !h.str && PIPELINE_ELEM_OPS.has(h.atom)) {
      outerFirst.push({ kind: "elem", op: h.atom });
      cur = arg;
      continue;
    }
    return null;
  }
}

/** Input constraint + return type path for a pipeline, as TS type text over `A`. */
function pipelineGenericTypes(steps: readonly PipelineStep[]): { constraint: string; result: string } {
  // Reverse through steps: result type any ← field k ← List ← … → input constraint.
  let c = "any";
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.kind === "field") {
      const k = TS_IDENT.test(s.key) ? s.key : JSON.stringify(s.key);
      c = `{ ${k}: ${c} }`;
    } else {
      c = `List<${c}>`;
    }
  }
  let r = "A";
  for (const s of steps) {
    r = s.kind === "field" ? `${r}[${JSON.stringify(s.key)}]` : `${r}[number]`;
  }
  return { constraint: c, result: r };
}

// ── binder demand harvest (nested accessor coherence) ─────────────────────────
// Pure field/elem consumers contribute structural demands on free roots; formals
// are annotated once. Native index/slice emit stays. See nested-accessor-coherence-DRAFT.

/** List-preserving ops: param must be List; element shape unconstrained by the op alone. */
const LIST_PRESERVE_OPS = new Set(["cdr", "cddr", "cdddr", "cddddr", "rest", "tail"]);

type DemandShape =
  | { kind: "any" }
  | { kind: "list"; elem: DemandShape; /** car/cadr/… when from pure chain; omitted when unknown */ slot?: string }
  | { kind: "obj"; fields: Map<string, DemandShape> };

const DEMAND_ANY: DemandShape = { kind: "any" };

/** Pure field+elem chain ending at a free atom (application order steps). */
function tryPureChain(expr: Node): { root: string; steps: PipelineStep[] } | null {
  const outerFirst: PipelineStep[] = [];
  let cur: Node = expr;
  for (;;) {
    if (isAtom(cur) && !cur.str) {
      return outerFirst.length === 0 ? null : { root: cur.atom, steps: [...outerFirst].reverse() };
    }
    if (!isList(cur) || cur.list.length !== 2) return null;
    const h = cur.list[0]!;
    const arg = cur.list[1]!;
    if (isKeyword(h)) {
      outerFirst.push({ kind: "field", key: keywordName(h) });
      cur = arg;
      continue;
    }
    if (isAtom(h) && !h.str && PIPELINE_ELEM_OPS.has(h.atom)) {
      outerFirst.push({ kind: "elem", op: h.atom });
      cur = arg;
      continue;
    }
    return null;
  }
}

function shapeFromSteps(steps: readonly PipelineStep[]): DemandShape {
  let s: DemandShape = DEMAND_ANY;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    s =
      step.kind === "field"
        ? { kind: "obj", fields: new Map([[step.key, s]]) }
        : { kind: "list", elem: s, slot: step.op };
  }
  return s;
}

/** Replace deepest `any` leaf with `leaf` (one-hop init: field chain → bound demand). */
function substituteLeaf(s: DemandShape, leaf: DemandShape): DemandShape {
  if (s.kind === "any") return leaf;
  if (s.kind === "list") {
    return { kind: "list", elem: substituteLeaf(s.elem, leaf), slot: s.slot };
  }
  const fields = new Map<string, DemandShape>();
  for (const [k, v] of s.fields) fields.set(k, substituteLeaf(v, leaf));
  return { kind: "obj", fields };
}

/** True when two object shapes share no field names (zip-pair car vs cadr slots). */
function objFieldsDisjoint(a: DemandShape & { kind: "obj" }, b: DemandShape & { kind: "obj" }): boolean {
  if (a.fields.size === 0 || b.fields.size === 0) return false;
  for (const k of a.fields.keys()) {
    if (b.fields.has(k)) return false;
  }
  return true;
}

/**
 * Join consumer demands. Constructor conflict (list vs object) → null.
 * Nested key conflicts widen that key to `any` (not whole-shape skip).
 *
 * List elements that are disjoint objects (car vs cadr of a zip pair) → List&lt;any&gt;
 * rather than a false super-object. Same-object multi-field joins
 * (`(:tagline click)` ⊔ `(:reaction click)`) still merge keys.
 */
function joinShapes(a: DemandShape, b: DemandShape): DemandShape | null {
  if (a.kind === "any") return b;
  if (b.kind === "any") return a;
  if (a.kind === "list" && b.kind === "list") {
    // car vs cadr (different slots) with disjoint field sets → List<any>, not a
    // super-object. Same slot (two fields via car) still merges object keys.
    if (
      a.slot !== undefined &&
      b.slot !== undefined &&
      a.slot !== b.slot &&
      a.elem.kind === "obj" &&
      b.elem.kind === "obj" &&
      objFieldsDisjoint(a.elem, b.elem)
    ) {
      return { kind: "list", elem: DEMAND_ANY };
    }
    const e = joinShapes(a.elem, b.elem);
    if (e === null) return null;
    const slot = a.slot === b.slot ? a.slot : undefined;
    return { kind: "list", elem: e, slot };
  }
  if (a.kind === "obj" && b.kind === "obj") {
    const fields = new Map(a.fields);
    for (const [k, v] of b.fields) {
      const prev = fields.get(k);
      if (prev === undefined) fields.set(k, v);
      else {
        const m = joinShapes(prev, v);
        fields.set(k, m === null ? DEMAND_ANY : m);
      }
    }
    return { kind: "obj", fields };
  }
  return null; // constructor conflict
}

function mergeDemand(into: Map<string, DemandShape>, name: string, shape: DemandShape): void {
  const prev = into.get(name);
  if (prev === undefined) {
    into.set(name, shape);
    return;
  }
  const j = joinShapes(prev, shape);
  if (j === null)
    into.delete(name); // conflict → no annotation
  else into.set(name, j);
}

function renderShape(s: DemandShape): string {
  if (s.kind === "any") return "any";
  if (s.kind === "list") return `List<${renderShape(s.elem)}>`;
  const parts: string[] = [];
  for (const [k, v] of s.fields) {
    const key = TS_IDENT.test(k) ? k : JSON.stringify(k);
    parts.push(`${key}: ${renderShape(v)}`);
  }
  return `{ ${parts.join("; ")} }`;
}

function isNamedLetForm(n: ListNode): boolean {
  const h = head(n);
  return (h === "let" || h === "let*" || h === "letrec" || h === "letrec*") && isAtom(n.list[1]) && !n.list[1]!.str;
}

function isPlainLetForm(n: ListNode): boolean {
  const h = head(n);
  return (h === "let" || h === "let*" || h === "letrec" || h === "letrec*") && isList(n.list[1]);
}

/**
 * Unary input domains of same-forest pipeline defines (compose/pipe → lambda).
 * Scheme name → demand shape on the single parameter.
 */
function collectComposeDomains(forest: readonly Node[]): Map<string, DemandShape> {
  const out = new Map<string, DemandShape>();
  for (const form of forest) {
    if (!isList(form) || head(form) !== "define") continue;
    const sig = form.list[1];
    const val = form.list[2];
    if (!isAtom(sig) || sig.str || val === undefined) continue;
    if (!isList(val) || head(val) !== "lambda") continue;
    const params = paramAtoms(val.list[1]);
    if (params.length !== 1 || params[0]!.rest) continue;
    const bodyForms = val.list.slice(2);
    if (bodyForms.length !== 1) continue;
    const steps = extractUnaryPipeline(bodyForms[0]!, params[0]!.atom);
    if (steps === null || steps.length === 0) continue;
    out.set(sig.atom, shapeFromSteps(steps));
  }
  return out;
}

function findFunctionDefine(forest: readonly Node[], name: string): { formals: string[]; body: Node[] } | null {
  for (const form of forest) {
    if (!isList(form) || head(form) !== "define") continue;
    const sig = form.list[1];
    if (!isList(sig) || !isAtom(sig.list[0]) || sig.list[0]!.str) continue;
    if (sig.list[0]!.atom !== name) continue;
    const formals = paramAtoms({ list: sig.list.slice(1) })
      .filter((p) => !p.rest)
      .map((p) => p.atom.atom);
    return { formals, body: form.list.slice(2) };
  }
  return null;
}

/**
 * Lazy formal-shape analysis for a multi-arg function define.
 * e.g. frontier-of's `history` gets List<{ tagline; reactions }> from its map lambda.
 */
function formalShapesOf(fnName: string, dctx: DemandHarvestCtx): Map<string, DemandShape> {
  const cached = dctx.fnFormalShapes.get(fnName);
  if (cached !== undefined) return cached;
  if (dctx.visiting.has(fnName)) return new Map();
  dctx.visiting.add(fnName);
  const def = findFunctionDefine(dctx.forest, fnName);
  const result = new Map<string, DemandShape>();
  if (def !== null) {
    const into = new Map<string, DemandShape>();
    for (const f of def.body) collectDemandsInNode(f, into, dctx);
    for (const p of def.formals) {
      const s = into.get(p);
      if (s !== undefined && s.kind !== "any") result.set(p, s);
    }
  }
  dctx.fnFormalShapes.set(fnName, result);
  dctx.visiting.delete(fnName);
  return result;
}

/**
 * List-domain reverse table (eng-review G3/G4 — mandatory, arity-aware).
 * When domain is `List<E>` on an expression headed by these, push onto free roots.
 * Arg indices are 0-based into call arguments (after the head).
 *
 * Roles (demand-harvest totality plan §3):
 *   list-elements     (list a b) + List<E> → each arg ← E
 *   cons              (cons h t) + List<E> → h←E, t←List<E>
 *   list-preserve-all (append xs ys) + List<E> → each arg ← List<E>
 *   list-preserve-arg (reverse xs)/(take n xs)/(drop n xs)/(filter p xs)
 *                     — only the list slot (not the count/pred)
 */
type ListDomainReverse =
  | { kind: "list-elements" }
  | { kind: "cons" }
  | { kind: "list-preserve-all" }
  | { kind: "list-preserve-arg"; argIndex: number };

/** Exhaustive reverser heads — census test fails if emit adds a special case outside this map. */
export const LIST_DOMAIN_REVERSERS: ReadonlyMap<string, ListDomainReverse> = new Map([
  ["list", { kind: "list-elements" }],
  ["cons", { kind: "cons" }],
  ["append", { kind: "list-preserve-all" }],
  ["reverse", { kind: "list-preserve-arg", argIndex: 0 }],
  // SRFI-1 / prelude: (take n xs) (drop n xs) — list is arg 1, never annotate n
  ["take", { kind: "list-preserve-arg", argIndex: 1 }],
  ["drop", { kind: "list-preserve-arg", argIndex: 1 }],
  // (filter pred xs) (remove pred xs) — list is arg 1
  ["filter", { kind: "list-preserve-arg", argIndex: 1 }],
  ["remove", { kind: "list-preserve-arg", argIndex: 1 }],
]);

/**
 * Heads that are demand **sources** (generate DemandShape), not reversers.
 * Census / docs — not an open if-chain.
 */
export const DEMAND_SOURCE_HEADS = [
  "map", // multi-list λ zip + keyword + named/compose first-arg
  // pure chains use keywords / PIPELINE_ELEM_OPS, not a single head
  // compose/pipe: collectComposeDomains
  // callee formals: formalShapesOf
] as const;

/**
 * Explicit opaque heads (demand stops — residual OK if named).
 * R5: formalShapesOf mutual-recursion cycle returns empty mid-visit (visible, not silent).
 */
export const DEMAND_OPAQUE_HEADS = ["cut", "apply", "dict", "require", "case-lambda", "do"] as const;

/**
 * Push a required shape through an argument expression onto free roots.
 * Handles: bare atom, LIST_DOMAIN_REVERSERS heads, pure field/elem chains.
 */
function applyDomainToArg(arg: Node, domain: DemandShape, into: Map<string, DemandShape>): void {
  if (isAtom(arg) && !arg.str) {
    mergeDemand(into, arg.atom, domain);
    return;
  }
  if (isList(arg) && domain.kind === "list") {
    const h = head(arg);
    const rev = h === undefined ? undefined : LIST_DOMAIN_REVERSERS.get(h);
    if (rev !== undefined) {
      const args = arg.list.slice(1);
      switch (rev.kind) {
        case "list-elements":
          for (const a of args) applyDomainToArg(a, domain.elem, into);
          return;
        case "cons":
          if (args.length >= 2) {
            applyDomainToArg(args[0]!, domain.elem, into);
            applyDomainToArg(args[1]!, domain, into);
          }
          return;
        case "list-preserve-all":
          for (const a of args) applyDomainToArg(a, domain, into);
          return;
        case "list-preserve-arg": {
          const a = args[rev.argIndex];
          if (a !== undefined) applyDomainToArg(a, domain, into);
          return;
        }
      }
    }
  }
  const argChain = tryPureChain(arg);
  if (argChain !== null) {
    mergeDemand(into, argChain.root, substituteLeaf(shapeFromSteps(argChain.steps), domain));
  }
}

/**
 * Let / named-let: body demands + reverse one-hop through binding inits
 * (pure chain, list, cons) so free roots in inits pick up consumer domains.
 * Reverse order: later bindings (history+) first so their demand reaches earlier
 * free roots (history) via (cons entry history).
 */
function harvestLetLike(
  pairs: { name: string; init: Node }[],
  bodyForms: readonly Node[],
  into: Map<string, DemandShape>,
  dctx: DemandHarvestCtx,
): void {
  const localNames = new Set(pairs.map((p) => p.name));
  const local = new Map<string, DemandShape>();
  for (const f of bodyForms) collectDemandsInNode(f, local, dctx);
  for (const { name, init } of [...pairs].reverse()) {
    const Cp = local.get(name);
    if (Cp !== undefined) applyDomainToArg(init, Cp, local);
    collectDemandsInNode(init, local, dctx);
  }
  for (const [name, shape] of local) {
    if (!localNames.has(name)) mergeDemand(into, name, shape);
  }
}

/**
 * Harvest structural demands: pure field/elem chains, list-preserve, map/lambda
 * element push, and fused callee formal domains (compose + multi-arg defines).
 * Join is structural meet — never drop a demand for a second consumer.
 */
function collectDemandsInNode(n: Node, into: Map<string, DemandShape>, dctx: DemandHarvestCtx): void {
  if (!isList(n) || isNil(n)) return;

  // Named let: body demands + reverse one-hop through inits → outer free roots.
  if (isNamedLetForm(n)) {
    const bindings = n.list[2];
    const bodyForms = n.list.slice(3);
    const pairs: { name: string; init: Node }[] = [];
    if (isList(bindings)) {
      for (const b of bindings.list) {
        if (isList(b) && isAtom(b.list[0]) && !b.list[0]!.str) {
          pairs.push({ name: b.list[0]!.atom, init: b.list[1] ?? { atom: "#f" } });
        }
      }
    }
    harvestLetLike(pairs, bodyForms, into, dctx);
    return;
  }

  // Plain let / let*: same reverse one-hop (list, cons, pure chain).
  if (isPlainLetForm(n)) {
    const bindings = n.list[1];
    const bodyForms = n.list.slice(2);
    const pairs: { name: string; init: Node }[] = [];
    if (isList(bindings)) {
      for (const b of bindings.list) {
        if (isList(b) && isAtom(b.list[0]) && !b.list[0]!.str) {
          pairs.push({ name: b.list[0]!.atom, init: b.list[1] ?? { atom: "#f" } });
        }
      }
    }
    harvestLetLike(pairs, bodyForms, into, dctx);
    return;
  }

  // This form as a pure chain.
  const chain = tryPureChain(n);
  if (chain !== null) mergeDemand(into, chain.root, shapeFromSteps(chain.steps));

  // (cons h t) — tail must be a list (acc in reduce (lambda (x acc) (cons h acc))).
  if (isAtom(n.list[0]) && !n.list[0]!.str && n.list[0]!.atom === "cons" && n.list.length >= 3) {
    const tail = n.list[2]!;
    if (isAtom(tail) && !tail.str) {
      mergeDemand(into, tail.atom, { kind: "list", elem: DEMAND_ANY });
    } else {
      applyDomainToArg(tail, { kind: "list", elem: DEMAND_ANY }, into);
    }
  }

  // List-preserving: (cdr ts) / (cdr (car …)) etc.
  if (n.list.length === 2 && isAtom(n.list[0]) && !n.list[0]!.str && LIST_PRESERVE_OPS.has(n.list[0]!.atom)) {
    const arg = n.list[1]!;
    if (isAtom(arg) && !arg.str) {
      mergeDemand(into, arg.atom, { kind: "list", elem: DEMAND_ANY });
    } else {
      const inner = tryPureChain(arg);
      if (inner !== null) {
        mergeDemand(into, inner.root, { kind: "list", elem: shapeFromSteps(inner.steps) });
      }
    }
  }

  // (map (lambda (e) …) history) → history : List<demands(e)>
  // (map (lambda (p r) …) personas reactions) → zip: each list gets List<demands(param_i)>
  // (map :field xs) → xs : List<{ field: any }>
  // (map f xs) named/compose — unary domain of f onto xs (cut stays opaque)
  if (isAtom(n.list[0]) && !n.list[0]!.str && n.list[0]!.atom === "map" && n.list.length >= 3) {
    const f = n.list[1]!;
    if (isList(f) && head(f) === "lambda") {
      const params = paramAtoms(f.list[1]);
      const lamBody = f.list.slice(2);
      const local = new Map<string, DemandShape>();
      for (const b of lamBody) collectDemandsInNode(b, local, dctx);
      // Multi-list zip: param i ↔ list arg at index 2+i
      for (const [i, param] of params.entries()) {
        if (param!.rest) break;
        const listArg = n.list[2 + i];
        if (listArg === undefined) break;
        const s = local.get(param!.atom.atom);
        if (s !== undefined && s.kind !== "any") {
          applyDomainToArg(listArg, { kind: "list", elem: s }, into);
        }
      }
    } else if (isKeyword(f)) {
      const elemShape: DemandShape = {
        kind: "obj",
        fields: new Map([[keywordName(f), DEMAND_ANY]]),
      };
      applyDomainToArg(n.list[2]!, { kind: "list", elem: elemShape }, into);
    } else if (isAtom(f) && !f.str) {
      // Named f / compose pipeline define — unary first formal only (multi-arg HOF opaque)
      let elemShape: DemandShape | undefined = dctx.composeDomains.get(f.atom);
      if (elemShape === undefined) {
        const shapes = formalShapesOf(f.atom, dctx);
        const def = findFunctionDefine(dctx.forest, f.atom);
        if (def !== null && def.formals.length === 1) {
          elemShape = shapes.get(def.formals[0]!);
        }
      }
      if (elemShape !== undefined && elemShape.kind !== "any") {
        applyDomainToArg(n.list[2]!, { kind: "list", elem: elemShape }, into);
      }
      // cut / multi-arg named f: DEMAND_OPAQUE — no push
    }
  }

  // Callee domain fusion — compose unary + multi-arg function formals.
  if (isAtom(n.list[0]) && !n.list[0]!.str) {
    const fname = n.list[0]!.atom;
    // Compose/pipe unary
    const composeDom = dctx.composeDomains.get(fname);
    if (composeDom !== undefined && n.list.length >= 2 && !isKeyword(n.list[1])) {
      applyDomainToArg(n.list[1]!, composeDom, into);
    }
    // Multi-arg: (frontier-of (list entry) personas hints)
    const formalShapes = formalShapesOf(fname, dctx);
    if (formalShapes.size > 0) {
      const def = findFunctionDefine(dctx.forest, fname);
      if (def !== null) {
        let ai = 1;
        for (const formal of def.formals) {
          if (ai >= n.list.length || isKeyword(n.list[ai])) break;
          const dom = formalShapes.get(formal);
          if (dom !== undefined) applyDomainToArg(n.list[ai]!, dom, into);
          ai += 1;
        }
      }
    }
  }

  for (const c of n.list) collectDemandsInNode(c, into, dctx);
}

/** Demands for formals: pure chains ⊔ list-preserve ⊔ map/lambda ⊔ callee domains. */
function demandsForFormals(
  bodyForms: readonly Node[],
  formalNames: readonly string[],
  dctx: DemandHarvestCtx,
): Map<string, string> {
  const shapes = new Map<string, DemandShape>();
  for (const f of bodyForms) collectDemandsInNode(f, shapes, dctx);
  const out = new Map<string, string>();
  const want = new Set(formalNames);
  for (const name of want) {
    const s = shapes.get(name);
    if (s !== undefined && s.kind !== "any") out.set(name, renderShape(s));
  }
  return out;
}

/** Scheme `#f` literal (named-let optional-accumulator seed). */
function isFalseLiteral(n: Node): boolean {
  return isAtom(n) && !n.str && n.atom === "#f";
}

/**
 * Optional accumulator: init `#f` + structural body demand → `T | false`.
 * Without this, `(let walk ((click #f)) (:tagline click) …)` annotates only the
 * object arm and rejects the seed / recursive `false` arm.
 */
function unionFalseWhenInitF(demands: Map<string, string>, names: readonly string[], inits: readonly Node[]): void {
  for (const [i, name_] of names.entries()) {
    const name = name_!;
    const ann = demands.get(name);
    if (ann === undefined) continue;
    if (!isFalseLiteral(inits[i]!)) continue;
    if (ann.includes("| false")) continue;
    demands.set(name, `${ann} | false`);
  }
}

/** Write `(a: T, b, ...rest)` using demand annotations when present. */
function emitAnnotatedParams(params: { atom: Atom; rest: boolean }[], demands: Map<string, string>, ctx: Ctx): void {
  for (const [idx, p] of params.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    if (p.rest) ctx.buf.raw("...");
    const name = emitName(p.atom, ctx);
    ctx.buf.raw(name);
    // Rest formals: leave bare (polymorphic domain; see rest inference law).
    if (!p.rest) {
      const ann = demands.get(p.atom.atom);
      if (ann !== undefined) ctx.buf.raw(`: ${ann}`);
    }
  }
}

function emitLambda(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const params = paramAtoms(n.list[1]);
  const bodyForms = n.list.slice(2);
  // compose/pipe desugar to `(lambda (it) (f (g (h it))))`. Pure field/elem
  // pipelines share this path — two shapes:
  //
  //   • Field-only (`(:name d)`, `(compose :a :b)`): HOF-safe unconstrained A +
  //     conditional return (same law as keyword-as-fn). `A extends C` is too
  //     strict for `(map (lambda (d) (:name d)) privileged)` when the list only
  //     proved a partial row — contravariance rejects the lambda.
  //   • With elem ops (`last`/`car`/…): strict `A extends C` + direct result.
  //     Ambient `last`/`car` need a real List domain to typecheck clean under
  //     PRE (IDE contract C2), and call sites must bite on a wrong arg (TS2345).
  //     Compose/pipe defines almost always carry an elem step; field-only map
  //     lambdas stay on the HOF-safe branch.
  if (params.length === 1 && !params[0]!.rest && bodyForms.length === 1) {
    const steps = extractUnaryPipeline(bodyForms[0]!, params[0]!.atom);
    if (steps !== null) {
      const { constraint, result } = pipelineGenericTypes(steps);
      const pname = emitName(params[0]!.atom, ctx);
      const hasElem = steps.some((s) => s.kind === "elem");
      if (hasElem) {
        ctx.buf.raw(`<A extends ${constraint}>(${pname}: A): ${result} => `);
        emitArrowBody(bodyForms, ctx);
      } else {
        ctx.buf.raw(`<A,>(${pname}: A): A extends ${constraint} ? ${result} : unknown => ((${pname}: any) => `);
        emitArrowBody(bodyForms, ctx);
        ctx.buf.raw(`)(${pname})`);
      }
      recordSpan(ctx, start, n);
      return;
    }
  }
  const demands = demandsForFormals(
    bodyForms,
    params.filter((p) => !p.rest).map((p) => p.atom.atom),
    ctx.demandCtx,
  );
  ctx.buf.raw("(");
  emitAnnotatedParams(params, demands, ctx);
  ctx.buf.raw(") => ");
  emitArrowBody(bodyForms, ctx);
  recordSpan(ctx, start, n);
}

/** The body of a lambda/define arrow. A single expression → `expr`; a sequence →
 *  a `{ … return last; }` block. An object-literal sole body is parenthesized
 *  (`() => ({ … })`) so `{` is not parsed as a block (which turns `k: v` into
 *  labels and drops the return value). */
function emitArrowBody(forms: Node[], ctx: Ctx): void {
  if (forms.length === 0) {
    ctx.buf.raw("(undefined as unknown)");
    return;
  }
  if (forms.length === 1) {
    const only = forms[0]!;
    // A let/begin sole body IS the arrow's own block — emit as a real block.
    if (isList(only)) {
      const h = head(only);
      if ((h === "let" || h === "let*" || h === "letrec" || h === "letrec*") && !isAtom(only.list[1])) {
        emitLetBlock(only, ctx, "return ");
        return;
      }
      if (h === "begin") {
        emitBeginBlock(only.list.slice(1), ctx, "return ");
        return;
      }
      // `(lambda (…) (dict …))` → `() => ({ … })`, never `() => { … }`.
      if (h === "dict") {
        ctx.buf.raw("(");
        emitExpr(only, ctx);
        ctx.buf.raw(")");
        return;
      }
    }
    emitExpr(only, ctx);
    return;
  }
  emitBeginBlock(forms, ctx, "return ");
}

/** A `(begin a b last)` as a BLOCK: `{ a; b; return last; }` (or `lead`-prefixed). */
function emitBeginBlock(forms: Node[], ctx: Ctx, lastPrefix: string): void {
  ctx.buf.raw("{ ");
  emitBodyForms(forms, ctx, lastPrefix);
  ctx.buf.raw("}");
}

/** `begin` in EXPRESSION position: not block-placeable, so we emit just the last
 *  form's value (type-faithful — a `begin`'s type is its last form's). */
function emitBeginExpr(n: ListNode, ctx: Ctx): void {
  const forms = n.list.slice(1);
  if (forms.length === 0) {
    ctx.buf.spanned("(undefined as unknown)", n);
    return;
  }
  const start = ctx.buf.offset;
  // Emit leading forms as a comma sequence so any type errors in them still bite,
  // and the value is the last form.
  if (forms.length > 1) ctx.buf.raw("(");
  for (const [idx, f] of forms.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitExpr(f, ctx);
  }
  if (forms.length > 1) ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

/** A let / let-star / letrec as a TS BLOCK STATEMENT: `{ const x = v; body }`. The
 *  `lastPrefix` ("" at statement position, "return " inside an arrow body) is
 *  applied to the final body form. */
function emitLetBlock(n: ListNode, ctx: Ctx, lastPrefix: string): void {
  // Named let `(let loop ((x v)) …)` — a loop, not a binding block. Type-faithful
  // minimal lowering: declare the loop fn + its inits, then run the body block.
  if (isAtom(n.list[1])) {
    emitNamedLetBlock(n, ctx, lastPrefix);
    return;
  }
  const bindings = n.list[1];
  const bodyForms = n.list.slice(2);
  ctx.buf.raw("{ ");
  if (isList(bindings)) {
    for (const b of bindings.list) {
      if (isList(b) && isAtom(b.list[0])) {
        const name = emitName(b.list[0], ctx);
        const kw = ctx.setVars.has(name) ? "let" : "const";
        ctx.buf.raw(`${kw} ${name} = `);
        if (b.list[1]) emitExpr(b.list[1], ctx);
        else ctx.buf.raw("undefined as unknown");
        ctx.buf.raw("; ");
      }
    }
  }
  emitBodyForms(bodyForms, ctx, lastPrefix);
  ctx.buf.raw("}");
}

/** A named let → `{ const loop = (x: C) => {…}; <lastPrefix>loop(inits); }`. */
function emitNamedLetBlock(n: ListNode, ctx: Ctx, lastPrefix: string): void {
  const nameAtom = n.list[1] as Atom;
  const name = emitName(nameAtom, ctx);
  const bindings = n.list[2];
  const varAtoms: Atom[] = [];
  const inits: Node[] = [];
  if (isList(bindings)) {
    for (const b of bindings.list) {
      if (isList(b) && isAtom(b.list[0])) {
        varAtoms.push(b.list[0]);
        inits.push(b.list[1] ?? { atom: "#f" });
      }
    }
  }
  const bodyForms = n.list.slice(3);
  const formalNames = varAtoms.filter((a) => !a.str).map((a) => a.atom);
  const demands = demandsForFormals(bodyForms, formalNames, ctx.demandCtx);
  // Align indices with varAtoms (including any string-named skips — rare).
  unionFalseWhenInitF(
    demands,
    varAtoms.map((a) => a.atom),
    inits,
  );
  ctx.buf.raw("{ ");
  ctx.buf.raw(`const ${name} = (`);
  for (const [idx, v] of varAtoms.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    const pn = emitName(v, ctx);
    ctx.buf.raw(pn);
    const ann = demands.get(v.atom);
    if (ann !== undefined) ctx.buf.raw(`: ${ann}`);
  }
  ctx.buf.raw(") => ");
  emitArrowBody(bodyForms, ctx);
  ctx.buf.raw("; ");
  ctx.buf.raw(lastPrefix);
  ctx.buf.raw(`${name}(`);
  for (const [idx, v] of inits.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitExpr(v, ctx);
  }
  ctx.buf.raw("); }");
}

/** Emit a body's forms inside an open block: leading forms as statements, the
 *  last form prefixed by `lastPrefix` (e.g. "return " / ""). */
function emitBodyForms(forms: Node[], ctx: Ctx, lastPrefix: string): void {
  for (const [idx, f] of forms.entries()) {
    if (idx === forms.length - 1) ctx.buf.raw(lastPrefix);
    emitStmtInner(f, ctx);
    ctx.buf.raw("; ");
  }
}

/**
 * A let / begin in EXPRESSION position (where a *value* is needed and no statement
 * block can be placed — e.g. `(define r (let ((x 1)) (+ x 1)))`). We emit an
 * immediately-invoked arrow `(() => { const x = …; return …; })()`: the binding
 * forms are still type-checked and the value flows. This is the ONE place an
 * arrow-call appears — the "block-not-IIFE" rule governs STATEMENT/body position
 * (where a bare block suffices and an IIFE would distort CFA); at expression
 * position the arrow is the type-faithful way to bind-and-yield. The block body is
 * built by the same {@link emitLetBlock} used at statement position.
 */
function emitLetExpr(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  ctx.buf.raw("(() => ");
  emitLetBlock(n, ctx, "return ");
  ctx.buf.raw(")()");
  recordSpan(ctx, start, n);
}

function emitSetExpr(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const target = n.list[1];
  ctx.buf.raw("(");
  if (isAtom(target)) ctx.buf.raw(emitName(target, ctx));
  else ctx.buf.raw("(undefined as unknown)");
  ctx.buf.raw(" = ");
  if (n.list[2]) emitExpr(n.list[2], ctx);
  else ctx.buf.raw("undefined as unknown");
  ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

function emitQuote(datum: Node | undefined, ctx: Ctx, form: Node): void {
  const start = ctx.buf.offset;
  emitQuoteDatum(datum, ctx);
  recordSpan(ctx, start, form);
}

function emitQuoteDatum(datum: Node | undefined, ctx: Ctx): void {
  if (datum === undefined) {
    ctx.buf.raw("undefined as unknown");
    return;
  }
  if (isAtom(datum)) {
    if (datum.str) ctx.buf.raw(JSON.stringify(decodeString(datum.atom)));
    else if (isNumber(datum)) ctx.buf.raw(datum.atom);
    else if (isBool(datum)) ctx.buf.raw(datum.atom === "#t" ? "true" : "false");
    else ctx.buf.raw(JSON.stringify(datum.atom)); // quoted symbol → string
    return;
  }
  // Empty list: PRE dialect is `List<T> = T[]` (arrival-internals-types-prelude
  // types.d.ts). Empty is `[]` (never[] → assignable to any List<T>), NOT
  // `null` (carriers Cons|null brand — that is the type-layer, not the lens PRE).
  // Emitting null made (if … '()) / (loop … '()) fail List slots.
  if (isNil(datum) || datum.list.length === 0) {
    ctx.buf.raw("[]");
    return;
  }
  // Non-empty quoted list → list(...) so element type is inferred, not a
  // widened object[] from a bare array literal of heterogeneous forms.
  ctx.buf.raw("list(");
  for (const [idx, d] of datum.list.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitQuoteDatum(d, ctx);
  }
  ctx.buf.raw(")");
}

// ── statement-position emit (top-level + body) ───────────────────────────────

/** Emit a top-level / body form as a STATEMENT. A value-bearing form is a bare
 *  expression here — the caller adds any `return`/`;` prefix/suffix. */
function emitStmtInner(form: Node, ctx: Ctx): void {
  if (isList(form) && (head(form) === "define" || head(form) === "define/overridable")) {
    emitDefine(form, ctx);
    return;
  }
  if (
    isList(form) &&
    (head(form) === "let" || head(form) === "let*" || head(form) === "letrec" || head(form) === "letrec*")
  ) {
    // A let at statement position is a real block statement.
    emitLetBlock(form, ctx, "");
    return;
  }
  if (isList(form) && head(form) === "begin") {
    emitBeginBlock(form.list.slice(1), ctx, "");
    return;
  }
  // Object literal as an expression statement must be parenthesized — a leading
  // `{` is a block, not a value (same rule as arrow expression bodies).
  // Covers top-level results and `return ({…})` when lastPrefix is `return `.
  if (isList(form) && head(form) === "dict") {
    ctx.buf.raw("(");
    emitExpr(form, ctx);
    ctx.buf.raw(")");
    return;
  }
  emitExpr(form, ctx);
}

function emitDefine(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const sig = n.list[1];
  if (isList(sig)) {
    // `(define (f a b) body)` → `const f = (a: C, b) => { … };` when demand harvest hits.
    const nameAtom = isAtom(sig.list[0]) ? sig.list[0] : undefined;
    const name = nameAtom ? emitName(nameAtom, ctx) : "_";
    if (nameAtom) ctx.declaredNames.set(name, nameAtom.atom);
    const params = paramAtoms({ list: sig.list.slice(1) });
    const bodyForms = n.list.slice(2);
    const demands = demandsForFormals(
      bodyForms,
      params.filter((p) => !p.rest).map((p) => p.atom.atom),
      ctx.demandCtx,
    );
    const kw = ctx.setVars.has(name) ? "let" : "const";
    ctx.buf.raw(`${kw} ${name} = (`);
    emitAnnotatedParams(params, demands, ctx);
    ctx.buf.raw(") => ");
    emitArrowBody(bodyForms, ctx);
  } else {
    // `(define x v)` → `const x = <v>;`
    const name = isAtom(sig) ? emitName(sig, ctx) : "_";
    if (isAtom(sig)) ctx.declaredNames.set(name, sig.atom);
    const kw = ctx.setVars.has(name) ? "let" : "const";
    // `(define/overridable x type default)` compiles just like an ordinary define
    // FOR NOW: both sub-expressions emit exactly as any define's value would —
    // no dedicated type-tag lowering. The type tag is never a bare name standing
    // in for some other type (s/* — s/enum, s/object, … — is the only type
    // vocabulary, prelude-loaded the same way BUILTIN_PREAMBLE is), so it needs
    // no special-cased resolution: emitting it through the ordinary expression
    // path is what makes an unbound identifier there correctly bite as an
    // unresolved reference, same as any other free ref would. `x`'s own type
    // still just infers from `default` (last statement); the tag doesn't
    // annotate it yet.
    if (head(n) === "define/overridable" && n.list[2]) {
      emitExpr(n.list[2], ctx);
      ctx.buf.raw(";\n");
    }
    ctx.buf.raw(`${kw} ${name} = `);
    const valueIdx = head(n) === "define/overridable" ? 3 : 2;
    if (n.list[valueIdx]) emitExpr(n.list[valueIdx], ctx);
    else ctx.buf.raw("undefined as unknown");
  }
  recordSpan(ctx, start, n);
}

// ── pure helpers ─────────────────────────────────────────────────────────────

/**
 * Parameter atoms for lambda / define formals.
 *
 * - `(a b c)` → fixed params
 * - `(a b . rest)` → fixed + rest (`...rest`)
 * - bare atom `args` → rest-only (`...args`) — R5RS formals-as-symbol
 *
 * **Bare formals law** (polyglot `str`, etc.): the formal is *arbitrary length*
 * (`...args`). The element type is not invented here — emit is unannotated;
 * the lens's "infer from consumers" pass finds the common denominator of body
 * (and call-site) uses of `args`. Wrong: zero-arity `() => …` (arity false-
 * positive "Expected 0 arguments, but got N").
 */
function paramAtoms(node: Node | undefined): { atom: Atom; rest: boolean }[] {
  if (node === undefined) return [];
  // `(lambda args body)` — whole arg list as one rest binding.
  if (isAtom(node) && !node.str) return [{ atom: node, rest: true }];
  if (!isList(node)) return [];
  const out: { atom: Atom; rest: boolean }[] = [];
  for (let i = 0; i < node.list.length; i++) {
    const p = node.list[i]!;
    if (isAtom(p) && p.atom === ".") {
      const rest = node.list[i + 1];
      if (isAtom(rest)) out.push({ atom: rest, rest: true });
      break;
    }
    if (isAtom(p)) out.push({ atom: p, rest: false });
  }
  return out;
}

/** Decode a scheme string literal's escapes (parser stores them raw). */
function decodeString(raw: string): string {
  return raw.replaceAll(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      default:
        return c;
    }
  });
}

/**
 * Emit type-faithful virtual TS for an arrival Scheme program, with a span lens
 * back to the source. The emitted module references the
 * `@inhuman.tools/arrival-internals-types-prelude` prelude globals
 * (`declare function car…`, `sexpr`, `List`, …) — prepend PRE (unmapped)
 * before type-checking; nothing is declared here.
 *
 * Each top-level form is emitted under its own try/catch: a parse/emit failure on
 * one form degrades THAT form to an unmapped `unknown` (recorded in
 * `droppedForms`) and never throws out of `emitTypes`, so the LSP never blanks all
 * diagnostics. The module ends with `export {};` so top-level `const` bindings
 * are module-scoped and never collide across files in a shared program.
 */
export interface EmitTypesOptions {
  /** Host-injected ambient function names (sift rosetta tools) — heads lowered via
   *  bare `encodeSchemeIdent(name)(…)` so the type-lens resolves their signatures.
   *  See `Ctx.hostMembers`. */
  hostMembers?: ReadonlySet<string>;
  /**
   * Registry-harvested Law-N witnesses: head names whose Contract carries
   * `narrows: { witness }` (registry-emit.md owns the field + harvest — see
   * `narrowsMembersOf` for the reduction; consumed here only as a reduced KEY SET,
   * never the witness sub-field, which feeds a separate CI table). Feeds the
   * narrowing-form grammar: a condition reachable from `if` through zero or more
   * `not`/`and`/`or`, bottoming out ONLY in members of this set, emits NATIVE
   * `!`/`&&`/`||`/bare-call. Absent → EMPTY_SET → every condition wraps — Law F's
   * value-position analog: no witness ⇒ conservative, never reversed.
   */
  narrowsMembers?: ReadonlySet<string>;
  /**
   * Heads with **record-shaped** Contract `inputRest` (kwargs channel). Merged
   * with names bound to a kwargs-require (see `kwargsRequireSuffixes`).
   */
  kwargsMembers?: ReadonlySet<string>;
  /**
   * Require-path suffixes whose `(require "…")` result is a kwargs callable.
   * Host-supplied — mercury does not name domain filetypes. Empty ⇒ none.
   */
  kwargsRequireSuffixes?: readonly string[];
  /**
   * Require-as-import map: scheme require path → TS import binding. When present,
   * `(require "path")` emits the binding (default import of a virtual module).
   */
  requireBindings?: ReadonlyMap<string, string>;
}

export function emitTypes(source: string | readonly Node[], opts?: EmitTypesOptions): EmitTypesResult {
  const buf = new Buf();
  const droppedForms: number[] = [];

  let forest: Node[];
  try {
    forest = desugar(typeof source === "string" ? parseSexprs(source) : [...source]);
  } catch {
    // Whole-program parse failure: emit an empty module rather than throw.
    return { ts: "export {};\n", mappings: [], droppedForms: [], declaredNames: new Map() };
  }

  const nameOf = resolveNames(forest, []);
  const setVars = collectSetBangNames(forest, nameOf);
  const kwargsRequireSuffixes = opts?.kwargsRequireSuffixes ?? [];
  // inputRest-record heads: host harvest ∪ local bindings of kwargs-requires.
  const kwargsMembers = new Set<string>([
    ...(opts?.kwargsMembers ?? EMPTY_SET),
    ...collectRequireKwargHeads(forest, kwargsRequireSuffixes),
  ]);
  // Demand harvest: compose domains + lazy multi-arg formal shapes (map/lambda, calls).
  const demandCtx: DemandHarvestCtx = {
    forest,
    composeDomains: collectComposeDomains(forest),
    fnFormalShapes: new Map(),
    visiting: new Set(),
  };
  const ctxBase: Ctx = {
    buf,
    nameOf,
    setVars,
    hostMembers: opts?.hostMembers ?? EMPTY_SET,
    narrowsMembers: opts?.narrowsMembers ?? EMPTY_SET,
    kwargsMembers,
    kwargsRequireSuffixes,
    declaredNames: new Map(),
    requireBindings: opts?.requireBindings ?? new Map(),
    demandCtx,
  };

  for (const [idx, form] of forest.entries()) {
    // `(require …)` is an environment directive (load a file into the env), not
    // a value form — there is nothing to type-check IN THIS BUFFER. Emitting it
    // as a call produced a bogus `Cannot find name 'require'` (+ an @types/node
    // upsell) from tsc. Skipped + recorded; the names a require brings into
    // scope stay unresolved until the lens grows cross-file resolution.
    if (isList(form) && head(form) === "require") {
      droppedForms.push(idx);
      continue;
    }
    const checkpoint = buf.offset;
    try {
      emitStmtTop(form, ctxBase);
      buf.raw(";\n");
    } catch {
      // Degrade this form to a transparent `unknown`. We can't easily rewind the
      // buffer, so append a fresh transparent statement; the partial emit (if any)
      // is harmless TS prefix. Record the drop.
      if (buf.offset === checkpoint) buf.raw("undefined as unknown;\n");
      droppedForms.push(idx);
    }
  }

  buf.raw("export {};\n");
  return { ts: buf.toString(), mappings: buf.mappings, droppedForms, declaredNames: ctxBase.declaredNames };
}

/** A top-level form: define → const; let/begin → block statement; else → expr stmt. */
function emitStmtTop(form: Node, ctx: Ctx): void {
  emitStmtInner(form, ctx);
}
