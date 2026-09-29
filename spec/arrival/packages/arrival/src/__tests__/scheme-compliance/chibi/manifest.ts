// Chibi harness v2 — manifest.ts (docs/test-suite-architecture.md F4).
//
// Builds an ordered `Manifest` of `Step`s from the raw r7rs-tests.scm corpus text, entirely at
// collection time (top-level await in the spec). Two passes:
//
//   1. `splitTopLevelForms` — a STRUCTURAL splitter (paren/bracket depth, strings, `;` line
//      comments, nested `#| … |#` block comments, `#\` char literals, `#;` datum comments). It
//      matches NO content patterns — the "find complex forms" job v1's `stripComplexForms`
//      did is replaced entirely by step 2 below (the reader is the detector, not a regex).
//   2. Per-form `readerParse` + head-symbol classification. A slice whose parse throws becomes
//      an `unreadable` step (carrying the reader's own door message) instead of aborting
//      anything. A parseable form is classified by its head symbol:
//        - `test-begin`/`test-end` → section markers (never executed; the manifest already
//          carries the nesting, so the runner doesn't need to interpret these at all).
//        - `import` → DROPPED. arrival has no scheme-level `import` special form (see
//          `reference-import-deleted-require-is-the-loader.md`); the corpus's one occurrence
//          (line 3) would otherwise become a poisoned "setup" step. This is head-symbol
//          matched — the same mechanism as every other classification here — not a content
//          regex, so it stays within the "reader/structure, never content" discipline.
//        - a `test`/`test-assert`/`test-error`/`test-values`/`test-numeric-syntax` head → a
//          standalone `TestStep`.
//        - a `let`/`let*`/`letrec`/`letrec*`/`let-values`/`let*-values`/`let-syntax`/
//          `letrec-syntax`/`begin` head whose DIRECT body forms include at least one test-head
//          form → a `block` step (§3.1 "Block steps"): the corpus is genuinely stateful (a
//          `(let () (define count 0) …)` idiom), so these execute as ONE unit with k outcome
//          slots. (Broader than the harness design's literal "let/letrec" phrasing — the corpus
//          also nests single test forms under `let-syntax`/`letrec-syntax`/`begin`, e.g. lines
//          557-567 and 569-573; recognizing only bare `let` would silently drop those test rows
//          from the manifest, which is worse than the minor scope broadening.)
//        - anything else → a `setup` step (a `define`, a bare statement, …), executed for its
//          side effects but never itself a vitest row.
//
// `datumSymbols` is a plain recursive walk over the parsed datum (APair spine + AVector
// elements), collecting every `ASymbol.__name__` string it finds — this is what the
// registries (registries.ts) match on, replacing v1's substring matching over stringified
// names.
import fs from "fs";
import { ANil } from "../../../values/primitives/ANil.js";
import { APair } from "../../../values/primitives/APair.js";
import { ASymbol } from "../../../values/primitives/ASymbol.js";
import { AString } from "../../../values/primitives/AString.js";
import { AVector } from "../../../values/primitives/AVector.js";
import { parse as readerParse } from "../../../reader/parse.js";
import type { SchemeValue } from "../../../values/types.js";

export type TestFormKind = "test" | "test-assert" | "test-error" | "test-values" | "test-numeric-syntax";

/** Splitter output: one exact source slice per top-level form, plus its 1-based start line. */
export interface RawForm {
  text: string;
  line: number;
}

export interface TestStep {
  kind: "test";
  /** Corpus order, execution key. Unique across the whole manifest (setups + tests + blocks +
   *  unreadable share one sequence, so the cursor in runner.ts can advance monotonically
   *  across ALL of them, not just test steps). */
  index: number;
  /** Innermost enclosing section name ("6.2 Numbers"), or "(preamble)" before the first
   *  `test-begin`. */
  section: string;
  /** Full section nesting, outermost first (["R7RS", "6.13 Input and output", "Read syntax"]). */
  sectionPath: string[];
  formKind: TestFormKind;
  /** Exact source slice for a standalone test; for a block MEMBER, a reconstructed exact slice
   *  of just that member's own sub-form (see `blockMembers` below) — display/forensics only,
   *  never re-executed on its own (the owning block execs as one unit; see runner.ts). */
  text: string;
  /** r7rs-tests.scm line. For a block member this is the OWNING BLOCK's start line (an
   *  approximation — the structural splitter does not track per-child line offsets within an
   *  already-sliced block; acceptable since this field is forensics-only for members). */
  line: number;
  /** Display name: normalized (whitespace-collapsed) form text, ≤200 chars. */
  name: string;
  /** Every identifier referenced anywhere in this form's datum (recursive walk) — what the
   *  registries (registries.ts) match on. */
  symbols: ReadonlySet<string>;
  /** false for a standalone top-level test step; true for a step reachable only via a `block`
   *  step's `members` array. */
  nested: boolean;
  /** 0-based position within the owning block's `members` array. Present iff `nested`. */
  slot?: number;
}

export type Step =
  | { kind: "section-begin"; name: string; line: number }
  | { kind: "section-end"; line: number }
  | { kind: "setup"; index: number; section: string; sectionPath: string[]; text: string; line: number }
  | TestStep
  | {
      kind: "block";
      index: number;
      section: string;
      sectionPath: string[];
      text: string;
      line: number;
      members: TestStep[];
    }
  | {
      kind: "unreadable";
      index: number;
      section: string;
      sectionPath: string[];
      text: string;
      line: number;
      readerError: string;
    };

export interface Manifest {
  corpusPath: string;
  steps: Step[];
  /** Every TestStep in corpus order, standalone AND block members flattened together
   *  (a block's members appear at the position its OWN step occupies in `steps`). */
  tests: TestStep[];
}

// ── head-symbol classification tables ───────────────────────────────────────────────────────

const TEST_HEADS: ReadonlySet<string> = new Set([
  "test",
  "test-assert",
  "test-error",
  "test-values",
  "test-numeric-syntax",
]);

// Broader than "let/letrec" (see file header): every head under which the corpus nests a
// single test form as part of a stateful/scoped unit.
const BLOCK_HEADS: ReadonlySet<string> = new Set([
  "let",
  "let*",
  "letrec",
  "letrec*",
  "let-values",
  "let*-values",
  "let-syntax",
  "letrec-syntax",
  "begin",
]);

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── datum helpers (raw APair/ASymbol walks — no unboxing, no to_array normalization) ────────

/** The direct children of a list-shaped datum `(a b c …)`: `[a, b, c, …]`. Stops at the first
 *  non-APair tail (ANil for a proper list; an improper tail is simply dropped — none of the
 *  heads this module classifies are ever improper lists in valid R7RS source). */
function listForms(list: SchemeValue): SchemeValue[] {
  const out: SchemeValue[] = [];
  let node: SchemeValue = list;
  while (node instanceof APair) {
    out.push(node.car);
    node = node.cdr as SchemeValue;
  }
  return out;
}

/** Exported for corpora whose top-level shape needs unwrapping before the classifier below
 *  can run (e.g. chibi's own SRFI-1 `test.sld`, wrapped in `define-library`/`begin`/
 *  `define` — see `srfi1-manifest.ts`): the same reader-based head-symbol check this module
 *  uses everywhere else, never a text/content match. */
export function headSymbolName(form: SchemeValue): string | undefined {
  if (!(form instanceof APair)) return undefined;
  const head = form.car;
  if (head instanceof ASymbol && typeof head.__name__ === "string") return head.__name__;
  return undefined;
}

function stringLiteralArg(form: SchemeValue, n: number): string | undefined {
  const el = listForms(form)[n];
  return el instanceof AString ? el.valueOf() : undefined;
}

/** Recursive datum walk collecting every symbol NAME referenced anywhere in `datum` — head
 *  symbols, operands, quoted data, vector elements. Guards APair identity to tolerate a
 *  reader-shared/cyclic structure (datum labels) without looping forever. */
export function datumSymbols(datum: SchemeValue): ReadonlySet<string> {
  const out = new Set<string>();
  const seen = new Set<APair<SchemeValue, SchemeValue>>();
  const walk = (v: unknown): void => {
    if (v instanceof ASymbol) {
      if (typeof v.__name__ === "string") out.add(v.__name__);
      return;
    }
    if (v instanceof APair) {
      if (seen.has(v)) return;
      seen.add(v);
      walk(v.car);
      walk(v.cdr);
      return;
    }
    if (v instanceof AVector) {
      for (const el of v.__vector__) walk(el);
      return;
    }
    // ANil / AString / AExact / AInexact / ABool / ACharacter / ABytevector / … carry no
    // identifiers of their own.
  };
  walk(datum);
  return out;
}

/** The index (within `listForms(form)`) where a let-family/begin form's BODY starts — i.e.
 *  past the head symbol and (for let-family) the bindings clause. Handles named `let`
 *  (`(let loop ((x 0)) …)`, where the name occupies the slot a bindings list would). */
function bodyStartIndex(items: SchemeValue[], head: string): number {
  if (head === "begin") return 1;
  if (items.length >= 2 && items[1] instanceof ASymbol) return 3; // named let
  return 2;
}

/** Scan a let-family/begin form's direct body children for nested `test*` forms, returning
 *  each as its own `TestStep` (§3.1 "Block steps"). `text`/`line` for each member are
 *  reconstructed from the RAW SOURCE (not the print protocol): `splitTopLevelForms` re-run
 *  over the block's own inner text yields index-aligned source slices for
 *  `[head, bindings-or-name, …body]`, exactly mirroring `listForms(form)`'s structure — so a
 *  member's `text` is a byte-exact slice of the original corpus, not a reprint. Only DIRECT
 *  children are scanned (a test nested two `let`s deep is not individually attributed — the
 *  owning block still executes it via the shared exec, just without its own `it()` row; a
 *  documented, narrow limitation, not a correctness bug: nothing is dropped from EXECUTION,
 *  only from per-row attribution). */
function blockMembers(
  form: SchemeValue,
  head: string,
  raw: RawForm,
  section: string,
  sectionPath: string[],
  nextIndex: () => number,
): TestStep[] {
  const items = listForms(form);
  const innerText = raw.text.slice(1, -1); // drop the outer ( … ) / [ … ] pair
  const rawChildren = splitTopLevelForms(innerText).map((f) => f.text);
  const aligned = rawChildren.length === items.length;

  const start = bodyStartIndex(items, head);
  const members: TestStep[] = [];
  for (let idx = start; idx < items.length; idx++) {
    const child = items[idx];
    const childHead = headSymbolName(child);
    if (childHead === undefined || !TEST_HEADS.has(childHead)) continue;
    const text = aligned ? rawChildren[idx] : raw.text;
    members.push({
      kind: "test",
      index: nextIndex(),
      section,
      sectionPath,
      formKind: childHead as TestFormKind,
      text,
      line: raw.line,
      name: normalizeText(text).slice(0, 200),
      symbols: datumSymbols(child),
      nested: true,
      slot: members.length,
    });
  }
  return members;
}

// ── structural splitter (§6): paren/bracket depth, strings, `;` comments, nested `#| |#`,
//    `#\` char literals, `#;` datum comments. NO content patterns. ─────────────────────────

function buildLineIndex(text: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") offsets.push(i);
  return offsets;
}

function lineAt(offsets: number[], pos: number): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

function skipStringLiteral(text: string, i: number): number {
  i++; // opening quote
  const len = text.length;
  while (i < len) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      i++;
      break;
    }
    i++;
  }
  return i;
}

/** `|…|` pipe-quoted symbol literal (R7RS §7.1.1) — `\|`/`\\` are its only escapes (mirrors
 *  `ASymbol.toString`'s bar-quoting). WITHOUT this, a `"` inside one (e.g. the corpus's
 *  `'|\"|`, r7rs-tests.scm:2268) is misread by `scanBalancedForm` as opening a real string
 *  literal, desyncing paren-depth tracking for everything after — the bug this fixes covers
 *  ~10KB / most of "Numeric syntax" collapsing into one bogus slice. */
function skipPipeSymbol(text: string, i: number): number {
  i++; // opening |
  const len = text.length;
  while (i < len) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "|") {
      i++;
      break;
    }
    i++;
  }
  return i;
}

/** `#| … |#`, nesting-aware (3 in the corpus, per design doc §0). `i` points at the leading
 *  `#`; returns the index just past the matching `|#`. */
function skipBlockComment(text: string, i: number): number {
  i += 2;
  let depth = 1;
  const len = text.length;
  while (i < len && depth > 0) {
    if (text[i] === "#" && text[i + 1] === "|") {
      depth++;
      i += 2;
      continue;
    }
    if (text[i] === "|" && text[i + 1] === "#") {
      depth--;
      i += 2;
      continue;
    }
    i++;
  }
  return i;
}

/** `#\` char literal: at least one char after the backslash, extended through any further
 *  alnum/hyphen run (named literals: `#\newline`, `#\x41`). `i` points at the leading `#`. */
function skipCharLiteral(text: string, i: number): number {
  const len = text.length;
  let j = i + 3;
  while (j < len && /[A-Za-z0-9-]/.test(text[j])) j++;
  return j;
}

/** Skip exactly one datum starting at `i` (leading whitespace/comments first) — the `#;`
 *  prefix's operand (13 in the corpus, all inside string literals per a direct check of this
 *  corpus, but handled generally regardless). Reuses `scanBalancedForm` for a parenthesized
 *  datum; a bare-token scan otherwise. */
function skipDatumComment(text: string, i: number): number {
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === ";") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    if (ch === "#" && text[i + 1] === "|") {
      i = skipBlockComment(text, i);
      continue;
    }
    if (ch === "#" && text[i + 1] === ";") {
      i = skipDatumComment(text, i + 2); // nested datum comment
      continue;
    }
    break;
  }
  if (i >= len) return i;
  if (text[i] === "(" || text[i] === "[") return scanBalancedForm(text, i);
  if (text[i] === '"') return skipStringLiteral(text, i);
  if (text[i] === "#" && text[i + 1] === "\\") return skipCharLiteral(text, i);
  if (text[i] === "|") return skipPipeSymbol(text, i);
  let j = i;
  while (j < len && !/[\s()[\]";]/.test(text[j])) j++;
  return j === i ? i + 1 : j; // never stall on a lone delimiter char
}

/** Scan a balanced `( … )`/`[ … ]` form starting at `i` (the opening bracket). Structural
 *  only — see the module header. Returns the index just past the matching close. */
function scanBalancedForm(text: string, i: number): number {
  const len = text.length;
  let depth = 0;
  while (i < len) {
    const ch = text[i];
    if (ch === '"') {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === ";") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    if (ch === "#" && text[i + 1] === "|") {
      i = skipBlockComment(text, i);
      continue;
    }
    if (ch === "#" && text[i + 1] === ";") {
      i = skipDatumComment(text, i + 2);
      continue;
    }
    if (ch === "#" && text[i + 1] === "\\") {
      i = skipCharLiteral(text, i);
      continue;
    }
    if (ch === "|") {
      i = skipPipeSymbol(text, i);
      continue;
    }
    if (ch === "(" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i; // unterminated — defensive only; a well-formed corpus never reaches this
}

/** Cut `text` into top-level forms: structural only (paren/bracket depth, strings, `;` line
 *  comments, nested `#| … |#` block comments, `#\` char literals, `#;` datum comments) — no
 *  content patterns whatsoever. Promoted from v1's `stripComplexForms` scanner (which found
 *  form BOUNDARIES the same way, then additionally pattern-matched content — the content half
 *  is gone, dropped in the harness v2 redesign). */
export function splitTopLevelForms(text: string): RawForm[] {
  const offsets = buildLineIndex(text);
  const forms: RawForm[] = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === ";") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    if (ch === "#" && text[i + 1] === "|") {
      i = skipBlockComment(text, i);
      continue;
    }
    if (ch === "#" && text[i + 1] === ";") {
      i = skipDatumComment(text, i + 2);
      continue;
    }
    if (ch === "(" || ch === "[") {
      const start = i;
      const startLine = lineAt(offsets, start);
      i = scanBalancedForm(text, i);
      forms.push({ text: text.slice(start, i), line: startLine });
      continue;
    }
    // A bare top-level atom (symbol/number/boolean/string/pipe-symbol/char literal) — no
    // top-level CORPUS form is ever a bare atom, but `blockMembers` re-runs this splitter over
    // a form's INNER content to source-slice its direct children, and the very first of those
    // (the head symbol, e.g. `let`/`begin`) is exactly a bare atom — so it must be captured,
    // not silently skipped, or the reconstructed children desync from `listForms(form)`.
    {
      const start = i;
      const startLine = lineAt(offsets, start);
      if (ch === '"') i = skipStringLiteral(text, i);
      else if (ch === "|") i = skipPipeSymbol(text, i);
      else if (ch === "#" && text[i + 1] === "\\") i = skipCharLiteral(text, i);
      else {
        let j = i;
        while (j < len && !/[\s()[\]";|]/.test(text[j])) j++;
        i = j === i ? i + 1 : j; // never stall on a lone delimiter char
      }
      forms.push({ text: text.slice(start, i), line: startLine });
    }
  }
  return forms;
}

// ── manifest builder (§9) ───────────────────────────────────────────────────────────────────

/** Whole-file corpus (r7rs-tests.scm): read + structurally split at the top level, then
 *  delegate to the shared classifier below. */
export async function buildManifest(corpusPath: string): Promise<Manifest> {
  const text = fs.readFileSync(corpusPath, "utf-8");
  const rawForms = splitTopLevelForms(text);
  return buildManifestFromForms(corpusPath, rawForms);
}

/** The classifier core, shared by `buildManifest` (whole-file corpora) and any corpus that
 *  must first extract its own ordered top-level form list from a non-top-level wrapper —
 *  e.g. chibi's own SRFI-1 `test.sld`, whose test forms sit inside
 *  `(define-library … (begin (define (run-tests) …)))` rather than at the file's own top
 *  level (see `srfi1-manifest.ts`'s `extractSrfi1Body`, which produces exactly this
 *  `RawForm[]` shape via the same structural splitter before handing off here). Identical
 *  head-symbol classification either way — a wrapper's extracted body is indistinguishable
 *  from a genuine top level once it's a `RawForm[]`. */
export async function buildManifestFromForms(corpusPath: string, rawForms: readonly RawForm[]): Promise<Manifest> {
  const steps: Step[] = [];
  const tests: TestStep[] = [];
  const sectionStack: string[] = [];
  let nextIndex = 0;
  const takeIndex = (): number => nextIndex++;

  for (const raw of rawForms) {
    let parsed: SchemeValue[];
    try {
      parsed = await readerParse(raw.text);
    } catch (e) {
      steps.push({
        kind: "unreadable",
        index: takeIndex(),
        section: sectionStack.at(-1) ?? "(preamble)",
        sectionPath: [...sectionStack],
        text: raw.text,
        line: raw.line,
        readerError: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (parsed.length !== 1) {
      steps.push({
        kind: "unreadable",
        index: takeIndex(),
        section: sectionStack.at(-1) ?? "(preamble)",
        sectionPath: [...sectionStack],
        text: raw.text,
        line: raw.line,
        readerError: `structural slice parsed to ${parsed.length} datums, expected exactly 1`,
      });
      continue;
    }
    const form = parsed[0];
    const head = headSymbolName(form);

    if (head === "import") continue; // see file header — dropped, never executed

    if (head === "test-begin") {
      const name = stringLiteralArg(form, 1) ?? "(unnamed)";
      sectionStack.push(name);
      steps.push({ kind: "section-begin", name, line: raw.line });
      continue;
    }
    if (head === "test-end") {
      sectionStack.pop();
      steps.push({ kind: "section-end", line: raw.line });
      continue;
    }

    const section = sectionStack.at(-1) ?? "(preamble)";
    const sectionPath = [...sectionStack];

    if (head !== undefined && TEST_HEADS.has(head)) {
      const test: TestStep = {
        kind: "test",
        index: takeIndex(),
        section,
        sectionPath,
        formKind: head as TestFormKind,
        text: raw.text,
        line: raw.line,
        name: normalizeText(raw.text).slice(0, 200),
        symbols: datumSymbols(form),
        nested: false,
      };
      steps.push(test);
      tests.push(test);
      continue;
    }

    if (head !== undefined && BLOCK_HEADS.has(head)) {
      // Peek member count first (a pure scan, no index consumption) so the BLOCK's own index
      // precedes its members' — corpus order stays intuitive in forensics ("step N/1087")
      // even though members are the ones individually registered as `it()` rows.
      const preview = blockMembers(form, head, raw, section, sectionPath, () => -1);
      if (preview.length > 0) {
        const blockIndex = takeIndex();
        const members = blockMembers(form, head, raw, section, sectionPath, takeIndex);
        steps.push({
          kind: "block",
          index: blockIndex,
          section,
          sectionPath,
          text: raw.text,
          line: raw.line,
          members,
        });
        tests.push(...members);
        continue;
      }
      // A let/begin with no nested test* member is plain setup — fall through.
    }

    steps.push({ kind: "setup", index: takeIndex(), section, sectionPath, text: raw.text, line: raw.line });
  }

  return { corpusPath, steps, tests };
}
