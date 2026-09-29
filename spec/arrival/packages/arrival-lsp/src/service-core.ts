// service-core is the environment-agnostic "Scheme LSP over TS LSP".
//
// It emits Scheme → virtual TS (`emitTypes`), runs it through one `ts.LanguageService`
// against the PRE + leaves, then maps results back to Scheme coordinates via `Mapper`.
//
// The public surface is shaped for direct use by CodeMirror adapters.
//
// It never touches fs or `ts.sys` — `ServiceEnvironment` supplies the files
// (disk in Node, glob in browser). The prelude map is built once; only the
// program snapshot changes per call.

// The dep-free virtual-file name constants (no node:fs — service-core runs in the
// browser too).
import { PROGRAM_FILE } from "@inhuman.tools/arrival-internals-types-prelude/virtual-files";
// The runtime-free reader (spans on every node) — the require scanner's truth.
import { parseSexprs, type Node } from "@inhuman.tools/arrival-sugarcoat";
import {
  emitRequireFaceModule,
  emitTypes,
  encodeSchemeIdent,
  decodeSchemeIdent,
  schemeifyTsText,
} from "@inhuman.tools/arrival-types-bridge";
import ts from "typescript";

import { balancePrefix, stringLiteralType } from "./balance.js";
import { Mapper } from "./span-map.js";

// balancePrefix lives in balance.ts (alternate backends import it without dragging
// `typescript` into their chunk); re-exported here for consumers.
export { balancePrefix } from "./balance.js";

const SENTINEL = "qzcursorzq"; // plain letters only (emitTypes cleanName)

export interface SchemeDiagnostic {
  start: number;
  length: number;
  line: number;
  character: number;
  severity: "error" | "warning" | "suggestion" | "message";
  code: number;
  messageText: string;
}

export interface SchemeQuickInfo {
  displayText: string;
  documentation: string;
  span: { start: number; length: number } | null;
}

export interface SchemeCompletionEntry {
  name: string;
  kind: string;
  sortText: string;
  insertText?: string;
}

export interface SchemeRichCompletion extends SchemeCompletionEntry {
  detail?: string;
  fits?: boolean;
  callable?: boolean;
}

export interface SchemeCompletionContext {
  /** Σ-style cursor position: head of a form / argument of a call / top level. */
  position: "operator" | "argument" | "top";
  /** At an argument slot: the enclosing call + which parameter the cursor
   *  fills, with the parameter's type rendered (`xs: List<number>`). */
  slot?: { callee: string; argIndex: number; paramType?: string };
  entries: SchemeRichCompletion[];
}

export interface SchemeClassifiedSpan {
  start: number;
  length: number;
  /** The tsc 2020-format token type: `"parameter"`, `"variable"`, `"function"`,
   *  `"property"`, `"class"`, `"interface"`, `"type"`, `"typeParameter"`, … */
  kind: string;
}

export interface SchemeDefinition {
  /** The defined symbol's name. */
  name: string;
  /** The `ts.ScriptElementKind` string. */
  kind: string;
  /** The Scheme span of the definition (lifted), or `null` if it lands in the
   *  prelude/infrastructure (a builtin's `.d.ts` has no Scheme source). */
  span: { start: number; length: number } | null;
  /** Present when the definition lives in a REQUIRED file: the require-path of
   *  that file (the span is in THAT file's coordinates). Absent = this buffer. */
  file?: string;
}

export interface SchemeLanguageServiceOptions {
  /** Override the tsc compiler options used for the virtual compilation. */
  compilerOptions?: ts.CompilerOptions;
  /**
   * `(require "path")` resolution — THE seam that keeps the lens filesystem-
   * blind (it runs in workers, browsers, tests): given the require string
   * verbatim, return that file's SOURCE, or null when unknown. When present,
   * the whole require closure (recursively, cycle-safe) is emitted AHEAD of
   * the program in the same virtual module — scheme's load-into-scope
   * semantics — so required defines resolve, type-flow, complete, and
   * goto-def across files. Absent → requires stay no-ops (soft suggestions).
   */
  resolveModule?: (path: string) => string | null;
  /**
   * Host-injected rosetta tools (sift's evidence tools), the seam that makes the type
   * mask narrow on injected symbols — not just the builtins. Two coupled parts, both
   * derived from ONE source (the env's rosetta-type registry, `rosettaTypesOf` —
   * host tools register via `symbol.rosetta` / internal bind), via `assembleHostPrelude`:
   *   • `prelude` — ambient `.d.ts` text with `declare function <encoded>…` per tool
   *     (+ the host's entity types), same global scope as the builtin leaves. Makes
   *     `typeof <encoded>` resolve → the CANDIDATE side narrows.
   *   • `members` — the host member names (scheme spelling). The emitter lowers a
   *     head in this set via bare `encodeSchemeIdent(name)(…)` so
   *     `Parameters<typeof head>` resolves → the SLOT side narrows.
   */
  host?: {
    prelude: string;
    members: readonly string[];
    /** Heads with record-shaped Contract inputRest — see HostPrelude.kwargsMembers. */
    kwargsMembers?: readonly string[];
  };
  /**
   * The scheme STDLIB preamble source (arrival's `BUILTIN_PREAMBLE`) — the
   * `(define …)` helpers that are themselves written in scheme (`field`,
   * `values-of`, `keys-of`, `entries-of`, `take`, `drop`, `count-if`,
   * `infer/chat/*`, `s/*`, and the `define/overridable` family). These are NOT
   * rosettas (no native impl, no `.d.ts` leaf) — they are scheme source that the
   * runtime always loads ahead of the user's program. The lens emits this source
   * into the SAME virtual module ahead of the require closure (an implicit,
   * always-present dependency) so its defines resolve, type-flow, and complete
   * exactly like a required file's. DERIVED from the one source of truth — never
   * restated as hand-written leaves. Absent → those names read as unresolved.
   */
  schemePrelude?: string;
  /**
   * `(require "data.json")` → granular SHAPE — the editor twin of the runtime
   * loader registry. Given a `(require)`d path verbatim, return the TS type the
   * lens should give that require (plain TS + `List<…>`/object literals), or
   * null when the path has no static shape (a `.scm` library, an opaque blob).
   * DERIVED host-side from the SAME loader registry the runtime parses with
   * (`resolveRequireType` over the kernel loader), so a custom extension's
   * `type` provider reaches the editor too.
   *
   * For each require path that yields a non-null shape, the lens builds a
   * virtual module `__req__/<path>.ts` with `export default` of that face
   * (require-as-import — not a flat `declare function require("path")` overload
   * bag, which broke when only a subset of paths had shapes: `"x.hbs"` was not
   * assignable to the only specialized parameter `"y.yaml"`). The program
   * `import`s those defaults; `emitTypes` rewrites `(require "path")` to the
   * binding. A shaped path is ALSO skipped as a scheme dependency (data, not
   * loadable forms). Absent → every require stays `unknown` via the host
   * ambient. */
  resolveRequireType?: (path: string) => string | null;
  /**
   * Require-path suffixes whose `(require "…")` result is a kwargs callable.
   * Host-supplied (e.g. `[".prompt"]`). Empty ⇒ the emitter does not treat any
   * require path as kwargs.
   */
  kwargsRequireSuffixes?: readonly string[];
}

/**
 * Where the virtual compilation's NON-PROGRAM files come from — the seam between
 * the environment-agnostic core and the entry that knows the platform.
 */
export interface ServiceEnvironment {
  /** The prelude file map (PRE + builtin leaves) — the compilation's root files
   *  besides the program. The core adds `__host.d.ts` / `__program.ts` on top. */
  rootFiles: Map<string, string>;
  /** Lookup-only virtual files (the TS default-lib chain in the browser) — served
   *  to the compiler when it asks, but never offered as root files. */
  supportFiles?: ReadonlyMap<string, string>;
  /** Resolve the default-lib file name for the merged compiler options. Node:
   *  `ts.getDefaultLibFilePath`; browser: the bundled lib's virtual file name. */
  getDefaultLibFileName: (options: ts.CompilerOptions) => string;
  /** Optional real-fs fallback (Node: `ts.sys`) for files outside the maps —
   *  the on-disk default-lib chain. Absent in the browser: maps are everything. */
  sys?: Pick<ts.System, "readFile" | "fileExists" | "readDirectory" | "directoryExists" | "getDirectories">;
}

// tsc's 2020-format semantic token types, by index (the encoding packs
// `(tokenType + 1) << 8`, so decode with `(classification >> 8) - 1`).
const TOKEN_TYPES = [
  "class",
  "enum",
  "interface",
  "namespace",
  "typeParameter",
  "type",
  "parameter",
  "variable",
  "enumMember",
  "property",
  "function",
  "member",
] as const;

const SCHEME_ATOM = /^[\w\-!$%&*+./<=>?@^~:]+$/;

export interface RequireRef {
  path: string;
  span: { start: number; length: number };
}

export function scanRequires(scheme: string): RequireRef[] {
  let forest: Node[];
  try {
    forest = parseSexprs(scheme);
  } catch {
    return [];
  }
  const out: RequireRef[] = [];
  for (const form of forest) {
    if (!("list" in form) || form.span === undefined) continue;
    const [head, arg] = form.list;
    if (head === undefined || !("atom" in head) || head.atom !== "require") continue;
    if (arg === undefined || !("atom" in arg) || arg.str !== true) continue;
    out.push({ path: arg.atom, span: { start: form.span[0], length: form.span[1] - form.span[0] } });
  }
  return out;
}

/** Every `(require "literal")` path ANYWHERE in the tree — value-position
 *  (`(define x (require "data.json"))`) included, not just statement-position.
 *  `scanRequires` finds the top-level load-into-scope requires (the `.scm` dep
 *  closure); this finds the data-file requires whose VALUE is bound, so the lens
 *  can give each its precise shape. Deduped, order-preserving. */
export function scanAllRequirePaths(scheme: string): string[] {
  let forest: Node[];
  try {
    forest = parseSexprs(scheme);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const visit = (node: Node): void => {
    if (!("list" in node)) return;
    const [head, arg] = node.list;
    if (
      head !== undefined &&
      "atom" in head &&
      head.atom === "require" &&
      arg !== undefined &&
      "atom" in arg &&
      arg.str === true
    ) {
      seen.add(arg.atom);
    }
    for (const child of node.list) visit(child);
  };
  for (const form of forest) visit(form);
  return [...seen];
}

/** Scheme-legal forms tsc rejects: redefinition is allowed in scheme — both
 *  `(define x 1) (define x 2)` in one file AND a program define shadowing a
 *  required one — but the flat `const` emit makes tsc cry 2451/2300. */
const SCHEME_LEGAL_TS_CODES = new Set([2451 /* Cannot redeclare */, 2300 /* Duplicate identifier */]);

/** "Cannot find name" siblings tsc tacks an ambient-lib install suggestion onto
 *  ("Do you need to install type definitions for node? Try `npm i --save-dev
 *  @types/node`...") — noise in a scheme file, never actionable. Folded into
 *  the same 2304/2552 SUGGESTION branch below so the tail never reaches the user. */
const NOISY_SUGGESTION_TS_CODES = new Set([
  2580 /* node */, 2591 /* require/module/exports, node */, 2581 /* jQuery */, 2592 /* jQuery */,
  2582 /* test runner */, 2593 /* test runner */, 2583 /* target library */, 2584 /* target library */, 2867 /* Bun */,
  2868 /* Bun */,
]);

/** Collect the rendered types a parameter's USE SITES expect inside `body`
 *  (checker.getContextualType per occurrence). Inner arrows re-binding the
 *  name shadow it (skipped). `null` = blocked: a site demanded a type the
 *  annotation gate rejects — conflicting/unprintable evidence, do not annotate. */
function expectedTypesOf(name: string, body: ts.Node, checker: ts.TypeChecker): Set<string> | null {
  const expected = new Set<string>();
  let blocked = false;
  const walk = (n: ts.Node): void => {
    if (blocked) return;
    // An inner arrow re-binding the name shadows it — stop descending.
    if (ts.isArrowFunction(n) && n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return;
    if (ts.isIdentifier(n) && n.text === name) {
      const t = checker.getContextualType(n);
      if (t !== undefined) {
        const rendered = checker.typeToString(t);
        if (annotatableType(rendered)) expected.add(rendered);
        else if (rendered !== "any" && rendered !== "unknown") blocked = true;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return blocked ? null : expected;
}

/**
 * Call-site twin of {@link expectedTypesOf}: for a const-bound arrow
 *   `const f = (a, b) => …`  with later  `f(x, y)`
 * collect the checker type of argument `paramIndex` at every call of `f`.
 *
 * Used when body use-sites give no domain (compose pipelines):
 *   `(define state-of (compose :state last :versions))`
 *   → `const state$dash$of = (it) => last(it["versions"])["state"]`
 *   + `state$dash$of(persona)` where `persona` is a typed row
 *   → annotate `it: <persona type>` so `last` returns a row with `.state`.
 *
 * Body use-site contextual typing cannot see this (indexing `it["versions"]`
 * has no useful expected type). Call sites are the domain of the function.
 *
 * Literal args are widened (`5` → `number`, `"a"` → `string`) so a single
 * call never pins a param to a singleton literal that then fights the body.
 *
 * Empty set = no usable call-site evidence (not blocked). `null` = blocked.
 */
function expectedTypesFromCallSites(
  fnName: string,
  paramIndex: number,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): Set<string> | null {
  const expected = new Set<string>();
  let blocked = false;
  const walk = (n: ts.Node): void => {
    if (blocked) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === fnName &&
      n.arguments[paramIndex] !== undefined
    ) {
      const raw = checker.getTypeAtLocation(n.arguments[paramIndex]!);
      // Widen 5/"hi"/true so call-site domain is a type, not a singleton literal.
      // (Object/row types from compose consumers stay as-is — base of non-literal is itself.)
      const t = checker.getBaseTypeOfLiteralType(raw);
      const rendered = checker.typeToString(t);
      if (annotatableType(rendered)) expected.add(rendered);
      // any/unknown at a call site is "no evidence", not a block — skip.
      else if (rendered !== "any" && rendered !== "unknown" && rendered !== "never") blocked = true;
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return blocked ? null : expected;
}

/**
 * If `arrow` is the initializer of a `const name = (params) => …` binding,
 * return `name`. Only direct const binding — reassignments / exports skipped.
 */
function constBindingNameOfArrow(arrow: ts.ArrowFunction): string | undefined {
  const parent = arrow.parent;
  if (!ts.isVariableDeclaration(parent)) return undefined;
  if (parent.initializer !== arrow) return undefined;
  if (!ts.isIdentifier(parent.name)) return undefined;
  // Prefer const — let/var reassignment would make call-site types lie.
  const list = parent.parent;
  if (!ts.isVariableDeclarationList(list)) return undefined;
  if ((list.flags & ts.NodeFlags.Const) === 0) return undefined;
  return parent.name.text;
}

/** The rendered-type gate for inferred annotations: reject the unknowable and
 *  the unprintable (an annotation must round-trip through the ambient
 *  prelude's vocabulary). */
function annotatableType(rendered: string): boolean {
  if (rendered === "any" || rendered === "unknown" || rendered === "never") return false;
  // Compose/persona shapes can be wide object types — allow more than 60 chars
  // but still reject noise sentinels and runaway dumps.
  if (rendered.length > 200 || rendered.includes("qzcursorzq") || rendered.includes("__")) return false;
  return true;
}

/** Rest annotations that carry no information — leave bare `...args` instead. */
function isTrivialRestType(rendered: string): boolean {
  return (
    rendered === "any" ||
    rendered === "unknown" ||
    rendered === "any[]" ||
    rendered === "unknown[]" ||
    rendered === "List<any>" ||
    rendered === "List<unknown>" ||
    rendered === "readonly any[]" ||
    rendered === "readonly unknown[]"
  );
}

/**
 * `List<string>` / `string[]` as a *rest* annotation is almost always an overfit:
 * multi-pass inference pins the map callback to `string` (string-append / narrow),
 * then forces `args: List<string>`, rejecting polymorphic rest (polyglot `str`
 * accepts any via `repr`). Bare rest is honest; body still typechecks.
 */
function isOverfitPrimitiveRestList(rendered: string): boolean {
  return (
    /^(List|ReadonlyArray|readonly\s+\w+\[\]|Array)<(string|number|boolean)>$/.test(rendered) ||
    /^(string|number|boolean)\[\]$/.test(rendered) ||
    /^readonly (string|number|boolean)\[\]$/.test(rendered)
  );
}

/**
 * Common denominator of rendered types from consumers.
 * One type → that type. Several → small union when all annotatable. Else null
 * (no forced annotation — better bare than a wrong invent).
 */
function commonDenominatorType(types: ReadonlySet<string>): string | null {
  const usable = [...types].filter((t) => annotatableType(t) && !isTrivialRestType(t));
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0]!;
  if (usable.length <= 4) return [...usable].sort().join(" | ");
  return null;
}

/**
 * Rest / bare-formals annotation.
 *
 * 1. Body consumers of the rest *list* (e.g. `map(f, args)` expects a list) —
 *    one non-trivial type wins.
 * 2. Body present but only trivial (`List<any>`) or conflicting → **leave bare**.
 *    Do NOT mine call-site elements: partial usage overfits (polyglot `str` is
 *    often called with strings, so call sites said `List<string>`, then
 *    `(str "\n" (map …))` failed — but runtime `str` accepts any via `repr`).
 * 3. Body completely silent (no contextual uses) → call-site *element* common
 *    denom as `List<T>`.
 */
function inferRestParamAnnotation(
  restName: string,
  body: ts.ConciseBody,
  boundName: string | undefined,
  restParamIndex: number,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): string | null {
  const bodyTypes = expectedTypesOf(restName, body, checker);
  if (bodyTypes !== null && bodyTypes.size > 0) {
    if (bodyTypes.size === 1) {
      const t = [...bodyTypes][0]!;
      if (!isTrivialRestType(t) && !isOverfitPrimitiveRestList(t) && annotatableType(t)) {
        return t;
      }
    }
    // Trivial / primitive-list overfit / multi: bare rest (polymorphic domain).
    return null;
  }
  // Body silent — hand off to call-site elements.
  if (boundName === undefined) return null;
  const elements = expectedRestElementTypesFromCallSites(boundName, restParamIndex, sf, checker);
  if (elements === null) return null;
  const el = commonDenominatorType(elements);
  if (el === null) return null;
  if (el.startsWith("List<") || /\[\]$/.test(el) || el.startsWith("readonly ")) return el;
  return `List<${el}>`;
}

/**
 * Element types contributed to a rest param by call sites of `fnName`.
 * For `f(a, b, c)` with rest at index 1 → types of `b` and `c` (not `a`).
 * Bare formals rest at 0 → every argument's type.
 */
function expectedRestElementTypesFromCallSites(
  fnName: string,
  restParamIndex: number,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): Set<string> | null {
  const expected = new Set<string>();
  let blocked = false;
  const walk = (n: ts.Node): void => {
    if (blocked) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fnName) {
      for (let i = restParamIndex; i < n.arguments.length; i++) {
        const raw = checker.getTypeAtLocation(n.arguments[i]!);
        const t = checker.getBaseTypeOfLiteralType(raw);
        const rendered = checker.typeToString(t);
        if (annotatableType(rendered)) expected.add(rendered);
        else if (rendered !== "any" && rendered !== "unknown" && rendered !== "never") blocked = true;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return blocked ? null : expected;
}

export { schemeifyTsText } from "@inhuman.tools/arrival-types-bridge";

// An atom character (arrival's lexer: not whitespace/bracket/string/quote/comment) —
// the same class the sampler's typed-scanner uses for partial-atom stripping.
const ATOM_CHAR = /[^\s()[\]{}"';]/;

/** The bounds of the atom containing `offset` (both edges = `offset` when the
 *  cursor sits on whitespace/structure — nothing to strip). */
function atomBoundsAt(scheme: string, offset: number): [number, number] {
  let start = offset;
  while (start > 0 && ATOM_CHAR.test(scheme[start - 1]!)) start--;
  let end = offset;
  while (end < scheme.length && ATOM_CHAR.test(scheme[end]!)) end++;
  return [start, end];
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  // ES modules so `import x from "__req__/….ts"` (require-as-import faces) resolve.
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts"],
  types: [],
  skipLibCheck: false,
  // Default export of virtual data/prompt modules is a declare const — allow
  // synthetic defaults if a face ever ships as CJS-shaped text.
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
};

/** Map a tsc `DiagnosticCategory` to the LSP/CodeMirror severity vocabulary. */
function severityOf(category: ts.DiagnosticCategory): SchemeDiagnostic["severity"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    default:
      return "message";
  }
}

/** The object a `createSchemeLanguageService` returns — its methods mirror the
 *  `ts.LanguageService` ones they delegate to, but in Scheme coordinates. */
export interface SchemeLanguageService {
  getSemanticDiagnostics(scheme: string): SchemeDiagnostic[];
  getQuickInfoAtPosition(scheme: string, schemeOffset: number): SchemeQuickInfo | null;
  getCompletionsAtPosition(scheme: string, schemeOffset: number): SchemeCompletionEntry[];
  /**
   * The LOOP-CLOSING completion: the same Σ∩T machinery that masks the
   * sampler's logits (position discrimination + slot-fit probing), surfaced
   * for a human. One call returns everything a rich completion UI needs —
   * entries with signatures + per-candidate slot verdicts + the cursor's
   * position and expected parameter type.
   */
  getCompletionContext(scheme: string, schemeOffset: number): SchemeCompletionContext;
  getDefinitionAtPosition(scheme: string, schemeOffset: number): SchemeDefinition[];
  /**
   * Semantic token classifications in Scheme coordinates — the merge layer over
   * lexical highlighting: an editor keeps the grammar's keyword/string/paren
   * colors and lays the checker's KNOWLEDGE (this is a parameter / a local / a
   * function) on top. Only token-faithful lifts are returned: a TS token whose
   * span lifts to a single scheme ATOM (use-sites). Binder occurrences lift to
   * whole forms under the current emitter mappings and are dropped — the
   * lexical layer already paints binders (definitionKeyword/DEFNAME).
   */
  getSemanticClassifications(scheme: string): SchemeClassifiedSpan[];
  /**
   * Layer T — the type-narrowed mask. Given the bound-symbol `candidates` valid at `schemeOffset`
   * (the sampler's Σ set), return the subset that is TYPE-VALID as the next token of the enclosing
   * call's current argument slot — i.e. a symbol whose value, or whose call's RETURN value, is
   * assignable to that parameter's type. The Σ∩T mask. When the cursor is NOT an argument of a
   * typed call (operator slot / top level / unknown callee), every candidate is returned (no
   * narrowing — Σ already constrains operators; T never *adds* a wrong restriction). A candidate
   * the type system can't resolve (a local binding, an injected tool without a declaration) is
   * kept — conservative: T only ever DROPS a provably ill-typed candidate, never a valid one.
   */
  getTypeValidCandidates(scheme: string, schemeOffset: number, candidates: readonly string[]): string[];
  /**
   * Is the argument slot at `schemeOffset` a LIST/array TS type? `true` ⇒ the slot's expected type
   * `__E` extends `readonly unknown[]` (a tuple like `[number, number]` extends it too — it IS a
   * list materializer slot), `false` ⇒ it does not, `null` ⇒ unresolved (not a typed-call argument,
   * unknown callee, or an un-nameable type). Reuses the SAME slot-location + `__E`-extraction probe
   * machinery as {@link getTypeValidCandidates}; the verdict rides one extra conditional-type alias.
   * Feeds the sampler's PRECISE list-structure gate (the async typed scanner stamps it as
   * `slotIsArray`); `null` leaves that gate a no-op (superset-safe).
   */
  getSlotIsArray(scheme: string, schemeOffset: number): boolean | null;
  /**
   * Does the argument slot at `schemeOffset` ADMIT A BARE WORD AS A STRING VALUE? `true` ⇒ the slot's
   * expected type `__E` accepts a plain string (`string` / `any` / `unknown`) and is NEITHER an array NOR
   * number-only — so a bare value-word (`men`, `classical`) is a fair materialization of the string value
   * (`(fn men)` ≡ `(fn "men")`), and the Σ bound-symbol gate exempts it at this slot. `false` ⇒ the slot is
   * a number / boolean / object / array — a bare word stays MASKED (genuinely wrong there). `null` ⇒
   * unresolved (not a typed-call argument, unknown callee, un-nameable type). Reuses the SAME slot-location +
   * `__E`-extraction machinery as {@link getSlotIsArray}; the verdict rides one extra conditional-type alias.
   * Feeds the sampler's scalar-string Σ exemption (the async typed scanner stamps it as `slotIsStringy`);
   * `null` leaves that exemption inert (the bare word stays Σ-gated — superset-safe). ENUM slots resolve
   * `false` (a string-literal union is not `string`-assignable), which is correct: an enum member is already a
   * BOUND value-symbol that passes Σ on its own, so it needs no exemption.
   */
  getSlotAcceptsBareWord(scheme: string, schemeOffset: number): boolean | null;
  /**
   * The ELEMENT-type verdict at an ARRAY-ELEMENT cursor — the inner twin of {@link getSlotAcceptsBareWord}
   * for a value sitting INSIDE an array surface (`(list …)`, `'(…)`, `[…]`). At an array value slot the
   * element-type bit is LOST the instant the cursor descends past the opener: `(list …)` lowers to the
   * generic `list(…)` whose `Parameters[i]` is `unknown` (→ stringy=true → a bare multi-word word
   * slips in), and `'(…)` lowers to a TS array-LITERAL with no enclosing call (→ the slot probes find
   * nothing). This probe recovers the element type DESPITE the surface:
   *  - `(list …)` / `[…]` / `(array …)`: the cursor is inside a list-MATERIALIZER call — walk OUT to the
   *    array param that materializer fills and read its ELEMENT type (the outer slot's number-index type),
   *    NOT the materializer's own `unknown` param.
   *  - `'(…)`: the quote lowered to a TS array literal — read the element via the literal's CONTEXTUAL type
   *    (its expected array type → number-index element type).
   * Returns `{ isStringy, enum }`:
   *  - `isStringy` — `true` ⇒ the element type is a free-form `string`/`any`/`unknown` (NOT array, NOT
   *    number/boolean/object): the model's bare value-word must be FORCED into a quoted string here (the
   *    INVERSE of the scalar exemption — at an array element a bare multi-word word whitespace-splits at the
   *    scorer, so the quote is forced UPFRONT). `false` ⇒ number/boolean/object/array element. `null` ⇒
   *    unresolved (not an array-element cursor, unknown callee, un-nameable type) ⇒ the force-quote stays inert.
   *  - `enum` — the element type's string-literal-union MEMBERS (the Σ∩T array analog: narrow the element to
   *    exactly these), or `null` when the element is not a finite string-literal union. A `null` here with
   *    `isStringy===true` is the free-form (force-quote) case; a non-null `enum` is the closed-domain case.
   * Feeds the sampler's array-element structure gate (the typed scanner stamps it as
   * `elementIsStringy`/`elementEnum`); a `null`/`null` verdict leaves that gate a no-op (superset-safe).
   */
  getSlotElementType(scheme: string, schemeOffset: number): { isStringy: boolean | null; enum: string[] | null };
  /**
   * Does the HEAD symbol `head` (resolved in `scheme`'s scope) PROVABLY return a LIST/array? `true` ⇒
   * `ReturnType<typeof head>` extends `readonly unknown[]` (a `list`/`vector`/`append`-style materializer —
   * a value of its result is a list, never a scalar), `false` ⇒ it provably does NOT (`car`/`first`/a
   * field accessor return an element `T`; `vector-ref` returns the element), `null` ⇒ unresolved (an
   * un-nameable / unbound head, or a non-callable). The ReturnType TWIN of {@link getSlotIsArray}: same
   * `[…] extends [readonly unknown[]]` test, but over the head's RETURN instead of a slot's expected type.
   *
   * Feeds the sampler's TYPE-REACHABILITY gate (the async typed scanner stamps the provably-array heads as
   * `arrayReturningHeads`). The polarity is the SOUND DUAL of a `ReturnType ⊆ T` query: an uninstantiated
   * generic head (`car<T>` with no argument) infers `R = unknown`, which is NOT `⊆ T` for any concrete `T`,
   * so a `⊆ T` test would DROP `car` and CUT the `(car …)` pipe. Instead we mask only what is PROVABLY array
   * (a dead end at a scalar slot) and ADMIT everything else — `car`/`first`/`:field` (return an element, not
   * an array) and any unresolved head pass, deferring the real value-typing to the argument-slot recursion.
   * `null`/`false` therefore both leave the head ADMITTED (the gate masks only on `true`). Slot-independent:
   * the head's return type is the same wherever it is called, so no slot argument is taken.
   */
  getHeadReturnsArray(scheme: string, head: string): boolean | null;
  /**
   * Is the argument slot at `schemeOffset` STRING-TYPED — its expected type `__E` a subtype of `string`
   * (`string`, `any`-narrowing aside, OR a closed string-literal union like `"fastest" | "scenic"`), and
   * NOT an array? `true` ⇒ a non-string scalar literal (`#t`/`#f`/`#\c`, a NUMBER) is type-wrong here and the
   * structure gate masks it (only a quoted string, a bound enum member, or a `T`-producing call belongs);
   * `false` ⇒ the slot is a number / boolean / object / array (a `#`-literal or number may be RIGHT — do not
   * mask it); `null` ⇒ unresolved. The DISCRIMINATOR {@link getSlotAcceptsBareWord} cannot supply: an ENUM
   * resolves `acceptsBareWord:false` (its members are bound symbols, not free-form `string`) AND a number slot
   * ALSO resolves `false`, so `slotIsStringy===false` alone conflates string-enum with number/boolean — this
   * probe separates them via `[__E] extends [string]` (true for `string` AND a string-literal union, false for
   * number/boolean). Feeds the sampler's structure gate (stamped as `slotIsStringTyped`); `null`/`false` leave
   * the non-string-literal masking inert (superset-safe — a `#`-literal / number stays admitted).
   */
  getSlotIsStringTyped(scheme: string, schemeOffset: number): boolean | null;
  /**
   * Debug dump: the virtual `__program.ts` the lens typechecks for `scheme` —
   * require-as-import lines + scheme-prelude/deps + emitted program + usage-
   * based param annotations. Never runs; exists only so a CLI/host can print
   * what the checker sees. Side-effects the same `programText` cell as every
   * other query (subsequent diagnostics/hover share this snapshot until the
   * next load). Pair with {@link getTypelevelModules} for a self-contained
   * offline typecheck (the program `import`s those virtual faces).
   */
  getTypelevelProgram(scheme: string): string;
  /**
   * Virtual require-face modules from the last {@link getTypelevelProgram} /
   * diagnostics load — keys like `__req__/personas.yaml.ts`, values are the
   * face TS text. Empty when no data/prompt/hbs requires were resolved.
   * Plain record (not Map) so it survives postMessage / offline materialize.
   */
  getTypelevelModules(): Readonly<Record<string, string>>;
}

/**
 * Create a Scheme language service over an explicit {@link ServiceEnvironment}.
 * Reuses ONE prelude file map + ONE `LanguageServiceHost` whose only mutable cell
 * is the emitted `__program.ts` snapshot; each query emits fresh TS for its
 * `scheme` argument and bumps the program version so tsc re-checks it.
 * (Recreate-per-source is fine for v1; an incremental host that diffs the
 * program text is a later optimization.)
 */
export function createSchemeLanguageServiceCore(
  env: ServiceEnvironment,
  opts?: SchemeLanguageServiceOptions,
): SchemeLanguageService {
  const options: ts.CompilerOptions = { ...DEFAULT_OPTIONS, ...opts?.compilerOptions };
  const preludeFiles = env.rootFiles;
  const supportFiles = env.supportFiles ?? new Map<string, string>();
  // Host-injected ambient declare functions (sift's tool declarations).
  if (opts?.host !== undefined) preludeFiles.set("__host.d.ts", opts.host.prelude);
  // The emitter's member roster — a head in this set lowers to a bare encoded
  // global call so its signature bites and its slots narrow. DERIVED from the
  // ambient declare functions (prelude leaves + host), read back off the checker.
  // Lazy: the probe needs `service`.
  let memberRoster: ReadonlySet<string> | null = null;
  const emitterMembers = (): ReadonlySet<string> => {
    memberRoster ??= new Set([...builtinCompletions().map((e) => e.name), ...(opts?.host?.members ?? [])]);
    return memberRoster;
  };
  /** Record-shaped inputRest heads (kwargs channel) — host harvest only; emit also
   *  discovers local kwargs-requires for `opts.kwargsRequireSuffixes`. */
  const emitterKwargsMembers = (): ReadonlySet<string> => new Set(opts?.host?.kwargsMembers);
  const emitterKwargsRequireSuffixes = (): readonly string[] => opts?.kwargsRequireSuffixes ?? [];

  // The scheme stdlib preamble, emitted ONCE to TS and cached — it's constant
  // for the service's lifetime. Sits at the very front of every program module
  // (ahead of the require closure) as an implicit, always-present dependency, so
  // its `(define …)` helpers resolve in program scope. Its own internal spans are
  // unmapped (no Mapper), so any diagnostic inside it is dropped on lift-out.
  let schemePreludeTs: string | null = null;
  const emittedSchemePrelude = (): string => {
    if (schemePreludeTs === null) {
      schemePreludeTs =
        opts?.schemePrelude === undefined
          ? ""
          : emitTypes(opts.schemePrelude, {
              hostMembers: emitterMembers(),
              kwargsMembers: emitterKwargsMembers(),
              kwargsRequireSuffixes: emitterKwargsRequireSuffixes(),
            }).ts.replace(/export \{\};\n$/, "");
    }
    return schemePreludeTs;
  };

  // Mutable program cell + version, bumped each time we set a new emitted module.
  let programText = "export {};\n";
  let programVersion = 0;
  // Per-require virtual modules (data/prompt/hbs): one file each, `export default`
  // the require face. Require-as-import: the open buffer `import`s them instead of
  // a flat `declare function require("path")` overload bag (incomplete bags made
  // `"x.hbs"` fail against the only specialized `"y.yaml"` parameter).
  let dataModules = new Map<string, string>();
  let dataModuleVersion = 0;
  // Emitted TS identifier → the ORIGINAL scheme source spelling it was minted from (see
  // `emitTypes`'s `declaredNames`) — the MAIN program's own defines only (a required file's
  // names are out of scope for THIS buffer's completions). Consumed by `computeEntries` to
  // backport a completion candidate to what the user actually typed: tsc's own completion
  // list answers in EMITTED terms (`cleanName` is lossy/many-to-one — `config/audience` and
  // `config-audience` both emit `configAudience` — so this is populated at the mint site,
  // not derived by inverting the emitted name).
  let programDeclaredNames: ReadonlyMap<string, string> = new Map();

  /** Normalize paths TS resolves (often `/__req__/…` or `./__req__/…`) to map keys. */
  const normPath = (fn: string): string => {
    if (fn === PROGRAM_FILE || fn.endsWith(`/${PROGRAM_FILE}`)) return PROGRAM_FILE;
    return fn.replace(/^\.\//, "").replace(/^\//, "");
  };

  const inMemory = (fn: string): string | undefined => {
    const key = normPath(fn);
    return (
      preludeFiles.get(key) ??
      preludeFiles.get(fn) ??
      supportFiles.get(key) ??
      supportFiles.get(fn) ??
      dataModules.get(key) ??
      dataModules.get(fn)
    );
  };

  /** Resolve `import … from "__req__/path"` / `./__req__/path` to our virtual module. */
  const resolveDataModule = (moduleName: string): string | undefined => {
    const raw = normPath(moduleName);
    const candidates = [raw, raw.endsWith(".ts") ? raw : `${raw}.ts`, `__req__/${raw}`, `__req__/${raw}.ts`];
    for (const c of candidates) {
      if (dataModules.has(c)) return c;
    }
    // Import specifier is the full virt key without leading junk.
    for (const key of dataModules.keys()) {
      if (key === raw || key === `${raw}.ts` || key.endsWith(`/${raw}`) || key.endsWith(`/${raw}.ts`)) return key;
    }
    return undefined;
  };

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...preludeFiles.keys(), ...dataModules.keys(), PROGRAM_FILE],
    getScriptVersion: (fn) => {
      const key = normPath(fn);
      if (key === PROGRAM_FILE) return String(programVersion);
      if (dataModules.has(key) || dataModules.has(fn)) return String(dataModuleVersion);
      return "1";
    },
    getScriptSnapshot: (fn) => {
      const key = normPath(fn);
      if (key === PROGRAM_FILE) return ts.ScriptSnapshot.fromString(programText);
      const inMem = inMemory(fn);
      if (inMem !== undefined) return ts.ScriptSnapshot.fromString(inMem);
      try {
        const onDisk = env.sys?.readFile(fn);
        return onDisk === undefined ? undefined : ts.ScriptSnapshot.fromString(onDisk);
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => env.getDefaultLibFileName(o),
    fileExists: (fn) => {
      const key = normPath(fn);
      return key === PROGRAM_FILE || inMemory(fn) !== undefined || (env.sys?.fileExists(fn) ?? false);
    },
    readFile: (fn) => {
      const key = normPath(fn);
      if (key === PROGRAM_FILE) return programText;
      return inMemory(fn) ?? env.sys?.readFile(fn);
    },
    readDirectory: (path, extensions, exclude, include, depth) =>
      env.sys?.readDirectory(path, extensions, exclude, include, depth) ?? [],
    directoryExists: (dir) => env.sys?.directoryExists(dir) ?? true,
    getDirectories: (dir) => env.sys?.getDirectories(dir) ?? [],
    resolveModuleNameLiterals: (literals) =>
      literals.map((lit) => {
        const resolved = resolveDataModule(lit.text);
        if (resolved === undefined) return { resolvedModule: undefined };
        return {
          resolvedModule: {
            resolvedFileName: resolved,
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          },
        };
      }),
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  // Completion-vocabulary caches (lazy, constant for the service's lifetime —
  // all depend only on the prelude + host, never on the program).
  let baselineNames: Set<string> | null = null;
  let builtinEntries: SchemeCompletionEntry[] | null = null;
  let builtinSigs: Map<string, string> | null = null;

  /** One emitted unit of the require closure: a required file's TS segment in
   *  the concatenated module, with its OWN mapper (its scheme coordinates). */
  interface DepUnit {
    path: string;
    /** [base, base+length) — the unit's TS segment in the program module. */
    base: number;
    length: number;
    mapper: Mapper;
  }

  /** The most recent loadSource's require closure (parallel to the program
   *  mapper the caller got back) — consumed by diagnostics (per-file error
   *  summaries) and definitions (cross-file lifts). */
  let depUnits: DepUnit[] = [];
  let programRequires: RequireRef[] = [];

  /**
   * Emit `scheme` — WITH its require closure when `resolveModule` is present —
   * install the concatenation as the program module, run USAGE-BASED PARAMETER
   * INFERENCE over it (inferParamInsertions: "infer from consumers"), and
   * return a Mapper over the PROGRAM's segment. Required files keep their own
   * mappers in `depUnits`. Closure order is dependencies-first (post-order
   * DFS, visited-set cycle-safe), matching scheme's load semantics; a dep's
   * trailing `export {};` is stripped (one module, one export statement).
   */
  function loadSource(scheme: string): Mapper {
    const resolve = opts?.resolveModule;
    const resolveReqType = opts?.resolveRequireType;
    // Requires are walked when EITHER seam is present: `resolveModule` emits
    // `.scm` deps into scope, `resolveRequireType` drives require-as-import faces.
    programRequires = resolve === undefined && resolveReqType === undefined ? [] : scanRequires(scheme);
    // 1. Emit every unit (deps first), tracking raw segments + LOCAL mappings.
    interface RawUnit {
      path: string;
      base: number;
      length: number;
      source: string;
      localMappings: { tsStart: number; tsLength: number; schemeStart: number; schemeLength: number }[];
    }
    const rawDeps: RawUnit[] = [];
    // Merged across every required file too — `config.scm`-style requires (see
    // run-traced.ts's `(require "config.scm")` note) are the common home for a
    // `define/overridable` cluster, not just the open buffer.
    const depDeclaredNames = new Map<string, string>();
    // The scheme stdlib preamble leads the module — an implicit dependency ahead
    // of the require closure. Untracked in rawDeps: it has no Scheme mapper, so
    // its defines are in scope but its own spans never lift to a diagnostic.
    const prefix = emittedSchemePrelude();
    // Data-file requires resolve to a shape face (virtual module), scheme requires
    // load into scope (dep). A path is a data file iff the registry yields a type
    // for it. Collected over the WHOLE tree (value-position
    // `(define x (require …))` included), deduped, so each `(require "data.json")`
    // gets its precise shape.
    const dataReqTypes = new Map<string, string>();
    const collectDataReqs = (source: string): void => {
      if (resolveReqType === undefined) return;
      for (const path of scanAllRequirePaths(source)) {
        if (dataReqTypes.has(path)) continue;
        const reqType = resolveReqType(path);
        if (reqType !== null) dataReqTypes.set(path, reqType);
      }
    };
    collectDataReqs(scheme);
    // First walk scheme deps only to collect nested data requires (no emit yet).
    if (programRequires.length > 0 && resolve !== undefined) {
      const visitedCollect = new Set<string>();
      const collectDepTree = (path: string): void => {
        if (visitedCollect.has(path)) return;
        visitedCollect.add(path);
        if (dataReqTypes.has(path) || (resolveReqType?.(path) ?? null) !== null) return;
        const source = resolve(path);
        if (source === null) return;
        collectDataReqs(source);
        for (const nested of scanRequires(source)) collectDepTree(nested.path);
      };
      for (const r of programRequires) collectDepTree(r.path);
    }
    // Data/prompt/hbs requires → require-as-import (per-file default export).
    // Face text from type-emit/require-face.ts (simplified twin of build/*-module).
    // Content from resolveModule when the host files table has it (studio/build-typelevel).
    const nextData = new Map<string, string>();
    const importLines: string[] = [];
    const requireBindings = new Map<string, string>();
    let reqI = 0;
    for (const [path, reqType] of dataReqTypes) {
      const virt = `__req__/${path}.ts`;
      const content = resolve?.(path) ?? null;
      nextData.set(
        virt,
        emitRequireFaceModule(path, content, reqType, {
          hostMembers: emitterMembers(),
          kwargsMembers: emitterKwargsMembers(),
          kwargsRequireSuffixes: emitterKwargsRequireSuffixes(),
        }),
      );
      const binding = `__req${reqI++}`;
      importLines.push(`import ${binding} from ${JSON.stringify(`./${virt}`)};`);
      requireBindings.set(path, binding);
    }
    dataModules = nextData;
    dataModuleVersion += 1;
    const importBlock = importLines.length > 0 ? `${importLines.join("\n")}\n` : "";

    // Emit scheme deps (with requireBindings so nested data requires stay imports).
    let depsText = "";
    if (programRequires.length > 0) {
      const visited = new Set<string>();
      const emitDep = (path: string): void => {
        if (visited.has(path)) return;
        visited.add(path);
        if (dataReqTypes.has(path) || (resolveReqType?.(path) ?? null) !== null) return;
        if (resolve === undefined) return;
        const source = resolve(path);
        if (source === null) return;
        for (const nested of scanRequires(source)) emitDep(nested.path);
        const dep = emitTypes(source, {
          hostMembers: emitterMembers(),
          kwargsMembers: emitterKwargsMembers(),
          kwargsRequireSuffixes: emitterKwargsRequireSuffixes(),
          requireBindings,
        });
        const text = dep.ts.replace(/export \{\};\n$/, "");
        const base = prefix.length + importBlock.length + depsText.length;
        rawDeps.push({ path, base, length: text.length, source, localMappings: dep.mappings });
        depsText += text;
        for (const [emittedName, original] of dep.declaredNames) depDeclaredNames.set(emittedName, original);
      };
      for (const r of programRequires) emitDep(r.path);
    }

    const {
      ts: emitted,
      mappings,
      declaredNames,
    } = emitTypes(scheme, {
      hostMembers: emitterMembers(),
      kwargsMembers: emitterKwargsMembers(),
      kwargsRequireSuffixes: emitterKwargsRequireSuffixes(),
      requireBindings,
    });
    const programBase = prefix.length + importBlock.length + depsText.length;
    programText = prefix + importBlock + depsText + emitted;
    programVersion += 1;
    // The main program's OWN names win on collision (a local shadowing a required name is
    // legal scheme — same precedence the completion subtraction/dedup elsewhere gives locals).
    programDeclaredNames = new Map([...depDeclaredNames, ...declaredNames]);

    // 2. Parameter inference (multi-pass): inject `: T` from call sites + body
    // contextual types. Multiple passes so annotations flow through chains —
    // e.g. `demo(sample)` types `p`, then `state-of(p)` types `it` for compose.
    // Each pass recompiles (programVersion++) so the checker sees prior inserts.
    let programMappings: { tsStart: number; tsLength: number; schemeStart: number; schemeLength: number }[] =
      mappings.map((m) => ({ ...m, tsStart: m.tsStart + programBase }));
    const MAX_INFER_PASSES = 4;
    for (let pass = 0; pass < MAX_INFER_PASSES; pass++) {
      const insertions = inferParamInsertions();
      if (insertions.length === 0) break;
      let next = "";
      let at = 0;
      for (const ins of insertions) {
        next += programText.slice(at, ins.pos) + ins.text;
        at = ins.pos;
      }
      programText = next + programText.slice(at);
      programVersion += 1;
      const shiftAt = (p: number): number =>
        p + insertions.reduce((s, ins) => s + (ins.pos <= p ? ins.text.length : 0), 0);
      const widen = (start: number, len: number): number =>
        len + insertions.reduce((s, ins) => s + (ins.pos > start && ins.pos < start + len ? ins.text.length : 0), 0);
      for (const u of rawDeps) {
        const newBase = shiftAt(u.base);
        u.localMappings = u.localMappings.map((m) => ({
          ...m,
          tsLength: widen(u.base + m.tsStart, m.tsLength),
          tsStart: shiftAt(u.base + m.tsStart) - newBase,
        }));
        u.length = shiftAt(u.base + u.length) - newBase;
        u.base = newBase;
      }
      programMappings = programMappings.map((m) => ({
        ...m,
        tsLength: widen(m.tsStart, m.tsLength),
        tsStart: shiftAt(m.tsStart),
      }));
    }

    // 3. Mappers over the FINAL text.
    depUnits = rawDeps.map((u) => ({
      path: u.path,
      base: u.base,
      length: u.length,
      mapper: new Mapper(u.localMappings, u.source, programText.slice(u.base, u.base + u.length)),
    }));
    return new Mapper(programMappings, scheme, programText);
  }

  /**
   * "Infer from consumers" — for every UNANNOTATED arrow parameter, collect a
   * type from TS's checker and inject `: T` when evidence agrees:
   *
   *  1. **Body use sites** (preferred — the function's own contract):
   *     `getContextualType` at each occurrence (e.g. `(string-append str1 …)`
   *     expects string at str1). A misuse call `(concat 5 "b")` must bite on `5`,
   *     not re-annotate `str1: 5` and cry inside the body.
   *  2. **Call sites** (fallback when body has no domain — compose pipelines):
   *     `const f = (it) => …` + `f(persona)` → type of `persona`. Body indexing
   *     `it["versions"]` has no useful expected type; call sites are the domain.
   *
   * Unanimous annotatable type → insert. Conflict / unprintable → skip
   * (never a wrong annotation).
   *
   * **Rest / bare formals** (`...args` from `(lambda args …)`): arbitrary length;
   * type is a handoff to consumers — common denominator of body list uses, else
   * of call-site *element* types. See {@link inferRestParamAnnotation}.
   */
  function inferParamInsertions(): { pos: number; text: string }[] {
    const program = service.getProgram();
    const sf = program?.getSourceFile(PROGRAM_FILE);
    if (!sf || !program) return [];
    const checker = program.getTypeChecker();
    const insertions: { pos: number; text: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isArrowFunction(node)) {
        const boundName = constBindingNameOfArrow(node);
        node.parameters.forEach((param, paramIndex) => {
          if (param.type !== undefined || !ts.isIdentifier(param.name)) return;
          if (param.dotDotDotToken !== undefined) {
            const restAnn = inferRestParamAnnotation(param.name.text, node.body, boundName, paramIndex, sf, checker);
            if (restAnn !== null) {
              insertions.push({ pos: param.name.end, text: `: ${restAnn}` });
            }
            return;
          }
          // Body contract first — misuse call sites must not rewrite the domain.
          let expected = expectedTypesOf(param.name.text, node.body, checker);
          if (expected !== null && expected.size === 0 && boundName !== undefined) {
            // No body evidence (compose / opaque body) — take domain from callers.
            expected = expectedTypesFromCallSites(boundName, paramIndex, sf, checker);
          } else if (expected === null && boundName !== undefined) {
            // Body blocked (conflicting use sites) — do not paper over with call sites.
            expected = null;
          }
          if (expected !== null && expected.size === 1) {
            insertions.push({ pos: param.name.end, text: `: ${[...expected][0]!}` });
          }
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return insertions.toSorted((a, b) => a.pos - b.pos);
  }

  /** The dep unit containing a TS offset of the concatenated module, if any. */
  function depAt(tsOffset: number): DepUnit | null {
    for (const u of depUnits) if (tsOffset >= u.base && tsOffset < u.base + u.length) return u;
    return null;
  }

  return {
    getSemanticDiagnostics(scheme): SchemeDiagnostic[] {
      const mapper = loadSource(scheme);
      const out: SchemeDiagnostic[] = [];
      // Problems INSIDE required files don't belong on this buffer's spans —
      // they roll up into one summary per require form (provenance, not noise).
      const depProblems = new Map<string, number>();
      for (const d of service.getSemanticDiagnostics(PROGRAM_FILE)) {
        if (d.start === undefined) continue;
        // Scheme-legal redefinition (in-file or program-shadows-required) —
        // never an error in scheme, only in the flat const emit.
        if (SCHEME_LEGAL_TS_CODES.has(d.code)) continue;
        const dep = depAt(d.start);
        if (dep !== null) {
          if (d.category === ts.DiagnosticCategory.Error)
            depProblems.set(dep.path, (depProblems.get(dep.path) ?? 0) + 1);
          continue;
        }
        // Lift the TS diagnostic span OUT to Scheme. Drop diagnostics that don't
        // lift (unmapped prelude/infrastructure spans) — never surface a
        // wrong-positioned error.
        const span = mapper.toScheme(d.start);
        if (span === null) continue;
        const { line, character } = mapper.schemeOffsetToLineCol(span.start);
        const lifted = scheme.slice(span.start, span.start + span.length);
        let severity = severityOf(d.category);
        let messageText = ts.flattenDiagnosticMessageText(d.messageText, "\n");
        // ── speak SCHEME, and never cry wolf on what the lens can't know ──
        // 2304/2552 "Cannot find name": an unknown free name may live outside
        // the lens's sight (no resolveModule → any required file; with it →
        // an unresolvable path / runtime-injected binding) → SUGGESTION, named
        // by the SCHEME atom (the TS message carries the cleanName'd twin).
        if (d.code === 2304 || d.code === 2552 || NOISY_SUGGESTION_TS_CODES.has(d.code)) {
          const rawAtom = SCHEME_ATOM.test(lifted) ? lifted : /Cannot find name '([^']+)'/.exec(messageText)?.[1];
          // TS message may quote the encoded name; prefer scheme spelling.
          const atom = rawAtom === undefined ? schemeifyTsText(lifted) : schemeifyTsText(rawAtom);
          severity = "suggestion";
          messageText =
            opts?.resolveModule === undefined
              ? `Cannot find name '${atom}' in this file (\`require\`d names aren't resolved yet).`
              : `Cannot find name '${atom}' in this file or its \`require\`s.`;
        } else {
          // Type mismatches, arity, etc. — rewrite encoded idents in the prose.
          messageText = schemeifyTsText(messageText);
        }
        // Former ArrShape-gap (2339) is now a free-name miss (2304) when the
        // emitter roster has a head but no ambient declare function leaf.
        // Softened above via the 2304 path when resolveModule is set.
        out.push({
          start: span.start,
          length: span.length,
          line,
          character,
          severity,
          code: d.code,
          messageText,
        });
      }
      // Roll dep problems up onto their require forms (first occurrence wins).
      for (const [path, count] of depProblems) {
        const ref = programRequires.find((r) => r.path === path);
        if (ref === undefined) continue; // transitively required — surfaces in ITS requirer
        const { line, character } = mapper.schemeOffsetToLineCol(ref.span.start);
        out.push({
          start: ref.span.start,
          length: ref.span.length,
          line,
          character,
          severity: "warning",
          code: 0,
          messageText: `required file "${path}" has ${count} type error${count === 1 ? "" : "s"} — open it for details.`,
        });
      }
      return out;
    },

    getQuickInfoAtPosition(scheme, schemeOffset): SchemeQuickInfo | null {
      const mapper = loadSource(balancePrefix(scheme)); // cursor query → balance the mid-edit prefix
      const tsOffset = mapper.toTs(schemeOffset);
      if (tsOffset === null) return null;
      const info = service.getQuickInfoAtPosition(PROGRAM_FILE, tsOffset);
      if (info === undefined) return null;
      return {
        displayText: schemeifyTsText(ts.displayPartsToString(info.displayParts)),
        documentation: schemeifyTsText(ts.displayPartsToString(info.documentation)),
        span: mapper.toScheme(info.textSpan.start),
      };
    },

    getCompletionsAtPosition(scheme, schemeOffset): SchemeCompletionEntry[] {
      return computeEntries(scheme, schemeOffset);
    },

    getCompletionContext(scheme, schemeOffset): SchemeCompletionContext {
      const entries = computeEntries(scheme, schemeOffset);
      // Locate the cursor's role with the same sentinel machinery the sampler's
      // T mask uses — this IS the loop closure. The sentinel REPLACES the atom
      // being typed (mid-atom, the partial text is a continuation of the same
      // slot, not a completed earlier argument — the typed-scanner strips it
      // the same way before narrowing).
      const [atomStart, atomEnd] = atomBoundsAt(scheme, schemeOffset);
      const sentinelScheme = balancePrefix(`${scheme.slice(0, atomStart)} ${SENTINEL} ${scheme.slice(atomEnd)}`);
      const role = findCursorRole(sentinelScheme);
      const builtinSigs = builtinSignatures();
      // tsc only knows a local by its EMITTED identifier — an entry's `.name` may be
      // the backported scheme spelling (`config/audience`), which a slash/hyphen
      // can't stand in for in a bare TS reference. Resolve through
      // `programDeclaredNames`'s reverse before any TS-side probing (builtins are
      // never in that map, so this is the identity for them).
      const emittedNameOf = (name: string): string => {
        for (const [emitted, original] of programDeclaredNames) if (original === name) return emitted;
        return name;
      };
      // Locals' signatures resolve against the program's own emitted consts.
      const localEntries = entries.filter((e) => !builtinSigs.has(e.name));
      const localEmittedNames = localEntries.map((e) => emittedNameOf(e.name));
      const localSigsByEmitted = probeLocalSignatures(scheme, localEmittedNames);
      const localSigs = new Map(localEntries.map((e, i) => [e.name, localSigsByEmitted.get(localEmittedNames[i])]));
      // At an argument slot: one batched probe gives every candidate's verdict
      // (exactly the sampler's per-step mask) + the parameter's rendered type.
      let verdicts: (boolean | null)[] | null = null;
      let paramType: string | undefined;
      if (role.kind === "argument") {
        const probed = probeTypes(
          scheme,
          role.calleeText,
          role.argIndex,
          entries.map((e) => emittedNameOf(e.name)),
        );
        verdicts = probed.verdicts;
        paramType = probed.paramType;
      }
      const rich: SchemeRichCompletion[] = entries.map((e, i) => {
        const rawDetail = builtinSigs.get(e.name) ?? localSigs.get(e.name);
        // Detail may already be schemeified (builtin cache) or still encoded (locals).
        const detail = rawDetail === undefined ? undefined : schemeifyTsText(rawDetail);
        const fits = verdicts?.[i];
        return {
          ...e,
          ...(detail === undefined ? {} : { detail }),
          ...(fits === null || fits === undefined ? {} : { fits }),
          // CALLABLE_SIG matches encoded or scheme "function …" prefixes.
          ...(detail === undefined ? {} : { callable: CALLABLE_SIG.test(detail) || CALLABLE_SIG.test(rawDetail!) }),
        };
      });
      return {
        position: role.kind,
        ...(role.kind === "argument"
          ? {
              slot: {
                // role.calleeText is TS-side currency (encoded ident). Surface
                // the scheme spelling to the user.
                callee: schemeifyTsText(role.calleeText),
                argIndex: role.argIndex,
                ...(paramType === undefined ? {} : { paramType: schemeifyTsText(paramType) }),
              },
            }
          : {}),
        entries: rich,
      };
    },

    getDefinitionAtPosition(scheme, schemeOffset): SchemeDefinition[] {
      const mapper = loadSource(scheme);
      const tsOffset = mapper.toTs(schemeOffset);
      if (tsOffset === null) return [];
      const defs = service.getDefinitionAtPosition(PROGRAM_FILE, tsOffset);
      if (defs === undefined) return [];
      const out: SchemeDefinition[] = [];
      for (const d of defs) {
        if (d.fileName !== PROGRAM_FILE) {
          // A builtin's `.d.ts` definition — no scheme source anywhere.
          out.push({ name: schemeifyTsText(d.name), kind: d.kind, span: null });
          continue;
        }
        // Inside the concatenated module: a REQUIRED file's segment lifts via
        // THAT file's mapper (own coordinates + its require-path); the
        // program's segment lifts via the shifted program mapper.
        const dep = depAt(d.textSpan.start);
        if (dep !== null) {
          const span = dep.mapper.toScheme(d.textSpan.start - dep.base);
          out.push({
            name: schemeifyTsText(d.name),
            kind: d.kind,
            span,
            ...(span === null ? {} : { file: dep.path }),
          });
          continue;
        }
        out.push({
          name: schemeifyTsText(d.name),
          kind: d.kind,
          span: mapper.toScheme(d.textSpan.start),
        });
      }
      return out;
    },

    getSemanticClassifications(scheme): SchemeClassifiedSpan[] {
      const mapper = loadSource(scheme);
      const encoded = service.getEncodedSemanticClassifications(
        PROGRAM_FILE,
        { start: 0, length: programText.length },
        ts.SemanticClassificationFormat.TwentyTwenty,
      );
      const out: SchemeClassifiedSpan[] = [];
      for (let i = 0; i < encoded.spans.length; i += 3) {
        const tsStart = encoded.spans[i]!;
        const classification = encoded.spans[i + 2]!;
        // 2020 format packs (tokenType + 1) << 8 | modifierSet.
        const kind = TOKEN_TYPES[(classification >> 8) - 1];
        if (kind === undefined) continue;
        const span = mapper.toScheme(tsStart);
        if (span === null) continue;
        // Token-faithful lifts only: the lifted text must be a single atom.
        // Binder positions and `__arr` infrastructure lift to their WHOLE form
        // (no token mapping yet) — painting `(define names …)` as "variable"
        // would be wrong+noisy, so they are dropped, not approximated.
        const text = scheme.slice(span.start, span.start + span.length);
        if (!SCHEME_ATOM.test(text)) continue;
        out.push({ start: span.start, length: span.length, kind });
      }
      return out;
    },

    getTypeValidCandidates(scheme, schemeOffset, candidates): string[] {
      const cands = [...candidates];
      if (cands.length === 0) return cands;
      // 1. Locate the enclosing call's argument slot at the cursor. Insert the clean-name-proof
      //    sentinel at the cursor, balance, emit.
      const sentinelScheme = balancePrefix(
        `${scheme.slice(0, schemeOffset)} ${SENTINEL} ${scheme.slice(schemeOffset)}`,
      );
      const role = findCursorRole(sentinelScheme);
      if (role.kind !== "argument") return cands; // not a typed-call argument slot → no T narrowing
      // 2. Batched conditional-type probe → per-candidate verdict in one checker read.
      const { verdicts } = probeTypes(scheme, role.calleeText, role.argIndex, cands);
      // 3. Keep iff PROVEN valid (true) OR unresolved (null) — never drop on uncertainty.
      return cands.filter((_, i) => verdicts[i] !== false);
    },

    getSlotIsArray(scheme, schemeOffset): boolean | null {
      // Same slot-location as getTypeValidCandidates: sentinel at the cursor, balance, find the role.
      const sentinelScheme = balancePrefix(
        `${scheme.slice(0, schemeOffset)} ${SENTINEL} ${scheme.slice(schemeOffset)}`,
      );
      const role = findCursorRole(sentinelScheme);
      if (role.kind !== "argument") return null; // not a typed-call argument slot → no structure verdict
      return probeSlotIsArray(scheme, role.calleeText, role.argIndex);
    },

    getSlotAcceptsBareWord(scheme, schemeOffset): boolean | null {
      // Same slot-location as getSlotIsArray: sentinel at the cursor, balance, find the role.
      const sentinelScheme = balancePrefix(
        `${scheme.slice(0, schemeOffset)} ${SENTINEL} ${scheme.slice(schemeOffset)}`,
      );
      const role = findCursorRole(sentinelScheme);
      if (role.kind !== "argument") return null; // not a typed-call argument slot → no exemption
      return probeSlotAcceptsBareWord(scheme, role.calleeText, role.argIndex);
    },

    getSlotElementType(scheme, schemeOffset): { isStringy: boolean | null; enum: string[] | null } {
      // Same sentinel placement as the slot probes, but the WALK is different: we don't want the cursor's
      // immediate argument slot (which is `list`'s `unknown` inside `(list …)`, or nothing inside `'(…)`),
      // we want the ENCLOSING ARRAY's ELEMENT type. probeElementType drives the TS AST from the sentinel.
      const sentinelScheme = balancePrefix(
        `${scheme.slice(0, schemeOffset)} ${SENTINEL} ${scheme.slice(schemeOffset)}`,
      );
      return probeElementType(sentinelScheme);
    },

    getHeadReturnsArray(scheme, head): boolean | null {
      // No slot to locate — the verdict is a property of the HEAD's signature alone (its ReturnType is the
      // same wherever it is applied). Resolve the head against `scheme`'s scope (locals + require closure)
      // exactly as the slot probes do, then ride one `__isArrRet` alias.
      return probeHeadReturnsArray(scheme, head);
    },

    getSlotIsStringTyped(scheme, schemeOffset): boolean | null {
      // Same slot-location as getSlotIsArray: sentinel at the cursor, balance, find the role.
      const sentinelScheme = balancePrefix(
        `${scheme.slice(0, schemeOffset)} ${SENTINEL} ${scheme.slice(schemeOffset)}`,
      );
      const role = findCursorRole(sentinelScheme);
      if (role.kind !== "argument") return null; // not a typed-call argument slot → no string-typed verdict
      return probeSlotIsStringTyped(scheme, role.calleeText, role.argIndex);
    },

    getTypelevelProgram(scheme): string {
      loadSource(scheme);
      return programText;
    },

    getTypelevelModules(): Readonly<Record<string, string>> {
      return Object.fromEntries(dataModules);
    },
  };

  /** Resolve the call slot's expected type `__E = Parameters<typeof <callee>>[<arg>]` and read back
   *  whether it extends `readonly unknown[]` (a list/array materializer slot). `true` / `false` /
   *  `null` (unresolved — an error-any `__E` distributes the conditional to a non-`true`/`false`
   *  type, kept as `null`). Rides ON TOP of the emitted program (locals + require closure in scope),
   *  ONE program load — the same construction as {@link probeTypes}, with a single `__isArr` alias
   *  instead of the per-candidate tuple. `[__E]`-tuple wrapping defeats union distribution. */
  function probeSlotIsArray(scheme: string, calleeText: string, argIndex: number): boolean | null {
    loadSource(balancePrefix(scheme));
    const emitted = programText;
    const probeProgram = [
      emitted,
      `type __E = Parameters<typeof ${calleeText}>[${argIndex}];`,
      `type __isArr = [__E] extends [readonly unknown[]] ? true : false;`,
      `declare const __probe: [__isArr];`,
    ].join("\n");
    const elements = readProbeTuple(probeProgram, "__probe");
    const checker = checkerNow();
    if (elements === null || checker === null) return null;
    const el = elements[0];
    if (el === undefined) return null;
    const text = checker.typeToString(el); // a single literal: "true" / "false" / other (error-any)
    return text === "true" ? true : text === "false" ? false : null;
  }

  /** Resolve the call slot's expected type `__E = Parameters<typeof <callee>>[<arg>]` and read back whether
   *  it ADMITS A BARE WORD AS A STRING (the scalar-string Σ exemption's source). `true` ⇒ `__E` is NOT an
   *  array AND a plain `string` is assignable to it (`string` / `any` / `unknown`); `false` ⇒ it is a number
   *  / boolean / object / array; `null` ⇒ unresolved (error-any `__E`). Same construction as
   *  {@link probeSlotIsArray} (ONE program load, one alias). The conditional ladder:
   *    array? → false (the structure gate owns lists; a bare word is never a list element here)
   *    else `[string] extends [__E]` → true (string / any / unknown admit a bare word as their value)
   *    else → false (number / boolean / object — a bare word is genuinely wrong; an enum union is `false`
   *           too, correctly: its members are already bound value-symbols that pass Σ unaided).
   *  `[__E]`-tuple wrapping defeats union distribution (a `string | undefined` optional slot stays stringy). */
  function probeSlotAcceptsBareWord(scheme: string, calleeText: string, argIndex: number): boolean | null {
    loadSource(balancePrefix(scheme));
    const emitted = programText;
    const probeProgram = [
      emitted,
      `type __E = Parameters<typeof ${calleeText}>[${argIndex}];`,
      `type __stringy = [__E] extends [readonly unknown[]] ? false : ([string] extends [__E] ? true : false);`,
      `declare const __probe: [__stringy];`,
    ].join("\n");
    const elements = readProbeTuple(probeProgram, "__probe");
    const checker = checkerNow();
    if (elements === null || checker === null) return null;
    const el = elements[0];
    if (el === undefined) return null;
    const text = checker.typeToString(el); // a single literal: "true" / "false" / other (error-any)
    return text === "true" ? true : text === "false" ? false : null;
  }

  /** Resolve the HEAD `head`'s RETURN type and read whether it extends `readonly unknown[]` (provably a
   *  list/array materializer). The ReturnType TWIN of {@link probeSlotIsArray}: `ReturnType<typeof <ref>>`
   *  instead of `Parameters<…>[i]`, same `[…] extends [readonly unknown[]]` test, ONE program load, one
   *  alias. `typeofRef` resolves the head exactly as the candidate probe does (a program local via
   *  `typeof <name>`, a builtin/operator via `typeof $u2026$`). `true` ⇒ provably array (mask it at a
   *  scalar slot); `false` ⇒ provably not (an element-returning `car`/`first`/accessor — ADMIT); `null` ⇒
   *  unresolved (un-nameable head, unbound name → error-any return → ADMIT). The `[…]`-tuple wrapping defeats
   *  union distribution. A NON-callable head makes `ReturnType<…>` an error-any ⇒ `null` ⇒ admitted. */
  function probeHeadReturnsArray(scheme: string, head: string): boolean | null {
    const builtinNames = new Set(builtinSignatures().keys());
    const ref = typeofRef(head, builtinNames);
    loadSource(balancePrefix(scheme));
    const emitted = programText;
    // The `: false` non-function arm is LOAD-BEARING: writing `? R : never` and testing `[R] extends […]`
    // separately collapses a NON-CALLABLE head (a value symbol, an unbound name) to `__R = never`, and
    // `[never] extends [readonly unknown[]]` is `true` — which would MASK a non-array, non-callable value at a
    // scalar slot (a value symbol like an enum member). Folding the array test INSIDE the function-arm makes a
    // non-function resolve `false` (ADMIT), so only a head that IS a function AND returns array yields `true`.
    const probeProgram = [
      emitted,
      `type __isArrRet = [${ref}] extends [(...a: any[]) => infer R] ? ([R] extends [readonly unknown[]] ? true : false) : false;`,
      `declare const __probe: [__isArrRet];`,
    ].join("\n");
    const elements = readProbeTuple(probeProgram, "__probe");
    const checker = checkerNow();
    if (elements === null || checker === null) return null;
    const el = elements[0];
    if (el === undefined) return null;
    const text = checker.typeToString(el); // a single literal: "true" / "false" / other (error-any → null)
    return text === "true" ? true : text === "false" ? false : null;
  }

  /** Resolve the call slot's expected type `__E` and read whether it is STRING-TYPED — a subtype of `string`
   *  (`string` or a closed string-literal union), NOT an array. The conditional ladder mirrors
   *  {@link probeSlotAcceptsBareWord} but asks `[__E] extends [string]` (a SUBTYPE test) rather than
   *  `[string] extends [__E]` (an assignability test): `"a"|"b"` IS `extends string` (→ true) but `string` is
   *  NOT assignable-TO `"a"|"b"` (so getSlotAcceptsBareWord returns false for an enum). This is exactly the
   *  separation the gate needs: a string-literal enum and a free-form string both resolve `true` here (mask
   *  non-string literals), while number/boolean/object resolve `false`. ONE program load, one alias;
   *  `[__E]`-tuple wrapping defeats union distribution (a `string | undefined` optional slot stays string). */
  function probeSlotIsStringTyped(scheme: string, calleeText: string, argIndex: number): boolean | null {
    loadSource(balancePrefix(scheme));
    const emitted = programText;
    const probeProgram = [
      emitted,
      `type __E = Parameters<typeof ${calleeText}>[${argIndex}];`,
      `type __strTyped = [__E] extends [readonly unknown[]] ? false : ([__E] extends [string] ? true : false);`,
      `declare const __probe: [__strTyped];`,
    ].join("\n");
    const elements = readProbeTuple(probeProgram, "__probe");
    const checker = checkerNow();
    if (elements === null || checker === null) return null;
    const el = elements[0];
    if (el === undefined) return null;
    const text = checker.typeToString(el); // a single literal: "true" / "false" / other (error-any)
    return text === "true" ? true : text === "false" ? false : null;
  }

  /**
   * Resolve the ELEMENT type at the sentinel'd array-element cursor and derive `{ isStringy, enum }`.
   * Unlike the `__E = Parameters<…>` slot probes (a type-alias readback), this is a CHECKER-INSTANCE query
   * on the live emitted node: it finds the INNERMOST array-PRODUCING expression that directly contains the
   * sentinel and reads the ELEMENT of that expression's CONTEXTUAL type. The two live array surfaces both
   * resolve through ONE primitive — `getContextualType` does the outer-slot resolution for free:
   *  - `'(…)` lowered to a TS array LITERAL `[…]`: `getContextualType(literal)` = the expected array type
   *    (`T_diet[]` / `readonly unknown[]`); its number-index is the element type.
   *  - `(list …)` lowered to `list(…)`: `getContextualType(thatCall)` = the same expected array type
   *    (TS flows the outer slot INTO the call's contextual position: `list(x)` filling a
   *    `T_diet[]` slot has contextual type `T_diet[]`, NOT the generic `list`'s `unknown`); number-index → element.
   * A regular nested call (`(find-y …)`) is NOT a materializer — its args are typed by ITS OWN signature, so
   * it is deliberately NOT treated as an array producer (only an array literal, or a `list` call, is).
   * Returns `{ isStringy: null, enum: null }` when the cursor is not inside such a surface (the gate no-ops).
   */
  function probeElementType(sentinelScheme: string): { isStringy: boolean | null; enum: string[] | null } {
    const NONE = { isStringy: null, enum: null } as const;
    loadSource(sentinelScheme);
    const program = service.getProgram();
    const sf = program?.getSourceFile(PROGRAM_FILE);
    if (!sf || !program) return NONE;
    const checker = program.getTypeChecker();
    // Find the sentinel node in the emitted TS. CRITICAL: inside a `'(…)` quote-list the sentinel lowers to
    // a STRING LITERAL (`emitQuoteDatum` renders a bare symbol as `JSON.stringify(atom)` → `"qzcursorzq"`),
    // whereas inside `(list …)` it stays a bare IDENTIFIER. Match both spellings so both surfaces resolve.
    let sentinel: ts.Node | null = null;
    const find = (n: ts.Node): void => {
      if (sentinel) return;
      if ((ts.isIdentifier(n) && n.text === SENTINEL) || (ts.isStringLiteral(n) && n.text === SENTINEL)) sentinel = n;
      else ts.forEachChild(n, find);
    };
    find(sf);
    if (sentinel === null) return NONE;
    const s = (sentinel as ts.Node).getStart(sf);
    const e = (sentinel as ts.Node).getEnd();
    // Walk up to the INNERMOST array-producing expression directly containing the sentinel: a TS array
    // literal (the `'(…)` lowering), or a `list(…)` materializer CALL whose argument is the sentinel.
    let producer: ts.Expression | null = null;
    for (let p: ts.Node | undefined = (sentinel as ts.Node).parent; p; p = p.parent) {
      if (ts.isArrayLiteralExpression(p)) {
        producer = p;
        break;
      }
      if (
        ts.isCallExpression(p) &&
        isListMaterializerCallee(p.expression.getText(sf)) && // Only when the sentinel is one of the call's ARGUMENTS (an element), not its callee.
        p.arguments.some((a) => a.getStart(sf) <= s && e <= a.end)
      ) {
        producer = p;
        break;
      }
      // A non-materializer CallExpression that encloses the sentinel as an argument means the cursor is an
      // argument of a REGULAR call (its own param type governs) — stop: this is not an array element.
      if (ts.isCallExpression(p) && p.arguments.some((a) => a.getStart(sf) <= s && e <= a.end)) return NONE;
    }
    if (producer === null) return NONE;
    const arrayCtx = checker.getContextualType(producer);
    if (arrayCtx === undefined) return NONE;
    // The element type = the array's number-index type. (No number-index ⇒ the contextual type is not an
    // array here — e.g. an inner literal sitting at a scalar element slot — so there is no element to force.)
    const elem = checker.getIndexTypeOfType(arrayCtx, ts.IndexKind.Number);
    if (elem === undefined) return NONE;
    return deriveElementVerdict(checker, elem);
  }

  /** Is `calleeText` the list-materializer `list` (the `(list …)` surface lowers its head to bare `list`)?
   *  Only this exact constructor is an array producer whose arguments ARE the elements;
   *  every other call is a regular function whose arguments are its own params. */
  function isListMaterializerCallee(calleeText: string): boolean {
    return calleeText === "list" || calleeText === encodeSchemeIdent("list");
  }

  /** From the resolved ELEMENT `ts.Type`, derive the array-element verdict:
   *   - `enum` — the element's string-literal-union MEMBERS (each a `StringLiteral` type's value), or `null`
   *     when the element is not a pure finite union of string literals.
   *   - `isStringy` — `true` iff the element is a free-form `string`/`any`/`unknown` (NOT an array, NOT a
   *     number/boolean/object, NOT a closed string-literal union): the force-quote case. A string-literal
   *     union is `false` (it is the `enum` case — its members are bound value-symbols). */
  function deriveElementVerdict(
    checker: ts.TypeChecker,
    elem: ts.Type,
  ): { isStringy: boolean | null; enum: string[] | null } {
    // ENUM — a string-literal, or a union all of whose members are string literals.
    const members = stringLiteralMembers(elem);
    if (members !== null && members.length > 0) return { isStringy: false, enum: members };
    // STRINGY — `string`/`any`/`unknown` element accepts a bare value-word → force-quote. (Array / number /
    // boolean / object element ⇒ not stringy ⇒ no force-quote.)
    if (elem.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { isStringy: true, enum: null };
    if (elem.flags & ts.TypeFlags.String) return { isStringy: true, enum: null };
    return { isStringy: false, enum: null };
  }

  /** The members of a string-literal-union element type (`"a" | "b"` → `["a","b"]`, `"a"` → `["a"]`), or
   *  `null` when `elem` is not a pure union of string literals (it has any non-string-literal constituent). */
  function stringLiteralMembers(elem: ts.Type): string[] | null {
    const consts = elem.isUnion() ? elem.types : [elem];
    const out: string[] = [];
    for (const t of consts) {
      if (t.isStringLiteral()) out.push(t.value);
      else return null; // a non-string-literal constituent ⇒ not a closed string-literal domain
    }
    return out;
  }

  /** The shared completion-entry computation (see getCompletionsAtPosition):
   *  tsc's in-scope answer MINUS the substrate baseline PLUS the builtin roster. */
  function computeEntries(scheme: string, schemeOffset: number): SchemeCompletionEntry[] {
    // The prefix is mid-edit (usually unbalanced) — balance it so it parses; the cursor
    // offset is unchanged (closers append at the end). Query tsc at the ATOM'S
    // START, not the raw cursor: the end of a partial atom falls off its token
    // mapping into the enclosing form's mapping (→ `car`), where tsc
    // answers MEMBER completions — the whole scope vanishes.
    const mapper = loadSource(balancePrefix(scheme));
    const tsOffset = mapper.toTs(atomBoundsAt(scheme, schemeOffset)[0]);
    if (tsOffset === null) return [];
    const completions = service.getCompletionsAtPosition(PROGRAM_FILE, tsOffset, undefined);
    // Answer in SCHEME terms, not virtual-TS terms (the raw tsc list is the
    // whole JS global scope — console, Array, the lens's own __arr/sexpr —
    // none of which is a scheme symbol; pure emission substrate):
    //   1. SUBTRACT the JS-global baseline (what an EMPTY program completes to);
    //      what survives is program-local bindings + context-specific members.
    //   2. MERGE the builtin roster (ArrShape members — real scheme names like
    //      `string-append`, plus host-injected rosetta tools) — tsc only offers
    //      them at `__arr.` member positions, which no scheme cursor reaches
    //      until the emitter maps head tokens; scheme-wise they are in scope
    //      at every position.
    const baseline = jsGlobalBaseline();
    const out: SchemeCompletionEntry[] = [];
    const seen = new Set<string>();
    for (const e of completions?.entries ?? []) {
      // Subtraction matches name AND kind: a program LOCAL that happens to
      // collide with a substrate name (`(define Array …)` — a const, vs the
      // baseline's type-only `Array` interface) must survive. Name-only
      // matching would treat it as the baseline entry and drop it.
      if (baseline.has(`${e.name} ${e.kind}`) || e.name.startsWith("__") || e.name === "sexpr" || seen.has(e.name)) {
        continue;
      }
      seen.add(e.name);
      // Backport: tsc answers in EMITTED terms (`cleanName` may have renamed a program
      // local — `config/audience` → `configAudience`); a completion the user selects must
      // read/insert what they'd actually TYPE in scheme, not the TS-shadow spelling.
      const name = programDeclaredNames.get(e.name) ?? e.name;
      out.push({
        name,
        kind: e.kind,
        sortText: e.sortText,
        ...(e.insertText === undefined ? {} : { insertText: e.insertText }),
      });
    }
    for (const b of builtinCompletions()) {
      if (seen.has(b.name)) continue; // a local shadowing a builtin wins
      seen.add(b.name);
      out.push(b);
    }
    return out;
  }

  /** What an EMPTY program completes to at offset 0: the JS/lib global scope, TS
   *  keywords, and the lens's own infrastructure (`__arr`, `sexpr`, `List`, `Dict`…).
   *  None of it is a scheme symbol — it is the SUBTRACTION set for real queries
   *  (what survives subtraction is exactly what the PROGRAM brought into scope). */
  function jsGlobalBaseline(): Set<string> {
    if (baselineNames === null) {
      // `loadSource` mutates the shared program* state as its whole point — but this
      // probe's subject is the EMPTY program, not the caller's real document. Restore
      // afterward (and bump the version once more) so a completion request that
      // triggers this one-time warm-up mid-flight doesn't lose the real program's
      // state to it — a fresh service's very first completion request would
      // otherwise see `programDeclaredNames` clobbered back to empty, silently
      // undoing the backport for that request.
      const saved = { text: programText, declaredNames: programDeclaredNames, depUnits };
      loadSource("");
      const c = service.getCompletionsAtPosition(PROGRAM_FILE, 0, undefined);
      // Keyed `name kind` so the subtraction is exact: a program VALUE binding
      // may legally share a name with a substrate TYPE (see the caller).
      baselineNames = new Set((c?.entries ?? []).map((e) => `${e.name} ${e.kind}`));
      programText = saved.text;
      programDeclaredNames = saved.declaredNames;
      depUnits = saved.depUnits;
      programVersion += 1;
    }
    return baselineNames;
  }

  /** The builtin roster under its REAL scheme names (`car`, `string-append`, `+`,
   *  `odd?`, …, plus host-injected rosetta tools). Completions are taken from the
   *  ambient global function scope (empty program), then decoded from
   *  `encodeSchemeIdent` form back to scheme spelling. */
  function builtinCompletions(): SchemeCompletionEntry[] {
    if (builtinEntries === null) {
      // Harvest scheme names from ambient `declare function <encoded>…` leaves
      // (and host prelude). No TS completion probe — that re-entered loadSource
      // via emitterMembers and blew the stack once ArrShape went away.
      const seen = new Set<string>();
      const entries: SchemeCompletionEntry[] = [];
      const absorb = (text: string): void => {
        for (const m of text.matchAll(/\bdeclare\s+function\s+([A-Za-z_$][\w$]*)/g)) {
          const enc = m[1]!;
          // Lens infrastructure, not scheme vocabulary.
          if (enc === "sexpr" || enc.startsWith("__")) continue;
          let schemeName = enc;
          try {
            schemeName = decodeSchemeIdent(enc);
          } catch {
            /* bare car / map / … */
          }
          if (seen.has(schemeName)) continue;
          seen.add(schemeName);
          entries.push({ name: schemeName, kind: "method", sortText: schemeName });
        }
      };
      for (const text of preludeFiles.values()) absorb(text);
      if (opts?.host !== undefined) {
        absorb(opts.host.prelude);
        for (const m of opts.host.members) {
          if (seen.has(m)) continue;
          seen.add(m);
          entries.push({ name: m, kind: "method", sortText: m });
        }
      }
      builtinEntries = entries;
    }
    return builtinEntries;
  }

  /** Emit the sentinel'd scheme, then walk the TS AST to where the SENTINEL landed —
   *  the cursor's Σ-style role:
   *    • inside a CallExpression's ARGUMENTS → `argument` + callee text + arg index
   *      (the T-narrowable slot);
   *    • AS a CallExpression's callee, or the scheme cursor sits right after `(`
   *      (the emitter lowers an unknown head so the sentinel is itself the call) →
   *      `operator`;
   *    • anywhere else → `top`. */
  function findCursorRole(
    sentinelScheme: string,
  ): { kind: "argument"; calleeText: string; argIndex: number } | { kind: "operator" } | { kind: "top" } {
    loadSource(sentinelScheme);
    const program = service.getProgram();
    const sf = program?.getSourceFile(PROGRAM_FILE);
    if (!sf) return { kind: "top" };
    let found: ReturnType<typeof findCursorRole> | null = null;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node) && node.text === SENTINEL) {
        const s = node.getStart(sf);
        const e = node.getEnd();
        for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
          if (ts.isCallExpression(p)) {
            const argIndex = p.arguments.findIndex((a) => a.getStart(sf) <= s && e <= a.end);
            if (argIndex !== -1) {
              found = { kind: "argument", calleeText: p.expression.getText(sf), argIndex };
              return;
            }
            if (p.expression.getStart(sf) <= s && e <= p.expression.end) {
              found = { kind: "operator" };
              return;
            }
          }
        }
        found = { kind: "top" };
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found ?? { kind: "top" };
  }

  /** Resolve a probe module and read the tuple type of `declare const <name>: […]`
   *  element by element off the checker — never through a whole-tuple
   *  `typeToString`, which truncates past ~160 chars. */
  function readProbeTuple(probeProgramText: string, name: string): readonly ts.Type[] | null {
    programText = probeProgramText;
    programVersion += 1;
    const program = service.getProgram();
    const sf = program?.getSourceFile(PROGRAM_FILE);
    if (!sf || !program) return null;
    const checker = program.getTypeChecker();
    let probeNode: ts.Node | null = null;
    const find = (n: ts.Node): void => {
      if (probeNode) return;
      if (ts.isIdentifier(n) && n.text === name && ts.isVariableDeclaration(n.parent)) probeNode = n;
      else ts.forEachChild(n, find);
    };
    find(sf);
    if (!probeNode) return null;
    const tupleType = checker.getTypeAtLocation(probeNode);
    if (!(tupleType.flags & ts.TypeFlags.Object)) return null;
    return checker.getTypeArguments(tupleType as ts.TypeReference);
  }

  /** The current checker (valid until the next program load). */
  function checkerNow(): ts.TypeChecker | null {
    return service.getProgram()?.getTypeChecker() ?? null;
  }

  /** The TYPE EXPRESSION a candidate contributes to `__ok<…>`. TWO cases:
   *   • a STRING-LITERAL candidate (`"thai"`) → the literal type ITSELF.
   *   • everything else (locals, builtins, host tools) → `typeof <encodeSchemeIdent(name)>`
   *     — typelevel names are always the lossless encoding (no `__arr` bag). */
  function typeofRef(name: string, _builtinNames: ReadonlySet<string>): string {
    const lit = stringLiteralType(name);
    if (lit !== null) return lit;
    return `typeof ${encodeSchemeIdent(name)}`;
  }

  /** Load a probe module and read, per candidate, whether it is type-valid in the given call slot.
   *  `true` = proven assignable, `false` = proven not, `null` = unresolved (kept by the caller).
   *  The probe rides ON TOP of the emitted program (locals stay in scope: a
   *  LOCAL callee's parameters resolve, a LOCAL candidate's type resolves —
   *  both were `any`-kept before). ONE program load for the whole list. */
  function probeTypes(
    scheme: string,
    calleeText: string,
    argIndex: number,
    candidates: string[],
  ): { verdicts: (boolean | null)[]; paramType?: string } {
    // `__ok<T>`: T fits the slot iff it IS the param type, OR it is a function whose RETURN type is
    // (the next token at an arg slot is usually a sub-call's operator). `[x]`-tuple wrapping defeats
    // union distribution. An unresolvable typeof is `any` ⇒ both branches `true` ⇒ kept.
    const okT =
      `type __ok<T> = (([T] extends [(...a: any[]) => infer R] ? ([R] extends [__E] ? true : false) : false) extends true ? true ` +
      `: ([T] extends [__E] ? true : false));`;
    const builtinNames = new Set(builtinSignatures().keys());
    // Ride the FULL require closure (loadSource concatenates it), so required
    // names resolve in the probe instead of degrading to `any`.
    loadSource(balancePrefix(scheme));
    const emitted = programText;
    const probeProgram = [
      emitted,
      `type __E = Parameters<typeof ${calleeText}>[${argIndex}];`,
      okT,
      `declare const __probe: [${candidates.map((n) => `__ok<${typeofRef(n, builtinNames)}>`).join(", ")}];`,
      `declare const __param: [__E];`,
    ].join("\n");
    const elements = readProbeTuple(probeProgram, "__probe");
    const checker = checkerNow();
    if (elements === null || checker === null) return { verdicts: candidates.map(() => null) };
    const verdicts = candidates.map((_, i) => {
      const el = elements[i];
      if (el === undefined) return null;
      const text = checker.typeToString(el); // a single literal: "true" / "false" / other
      return text === "true" ? true : text === "false" ? false : null;
    });
    // The expected parameter type, rendered — the slot's "what goes here".
    let paramType: string | undefined;
    const sf = service.getProgram()?.getSourceFile(PROGRAM_FILE);
    if (sf !== undefined) {
      let paramNode: ts.Node | null = null;
      const find = (n: ts.Node): void => {
        if (paramNode) return;
        if (ts.isIdentifier(n) && n.text === "__param" && ts.isVariableDeclaration(n.parent)) paramNode = n;
        else ts.forEachChild(n, find);
      };
      find(sf);
      if (paramNode !== null) {
        const t = checker.getTypeArguments(checker.getTypeAtLocation(paramNode) as ts.TypeReference)[0];
        if (t !== undefined) {
          const text = checker.typeToString(t);
          if (text !== "any" && text !== "unknown") paramType = text;
        }
      }
    }
    return { verdicts, ...(paramType === undefined ? {} : { paramType }) };
  }

  /** Builtin signatures, rendered once per service (the roster is constant):
   *  ONE ambient probe tuple `[typeof car, typeof string$dash$append, …]`. */
  function builtinSignatures(): Map<string, string> {
    if (builtinSigs === null) {
      const names = builtinCompletions().map((e) => e.name);
      const probeProgram = [
        `declare const __sigs: [${names.map((n) => `typeof ${encodeSchemeIdent(n)}`).join(", ")}];`,
        "export {};",
      ].join("\n");
      const elements = readProbeTuple(probeProgram, "__sigs");
      const checker = checkerNow();
      builtinSigs = new Map();
      if (elements !== null && checker !== null) {
        for (const [i, n] of names.entries()) {
          const el = elements[i];
          // Cache scheme-spelled signatures — completion detail is user-facing.
          if (el !== undefined) builtinSigs!.set(n, schemeifyTsText(checker.typeToString(el)));
        }
      }
    }
    return builtinSigs;
  }

  /** Render the locals' types by probing `typeof <name>` against the emitted
   *  program (they are its top-level consts). Unresolvable names render "any"
   *  and are omitted. */
  function probeLocalSignatures(scheme: string, names: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    const idNames = names.filter((n) => /^[A-Z_$][\w$]*$/i.test(n));
    if (idNames.length === 0) return out;
    // Ride the FULL require closure (loadSource concatenates it), so required
    // names resolve in the probe instead of degrading to `any`.
    loadSource(balancePrefix(scheme));
    const emitted = programText;
    const probeProgram = [emitted, `declare const __sigs: [${idNames.map((n) => `typeof ${n}`).join(", ")}];`].join(
      "\n",
    );
    const elements = readProbeTuple(probeProgram, "__sigs");
    const checker = checkerNow();
    if (elements === null || checker === null) return out;
    for (const [i, n] of idNames.entries()) {
      const el = elements[i];
      if (el === undefined) continue;
      const text = checker.typeToString(el);
      // User-facing local signatures — scheme spellings (same as builtinSigs).
      if (text !== "any") out.set(n, schemeifyTsText(text));
    }
    return out;
  }
}

/** A rendered signature that denotes a callable value (drives Σ's
 *  operator-position ranking client-side). */
const CALLABLE_SIG = /=>/;
