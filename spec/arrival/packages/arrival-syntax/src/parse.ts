/**
 * Scheme s-expression forest: source text → plain trees with comments and spans.
 *
 * This is not Arrival’s evaluator `Parser`. That reader mints `APair` / `AVector` /
 * interned `ASymbol`, expands `[…]`/`{…}` into values, and drops comments. This
 * parser keeps the written surface: `[]`/`{}` as containers (`open`), lead/trail
 * comments, and a byte span on every node — so an editor or type-lens can map
 * back onto the buffer.
 *
 * A `;`-line-comment on its OWN line(s) before a datum becomes that datum's
 * `lead`; one on the SAME line just after a datum is its `trail`. (A dangling
 * comment before a `)` with no following datum is dropped.)
 */
import invariant from "tiny-invariant";

/** Opener that minted a list node. Stamped by parseSexprs; sugarcoat's
 *  `normalizePolyglot` strips it after recovering free `[]`/`{}` surfaces.
 *  Absent/`"("` means a plain paren list. */
export type ListOpen = "(" | "[" | "{";

export type Node =
  | { atom: string; str?: boolean; lead?: string[]; trail?: string[]; span?: readonly [start: number, end: number] }
  | {
      list: Node[];
      open?: ListOpen;
      lead?: string[];
      trail?: string[];
      span?: readonly [start: number, end: number];
    };

export function parseSexprs(src: string): Node[] {
  let i = 0;
  const n = src.length;
  // `{`/`}` are delimiters so free dict/n-expr surfaces parse as containers (not atom glue).
  const isDelim = (c: string | undefined) =>
    c === undefined ||
    /\s/.test(c) ||
    c === "(" ||
    c === ")" ||
    c === "[" ||
    c === "]" ||
    c === "{" ||
    c === "}" ||
    c === '"' ||
    c === ";";

  let pendingLead: string[] = [];
  let lastNode: Node | null = null;
  let sawNewlineSinceNode = false;

  const skipWs = () => {
    while (i < n) {
      const c = src[i];
      if (c === "\n") {
        sawNewlineSinceNode = true;
        i++;
        continue;
      }
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (c === ";") {
        const start = i;
        while (i < n && src[i] !== "\n") i++;
        const text = src.slice(start, i).replace(/\s+$/, "");
        // same line as the just-read datum → its trailing comment; else leading.
        if (!sawNewlineSinceNode && lastNode) (lastNode.trail ??= []).push(text);
        else pendingLead.push(text);
        continue;
      }
      break;
    }
  };

  const readString = (): Node => {
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        out += src[i] + (src[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return { atom: out, str: true };
      }
      out += c;
      i++;
    }
    invariant(false, "unterminated string");
  };

  const readDatum = (): Node => {
    skipWs();
    const lead = pendingLead;
    pendingLead = [];
    const start = i; // datum's first char (after lead-comment/whitespace skip)
    const c = src[i];
    invariant(c !== undefined, "unexpected EOF");
    let node: Node;
    if (c === "#" && src[i + 1] === "\\") {
      // `#\<char>` character literal (R7RS 7.1.1): self-delimiting — a single
      // non-alphabetic payload (`#\"`, `#\\`, `#\(`, `#\;`, `#\ `, ...) always
      // consumes EXACTLY one more character regardless of what follows; an
      // alphabetic payload can extend into a named literal (`#\space`,
      // `#\newline`, `#\x41`, ...), so consume the whole run. Without this,
      // the payload char falls through to the generic atom scan below, which
      // stops at `"`/`(`/`)`/`[`/`]`/`;` — e.g. `#\"` reads as the 2-char atom
      // `#\` and then hands the bare `"` to `readString`, which then swallows
      // everything up to the NEXT quote in the source (or to EOF, throwing
      // "unterminated string") instead of the one intended character literal.
      const charStart = i;
      i += 2;
      if (i < n && /[a-z]/i.test(src[i])) {
        while (i < n && /[a-z0-9]/i.test(src[i])) i++;
      } else if (i < n) {
        i++;
      }
      node = { atom: src.slice(charStart, i) };
      if (lead.length > 0) node.lead = lead;
      node.span = [start, i];
      lastNode = node;
      sawNewlineSinceNode = false;
      return node;
    }
    switch (c) {
      case "(":
      case "[":
      case "{": {
        node = readList(c);
        break;
      }
      case ")":
      case "]":
      case "}": {
        invariant(false, () => `unexpected ${c} at ${i}`);
        break;
      }
      case '"': {
        node = readString();
        break;
      }
      case "'": {
        i++;
        node = { list: [{ atom: "quote" }, readDatum()] };
        break;
      }
      case "`": {
        i++;
        node = { list: [{ atom: "quasiquote" }, readDatum()] };
        break;
      }
      case ",": {
        i++;
        if (src[i] === "@") {
          i++;
          node = { list: [{ atom: "unquote-splicing" }, readDatum()] };
        } else node = { list: [{ atom: "unquote" }, readDatum()] };

        break;
      }
      default: {
        const start = i;
        while (i < n && !isDelim(src[i])) i++;
        // Racket `#:limit` ≡ arrival `:limit` (same mint as ASymbol keywords).
        let name = src.slice(start, i);
        if (name.length > 2 && name.startsWith("#:")) name = `:${name.slice(2)}`;
        node = { atom: name };
      }
    }
    if (lead.length > 0) node.lead = lead;
    // Source span [start, end) in `src` — inert metadata (like lead/trail), consumed
    // by the editor's parameter-hint placement and the type-layer span map.
    node.span = [start, i];
    lastNode = node;
    sawNewlineSinceNode = false;
    return node;
  };

  function readList(open: ListOpen): Node {
    i++; // open
    const items: Node[] = [];
    for (;;) {
      skipWs();
      const c = src[i];
      invariant(c !== undefined, "unbalanced list");
      if (c === ")" || c === "]" || c === "}") {
        // Mismatched closer still consumes (the reader was permissive on ) vs ]); keep that.
        i++;
        break;
      }
      items.push(readDatum());
    }
    // Only stamp non-paren openers — paren is the default Scheme list.
    return open === "(" ? { list: items } : { list: items, open };
  }

  const forms: Node[] = [];
  for (;;) {
    skipWs();
    if (i >= n) break;
    forms.push(readDatum());
  }
  return forms;
}
