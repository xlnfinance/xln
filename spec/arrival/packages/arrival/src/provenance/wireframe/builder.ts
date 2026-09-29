/**
 * Whole-program prospective wireframe — `classify` generalized over top-level
 * defines + main expression.
 *
 * CUT-AND-CLOSE. Designated subterms (membrane ports, port-coupled muxes, fan
 * instantiation, binders, port-reaching define calls) become NODES; maximal pure
 * residue becomes ONE wire via `unevalWire` (params = ingress). Wire purity is by
 * construction — ports break segments; a wire body has no source/sink/port-mux.
 *
 * SELECTOR-CONE (owned here; classifier supplies roles only). Mux is port-coupled
 * iff `reachesPort(classify(selector, reachClassifier, subst))`:
 *   - `subst` = builder let-walk (couples through bindings)
 *   - field arm descends focused child only (`(:flag (src))` couples; plain slot does not)
 *   - port-reaching defines lower to `opaque` (transitive coupling)
 * Pure-selector mux collapses into its wire; both arms' FV still ingress
 * (precision trade — do not "fix" by re-recording).
 *
 * I5: fan is one region host in G; callback wireframe is private `template`
 * (replayed on demand). Field-demand at region boundary → replay, not records.
 *
 * LOOPS (`loops.ts`): binder{cycles} get private GraphBuilder interiors. named-let
 * self-call / do steps are BACKEDGE `recur` (next-iteration params; binder ingress
 * = initials only). Declared loop-role with no recursive shape → empty interior.
 * letrec-bound closure under-designates call-site mux (classify never expands
 * callees); port still cut so replay cone is sound.
 *
 * STRUCT-FACT: `factTagOf` tags whole-body `(length|vector-length|string-length p)`
 * as one term `length` on `Wire.fact` — not a second edge species. Count-demand
 * routes through fact wires only (`reachableNodesForDemand` in loops.ts).
 *
 * BARE ROLE REFS: designated at value occurrence (HOF argument), not only
 * application head. LIMIT: no alias chasing — `(let ((g fetch)) (g))` under-designates `(g)`.
 */
import type { SchemeValue } from "../../values/types.js";
import { APair } from "../../values/primitives/APair.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { classify, type Classifier, type LineageNode, type Subst } from "../lineage.js";
import type { CallbackRoles } from "../../common/symbols/_bake.js";
import { classifyProgramPrelude, buildPreludeSource, reachesPort } from "../prelude.js";
import { defineNameOf } from "../slice.js";
import { scopeId } from "../scope-id.js";
import { unevalWire } from "../uneval.js";
import { parseDoBindings, parseDoClause } from "./loops.js";
import type {
  DefineTemplate,
  Wire,
  WireConsumer,
  WireFact,
  WireFrame,
  WireFrameEntry,
  WireframeGraph,
  WireframeNode,
  WireframeProgram,
} from "./types.js";

/** Structural-fact surface ops → one term `length` (not per-spelling tags). */
const FACT_VERBS: ReadonlySet<string> = new Set(["length", "vector-length", "string-length"]);

export interface WireframeBuildOptions {
  /** Declaration-driven role read (`.provenanceRole`). */
  readonly classifier: Classifier;
  /** Resolvable in hermetic base env? Production: sealed base chain; tests: a set. */
  readonly isBaseName: (name: string) => boolean;
  /** Host-verb callback roles — stamped on fan nodes, not used for designation. */
  readonly callbackRolesOf?: (op: string) => CallbackRoles | undefined;
}

interface BuildCtx {
  readonly classifier: Classifier;
  /** Port-reaching defines → opaque for transitive selector coupling. */
  readonly reachClassifier: Classifier;
  readonly preludeNames: ReadonlySet<string>;
  readonly materialNames: ReadonlySet<string>;
  readonly isBaseName: (name: string) => boolean;
  readonly callbackRolesOf?: (op: string) => CallbackRoles | undefined;
}

/** Lexical walk context: subst (let transparency) + frames for unevalWire rewrap. */
interface WalkEnv {
  readonly subst: Subst;
  readonly frames: readonly WireFrame[];
  /** Innermost loop's recur name; a call is BACKEDGE. Fresh env (no recur) inside fan templates. */
  readonly recur?: { readonly name: string };
}

// Local surface helpers (lineage keeps private copies of the same shapes).

function opName(x: unknown): string {
  const v = (x as { valueOf?: () => unknown })?.valueOf?.();
  return typeof v === "string" || typeof v === "symbol" ? String(v) : String(x);
}

function operands(app: APair<SchemeValue, SchemeValue>): unknown[] {
  const out: unknown[] = [];
  let n: unknown = app.cdr;
  while (n instanceof APair) {
    out.push(n.car);
    n = n.cdr;
  }
  return out;
}

/** Lambda formals including dotted rest. */
function lambdaParams(formals: unknown): string[] {
  const out: string[] = [];
  let n: unknown = formals;
  while (n instanceof APair) {
    if (n.car instanceof ASymbol) out.push(opName(n.car));
    n = n.cdr;
  }
  if (n instanceof ASymbol) out.push(opName(n));
  return out;
}

const LEAF = (slot: string): LineageNode => ({ kind: "leaf", slot });

/** Empty interior for declared-loop role with no known recursive shape. */
const EMPTY_GRAPH: WireframeGraph = { nodes: [], wires: [], egress: null };

function letEntries(bindings: unknown): WireFrameEntry[] {
  const out: WireFrameEntry[] = [];
  let n: unknown = bindings;
  while (n instanceof APair) {
    const b = n.car;
    if (b instanceof APair && b.car instanceof ASymbol) {
      out.push({ name: opName(b.car), rhs: b.cdr instanceof APair ? b.cdr.car : undefined });
    }
    n = n.cdr;
  }
  return out;
}

function chainOf(n: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = n;
  while (cur instanceof APair) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

/** One graph under construction. Region interiors own a separate GraphBuilder (I5). */
class GraphBuilder {
  private readonly nodes: WireframeNode[] = [];
  private readonly wires: Wire[] = [];
  /** Surface subterm → node id (shared across wires in this graph). */
  private readonly cuts = new Map<unknown, number>();
  private egress: number | null = null;

  constructor(private readonly bctx: BuildCtx) {}

  finish(): WireframeGraph {
    return { nodes: this.nodes, wires: this.wires, egress: this.egress };
  }

  private addNode(node: WireframeNode): number {
    this.nodes.push(node);
    return this.nodes.length - 1;
  }

  /** Designated nodes land; pure residue emits no wire (value-dropped form). */
  walkDropped(expr: unknown, env: WalkEnv): void {
    this.walkForCuts(expr, env);
  }

  /** Value expression → out-port + egress wire. Pure sink leaves egress null. */
  emitEgress(expr: unknown, env: WalkEnv): void {
    this.walkForCuts(expr, env);
    const cutId = this.cuts.get(expr);
    if (cutId !== undefined && this.nodes[cutId].kind === "sink") return;
    const out = this.addNode({ kind: "port", direction: "out", span: scopeId(expr) });
    this.egress = out;
    this.emitWire(expr, { node: out, slot: "out" }, env);
  }

  private emitWire(expr: unknown, consumer: WireConsumer, env: WalkEnv): void {
    this.walkForCuts(expr, env);
    const emitted = unevalWire({
      expr,
      frames: env.frames,
      cuts: this.cuts,
      preludeNames: this.bctx.preludeNames,
      materialNames: this.bctx.materialNames,
      isBaseName: this.bctx.isBaseName,
    });
    const fact = this.factTagOf(expr, env);
    this.wires.push({
      ...emitted,
      consumer,
      // eslint-disable-next-line unicorn/no-negated-condition -- omit fact when the expr has none
      ...(fact !== undefined ? { fact } : {}),
    });
  }

  /**
   * Tag whole-body structural-fact reads only. Guards (match unevalWire FV order):
   * local shadow / material define / non-base name → never tag.
   * Nested `(+ 1 (length xs))` not tagged — keeps count-demand routing exact.
   */
  private factTagOf(expr: unknown, env: WalkEnv): WireFact | undefined {
    if (!(expr instanceof APair) || !(expr.car instanceof ASymbol)) return undefined;
    const op = opName(expr.car);
    if (env.subst.has(op) || !FACT_VERBS.has(op)) return undefined;
    if (this.bctx.materialNames.has(op) || !this.bctx.isBaseName(op)) return undefined;
    if (operands(expr as APair<SchemeValue, SchemeValue>).length !== 1) return undefined;
    return { kind: "fact", verb: "length" };
  }

  private selectorReachesPort(selector: unknown, env: WalkEnv): boolean {
    return reachesPort(classify(selector as SchemeValue, this.bctx.reachClassifier, env.subst));
  }

  // ── designation walk ───────────────────────────────────────────────────────

  /** Build every designated subterm under `expr`; pure residue left for emitWire. */
  private walkForCuts(expr: unknown, env: WalkEnv): void {
    if (this.cuts.has(expr)) return;
    // Bare port-role value (source/sink/fan/loop) → designate at occurrence
    // (HOF args). source/sink keep kind; fan/loop → opaque (no call site for shape).
    // LIMIT: no alias chasing.
    if (expr instanceof ASymbol) {
      const name = opName(expr);
      if (!env.subst.has(name) && !this.bctx.materialNames.has(name)) {
        const role = this.bctx.classifier.roleOf(name);
        if (role === "source" || role === "sink" || role === "fan" || role === "loop") {
          this.cuts.set(
            expr,
            this.addNode(
              role === "source" || role === "sink"
                ? { kind: role, op: name, span: scopeId(expr) }
                : { kind: "opaque", op: name, span: scopeId(expr) },
            ),
          );
        }
      }
      return;
    }
    if (!(expr instanceof APair)) return;

    const head = expr.car;
    if (head instanceof ASymbol) {
      const form = opName(head);
      if (!env.subst.has(form)) {
        switch (form) {
          case "quote":
            return;
          case "quasiquote":
            this.walkQuasi(expr.cdr instanceof APair ? expr.cdr.car : undefined, 1, env);
            return;
          case "if":
          case "when":
          case "unless": {
            const rest = expr.cdr;
            if (!(rest instanceof APair)) return;
            const test = rest.car;
            if (this.selectorReachesPort(test, env)) {
              this.cuts.set(expr, this.buildMux(expr, rest, form, env));
              return;
            }
            // Pure-selector mux collapses into wire; still walk nested cuts.
            this.walkForCuts(test, env);
            for (const arm of chainOf(rest.cdr)) this.walkForCuts(arm, env);
            return;
          }
          case "cond": {
            const clauses = chainOf(expr.cdr).filter((c): c is APair<SchemeValue, SchemeValue> => c instanceof APair);
            const coupled = clauses.some(
              (c) => !(c.car instanceof ASymbol && opName(c.car) === "else") && this.selectorReachesPort(c.car, env),
            );
            if (coupled) {
              this.cuts.set(expr, this.buildCondMux(expr, clauses, env));
              return;
            }
            for (const clause of clauses) {
              if (!(clause.car instanceof ASymbol && opName(clause.car) === "else")) this.walkForCuts(clause.car, env);
              for (const bodyForm of chainOf(clause.cdr)) {
                if (bodyForm instanceof ASymbol && opName(bodyForm) === "=>") continue;
                this.walkForCuts(bodyForm, env);
              }
            }
            return;
          }
          case "let":
          case "let*":
          case "letrec":
          case "letrec*":
            this.walkLet(expr, form as "let" | "let*" | "letrec" | "letrec*", env);
            return;
          case "do":
            this.cuts.set(expr, this.buildDoBinder(expr, env));
            return;
          case "begin":
          case "and":
          case "or":
            for (const sub of chainOf(expr.cdr)) this.walkForCuts(sub, env);
            return;
          case "lambda": {
            const rest = expr.cdr;
            if (!(rest instanceof APair)) return;
            const extended = new Map(env.subst);
            for (const p of lambdaParams(rest.car)) extended.set(p, LEAF(p));
            const inner: WalkEnv = { subst: extended, frames: env.frames, recur: env.recur };
            for (const bodyForm of chainOf(rest.cdr)) this.walkForCuts(bodyForm, inner);
            return;
          }
          case "define": {
            const rest = expr.cdr;
            if (!(rest instanceof APair)) return;
            const extended = new Map(env.subst);
            if (rest.car instanceof APair) for (const p of lambdaParams(rest.car.cdr)) extended.set(p, LEAF(p));
            const inner: WalkEnv = { subst: extended, frames: env.frames, recur: env.recur };
            for (const bodyForm of chainOf(rest.cdr)) this.walkForCuts(bodyForm, inner);
            return;
          }
          default:
            break;
        }
      }
    }

    if (head instanceof APair) {
      // Computed operator — walk head+args; call itself is wire material (HOF hole).
      this.walkForCuts(head, env);
      for (const a of operands(expr)) this.walkForCuts(a, env);
      return;
    }
    if (!(head instanceof ASymbol)) {
      for (const a of operands(expr)) this.walkForCuts(a, env);
      return;
    }

    const op = opName(head);
    if (!env.subst.has(op)) {
      if (env.recur !== undefined && op === env.recur.name) {
        this.cuts.set(expr, this.buildArgNode({ kind: "recur", span: scopeId(expr) }, expr, env));
        return;
      }
      if (this.bctx.materialNames.has(op)) {
        this.cuts.set(expr, this.buildArgNode({ kind: "template-ref", name: op, span: scopeId(expr) }, expr, env));
        return;
      }
      const role = this.bctx.classifier.roleOf(op);
      switch (role) {
        case "source":
        case "sink":
        case "transparent":
        case "opaque":
          this.cuts.set(expr, this.buildArgNode({ kind: role, op, span: scopeId(expr) }, expr, env));
          return;
        case "fan":
          this.cuts.set(expr, this.buildFan(expr, op, env));
          return;
        case "loop": {
          // No known recursive shape → empty interior; named-let/do get real ones.
          const id = this.buildArgNode(
            { kind: "binder", op, span: scopeId(expr), cycles: true, params: [], interior: EMPTY_GRAPH },
            expr,
            env,
          );
          this.cuts.set(expr, id);
          return;
        }
        default:
          break;
      }
    }
    for (const a of operands(expr)) this.walkForCuts(a, env);
  }

  /** Quasiquote: only unquote bodies re-enter expression space (depth-counted). */
  private walkQuasi(n: unknown, depth: number, env: WalkEnv): void {
    if (!(n instanceof APair)) return;
    if (n.car instanceof ASymbol) {
      const hn = opName(n.car);
      if (hn === "unquote" || hn === "unquote-splicing") {
        const arg = n.cdr instanceof APair ? n.cdr.car : undefined;
        if (depth === 1) this.walkForCuts(arg, env);
        else this.walkQuasi(arg, depth - 1, env);
        return;
      }
      if (hn === "quasiquote") {
        this.walkQuasi(n.cdr instanceof APair ? n.cdr.car : undefined, depth + 1, env);
        return;
      }
    }
    let cur: unknown = n;
    while (cur instanceof APair) {
      this.walkQuasi(cur.car, depth, env);
      cur = cur.cdr;
    }
  }

  /** Let-family transparent to designation; named let → binder with interior. */
  private walkLet(
    expr: APair<SchemeValue, SchemeValue>,
    kind: "let" | "let*" | "letrec" | "letrec*",
    env: WalkEnv,
  ): void {
    const rest = expr.cdr;
    if (!(rest instanceof APair)) return;
    if (rest.car instanceof ASymbol) {
      this.cuts.set(expr, this.buildNamedLetBinder(expr, rest, env));
      return;
    }
    const entries = letEntries(rest.car);
    const sequential = kind !== "let";
    const extended = new Map(env.subst);
    const partial: WireFrameEntry[] = [];
    for (const entry of entries) {
      const rhsEnv: WalkEnv = sequential
        ? { subst: extended, frames: [...env.frames, { kind, entries: [...partial] }], recur: env.recur }
        : env;
      this.walkForCuts(entry.rhs, rhsEnv);
      const rhsSubst = sequential ? extended : env.subst;
      const rhsNode: LineageNode =
        entry.rhs === undefined
          ? { kind: "literal" }
          : classify(entry.rhs as SchemeValue, this.bctx.reachClassifier, rhsSubst);
      extended.set(entry.name, rhsNode);
      partial.push(entry);
    }
    const bodyEnv: WalkEnv = { subst: extended, frames: [...env.frames, { kind, entries }], recur: env.recur };
    for (const bodyForm of chainOf(rest.cdr)) this.walkForCuts(bodyForm, bodyEnv);
  }

  // ── node constructors ──────────────────────────────────────────────────────

  private buildArgNode(node: WireframeNode, expr: APair<SchemeValue, SchemeValue>, env: WalkEnv): number {
    const id = this.addNode(node);
    operands(expr).forEach((a, i) => this.emitWire(a, { node: id, slot: `arg${i}` }, env));
    return id;
  }

  private buildMux(
    expr: APair<SchemeValue, SchemeValue>,
    rest: APair<SchemeValue, SchemeValue>,
    form: string,
    env: WalkEnv,
  ): number {
    const test = rest.car;
    // if: [then, else?]; when/unless: last body form is value.
    const bodyForms = chainOf(rest.cdr);
    const arms = form === "if" ? bodyForms : bodyForms.length > 0 ? [bodyForms.at(-1)] : [];
    if (form !== "if") for (const dropped of bodyForms.slice(0, -1)) this.walkForCuts(dropped, env);
    const id = this.addNode({ kind: "mux", op: form, span: scopeId(expr), arms: arms.length });
    this.emitWire(test, { node: id, slot: "selector" }, env);
    arms.forEach((arm, k) => this.emitWire(arm, { node: id, slot: `arm${k}` }, env));
    return id;
  }

  private buildCondMux(
    expr: APair<SchemeValue, SchemeValue>,
    clauses: readonly APair<SchemeValue, SchemeValue>[],
    env: WalkEnv,
  ): number {
    const id = this.addNode({ kind: "mux", op: "cond", span: scopeId(expr), arms: clauses.length });
    let sel = 0;
    clauses.forEach((clause, k) => {
      const isElse = clause.car instanceof ASymbol && opName(clause.car) === "else";
      if (!isElse) this.emitWire(clause.car, { node: id, slot: `selector${sel++}` }, env);
      const body = chainOf(clause.cdr).filter((f) => !(f instanceof ASymbol && opName(f) === "=>"));
      // Last body form is arm; bare `(test)` returns test. deferred: => threading.
      const arm = body.length > 0 ? body.at(-1) : clause.car;
      for (const dropped of body.slice(0, -1)) this.walkForCuts(dropped, env);
      this.emitWire(arm, { node: id, slot: `arm${k}` }, env);
    });
    return id;
  }

  /** Fan = I5 region host; lambda body → private template interior. */
  private buildFan(expr: APair<SchemeValue, SchemeValue>, op: string, env: WalkEnv): number {
    const args = operands(expr);
    const fn = args[0];
    const lengthPreserving = op === "map" || op === "vector-map";
    let template: WireframeGraph | undefined;
    let elementParams: string[] | undefined;
    let fnOp: string | undefined;
    if (fn instanceof APair && fn.car instanceof ASymbol && opName(fn.car) === "lambda" && fn.cdr instanceof APair) {
      const params = lambdaParams(fn.cdr.car);
      const interior = new GraphBuilder(this.bctx);
      const intSubst = new Map(env.subst);
      for (const p of params) intSubst.set(p, LEAF(p));
      // frames: [] — non-element slots are region captures (I2), not inlined frames.
      const intEnv: WalkEnv = { subst: intSubst, frames: [] };
      const bodyForms = chainOf(fn.cdr.cdr);
      for (const dropped of bodyForms.slice(0, -1)) interior.walkDropped(dropped, intEnv);
      if (bodyForms.length > 0) interior.emitEgress(bodyForms.at(-1), intEnv);
      template = interior.finish();
      elementParams = params;
    } else if (fn instanceof ASymbol) {
      fnOp = opName(fn);
    } else if (fn !== undefined) {
      this.walkForCuts(fn, env); // computed callback — designated subterms still land
    }
    const roles = this.bctx.callbackRolesOf?.(op);
    const id = this.addNode({
      kind: "fan",
      op,
      span: scopeId(expr),
      lengthPreserving,
      // eslint-disable-next-line unicorn/no-negated-condition -- omit template when the fan has none
      ...(template !== undefined ? { template } : {}),
      // eslint-disable-next-line unicorn/no-negated-condition -- omit elementParams when undeclared
      ...(elementParams !== undefined ? { elementParams } : {}),
      // eslint-disable-next-line unicorn/no-negated-condition -- omit fnOp when the callback is not a named op
      ...(fnOp !== undefined ? { fnOp } : {}),
      // eslint-disable-next-line unicorn/no-negated-condition -- omit callbackRoles when the classifier has none
      ...(roles !== undefined ? { callbackRoles: roles } : {}),
    });
    args.slice(1).forEach((a, i) => this.emitWire(a, { node: id, slot: i === 0 ? "source" : `source${i}` }, env));
    return id;
  }

  /**
   * Named let → binder{cycles} with private interior. Loop vars = LEAF slots
   * extending outer subst (selector reachability sees captures). Self-call =
   * recur backedge; init wires are outer-scope ingress.
   */
  private buildNamedLetBinder(
    expr: APair<SchemeValue, SchemeValue>,
    rest: APair<SchemeValue, SchemeValue>,
    env: WalkEnv,
  ): number {
    const loopName = opName(rest.car);
    const afterName = rest.cdr;
    const entries = afterName instanceof APair ? letEntries(afterName.car) : [];
    const bodyForms = afterName instanceof APair ? chainOf(afterName.cdr) : [];
    const params = entries.map((e) => e.name);

    const interior = new GraphBuilder(this.bctx);
    const intSubst = new Map(env.subst);
    for (const p of params) intSubst.set(p, LEAF(p));
    const intEnv: WalkEnv = { subst: intSubst, frames: [], recur: { name: loopName } };
    for (const dropped of bodyForms.slice(0, -1)) interior.walkDropped(dropped, intEnv);
    if (bodyForms.length > 0) interior.emitEgress(bodyForms.at(-1), intEnv);

    const id = this.addNode({
      kind: "binder",
      op: "named-let",
      span: scopeId(expr),
      cycles: true,
      params,
      interior: interior.finish(),
    });
    entries.forEach((e, i) => this.emitWire(e.rhs, { node: id, slot: `arg${i}` }, env));
    return id;
  }

  /**
   * `do` → binder{cycles}. Body/test value-dropped (ports still land); no mux
   * for continue/stop (precision LIMIT — agreement corpus). Steps = backedge
   * recur (R7RS omitted step = identity; parseDoBindings encodes default).
   * result… is terminal egress under synthetic let rebinding loop vars to the
   * recur cut (R7RS latest-value scope; named-let gets this from syntactic
   * self-call).
   */
  private buildDoBinder(expr: APair<SchemeValue, SchemeValue>, env: WalkEnv): number {
    const rest = expr.cdr;
    const bindings = rest instanceof APair ? parseDoBindings(rest.car) : [];
    const afterBindings = rest instanceof APair ? rest.cdr : undefined;
    const clause = afterBindings instanceof APair ? parseDoClause(afterBindings.car) : parseDoClause(undefined);
    const bodyForms = afterBindings instanceof APair ? chainOf(afterBindings.cdr) : [];
    const params = bindings.map((b) => b.name);

    const interior = new GraphBuilder(this.bctx);
    const intSubst = new Map(env.subst);
    for (const p of params) intSubst.set(p, LEAF(p));
    const intEnv: WalkEnv = { subst: intSubst, frames: [] };
    for (const cmd of bodyForms) interior.walkDropped(cmd, intEnv);
    if (clause.test !== undefined) interior.walkDropped(clause.test, intEnv);
    const recurId = interior.addRecur(
      scopeId(expr),
      bindings.map((b) => b.step),
      intEnv,
    );
    if (clause.resultForms.length > 0) {
      const recurSentinel: unknown = {};
      interior.cuts.set(recurSentinel, recurId);
      const resultFrame: WireFrame = {
        kind: "let",
        entries: bindings.map((b): WireFrameEntry => ({ name: b.name, rhs: recurSentinel })),
      };
      const resultEnv: WalkEnv = { subst: intSubst, frames: [resultFrame] };
      for (const dropped of clause.resultForms.slice(0, -1)) interior.walkDropped(dropped, resultEnv);
      interior.emitEgress(clause.resultForms.at(-1), resultEnv);
    }

    const id = this.addNode({
      kind: "binder",
      op: "do",
      span: scopeId(expr),
      cycles: true,
      params,
      interior: interior.finish(),
    });
    bindings.forEach((b, i) => this.emitWire(b.init, { node: id, slot: `arg${i}` }, env));
    return id;
  }

  /** Backedge: next-iteration args; never escapes as graph egress. */
  private addRecur(span: string, args: readonly unknown[], env: WalkEnv): number {
    const id = this.addNode({ kind: "recur", span });
    args.forEach((a, i) => this.emitWire(a, { node: id, slot: `arg${i}` }, env));
    return id;
  }
}

/** Formals + body of a wireframe-material define (function form or lambda RHS). */
function defineShape(form: APair<SchemeValue, SchemeValue>): { params: string[]; bodyForms: unknown[] } {
  const rest = form.cdr;
  if (!(rest instanceof APair)) return { params: [], bodyForms: [] };
  const target = rest.car;
  if (target instanceof APair) return { params: lambdaParams(target.cdr), bodyForms: chainOf(rest.cdr) };
  const rhs = rest.cdr instanceof APair ? rest.cdr.car : undefined;
  if (rhs instanceof APair && rhs.car instanceof ASymbol && opName(rhs.car) === "lambda" && rhs.cdr instanceof APair) {
    return { params: lambdaParams(rhs.cdr.car), bodyForms: chainOf(rhs.cdr.cdr) };
  }
  return { params: [], bodyForms: rhs === undefined ? [] : [rhs] };
}

/**
 * Whole-program prospective layer: prelude partition, port-reaching defines →
 * named templates, main forms (last → egress; earlier value-dropped).
 */
export function buildWireframe(forms: readonly SchemeValue[], opts: WireframeBuildOptions): WireframeProgram {
  const membership = classifyProgramPrelude(forms, opts.classifier);
  const preludeSource = buildPreludeSource(forms, membership);
  const bctx: BuildCtx = {
    classifier: opts.classifier,
    reachClassifier: {
      roleOf: (op) => (membership.wireframe.has(op) ? "opaque" : opts.classifier.roleOf(op)),
    },
    preludeNames: membership.pure,
    materialNames: membership.wireframe,
    isBaseName: opts.isBaseName,
    // eslint-disable-next-line unicorn/no-negated-condition -- omit callbackRolesOf when the caller did not supply it
    ...(opts.callbackRolesOf !== undefined ? { callbackRolesOf: opts.callbackRolesOf } : {}),
  };

  const templates = new Map<string, DefineTemplate>();
  for (const form of forms) {
    const name = defineNameOf(form);
    if (name === null || !membership.wireframe.has(name) || !(form instanceof APair)) continue;
    const { params, bodyForms } = defineShape(form);
    const g = new GraphBuilder(bctx);
    const subst = new Map<string, LineageNode>(params.map((p) => [p, LEAF(p)]));
    const env: WalkEnv = { subst, frames: [] };
    for (const dropped of bodyForms.slice(0, -1)) g.walkDropped(dropped, env);
    if (bodyForms.length > 0) g.emitEgress(bodyForms.at(-1), env);
    templates.set(name, { params, graph: g.finish() });
  }

  const mainForms = forms.filter((f) => defineNameOf(f) === null);
  const main = new GraphBuilder(bctx);
  const rootEnv: WalkEnv = { subst: new Map(), frames: [] };
  mainForms.forEach((form, i) => {
    if (i < mainForms.length - 1) main.walkDropped(form, rootEnv);
    else main.emitEgress(form, rootEnv);
  });

  return {
    prelude: { names: membership.pure, source: preludeSource },
    membership,
    templates,
    main: main.finish(),
  };
}
