// scanner.ts — Layer S: the structural validity oracle.
// The oracle S reader in the static plane: docs/static-plane.md §THE FOUR READERS 4.2.
//
// Implementation of the constraint-kernel oracle's STATIC/STRUCTURAL half
// (sift/src/sampler/oracle-contract.ts). Reports the parse state at the end of an ACCEPTED
// PREFIX — paren depth, string/comment, operator-vs-argument position, form kind, whether the
// program is COMPLETE-ABLE here — and the structural next-token classes. Every method is a PURE
// FUNCTION OF THE PREFIX: no lookahead, no backtracking, aligning the constraint with
// autoregressive generation (the model emits token t from 1..t-1 and never revises).
//
// Why a single-pass scanner, not the Lexer FSM:
// The oracle is DEFINED ON TRUNCATED INPUT — EOF is its normal case — but the real Lexer
// (src/reader/Lexer.ts) THROWS `Unterminated` on exactly the truncated prefixes the oracle must
// report gracefully:
//
//   "(foo \"abc"   → Lexer throws; oracle must report { inString: true }
//   "#| open"      → Lexer throws; oracle must report { inComment: true }
//
// A bare paren inside an unterminated string is data, not structure — the oracle must KNOW that,
// and the Lexer can't tell us because it crashes before yielding the state. So Layer S ports the
// single-pass semantics of sift's `prefix-oracle.ts` (the S-only reference) directly. Shared,
// non-crashing machinery from arrival is `specials.names()` — the reader-macro set
// ('  ` ,@ , #( …) — which the scanner consults to classify quote/quasiquote prefixes.
//
// This scanner AGREES with `prefix-oracle.ts` on every shared structural field for every prefix
// (docs/static-plane.md §AGREEMENT GATES; mirror-contract drift alarm is oracle/contract.ts).
// The contract adds `formKind`/`strict` (strict-vs-lazy axis) and the Σ/T hooks
// (`validSymbols`/`expectedType`/`produces`) — for Layer S those degrade gracefully: Σ/T return
// null/true; formKind/strict derive structurally from the enclosing form's head where cheaply
// knowable, defaulting to application/top.

import * as specials from "../reader/specials.js";
import type {
  CursorPosition,
  FormKind,
  OracleScanner,
  OracleSession,
  OracleState,
  TokenClass,
  TypeTag,
} from "./contract.js";
import { computeValidSymbols, type OracleEnvΣ } from "./sigma.js";

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** Reader-macro prefixes whose following datum is QUOTED (data, not code → lazy, Σ/T off). A subset
 *  of arrival's reader-macro set; the assertion below pins that coupling so a future change to the
 *  Lexer's reader macros surfaces here rather than drifting silently. */
const QUOTE_PREFIXES = new Set(["'", "`"]);
for (const p of QUOTE_PREFIXES) {
  if (!specials.names().includes(p)) {
    throw new Error(`oracle/scanner: quote prefix ${p} is not an arrival reader macro`);
  }
}

/** Special-form heads whose later operands are LAZY arms (run only on a runtime condition). */
const LAZY_HEADS = new Set(["if", "and", "or", "when", "unless", "cond", "case"]);
/** Special-form heads that introduce a lambda-list as their first operand. */
const LAMBDA_HEADS = new Set(["lambda", "define", "named-lambda"]);
/** Special-form heads whose contents are pure data (Σ/T disabled, `.` legal). */
const QUOTE_HEADS = new Set(["quote"]);

/** Per-open-form frame carried down the scan stack. */
interface Frame {
  /** How many COMPLETE elements have been seen in this form (0 ⇒ next atom is the operator). */
  elems: number;
  /** The opening delimiter char ( [ { — for matched-close diagnostics if needed later. */
  open: string;
  /** The operator symbol of this form once known (elems ≥ 1 started with an atom), else null. */
  head: string | null;
  /** True iff this form was opened immediately after a quote/quasiquote reader macro. */
  quoted: boolean;
}

/** The raw structural scan result — every field a pure function of the prefix. Exported
 *  alongside `scan` (consumed via `/lsp-internals`). */
export interface ScanResult {
  depth: number;
  inString: boolean;
  inComment: boolean;
  midToken: boolean;
  position: CursorPosition;
  formKind: FormKind;
  strict: boolean;
  closeable: boolean;
  closeSuffix: string;
  overClosed: boolean;
}

/**
 * Scan a partial program and report the parse state at its end. Pure, O(n), single pass.
 * String escapes, `;` line comments, and nested `#| |#` block comments are honored so a `)` or
 * `(` inside them is text, not structure. Truncation is the normal case: an unterminated string
 * reports `inString:true`, an unterminated block comment `inComment:true` — never a throw.
 */
export function scan(src: string): ScanResult {
  const stack: Frame[] = [];
  let depth = 0;
  let min = 0;
  let inString = false;
  let inComment = false;
  let blockComment = 0;
  let esc = false;
  let midToken = false;
  // The token currently being accumulated (for head/quote classification at boundaries).
  let cur = "";

  const finishToken = () => {
    if (!midToken) return;
    midToken = false;
    const top = stack.at(-1);
    if (top) {
      if (top.elems === 0) top.head = cur; // first element is the operator
      top.elems++;
    }
    cur = "";
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;

    if (inString) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (blockComment > 0) {
      if (c === "#" && src[i + 1] === "|") {
        blockComment++;
        i++;
      } else if (c === "|" && src[i + 1] === "#") {
        blockComment--;
        i++;
      }
      continue;
    }
    if (inComment) {
      if (c === "\n") inComment = false;
      continue;
    }

    if (c === '"') {
      finishToken();
      inString = true;
      continue;
    }
    if (c === ";") {
      finishToken();
      inComment = true;
      continue;
    }
    if (c === "#" && src[i + 1] === "|") {
      finishToken();
      blockComment = 1;
      i++;
      continue;
    }

    if (OPEN.has(c)) {
      // A lone quote/quasiquote prefix immediately before `(` quotes the new form. The reference
      // reader treats `'` as ordinary atom content, so we mirror that for the structural counters:
      // detect the quote prefix from the in-flight token, then finishToken (which counts it exactly
      // as the reference does — a no-op increment with no live frame, an element with one).
      const quotePrefix = midToken && QUOTE_PREFIXES.has(cur);
      finishToken();
      const parent = stack.at(-1);
      // A child form is data (quoted) if a quote prefix precedes it, OR its parent is already
      // quoted, OR its parent's head is `quote`/`quasiquote` (its operands are data).
      const quoted =
        quotePrefix || (parent ? parent.quoted || (parent.head !== null && QUOTE_HEADS.has(parent.head)) : false);
      depth++;
      stack.push({ elems: 0, open: c, head: null, quoted });
      continue;
    }
    if (CLOSE.has(c)) {
      finishToken();
      depth--;
      if (depth < min) min = depth;
      stack.pop();
      const parent = stack.at(-1);
      if (parent) parent.elems++; // a finished sub-form is one element of its parent
      continue;
    }
    if (/\s/.test(c)) {
      finishToken();
      continue;
    }

    // any other char (including the reader-macro prefixes '  `  , @) is atom content — exactly
    // as the reference reader treats it. We classify a lone quote prefix at the next `(` instead.
    midToken = true;
    cur += c;
  }

  const inText = inString || inComment || blockComment > 0;
  const top = stack.at(-1);

  let position: CursorPosition;
  if (depth === 0) position = "top";
  else position = top && top.elems === 0 ? "operator" : "argument";

  const { formKind, strict } = classifyForm(stack, position, cur);

  return {
    depth,
    inString,
    inComment: inComment || blockComment > 0,
    midToken,
    position,
    formKind,
    strict,
    closeable: depth === 0 && !inText,
    closeSuffix: depth > 0 ? ")".repeat(depth) : "",
    overClosed: min < 0,
  };
}

/** Derive the enclosing form's kind + strictness from the open-form stack. `curToken` is the
 *  in-flight token at the cursor (used only to spot a lone quote prefix mid-type). */
function classifyForm(
  stack: Frame[],
  position: CursorPosition,
  curToken: string,
): { formKind: FormKind; strict: boolean } {
  const top = stack.at(-1);
  if (!top) {
    // Top level: a form completed here is inevitable ⇒ strict.
    return { formKind: "top", strict: true };
  }

  // A quoted form (opened under ' or `, or whose head is `quote`) is pure data: lazy, Σ/T off.
  if (top.quoted || (top.head !== null && QUOTE_HEADS.has(top.head))) {
    return { formKind: "quote", strict: false };
  }

  // Lambda-list: the first operand slot of lambda/define/named-lambda is a parameter list.
  if (top.head !== null && LAMBDA_HEADS.has(top.head)) {
    // operand index 1 is the lambda-list; later operands are the (lazy) body.
    if (top.elems === 1 && position === "argument") return { formKind: "lambda-list", strict: false };
    if (top.elems >= 1) return { formKind: "lazy-arm", strict: false };
  }

  // Lazy arms: operands of if/and/or/cond/case/when/unless run only on a runtime condition.
  if (top.head !== null && LAZY_HEADS.has(top.head) && position === "argument") {
    return { formKind: "lazy-arm", strict: false };
  }

  // A lone quote/quasiquote prefix being typed at the cursor quotes the next datum.
  if (QUOTE_PREFIXES.has(curToken)) return { formKind: "quote", strict: false };

  // Default: an ordinary application in a strict position.
  return { formKind: "application", strict: true };
}

/** The structural next-token classes valid after this state — the model-free Layer-S mask. */
export function validNextClasses(s: ScanResult): Set<TokenClass> {
  if (s.inString || s.inComment) return new Set<TokenClass>(["atom"]); // inside text: keep typing it
  const out = new Set<TokenClass>(["open", "atom", "string"]);
  if (s.depth > 0) out.add("close");
  if (s.closeable) out.add("end"); // EOS gate
  return out;
}

/**
 * Build the immutable OracleState verdict from a structural scan.
 *
 * Layer Σ (bound-symbol masking) is LIVE iff an `env` is injected: `validSymbols()` then returns
 * `boundSymbols() ∪ scope-locals`, position-filtered (operator ⇒ callables, argument ⇒ any). With no
 * env it degrades to null — the Layer-S contract ("Σ not modelled, do not constrain symbols").
 * T (expectedType/produces) stays null/true (graceful; type layer not modelled here).
 *
 * `prefix` is the accepted source the scan came from — Σ re-derives its lexical scope from it (a pure
 * function of the prefix, like every other field).
 */
function makeState(s: ScanResult, prefix: string, env: OracleEnvΣ | null): OracleState {
  const classes = validNextClasses(s);
  return {
    depth: s.depth,
    inString: s.inString,
    inComment: s.inComment,
    midToken: s.midToken,
    position: s.position,
    formKind: s.formKind,
    strict: s.strict,
    closeable: s.closeable,
    closeSuffix: s.closeSuffix,
    overClosed: s.overClosed,
    validSymbols: (): ReadonlySet<string> | null => computeValidSymbols(prefix, s.position, s.formKind, env),
    // T — not modelled (graceful per the contract).
    expectedType: (): TypeTag | null => null,
    produces: (_id: string, _type: TypeTag): boolean => true,
    validClasses: (): Set<TokenClass> => new Set(classes),
  };
}

/**
 * A resumable Layer-S session over a growing prefix. `advance` appends accepted text; `state` is
 * the verdict at the current cursor; `clone` branches for per-candidate masking with NO shared
 * mutable state. Layer S is structural-only: `lastClosed` is always null and `failed` always false
 * (no eager evaluation — that is the incremental evaluator, not Layer S).
 *
 * The session re-scans the accumulated prefix from scratch on each `advance`. That keeps the
 * resumable path always agreeing with `analyze` over the same prefix (asserted by the agreement
 * corpus) and correct by construction; the scan is O(n) and the prefixes are scout-program sized.
 */
class StructuralSession implements OracleSession {
  private prefix: string;
  private readonly env: OracleEnvΣ | null;

  constructor(prefix = "", env: OracleEnvΣ | null = null) {
    this.prefix = prefix;
    this.env = env;
  }

  advance(text: string): void {
    this.prefix += text;
  }

  clone(): OracleSession {
    // Carry the env into the branch — Σ must stay live on cloned sessions (the per-candidate masking
    // path), and the env is read-only here so sharing the reference is safe.
    return new StructuralSession(this.prefix, this.env);
  }

  get state(): OracleState {
    return makeState(scan(this.prefix), this.prefix, this.env);
  }

  get lastClosed(): null {
    return null;
  }

  get failed(): boolean {
    return false;
  }
}

/**
 * The stateless Layer-S scanner. `analyze` reports the verdict at the end of a whole prefix;
 * `feasible` answers the single query a constrained decoder needs per candidate: "is this partial
 * source the prefix of SOME valid program?" Structurally that is: well-nested (no over-close) and
 * not impossible to complete. `session` opens a resumable session seeded with an optional prefix.
 */
export const structuralScanner: OracleScanner = {
  analyze(prefix: string): OracleState {
    return makeState(scan(prefix), prefix, null);
  },
  feasible(prefix: string): boolean {
    const s = scan(prefix);
    // Over-closing (a `)` before its `(`) is a real misnesting — not a prefix of any valid program.
    // Everything else (open forms, mid-string, mid-comment, mid-token) is completable.
    return !s.overClosed;
  },
  session(prefix?: string): OracleSession {
    return new StructuralSession(prefix ?? "");
  },
};

/**
 * Build a Σ-LIVE scanner backed by a discovery `env`. Identical to {@link structuralScanner} for
 * every structural field (S is unchanged), but `validSymbols()` returns the position-filtered
 * bound set instead of null. Sessions opened from it carry the env into clones, so the per-candidate
 * masking path stays Σ-live. `feasible` is unchanged — structural feasibility is env-independent.
 */
export function makeSigmaScanner(env: OracleEnvΣ): OracleScanner {
  return {
    analyze(prefix: string): OracleState {
      return makeState(scan(prefix), prefix, env);
    },
    feasible(prefix: string): boolean {
      return !scan(prefix).overClosed;
    },
    session(prefix?: string): OracleSession {
      return new StructuralSession(prefix ?? "", env);
    },
  };
}
