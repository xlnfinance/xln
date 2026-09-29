/**
 * The ONE run posture every CLI verb shares: the entry-point wall-clock budget
 * (300s, env-tunable — the same knob runner-capability's budget.ts reads), the loader-armed
 * (runCtx, scope) WARM PAIR for require-using programs (the CUT, capability-refined:
 * `arrivalLoaderCapability` minted once via {@link execState}, jailed to a root dir, paired
 * with a {@link LexicalScope.fresh} session scope), and the two output surfaces — values
 * through arrival-serializer (budgeted), errors as their teaching-door TEXT (never a stack
 * trace; the doors ARE the UX).
 *
 * TWO PATHS, by the program's own shape: a require-FREE program runs the bare CUT
 * (default base, static validation available); a require-USING program runs the CUT
 * with the loader capability's warm pair + a session scope (the path the loader's
 * production consumers use) — a required module's forms evaluate through the
 * requiring run's COMPOSED resolver (`execExpr({ resolver })` —
 * `@inhuman.tools/arrival-modules`), so `(require …)` sees the stdlib too. The split stays because the
 * static pass cannot see require-spilled bindings (module-graph awareness is an LSP
 * problem, not v1's — see {@link usesRequire}), not because of any seal asymmetry —
 * and because the once-minted runCtx + scope keep defines + the require cache
 * alive for the whole session.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  disposeRunContext,
  execState,
  LexicalScope,
  RunContext,
  type EnvCapability,
  type SessionScope,
  type SchemeValue,
  toJS,
} from "@inhuman.tools/arrival";
import { StaticValidationError, tokenize, type Diagnostic } from "@inhuman.tools/arrival/lsp-internals";
import { arrivalLoaderCapability } from "@inhuman.tools/arrival-modules";
import { toSExprString } from "@inhuman.tools/arrival-serializer";

import type { ArmedCapabilities } from "./capabilities.js";
import type { OutputMode } from "./output-mode.js";
import { colorizeSexpr } from "./sexpr-color.js";
import { paint, streamColorMode, type ColorMode } from "./tints.js";

/** Wall-clock budget — the 5-minute program class, same env var as runner-capability. */
function wallDefault(): number {
  const raw = Number(process.env.ARRIVAL_RUN_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

/** The entry-point wall-clock budget, shared by every verb and both env paths. Always a
 *  concrete number (never `undefined` — unlike `ExecOptions.budgetMs`): callers that need a
 *  guaranteed-present budget (the REPL's per-form emitter, form-emitter.ts) can use this
 *  return type directly instead of re-asserting non-undefined at every call site. */
export function budgets(): { budgetMs: number } {
  return { budgetMs: wallDefault() };
}

/** The session handles a loader-armed run continues on: `capabilities`/`config` (the SAME
 *  objects the warm `runCtx` was minted from — reference identity, the vocabulary memo + the
 *  reused-runCtx tuple check are both identity-keyed on `config`), a caller-owned
 *  {@link RunContext} (dispose it via {@link disposeRunContext} when the session ends), and
 *  the {@link SessionScope} its top-level `define`s land in. */
export interface LoaderSession {
  readonly capabilities: readonly EnvCapability[];
  readonly config: Record<string, unknown>;
  readonly runCtx: RunContext;
  readonly scope: SessionScope;
}

/**
 * The loader-armed session, rooted at `root` (the entry file's dir for `run`,
 * cwd for the repl). The capability derives its own `Loader` from the raw fs
 * slice; `dirname: ""` makes `root` the jail root — the loader's own path
 * normalization refuses `..` escapes, and every resolved path is jail-relative,
 * re-anchored here via `path.resolve(root, p)`. The kernel wires the canonical
 * prelude `evalScheme` internally — no closure to supply here. Minted ONCE
 * per session: `scope` accumulates defines across calls (`execState(src, {
 * capabilities, config, runCtx, scope })`, the REPL continuation idiom) and the
 * require cache lives for the run's lifetime — dispose it (via
 * {@link disposeRunContext}) when the session (run/repl) ends.
 *
 * `armed` — the HOST-armed capability set (`--with` / config file, see
 * capabilities.ts): appended after the loader capability, its shared config bag
 * spread UNDER the loader's own keys (`fs`/`dirname` stay CLI-owned — a config
 * file must not re-root the require jail). Degradation is unconditionally "doors"
 * now (degradation.ts's mode distinction is retired — the auto-door mint is
 * mode-independent): an armed capability missing an OPTIONAL enabling config key
 * binds a cause-carrying door that teaches "provide X" at the reference, instead
 * of silently withholding into a bare unbound throw. The loader itself is
 * unaffected — `fs` is always supplied.
 */
export async function loaderSession(root: string, name: string, armed?: ArmedCapabilities): Promise<LoaderSession> {
  const capabilities: readonly EnvCapability[] = [arrivalLoaderCapability, ...(armed?.capabilities ?? [])];
  const config: Record<string, unknown> = {
    ...armed?.config,
    fs: { readFile: (p: string) => fs.readFile(path.resolve(root, p), "utf8") },
    dirname: "",
  };
  const scope = LexicalScope.fresh(name);
  const state = await execState("(begin)", { capabilities, config, scope });
  return { capabilities, config, runCtx: state.runCtx, scope };
}

/**
 * Does the program reference `require` at all? The static pass cannot see the bindings
 * a `(require "mod.scm")` SPILLS at runtime (module-graph awareness is the LSP problem,
 * not v1's), so a require-using program would false-fail validation on every spilled
 * name. The CLI downgrades: validation runs IFF the program is require-free; otherwise
 * the runtime doors remain the backstop. Detection uses the real FSM lexer (`tokenize`
 * counts `#\(`, strings, and comments faithfully — a symbol token equal to `require`
 * is a genuine reference, a string/comment mention is not).
 */
export function usesRequire(source: string): boolean {
  try {
    return tokenize(source, true).some((t) => t.token === "require");
  } catch {
    return false; // unlexable source — let the reader's own error teach downstream
  }
}

export const REQUIRE_SKIP_NOTE =
  "note: static validation skipped — (require …) bindings are invisible to the pass; runtime doors remain the backstop.";

/** Output budget: enough to see, never a flood (the serializer shrink-to-fit machinery). */
const PRINT_OPTS = { maxItems: 64, maxStringChars: 1024, maxTotalChars: 16_384 };

/**
 * One top-level form's **JS-side** value → stdout (from `exec`, which already
 * membrane-crosses). `undefined` (define / void) prints nothing — REPL norm.
 * `mode` is the display boundary (output-mode.ts): omit it (the REPL's plain path)
 * and the output is plain uncolored s-expr. Pass a mode (the `run` verb) to opt
 * into `--json` machine output or TTY color.
 *
 * Scheme-side values (from `execState`) must cross first — use {@link printSchemeValue}.
 * Never soft-peel here: mixed-world "maybe scheme maybe JS" is a membrane discipline leak.
 */
export function printValue(v: unknown, mode?: OutputMode): void {
  if (v === undefined) return;
  if (mode?.format === "json") {
    // One JSON value per top-level form → NDJSON a `| jq` consumes. A non-serializable
    // value (a procedure → `undefined` under JSON.stringify) prints nothing, same as a
    // void form would; never a bare `undefined` line.
    const json = JSON.stringify(v);
    if (json !== undefined) console.log(json);
    return;
  }
  const text = toSExprString(v, PRINT_OPTS);
  console.log(mode?.color === true ? colorizeSexpr(text) : text);
}

/** `execState` result → stdout: one scheme→JS crossing, then {@link printValue}. */
export function printSchemeValue(v: SchemeValue, mode?: OutputMode): void {
  printValue(toJS(v), mode);
}

export function formatDiagnostic(d: Diagnostic): string {
  const suggestions =
    d.suggestions !== undefined && d.suggestions.length > 0 ? `\n    did you mean: ${d.suggestions.join(", ")}` : "";
  return `${d.severity}: ${d.message}${suggestions}`;
}

/** `formatDiagnostic` plus a severity tint. Identity when `mode` is `"none"` — the
 *  REPL painter tints the whole error block itself, so it keeps the plain form. */
export function paintDiagnostic(d: Diagnostic, mode: ColorMode): string {
  const text = formatDiagnostic(d);
  return mode === "none" ? text : paint(text, d.severity === "warning" ? "warning" : "error", mode);
}

/**
 * Errors as their teaching text. A `StaticValidationError` fans out to its COMPLETE
 * diagnostic list (cause + every site, cascade-fused); everything else prints its
 * message — arrival's runtime doors (unbound-variable with suggestions, budget,
 * purity) already speak in cures, so the message IS the UX. No stack traces.
 *
 * Color follows stderr: a TTY gets the severity tint; a pipe stays byte-identical
 * (`streamColorMode`). Pass `mode` to pin (tests, or check's stdout sink).
 */
export function printError(e: unknown, mode: ColorMode = streamColorMode(process.stderr.isTTY === true)): void {
  if (e instanceof StaticValidationError) {
    for (const d of e.diagnostics) console.error(paintDiagnostic(d, mode));
    return;
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error(mode === "none" ? msg : paint(msg, "error", mode));
}
