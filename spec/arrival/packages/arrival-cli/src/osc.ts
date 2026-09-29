/**
 * Terminal-feature emitters — OSC (Operating System Command) + SGR escapes that modern
 * terminals honor and older ones ignore harmlessly. Pure string builders plus one
 * best-effort I/O probe (`probeCanvas`). Kept in one leaf so the terminal-compat
 * details live in one place (sibling to `ansi.ts`, which owns cursor/region; color
 * SGR is `tints.ts`).
 *
 * Graceful degradation is the contract: a terminal without OSC-8 shows the plain link text,
 * without OSC-133 shows the plain output, without OSC-52 simply doesn't copy — never a
 * garbled screen. So these are safe to emit unconditionally. OSC 10/11 are the exception
 * that wait on a reply: timeout / no-TTY → empty canvas, never a hang.
 */
import type { Readable, Writable } from "node:stream";

const ESC = "\u001B";
const BEL = "\u0007";
const OSC = `${ESC}]`;
const ST = `${ESC}\\`; // string terminator (ST) — preferred over BEL for OSC where accepted

/**
 * OSC 8 hyperlink: `text` becomes clickable, pointing at `url` (`file:///abs/path:line`,
 * `https://…`). Supported by iTerm2, WezTerm, kitty, GNOME Terminal, VTE; elsewhere the
 * link markers are ignored and the bare `text` shows. `id` (optional) groups multi-run
 * links as one hover target.
 */
export function hyperlink(url: string, text: string, id?: string): string {
  const params = id === undefined ? "" : `id=${id}`;
  return `${OSC}8;${params};${url}${ST}${text}${OSC}8;;${ST}`;
}

/** A `file://` URL for `absPath`, with an optional `:line` fragment the editor-aware
 *  terminals honor. `absPath` must be absolute. */
export function fileUrl(absPath: string, line?: number): string {
  const base = `file://${absPath}`;
  return line === undefined ? base : `${base}:${line}`;
}

// ── OSC 133 shell-integration marks (FinalTerm / iTerm2) ───────────────────────
// Warp, WezTerm, kitty, and iTerm2 use these to delimit each command's regions, making a
// turn a foldable / navigable / re-runnable BLOCK. A=prompt start, B=prompt end (command
// input start), C=command executed (output start), D[;exit]=command finished.
export const PROMPT_START = `${OSC}133;A${ST}`;
export const PROMPT_END = `${OSC}133;B${ST}`;
export const COMMAND_START = `${OSC}133;C${ST}`;
export function commandDone(exitCode = 0): string {
  return `${OSC}133;D;${exitCode}${ST}`;
}

/** OSC 9 desktop notification (iTerm2, kitty, WezTerm) — a system toast with `message`. */
export function notify(message: string): string {
  return `${OSC}9;${message}${BEL}`;
}

/** OSC 52 clipboard set — copy `text` to the terminal's clipboard (`c` = system, `p` =
 *  primary/X11). base64-encoded per the spec. Lets a remote/SSH session copy without a
 *  local mouse selection. */
export function clipboardSet(text: string, clipboard: "c" | "p" = "c"): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `${OSC}52;${clipboard};${b64}${ST}`;
}

/**
 * SGR 4:3 curly underline, optionally colored (`58:2::r:g:b`) — the "squiggle under the bad
 * token" a diagnostic wants, distinct from a red foreground. Closes with `4:0` (no
 * underline) and, when colored, `59` (default underline color). Terminals without the
 * extended SGR fall back to a plain underline or none.
 */
export function curlyUnderline(text: string, rgb?: readonly [number, number, number]): string {
  const openColor = rgb === undefined ? "" : `${ESC}[58:2::${rgb[0]}:${rgb[1]}:${rgb[2]}m`;
  const closeColor = rgb === undefined ? "" : `${ESC}[59m`;
  return `${ESC}[4:3m${openColor}${text}${ESC}[4:0m${closeColor}`;
}

// ── OSC 10/11 canvas probe ─────────────────────────────────────────────────────
// Native look: OSC 11 is the background *tint* (hue + chroma + L), OSC 10 is the
// default foreground's perceptual brightness. Both replies share one 80ms window.
// Unsupported terminals ignore the queries; a timeout is a no-op, not an error.

/** OSC 10 — foreground color query (BEL-terminated; ST also accepted on the reply). */
export const OSC10_QUERY = `${OSC}10;?${BEL}`;

/** OSC 11 — background color query. */
export const OSC11_QUERY = `${OSC}11;?${BEL}`;

export type OscRgb = { r: number; g: number; b: number };

/**
 * Parse OSC 11 (or OSC 10) color payload.
 * Accepts `rgb:rrrr/gggg/bbbb` (XParseColor) and `#rrggbb` / `rrggbb`.
 */
export function parseOscColorPayload(payload: string): OscRgb | null {
  const s = payload.trim();
  const xparse = /^rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})$/.exec(s);
  if (xparse) {
    const scale = (hex: string): number => {
      const n = Number.parseInt(hex, 16);
      const max = (1 << (hex.length * 4)) - 1;
      return Math.round((n / max) * 255);
    };
    return { r: scale(xparse[1]!), g: scale(xparse[2]!), b: scale(xparse[3]!) };
  }
  const hex = /^#?([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1]!;
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
    };
  }
  return null;
}

/**
 * Extract an OSC 10 or 11 payload from a reply buffer (BEL or ST terminated).
 * Requires a terminator — an unterminated partial chunk must return null so the
 * probe keeps waiting instead of finishing early with a truncated payload.
 */
export function extractOscColorFromBuffer(buf: string, code: 10 | 11): string | null {
  const m = new RegExp(String.raw`\x1b\]${code};([^\x07\x1b]+)(?:\x07|\x1b\\)`).exec(buf);
  return m?.[1] ?? null;
}

export function extractOsc11FromBuffer(buf: string): string | null {
  return extractOscColorFromBuffer(buf, 11);
}

export function extractOsc10FromBuffer(buf: string): string | null {
  return extractOscColorFromBuffer(buf, 10);
}

export type CanvasProbe = {
  readonly bg?: OscRgb;
  readonly fg?: OscRgb;
};

/**
 * Best-effort OSC 11 + OSC 10 probe. Non-TTY or timeout → whatever arrived
 * (possibly empty). Leftover keystrokes typed during the window are discarded
 * (the REPL has not started reading yet; an 80ms boot race is not worth a
 * re-inject path).
 */
export async function probeCanvas(
  opts: {
    stdin?: Readable & { isTTY?: boolean };
    stdout?: Writable & { isTTY?: boolean };
    timeoutMs?: number;
  } = {},
): Promise<CanvasProbe> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const timeoutMs = opts.timeoutMs ?? 80;
  if (stdin.isTTY !== true || stdout.isTTY !== true) return {};

  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      const bgPayload = extractOsc11FromBuffer(buf);
      const fgPayload = extractOsc10FromBuffer(buf);
      resolve({
        bg: bgPayload === null ? undefined : (parseOscColorPayload(bgPayload) ?? undefined),
        fg: fgPayload === null ? undefined : (parseOscColorPayload(fgPayload) ?? undefined),
      });
    };
    const onData = (chunk: string | Buffer): void => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (extractOsc11FromBuffer(buf) !== null && extractOsc10FromBuffer(buf) !== null) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on("data", onData);
    try {
      stdout.write(OSC11_QUERY + OSC10_QUERY);
    } catch {
      finish();
    }
  });
}
