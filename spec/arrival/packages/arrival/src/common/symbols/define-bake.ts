// define-bake — bake-time machinery for `symbol.define`/`symbol.defineSyntax` that cannot
// run at factory-call time: body parse + span-location, FV locality + eager-forward-reference
// check, derived-role classification, evaluate-then-bind (two-phase, sequential-RHS).
// Invoked from `../capability.ts` apply() Pass 2 after phase 1 (every non-define kind) binds.
//
// docs/environments.md §PRELUDE — Pass-2 order, FV locality, derived-role (§AXES). This file
// is the enforcement site.
//
// Kept out of capability.ts: pulls reader, lineage classifier, prelude fixpoint, call-function/
// Macro — machinery capability otherwise never touches. One-directional edge; CapabilityLike/
// ExportableSpec are local structural types so this file never imports the class it serves.

import invariant from "tiny-invariant";
import { ZodError } from "zod";
import * as z from "../scheme-zod/index.js";
import { formatPositionalRejection } from "./positional-rejection.js";
import { parse as readerParse } from "../../reader/parse.js";
import { freeVars } from "../../provenance/wireframe/free-vars.js";
import type { Classifier, DeclaredRole } from "../../provenance/lineage.js";
import { classifyProgramPrelude } from "../../provenance/prelude.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError } from "../../errors.js";
import { APair } from "../../values/primitives/APair.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { nil } from "../../values/primitives/ANil.js";
import { type ACallable } from "../../values/primitives/ACallable.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { call_function } from "../../eval/call-function.js";
import { Macro, type TransformerArgs } from "../../eval/Macro.js";
import type { SchemeValue } from "../../values/types.js";
import type { EvalSchemeInto, SchemeEnv } from "../scheme-env.js";
import type { PreludeBindTarget } from "../kernel.js";
import type { AEntity, DefineSymbolDef, DefineSyntaxSymbolDef, ProvenanceRole } from "./_bake.js";

// ── Local structural types (no import of capability.js) ──────────────────────

/** Slice of EnvCapability the allowlist/exports walk needs. */
export interface CapabilityLike {
  readonly name: string;
  readonly spec: {
    readonly deps?: readonly CapabilityLike[];
  };
  exports(): Promise<ReadonlySet<string>>;
}

/** Slice of CapabilitySpec for exports computation. */
export interface ExportableSpec {
  readonly symbols?: unknown; // plain record; typeof guard defends type-erased specs
  readonly prelude?: string;
}

// ── KEYWORD_SYNTAX baseline ──────────────────────────────────────────────────
// Core's keyword-bound names, unconditional: every SPECIAL_FORMS entry is also a
// symbol.keyword in env/core. Hardcoded (not derived from scheme/core dep) — assembled
// mode roots core universally; gating on dep-declaration would under-allow defines using
// if/cond/let merely because THIS capability doesn't list scheme/core.

// ── Resolver-synth family ────────────────────────────────────────────────────
// car/cdr/c[ad]+r are NOT capability exports — synthesized by eval/Resolver.ts cxrUnfold
// after ordinary env miss. Local CXR_RE copy (same convention as vocabulary.ts / Resolver.ts).

const CXR_RE = /^c[ad]+r$/;

export const KEYWORD_SYNTAX_BASELINE: ReadonlySet<string> = new Set([
  "lambda",
  "define",
  "define-macro",
  "let",
  "let*",
  "letrec",
  "letrec*",
  "and",
  "or",
  "if",
  "begin",
  "quote",
  "quasiquote",
  "cond",
  "case",
  "when",
  "unless",
  "do",
  "while",
  "try",
]);

// ── Parse + span-locate, memoized per def object ─────────────────────────────

const parseCache = new WeakMap<DefineSymbolDef | DefineSyntaxSymbolDef, SchemeValue>();

/** Parse body with `source = "«capability»#«name»"` so errors locate. Exactly one top-level
 *  form (the RHS expression) — 0 or 2+ is an authoring bug. */
export async function parseDefineBody(
  capabilityName: string,
  def: DefineSymbolDef | DefineSyntaxSymbolDef,
): Promise<SchemeValue> {
  const cached = parseCache.get(def);
  if (cached !== undefined) return cached;
  const forms = await readerParse(def.body, `${capabilityName}#${def.name}`);
  invariant(
    forms.length === 1,
    `symbol.${def.kind} "${def.name}" @ ${capabilityName}: body must parse to exactly ONE expression (the RHS), got ${forms.length}`,
  );
  const form = forms[0];
  parseCache.set(def, form);
  return form;
}

// ── Local walkers (same per-file convention as slice/prelude/free-vars) ──────

/** Top-level form is `(lambda …)`? Lambda RHS late-binds — forward refs resolve at call time. */
function isLambdaForm(body: unknown): boolean {
  return body instanceof APair && body.car instanceof ASymbol && body.car.__name__ === "lambda";
}

function unevaluatedMacroArgForms(code: unknown): SchemeValue[] {
  const out: SchemeValue[] = [];
  let cur: unknown = code;
  while (cur instanceof APair) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

/** Synthesize the form classifyProgramPrelude expects from a define's RHS.
 *  Callable: reconstruct `(define (name . formals) . bodyForms)` so the classifier's function
 *  arm strips the lambda and classifies the last body form — plain `(define name (lambda …))`
 *  would make every procedure look port-free. Constant: plain `(define name value)`.
 *  CONSTANT_CTX is a structural sentinel (pre-run bake; walks never read .ctx). */
function synthesizeDefine(name: string, body: SchemeValue): SchemeValue {
  const nameSym = new ASymbol(name);
  if (
    body instanceof APair &&
    body.car instanceof ASymbol &&
    body.car.__name__ === "lambda" &&
    body.cdr instanceof APair
  ) {
    const formals = body.cdr.car;
    const bodyForms = body.cdr.cdr;
    return new APair(new ASymbol("define"), new APair(new APair(nameSym, formals), bodyForms));
  }
  return new APair(new ASymbol("define"), new APair(nameSym, new APair(body, nil)));
}

/** Every EnvCapability reachable from roots (identity-deduped, roots first). */
function transitiveDeps(roots: readonly CapabilityLike[]): CapabilityLike[] {
  const seen = new Set<CapabilityLike>();
  const out: CapabilityLike[] = [];
  const visit = (cap: CapabilityLike): void => {
    if (seen.has(cap)) return;
    seen.add(cap);
    out.push(cap);
    for (const dep of cap.spec.deps ?? []) visit(dep);
  };
  for (const r of roots) visit(r);
  return out;
}

// ── EnvCapability.exports() — symbols keys ∪ prelude define names ────────────

const DEFINE_HEADS = new Set(["define", "define-macro", "define-syntax"]);

/** Top-level define/define-macro/define-syntax names in source. */
export async function macroAwareDefineNames(source: string): Promise<ReadonlySet<string>> {
  const forms = await readerParse(source);
  const names = new Set<string>();
  for (const form of forms) {
    const name = defineHeadNameOf(form);
    if (name !== null) names.add(name);
  }
  return names;
}

function defineHeadNameOf(form: unknown): string | null {
  if (!(form instanceof APair) || !(form.car instanceof ASymbol)) return null;
  const head = form.car.__name__;
  if (typeof head !== "string" || !DEFINE_HEADS.has(head)) return null;
  if (!(form.cdr instanceof APair)) return null;
  const target = form.cdr.car;
  if (target instanceof APair && target.car instanceof ASymbol) {
    // (define (name args…) …) / (define-macro (name . args) …)
    return typeof target.car.__name__ === "string" ? target.car.__name__ : null;
  }
  if (target instanceof ASymbol) {
    // (define name value) / (define-syntax name (syntax-rules …))
    return typeof target.__name__ === "string" ? target.__name__ : null;
  }
  return null;
}

/** Memoized by the caller, not here. */
export async function computeCapabilityExports(spec: ExportableSpec): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  if (typeof spec.symbols !== "function") {
    for (const key of Object.keys((spec.symbols as Record<string, unknown> | undefined) ?? {})) names.add(key);
  }
  if (spec.prelude !== undefined) {
    for (const n of await macroAwareDefineNames(spec.prelude)) names.add(n);
  }
  return names;
}

// ── Evaluate-then-bind ───────────────────────────────────────────────────────
// Eval `(define tmp body)` against scope via injected evalScheme (never import
// generator-exec — boundary + cycle). Recover boxed value via scope.get(tmp).

let tempCounter = 0;

async function evaluateBody(
  scope: SchemeEnv,
  evalScheme: EvalSchemeInto<SchemeEnv>,
  bodyString: string,
): Promise<unknown> {
  const tempName = `%%arrival-define-tmp%%${tempCounter++}`;
  await evalScheme(scope, `(define ${tempName} ${bodyString})`);
  return scope.get(tempName);
}

// RUNCTX SHARING — lambda-form defines batch: evalLambda always evaluates a lambda body
// against its DEFINITION-TIME ctx.runCtx. Separate evalScheme calls mint separate RunContexts,
// so sibling ALambdas cannot share a WeakMap-keyed dynamic-extent slot. A prelude text blob
// never had this problem (one evalScheme, one RunContext). Fix: batch every lambda-form
// `(define tmp body)` into ONE evalScheme call. Safe because minting a lambda value never
// touches its body (forward refs still resolve at call time). Eager entries stay per-entry
// evaluate-THEN-bindTarget — an eager RHS may need an earlier sibling already bound.

async function evaluateBodies(
  scope: SchemeEnv,
  evalScheme: EvalSchemeInto<SchemeEnv>,
  bodyStrings: readonly string[],
): Promise<unknown[]> {
  const tempNames = bodyStrings.map(() => `%%arrival-define-tmp%%${tempCounter++}`);
  const combinedSource = bodyStrings.map((body, i) => `(define ${tempNames[i]} ${body})`).join("\n");
  await evalScheme(scope, combinedSource);
  return tempNames.map((tempName) => scope.get(tempName));
}

/** Scheme-face validating wrapper: z.decode for throw-on-mismatch only — decoded value
 *  discarded; original scheme args/return flow through (nothing crosses the membrane). */
function buildDefineProcedure(
  verb: string,
  def: DefineSymbolDef,
  closureValue: unknown,
  provenanceRole: ProvenanceRole,
): ANativeProcedure {
  const closure = closureValue as ACallable;
  return new ANativeProcedure({
    name: verb,
    // Arity introspection-only (same as other kinds) — tighten from def.in when surface needs it.
    arity: { min: 0, max: null },
    contract: def,
    provenanceRole,
    // impl(args, callCtx) — thread callCtx.runCtx to call_function. Necessary but not
    // sufficient alone: evalLambda uses definition-time runCtx (see evaluateBodies).
    impl: (rawArgs, callCtx) => {
      const runCtx = callCtx.runCtx;
      // SPINE ADOPTION BEFORE validation. Order is load-bearing: a z.pair slot means
      // "non-empty spine"; a borrowed JS array satisfies that only once projected.
      // Validate first and z.pair rejects the raw array before adoption runs.
      // Adoption ≠ decode: z.decode is plane crossing (discarded here on purpose); adoption
      // is representation on the scheme plane — AValue in, AValue out, O(1), same store.
      const args = def.adoptArgs === undefined ? rawArgs : def.adoptArgs(rawArgs);
      // Rejection is a door: raw ZodError.message is unactionable JSON. Same positional
      // humanizer as the tool-call surface.
      if (def.validate) {
        try {
          z.decode(def.in, args);
        } catch (error) {
          if (error instanceof ZodError) throw new Error(formatPositionalRejection(def.name, error, args, def.in));
          throw error;
        }
      }
      return (async (): Promise<SchemeValue> => {
        // unknown until validated: multi-value arm reads as array. Promise.resolve for honest Thenable.
        const result: unknown = await Promise.resolve(call_function(closure, args as SchemeValue[], { runCtx }));
        if (def.validate) {
          const resultVector: readonly unknown[] = def.singleOut ? [result] : (result as readonly unknown[]);
          z.decode(def.out, resultVector);
        }
        return result as SchemeValue;
      })();
    },
  });
}

/** Wind evaluated `(lambda (formals expr . body) …)` into a Macro fexpr transformer.
 *  Transformer receives unevaluated call-site forms; applies through call_function
 *  (closure's definition-time scope, not use site's env). */
function buildMacro(verb: string, def: DefineSyntaxSymbolDef, closureValue: unknown): Macro {
  const closure = closureValue as ACallable;
  const macro = new Macro(
    verb,
    function (this: unknown, code: unknown, evalArgs: TransformerArgs): Promise<SchemeValue> {
      const argForms = unevaluatedMacroArgForms(code);
      // evalArgs.runCtx is required — is_macro dispatch always threads live EvalContext.runCtx.
      return Promise.resolve(call_function(closure, argForms, { runCtx: evalArgs.runCtx })) as Promise<SchemeValue>;
    },
    def.doc,
  );
  // Declared ternary walk attribute for assembled-mode vocabulary.
  macro.macroAttribute = def.macroAttribute;
  return macro;
}

// ── Orchestration — capability.ts apply() Pass 2 ─────────────────────────────

export interface BindCapabilityDefinesArgs {
  readonly capabilityName: string;
  /** Every verb this capability declares (phase 1 + phase 2) — letrec* name visibility. */
  readonly ownNames: ReadonlySet<string>;
  /** define/define-syntax entries in declaration order. */
  readonly entries: readonly (readonly [string, DefineSymbolDef | DefineSyntaxSymbolDef])[];
  readonly deps: readonly CapabilityLike[];
  /** Names outside this define set resolve from here (phase 1 + deps). */
  readonly env: SchemeEnv;
  /** Body evaluation target (`ctx?.preludeEvalScope ?? env`). */
  readonly scope: SchemeEnv;
  readonly bindTarget: (def: AEntity) => PreludeBindTarget;
  readonly evalScheme?: EvalSchemeInto<SchemeEnv>;
}

export async function bindCapabilityDefines(args: BindCapabilityDefinesArgs): Promise<void> {
  const { capabilityName, ownNames, entries, deps, env, scope, bindTarget } = args;
  if (entries.length === 0) return;
  invariant(
    args.evalScheme !== undefined,
    `capability "${capabilityName}" has symbol.define/symbol.defineSyntax declarations but no evalScheme was provided to lower()`,
  );
  const evalScheme = args.evalScheme;

  const parsedByDef = new Map<DefineSymbolDef | DefineSyntaxSymbolDef, SchemeValue>();
  for (const [, def] of entries) parsedByDef.set(def, await parseDefineBody(capabilityName, def));

  const allowlist = new Set<string>(KEYWORD_SYNTAX_BASELINE);
  for (const n of ownNames) allowlist.add(n);
  for (const dep of transitiveDeps(deps)) for (const n of await dep.exports()) allowlist.add(n);

  // FV law + eager-forward-ref — define bodies only (defineSyntax FVs name expansion env).
  const remaining = new Set(entries.map(([verb]) => verb));
  for (const [verb, def] of entries) {
    remaining.delete(verb); // remaining = names declared strictly AFTER this one
    if (def.kind !== "define") continue;
    const body = parsedByDef.get(def)!;
    const free = freeVars(body);
    for (const name of free) {
      if (allowlist.has(name)) continue;
      if (CXR_RE.test(name)) continue; // resolver-synth family
      throw new DefineLocalityError(name, def.name, capabilityName);
    }
    if (!isLambdaForm(body)) {
      for (const name of free) {
        if (remaining.has(name)) throw new DefineForwardReferenceError(def.name, name, capabilityName);
      }
    }
  }

  // Derived provenance: fixpoint over this capability's define set; env-derived classifier
  // for everything outside (phase 1 + deps).
  const defineEntries = entries.filter((e): e is readonly [string, DefineSymbolDef] => e[1].kind === "define");
  const classifier: Classifier = {
    roleOf: (op) =>
      (env.get(op, { throwError: false }) as { provenanceRole?: DeclaredRole } | undefined)?.provenanceRole,
  };
  const syntheticForms = defineEntries.map(([verb, def]) => synthesizeDefine(verb, parsedByDef.get(def)!));
  const membership = classifyProgramPrelude(syntheticForms, classifier);
  const derivedRoleByVerb = new Map<string, ProvenanceRole>();
  for (const [verb] of defineEntries) derivedRoleByVerb.set(verb, membership.wireframe.has(verb) ? "opaque" : "pipe");
  for (const [verb, def] of defineEntries) {
    const derived = derivedRoleByVerb.get(verb)!;
    if (def.declaredProvenance !== undefined && def.declaredProvenance !== derived) {
      throw new ProvenanceRoleShapeError(
        def.name,
        def.declaredProvenance,
        `derived (the capability-set fixpoint over "${capabilityName}"'s own symbol.define set) as ` +
          `"${derived}" — ${membership.reasons.get(verb) ?? "its body is fixpoint-closed (reaches no port, directly or transitively)"}`,
      );
    }
  }

  // Evaluate + bind sequentially. Lambda forms pre-evaluated as one batch (shared RunContext);
  // eager entries interleaved evaluate-then-bindTarget.
  const lambdaValueByDef = new Map<DefineSymbolDef | DefineSyntaxSymbolDef, unknown>();
  {
    const lambdaEntries = entries.filter(([, def]) => isLambdaForm(parsedByDef.get(def)!));
    const lambdaValues = await evaluateBodies(
      scope,
      evalScheme,
      lambdaEntries.map(([, def]) => def.body),
    );
    for (let i = 0; i < lambdaEntries.length; i++) lambdaValueByDef.set(lambdaEntries[i][1], lambdaValues[i]);
  }
  for (const [verb, def] of entries) {
    const value = lambdaValueByDef.has(def)
      ? lambdaValueByDef.get(def)
      : await evaluateBody(scope, evalScheme, def.body);
    if (def.kind === "define-syntax") {
      bindTarget(def).set(verb, buildMacro(verb, def, value));
      continue;
    }
    if (!def.callable) {
      if (def.validate) z.decode(def.out, [value]);
      bindTarget(def).set(verb, value);
      continue;
    }
    const proc = buildDefineProcedure(verb, def, value, derivedRoleByVerb.get(verb) ?? "pipe");
    bindTarget(def).set(verb, proc);
  }
}
