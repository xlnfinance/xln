// ide — IDE extensions (lint/hover/completion/goto/sem) over a SchemeIdeBackend seam.
//
// Each extension is wired to exactly one backend method. The seam is structural
// (sync or Promise) so in-process and worker backends are interchangeable.
// Coordinates are always Scheme; sugarcoat buffers must go through
// sugarcoatIdeBackend for translation. Do not mount full IDE on sugarcoat without it.

import {
  autocompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { linter, type Diagnostic } from "@codemirror/lint";
import { type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import { schemeifyTsText } from "@inhuman.tools/arrival-types-bridge";

import { schemeGhost, type SchemeGhostOptions } from "./ghost.js";
import { CONTROL_KEYWORDS, DEFINITION_KEYWORDS } from "./scheme-sugarcoat.js";

// ── the backend seam ───────────────────────────────────────────────────────
// Structural twins of arrival-lsp's Scheme* types (a devDep typecheck in
// __tests__ pins assignability so drift is caught at `pnpm typecheck`). Widened
// to MaybePromise: CodeMirror's lint/hover/completion sources all accept
// promises, so a worker backend is the same seam.

type MaybePromise<T> = T | Promise<T>;

/** A diagnostic in Scheme coordinates (mirrors arrival-lsp `SchemeDiagnostic`). */
export interface SchemeIdeDiagnostic {
  start: number;
  length: number;
  severity: "error" | "warning" | "suggestion" | "message";
  /** The tsc diagnostic code, carried for telemetry/explainers. */
  code: number;
  messageText: string;
}

/** Hover info in Scheme coordinates (mirrors `SchemeQuickInfo`). */
export interface SchemeIdeQuickInfo {
  displayText: string;
  documentation: string;
  span: { start: number; length: number } | null;
}

/** One completion entry (mirrors `SchemeCompletionEntry`). */
export interface SchemeIdeCompletionEntry {
  name: string;
  /** A `ts.ScriptElementKind` string (`"function"`, `"var"`, `"property"`, …). */
  kind: string;
  sortText: string;
  insertText?: string;
}

/** A go-to-definition result (mirrors `SchemeDefinition`); `span: null` means
 *  the definition lands outside the buffer (a builtin's `.d.ts`). */
export interface SchemeIdeDefinition {
  name: string;
  kind: string;
  span: { start: number; length: number } | null;
  /** Present when the definition lives in a REQUIRED file (the span is in
   *  THAT file's coordinates) — the cross-file jump target. */
  file?: string;
}

/** A semantically-classified token span (mirrors `SchemeClassifiedSpan`):
 *  what an identifier IS per the type checker — `"parameter"`, `"variable"`,
 *  `"function"`, `"property"`, `"type"`, … */
export interface SchemeIdeClassifiedSpan {
  start: number;
  length: number;
  kind: string;
}

/** A rich completion entry (mirrors `SchemeRichCompletion`): the base entry
 *  plus what the type system knows about the candidate AT THIS CURSOR. */
export interface SchemeIdeRichCompletion extends SchemeIdeCompletionEntry {
  /** Rendered type signature (`(xs: List<T>) => T`), when the checker can name it. */
  detail?: string;
  /** Slot verdict at an argument position — the sampler's Σ∩T mask, surfaced:
   *  `true` = proven fits, `false` = proven NOT, `undefined` = unknown. */
  fits?: boolean;
  /** True iff the candidate is a callable value (operator-position ranking). */
  callable?: boolean;
}

/** The full completion answer (mirrors `SchemeCompletionContext`). */
export interface SchemeIdeCompletionContext {
  position: "operator" | "argument" | "top";
  slot?: { callee: string; argIndex: number; paramType?: string };
  entries: SchemeIdeRichCompletion[];
}

/** What the IDE extensions need from a language service, in Scheme coordinates. */
export interface SchemeIdeBackend {
  getSemanticDiagnostics(scheme: string): MaybePromise<SchemeIdeDiagnostic[]>;
  getQuickInfoAtPosition(scheme: string, schemeOffset: number): MaybePromise<SchemeIdeQuickInfo | null>;
  getCompletionsAtPosition(scheme: string, schemeOffset: number): MaybePromise<SchemeIdeCompletionEntry[]>;
  getDefinitionAtPosition(scheme: string, schemeOffset: number): MaybePromise<SchemeIdeDefinition[]>;
  /** Optional — when present, `schemeIde` mounts the semantic-highlight layer. */
  getSemanticClassifications?(scheme: string): MaybePromise<SchemeIdeClassifiedSpan[]>;
  /** Optional — when present, completion upgrades to the Σ∩T-ranked rich UI. */
  getCompletionContext?(scheme: string, schemeOffset: number): MaybePromise<SchemeIdeCompletionContext>;
}

// ── pure mappers (exported for tests) ──────────────────────────────────────

/** Lift backend diagnostics into `@codemirror/lint` shape, clamped to the doc. */
export function toCmDiagnostics(diags: readonly SchemeIdeDiagnostic[], docLength: number): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of diags) {
    const from = Math.max(0, Math.min(d.start, docLength));
    const to = Math.max(from, Math.min(d.start + d.length, docLength));
    out.push({
      from,
      to,
      severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
      // Belt-and-suspenders: schemeify even if the worker predates server-side rewrite.
      message: schemeifyTsText(d.messageText),
      source: `scheme-ts(${d.code})`,
    });
  }
  return out;
}

/** `ts.ScriptElementKind` → CodeMirror completion `type` (drives the icon). */
const COMPLETION_TYPE: Record<string, string> = {
  method: "method",
  function: "function",
  "local function": "function",
  var: "variable",
  "local var": "variable",
  let: "variable",
  const: "constant",
  property: "property",
  getter: "property",
  parameter: "variable",
  keyword: "keyword",
  module: "namespace",
  class: "class",
  interface: "interface",
  type: "type",
  enum: "enum",
  "enum member": "constant",
  alias: "variable",
};

/** Map backend completion entries into CodeMirror `Completion`s. The backend's
 *  sortText carries through (CM ≥6.20 honors it as the tie-break key —
 *  dropping it silently discarded the service's own ranking). */
export function toCmCompletions(entries: readonly SchemeIdeCompletionEntry[]): Completion[] {
  return entries.map((e) => ({
    label: e.name,
    type: COMPLETION_TYPE[e.kind] ?? "variable",
    sortText: e.sortText,
    ...(e.insertText === undefined ? {} : { apply: e.insertText }),
  }));
}

// ── extensions ─────────────────────────────────────────────────────────────

export interface SchemeLinterOptions {
  /** Debounce after the last edit before re-linting (ms). Default 600. */
  delay?: number;
}

/** Type-checked diagnostics: squiggles + the lint gutter/panel vocabulary. */
export function schemeLinter(backend: SchemeIdeBackend, options?: SchemeLinterOptions): Extension {
  return linter(
    async (view) =>
      toCmDiagnostics(await backend.getSemanticDiagnostics(view.state.doc.toString()), view.state.doc.length),
    { delay: options?.delay ?? 600 },
  );
}

/** Hover: the signature/inferred type + docs of the symbol under the pointer. */
export function schemeHover(backend: SchemeIdeBackend): Extension {
  return [
    hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
      const info = await backend.getQuickInfoAtPosition(view.state.doc.toString(), pos);
      if (info === null || (info.displayText === "" && info.documentation === "")) return null;
      const from = info.span?.start ?? pos;
      const to = info.span === null ? pos : info.span.start + info.span.length;
      return {
        pos: from,
        end: to,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "cm-scheme-quickinfo";
          if (info.displayText !== "") {
            const sig = document.createElement("code");
            sig.className = "cm-scheme-quickinfo-signature";
            // Scheme spelling for humans (`number->string`, not `number$dash$$greater$string`).
            // Also covers a worker built before server-side schemeify landed.
            sig.textContent = schemeifyTsText(info.displayText);
            dom.append(sig);
          }
          if (info.documentation !== "") {
            const doc = document.createElement("div");
            doc.className = "cm-scheme-quickinfo-docs";
            doc.textContent = schemeifyTsText(info.documentation);
            dom.append(doc);
          }
          return { dom };
        },
      };
    }),
    quickInfoTheme,
  ];
}

const quickInfoTheme = EditorView.baseTheme({
  ".cm-scheme-quickinfo": { maxWidth: "44em", padding: "4px 6px" },
  ".cm-scheme-quickinfo-signature": { whiteSpace: "pre-wrap", display: "block" },
  ".cm-scheme-quickinfo-docs": { whiteSpace: "pre-wrap", marginTop: "4px", opacity: "0.8" },
});

// A scheme symbol run before the cursor — the same atom-char class the sugarcoat
// reader uses (scheme-sugarcoat.ts SYMBOL_BODY), so `string-upcase`, `+`, `list->vec`
// complete as ONE token. A single character class under `*` cannot backtrack —
// the slow-regex flag is a false positive on the `$` anchor.

const SYMBOL_BEFORE = /[\w\-!$%&*+./<=>?@^~]*$/;

// The SPECIAL FORMS are syntax, not bindings — no language service knows them
// (they never reach the type lens; the emitter consumes them). The language
// package owns them, so the completion source merges them under the backend's
// answers. Reuses the highlighter's classification sets.
const SECTION_FITS = { name: "fits this slot", rank: 1 };
const SECTION_SCOPE = { name: "in scope", rank: 2 };
const SECTION_BUILTINS = { name: "builtins", rank: 3 };
const SECTION_FORMS = { name: "forms", rank: 4 };

// Section is load-bearing for ORDER: CM puts unsectioned items first, so an
// unsectioned keyword would rank above the sectioned "fits"/scope entries.
// Forms deliberately last.
const FORM_COMPLETIONS: Completion[] = [...DEFINITION_KEYWORDS, ...CONTROL_KEYWORDS].map((name) => ({
  label: name,
  type: "keyword",
  section: SECTION_FORMS,
}));

// ── Σ∩T-ranked completion ────────────────────────────────────────────────
// Craft rules (anti-patterns called out):
//   • TIERED BOOST never filter: fits rise, unfit demote but stay visible.
//     (Hidden "smart complete" is undiscoverable; demotion is not.)
//   • Fixed-rank SECTIONS ("fits" / scope / builtins / forms) — stable order
//     is a hard constraint; churn is the #1 hated behavior.
//   • Locals > globals. Signature as detail. Commit on space/).
//
// Boosts only break ties; fuzzy quality still dominates within band.
function boostOf(e: SchemeIdeRichCompletion, isLocal: boolean): number {
  if (e.fits === true) return isLocal ? 80 : 60;
  if (e.fits === false) return -40;
  return isLocal ? 20 : 0;
}

/** One rich entry → a CM completion: section by semantic truth, boost by tier,
 *  signature as inline detail + info panel. Builtins arrive kind:"method";
 *  anything else came from the program itself (a local). */
function toRichCmCompletion(e: SchemeIdeRichCompletion): Completion {
  const isLocal = e.kind !== "method";
  const section = e.fits === true ? SECTION_FITS : isLocal ? SECTION_SCOPE : SECTION_BUILTINS;
  return {
    label: e.name,
    type: COMPLETION_TYPE[e.kind] ?? "variable",
    section,
    boost: boostOf(e, isLocal),
    ...(e.detail === undefined ? {} : { detail: schemeifyTsText(e.detail) }),
    // Info panel only when row doesn't say it (signature already in `detail`).
    // Demoted entries get the "does not fit" note.
    ...(e.fits === false ? { info: () => infoDom(e) } : {}),
    ...(e.insertText === undefined ? {} : { apply: e.insertText }),
  };
}

function infoDom(e: SchemeIdeRichCompletion): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-scheme-quickinfo";
  const note = document.createElement("div");
  note.className = "cm-scheme-quickinfo-docs";
  note.textContent = "type does not fit this argument slot";
  dom.append(note);
  return dom;
}

/** Special-form templates — structure, not just names. Offered as SNIPPETS
 *  only right after `(` (the head position; the buffer already owns the outer
 *  pair — closeBrackets inserted the `)` when the user typed `(`). Elsewhere
 *  the bare keyword completes. Terminal `${}` exits the field cycle cleanly. */
const FORM_SNIPPETS: readonly Completion[] = [
  ["define", "define (${name} ${params})\n  ${body}${}"],
  ["lambda", "lambda (${params}) ${body}${}"],
  ["let", "let ((${name} ${value}))\n  ${body}${}"],
  ["let*", "let* ((${name} ${value}))\n  ${body}${}"],
  ["cond", "cond\n  ((${test}) ${result})${}"],
  ["if", "if ${test} ${then} ${else}${}"],
  ["when", "when ${test}\n  ${body}${}"],
  ["unless", "unless ${test}\n  ${body}${}"],
].map(([label, template]) =>
  snippetCompletion(template!, { label: label!, type: "keyword", section: SECTION_FORMS, boost: 30 }),
);

/** Scheme's natural commit keys: a space or close-paren after a symbol always
 *  means "that symbol, done". Resolves Tab-vs-Enter the lisp-native way. */
const COMMIT_CHARS = [" ", ")"];

export interface SchemeCompletionOptions {
  /** DEBUG: keep the popup open when the editor loses focus — without this,
   *  clicking into devtools closes the tooltip and the popup DOM cannot be
   *  inspected at all. Never enable in production (a blurred editor holding a
   *  popup over other UI is wrong everywhere except a debugging bench). */
  keepOpenOnBlur?: boolean;
}

/** The completion source alone — compose into your own `autocompletion()`.
 *  With a `getCompletionContext`-capable backend this is the full Σ∩T-ranked
 *  pipeline; otherwise it degrades to the flat (name/kind) list. */
export function schemeCompletionSource(backend: SchemeIdeBackend): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const word = ctx.matchBefore(SYMBOL_BEFORE);
    if (word === null) return null;
    const emptyPrefix = word.from === word.to;
    const afterOpenParen = ctx.state.doc.sliceString(Math.max(0, word.from - 1), word.from) === "(";
    const rich = backend.getCompletionContext?.bind(backend);

    // Empty prefix: explicit invocation only. The unprompted moment at a
    // narrowed argument slot belongs to the GHOST (ghost.ts) — an inline
    // preview is the gentler shape of the same Σ∩T answer, and the two must
    // not race (the popup hides the ghost). Ctrl-Space always brings the list.
    if (emptyPrefix && !ctx.explicit) return null;

    if (rich !== undefined) {
      const doc = ctx.state.doc.toString();
      const context = await rich(doc, ctx.pos);
      const options_ = context.entries.map((e) => toRichCmCompletion(e));
      const seen = new Set(context.entries.map((e) => e.name));
      // Special forms: snippets right after `(`, bare keywords elsewhere.
      for (const form of afterOpenParen ? FORM_SNIPPETS : FORM_COMPLETIONS) {
        if (!seen.has(form.label)) options_.push(form);
      }
      if (options_.length === 0) return null;
      return { from: word.from, options: options_, validFor: SYMBOL_BEFORE, commitCharacters: COMMIT_CHARS };
    }

    // Flat fallback (a backend without getCompletionContext).
    const entries = await backend.getCompletionsAtPosition(ctx.state.doc.toString(), ctx.pos);
    const flat = toCmCompletions(entries);
    const seen = new Set(entries.map((e) => e.name));
    for (const form of FORM_COMPLETIONS) {
      if (!seen.has(form.label)) flat.push(form);
    }
    if (flat.length === 0) return null;
    return { from: word.from, options: flat, validFor: SYMBOL_BEFORE };
  };
}

/** Codepoint comparator — CM's default tie-break is localeCompare, which is
 *  environment-dependent; stable, deterministic order is a hard constraint. */
const byCodepoint = (a: Completion, b: Completion): number => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

/** Completion wired as the editor's autocompletion (overrides other sources). */
export function schemeCompletion(backend: SchemeIdeBackend, options?: SchemeCompletionOptions): Extension {
  return autocompletion({
    override: [schemeCompletionSource(backend)],
    compareCompletions: byCodepoint,
    ...(options?.keepOpenOnBlur === true ? { closeOnBlur: false } : {}),
  });
}

// ── semantic highlighting — the checker's knowledge over the lexical layer ──
// The grammar keeps painting keywords/strings/parens (scheme-sugarcoat tags); this
// layer adds what only the type lens knows: THIS atom is a parameter, THAT one
// a local, THAT one a function. Marks carry classes, not colors — the base
// theme italicizes parameters (typographic, theme-agnostic); themes may color
// `.cm-scheme-sem-<kind>` (parameter/variable/function/property/type/…).

const semanticMarks = new Map<string, Decoration>();
const semanticMark = (kind: string): Decoration => {
  let mark = semanticMarks.get(kind);
  if (mark === undefined) {
    mark = Decoration.mark({ class: `cm-scheme-sem cm-scheme-sem-${kind}` });
    semanticMarks.set(kind, mark);
  }
  return mark;
};

/** Lift classified spans into a decoration set, clamped + sorted (exported for tests). */
export function classificationsToDecorations(
  spans: readonly SchemeIdeClassifiedSpan[],
  docLength: number,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const s of spans.toSorted((a, b) => a.start - b.start || a.length - b.length)) {
    const from = Math.max(0, Math.min(s.start, docLength));
    const to = Math.max(from, Math.min(s.start + s.length, docLength));
    if (to === from) continue;
    builder.add(from, to, semanticMark(s.kind));
  }
  return builder.finish();
}

const semanticTheme = EditorView.baseTheme({
  ".cm-scheme-sem-parameter": { fontStyle: "italic" },
});

export interface SchemeSemanticHighlightOptions {
  /** Debounce after the last edit before re-classifying (ms). Default 400. */
  delay?: number;
}

/** Semantic token highlighting over the backend's classifications. No-op when
 *  the backend doesn't implement `getSemanticClassifications`. */
export function schemeSemanticHighlight(
  backend: SchemeIdeBackend,
  options?: SchemeSemanticHighlightOptions,
): Extension {
  const classify = backend.getSemanticClassifications?.bind(backend);
  if (classify === undefined) return [];

  const setMarks = StateEffect.define<DecorationSet>();
  const marksField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (deco, tr) => {
      let next = deco.map(tr.changes);
      for (const e of tr.effects) if (e.is(setMarks)) next = e.value;
      return next;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private generation = 0;
      constructor(private readonly view: EditorView) {
        this.schedule();
      }
      update(u: ViewUpdate): void {
        if (u.docChanged) this.schedule();
      }
      destroy(): void {
        this.generation += 1; // orphan any in-flight run
        if (this.timer !== null) clearTimeout(this.timer);
      }
      private schedule(): void {
        const gen = ++this.generation;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.run(gen), options?.delay ?? 400);
      }
      private async run(gen: number): Promise<void> {
        let spans: SchemeIdeClassifiedSpan[];
        try {
          spans = await classify(this.view.state.doc.toString());
        } catch {
          return; // a mid-edit parse failure keeps the previous marks
        }
        if (gen !== this.generation) return; // superseded by a newer edit
        this.view.dispatch({
          effects: setMarks.of(classificationsToDecorations(spans, this.view.state.doc.length)),
        });
      }
    },
  );

  return [marksField, plugin, semanticTheme];
}

export interface SchemeGotoDefinitionOptions {
  /** Cross-file jump: called when the definition lives in a REQUIRED file —
   *  `(path, span-in-that-file)`. Absent → cross-file definitions are ignored
   *  (the editor can't open files on its own). */
  openFile?: (path: string, span: { start: number; length: number }) => void;
}

/** Cmd/Ctrl-click on a symbol jumps to its definition — in-buffer, or through
 *  `openFile` when it lives in a required file. (A builtin's definition lives
 *  in the prelude and has no jump target.) */
export function schemeGotoDefinition(backend: SchemeIdeBackend, options?: SchemeGotoDefinitionOptions): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      void (async () => {
        const defs = await backend.getDefinitionAtPosition(view.state.doc.toString(), pos);
        const hit = defs.find((d) => d.span !== null);
        if (hit?.span == null) return;
        if (hit.file !== undefined) {
          options?.openFile?.(hit.file, hit.span);
          return;
        }
        view.dispatch({
          selection: { anchor: hit.span.start, head: hit.span.start + hit.span.length },
          scrollIntoView: true,
          userEvent: "select.definition",
        });
      })();
      return true; // claim the click — don't also move the caret mid-jump
    },
  });
}

export interface SchemeIdeOptions {
  lint?: boolean | SchemeLinterOptions;
  hover?: boolean;
  completion?: boolean;
  gotoDefinition?: boolean;
  semanticHighlight?: boolean | SchemeSemanticHighlightOptions;
  ghost?: boolean | SchemeGhostOptions;
  /** Cross-file goto-def: open a REQUIRED file at a span (the studio's file
   *  switcher). Absent → cross-file definitions are ignored. */
  openFile?: (path: string, span: { start: number; length: number }) => void;
}

/** The IDE bundle: lint + hover + completion + go-to-definition + semantic
 *  highlighting + ghost preview (each opt-out; semantic highlighting and the
 *  ghost also require the backend's optional methods). */
export function schemeIde(backend: SchemeIdeBackend, options?: SchemeIdeOptions): Extension {
  const ext: Extension[] = [];
  if (options?.lint !== false)
    ext.push(schemeLinter(backend, typeof options?.lint === "object" ? options.lint : undefined));
  if (options?.hover !== false) ext.push(schemeHover(backend));
  if (options?.completion !== false) ext.push(schemeCompletion(backend));
  if (options?.gotoDefinition !== false)
    ext.push(
      schemeGotoDefinition(backend, options?.openFile === undefined ? undefined : { openFile: options.openFile }),
    );
  if (options?.semanticHighlight !== false)
    ext.push(
      schemeSemanticHighlight(
        backend,
        typeof options?.semanticHighlight === "object" ? options.semanticHighlight : undefined,
      ),
    );
  if (options?.ghost !== false)
    ext.push(schemeGhost(backend, typeof options?.ghost === "object" ? options.ghost : undefined));
  return ext;
}
