// contract.ts — arrival's local, type-identical copy of the constraint-kernel oracle boundary.
//
// DRIFT ALARM. Canonical source: `sift/src/sampler/oracle-contract.ts`. Interfaces are
// re-declared here, NOT imported: arrival-scheme is a FOUNDATION package sift depends on,
// so importing sift types (even type-only) would invert the dependency arrow. The two
// copies MUST stay type-identical; the agreement corpus is the executable proof
// (runs sift's reference S reader and this impl over one shared corpus, asserts agreement).
//
// This package IMPLEMENTS these: Layer S (scanner.ts) supplies the structural half; Σ/T
// degrade gracefully (validSymbols/expectedType → null, produces → true) until those
// layers land. sift CONSUMES them, compiling per-cursor verdicts into a token mask /
// validator / repair pass without knowing how the verdict is computed.
//
// DESIGN INVARIANT: every method is a pure function of the ACCEPTED PREFIX — no lookahead,
// no backtracking — so the constraint aligns with autoregressive generation.

/** A type tag from arrival's entity algebra plus the structural kinds. `null` = unknown/any. */
export type TypeTag = string;

/** The structural token classes valid after a prefix (the model-free Layer-S mask). */
export type TokenClass = "open" | "close" | "atom" | "string" | "end";

/** Position of the token at/after the cursor. head = OPERATOR; later = ARGUMENT; depth-0 = TOP. */
export type CursorPosition = "top" | "operator" | "argument";

/** The KIND of the enclosing form — the strict-vs-lazy axis. `quote` also disables Σ/T. */
export type FormKind = "top" | "application" | "lambda-list" | "quote" | "lazy-arm";

/** The oracle's verdict at the cursor — a pure function of the accepted prefix. */
export interface OracleState {
  /** Net open delimiters (string/comment-aware). 0 ⇒ top level. */
  readonly depth: number;
  /** Inside a "…" string literal — a bare paren here is data, not structure. */
  readonly inString: boolean;
  /** Inside a `;` or `#| |#` comment. */
  readonly inComment: boolean;
  /** The cursor is inside an atom being typed (not at a token boundary). */
  readonly midToken: boolean;
  readonly position: CursorPosition;
  readonly formKind: FormKind;
  /** True iff the enclosing form is in a STRICT position (a form completed here is inevitable). */
  readonly strict: boolean;
  /** Could the program legally END here? (depth 0, not mid-string/comment.) The EOS gate. */
  readonly closeable: boolean;
  /** The suffix that completes the program from here — `")".repeat(depth)`. */
  readonly closeSuffix: string;
  /** A `)` appeared before its `(` in the prefix — a real misnesting (do not auto-repair). */
  readonly overClosed: boolean;

  /** Σ — bound identifiers valid at the cursor, position-filtered. `null` ⇒ Σ not modelled. */
  validSymbols(): ReadonlySet<string> | null;
  /** T — type expected at the current argument slot. `null` ⇒ no type constraint. */
  expectedType(): TypeTag | null;
  /** T — does `id` PRODUCE `type`? Structural stub returns true. */
  produces(id: string, type: TypeTag): boolean;
  /** The structural next-token classes (Layer S). Always available. */
  validClasses(): Set<TokenClass>;
}

/** The real value of a committed, eager-evaluated strict form (the dynamic half). */
export type EvalResult =
  | { readonly ok: true; readonly value: unknown; readonly type: TypeTag | null; readonly provenance?: unknown }
  | { readonly ok: false; readonly error: string };

/** A resumable oracle over a growing prefix. */
export interface OracleSession {
  /** Extend the accepted prefix by `text` (one or many tokens). */
  advance(text: string): void;
  /** A detached copy at the current prefix — for masking candidate continuations (no effects). */
  clone(): OracleSession;
  readonly state: OracleState;
  /** The real result of the strict form the last `advance` closed, or `null` (Layer S ⇒ null). */
  readonly lastClosed: EvalResult | null;
  /** A committed form has already failed → the decoder should stop early (Layer S ⇒ false). */
  readonly failed: boolean;
}

/** The stateless entry — analyse a whole prefix from scratch. */
export interface OracleScanner {
  analyze(prefix: string): OracleState;
  feasible(prefix: string): boolean;
  /** Open a resumable session seeded with an optional prefix. */
  session?(prefix?: string): OracleSession;
}

/** What the implementor injects so the oracle can answer Σ/T. The structural stub needs neither. */
export interface OracleEnv {
  /** Enumerate identifiers bound in the current lexical scope chain (Σ source). */
  boundSymbols(): ReadonlySet<string>;
  /** The signature of a callable: argument TypeTags, variadic flag, and return TypeTag. */
  signatureOf(id: string): { args: TypeTag[]; variadic: boolean; returns: TypeTag } | null;
}
