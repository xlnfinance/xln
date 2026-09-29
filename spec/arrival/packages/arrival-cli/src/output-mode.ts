/**
 * The display boundary (clig.dev discipline): one PURE function deciding how a run's
 * values reach the sink, from the sink's own shape — not scattered `isTTY` checks. Every
 * `arrival run` value passes through the mode this resolves; the decision is a pure
 * function of (stdout-is-a-TTY, env, --json) so it is testable with zero real terminal.
 *
 * Two axes, deliberately orthogonal:
 *   • FORMAT — `sexpr` (the human/default, the runtime's own stdout contract) vs `json`
 *     (machine, opt-in via `--json`, one JSON value per top-level form → NDJSON a `| jq`
 *     consumes). We do NOT auto-switch to JSON when stdout is piped: arrival's stdout has
 *     always been s-expr, so a pipe-triggered flip would silently break every existing
 *     consumer. Machine output is a thing you ASK for, not a thing that happens to you.
 *   • COLOR — subtle ANSI on the s-expr, gated purely on "is a human looking?": on when
 *     stdout is a TTY, off when piped (so `| jq`, `> file`, tests stay byte-identical to
 *     the pre-color output). `NO_COLOR` disables unconditionally (no-color.org); a
 *     `CLICOLOR_FORCE` forces it back through a pipe; `TERM=dumb` disables. JSON is never
 *     colored — it's a payload, not a view.
 *
 * The depth ladder (truecolor / 256 / 16) is NOT decided here — that is a
 * terminal-CAPABILITY question `tints.ts`'s `colorMode` owns. This resolves POLICY
 * (format + whether to color at all) by delegating the color boolean to
 * `streamColorMode`; the painter resolves capability. Composed, never duplicated.
 */
import { streamColorMode } from "./tints.js";

export type OutputFormat = "sexpr" | "json";

export interface OutputMode {
  readonly format: OutputFormat;
  /** Whether to ANSI-color the s-expr. Always false for `json`. */
  readonly color: boolean;
}

export interface OutputContext {
  /** `process.stdout.isTTY === true` — passed in, never read from a global, so tests pin it. */
  readonly stdoutIsTTY: boolean;
  readonly env: NodeJS.ProcessEnv;
  /** The `--json` flag. */
  readonly json: boolean;
}

/**
 * Should the s-expr be colored? Delegates to `streamColorMode` so run's value
 * coloring and check/repl/stderr diagnostics share one policy.
 */
function wantsColor(ctx: OutputContext): boolean {
  return streamColorMode(ctx.stdoutIsTTY, ctx.env) !== "none";
}

/** Resolve the display mode for a run. Pure — no globals, no side effects. */
export function resolveOutputMode(ctx: OutputContext): OutputMode {
  if (ctx.json) return { format: "json", color: false };
  return { format: "sexpr", color: wantsColor(ctx) };
}
