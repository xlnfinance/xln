/**
 * JSONC (JSON with Comments) — the tsconfig / VS Code dialect:
 *   - `//` line comments and `/* … *\/` block comments
 *   - trailing commas before `}` / `]`
 *
 * Used by the builtin `.json` require resolver so project data files can carry
 * the same documentation comments TypeScript configs already allow. Strict JSON
 * remains a subset — every valid JSON document still parses unchanged.
 *
 * Dep-free by design (sibling of `JSON.parse` in loader.ts's DATA_PARSERS table):
 * no `jsonc-parser` / `typescript` runtime dep on the loader path.
 */

/** Strip comments, then trailing commas, then `JSON.parse`. Throws SyntaxError
 *  (or whatever `JSON.parse` throws) on a still-malformed document. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}

/** Drop `//` / `/* *\/` outside of string literals. Block comments become a
 *  single space so `a/*x*\/b` cannot glue into `ab`. */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;

    // String literal — copy verbatim, honoring escapes, so `//` / `/*` inside
    // strings never look like comments.
    if (c === '"') {
      out += c;
      i += 1;
      while (i < n) {
        const d = text[i]!;
        out += d;
        i += 1;
        if (d === "\\") {
          if (i < n) {
            out += text[i]!;
            i += 1;
          }
          continue;
        }
        if (d === '"') break;
      }
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i += 1;
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      if (i < n) i += 2;
      out += " ";
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

/** Drop a comma that is followed only by whitespace and then `}` or `]`.
 *  String-aware so a value like `"a,}"` is never rewritten. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;

    if (c === '"') {
      out += c;
      i += 1;
      while (i < n) {
        const d = text[i]!;
        out += d;
        i += 1;
        if (d === "\\") {
          if (i < n) {
            out += text[i]!;
            i += 1;
          }
          continue;
        }
        if (d === '"') break;
      }
      continue;
    }

    if (c === ",") {
      let j = i + 1;
      while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }

    out += c;
    i += 1;
  }
  return out;
}
