/**
 * Primitive markdown → ANSI for the repl's value output: when a value IS a markdown string,
 * render it (headers, lists, blockquotes, fenced code, inline bold/italic/code, links)
 * instead of showing a quoted, escaped string literal. NOT a CommonMark implementation — the
 * block/inline primitives that actually read in a terminal.
 *
 * Detection is deliberately CONSERVATIVE (`looksLikeMarkdown`): a line-leading header / list /
 * quote / fence, else the value is left as a plain string. A string that merely contains a
 * `*` is not markdown. Rendering is gated by the caller to a colored TTY — a piped/`none` run
 * keeps the raw string, never these escapes.
 *
 * Links become OSC 8 hyperlinks — the one OSC family Ink's `@alcalzone/ansi-tokenize` keeps
 * (it drops other OSC), so they survive the render tree; SGR bold/italic and the paint colors
 * survive too.
 */
import { hyperlink } from "./osc.js";
import { DARCULA, paintAttr, paintHex, type ColorMode } from "./tints.js";

/** A serializer string literal `"…"` (the whole trimmed value) → its unescaped content; else
 *  `null` (a list, scalar, or a value that isn't a single top-level string). */
export function topLevelString(serialized: string): string | null {
  const s = serialized.trim();
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return null;
  return unescape(s.slice(1, -1));
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
function unescape(body: string): string {
  return body.replaceAll(/\\(.)/g, (_m, c: string) => ESCAPES[c] ?? c);
}

/** Does the string carry markdown BLOCK structure worth rendering (vs a plain string with a
 *  stray `*`)? Line-leading header / list / ordered / quote, or a fenced code block. */
export function looksLikeMarkdown(text: string): boolean {
  return /^(#{1,6} |[-*+] |\d+\. |> )/m.test(text) || text.includes("```");
}

/** Inline spans: links (→ OSC 8), `code`, **bold**, *italic* / _italic_. Applied left-to-right
 *  so consuming spans (link, code) run before the emphasis spans; the color/SGR escapes
 *  inserted carry no `*`/`` ` ``/`[`, so later regexes don't trip on them. */
function inline(s: string, mode: ColorMode): string {
  let out = s.replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string, u: string) =>
    hyperlink(u, tintish(t, DARCULA.property, mode)),
  );
  out = out.replaceAll(/`([^`]+)`/g, (_m, c: string) => tintish(c, DARCULA.string, mode));
  out = out.replaceAll(/\*\*([^*]+)\*\*/g, (_m, b: string) => paintAttr(b, "bold", mode));
  out = out.replaceAll(
    /(^|[^*])\*([^*\n]+)\*(?!\*)/g,
    (_m, pre: string, i: string) => pre + paintAttr(i, "italic", mode),
  );
  out = out.replaceAll(/_([^_\n]+)_/g, (_m, i: string) => paintAttr(i, "italic", mode));
  return out;
}

function tintish(text: string, hex: string, mode: ColorMode): string {
  return mode === "none" ? text : paintHex(text, hex, mode);
}

/** Render markdown to ANSI lines. Fence markers are dropped and the code body dimmed; headers
 *  bold+accent; bullets get a `•`; blockquotes a dim `│`. */
export function renderMarkdown(md: string, mode: ColorMode): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(tintish(`  ${line}`, DARCULA.string, mode));
      continue;
    }
    const h = /^(#{1,6}) (.*)$/.exec(line);
    if (h) {
      out.push(paintAttr(tintish(inline(h[2]!, mode), DARCULA.heading, mode), "bold", mode));
      continue;
    }
    const li = /^[-*+] (.*)$/.exec(line);
    if (li) {
      out.push(`  ${tintish("•", DARCULA.keyword, mode)} ${inline(li[1]!, mode)}`);
      continue;
    }
    const ol = /^(\d+\.) (.*)$/.exec(line);
    if (ol) {
      out.push(`  ${tintish(ol[1]!, DARCULA.keyword, mode)} ${inline(ol[2]!, mode)}`);
      continue;
    }
    const bq = /^> (.*)$/.exec(line);
    if (bq) {
      out.push(tintish(`│ ${inline(bq[1]!, mode)}`, DARCULA.comment, mode));
      continue;
    }
    out.push(inline(line, mode));
  }
  return out;
}
