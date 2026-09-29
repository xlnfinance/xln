/**
 * ANSI truecolor lines → a cell grid. The IR for HTML (1ch×1lh) and SVG (px twin).
 * Understands chalk's SGR: 38;2;r;g;b, 39, 0. Other codes are ignored (the shot
 * path forces truecolor). One code point per cell; no wide-glyph accounting.
 */

export type Rgb = { r: number; g: number; b: number };

export type Cell = {
  readonly ch: string;
  readonly fg?: Rgb;
};

export type Rows = readonly (readonly Cell[])[];

function applySgr(params: string, fg: Rgb | undefined): Rgb | undefined {
  if (params === "" || params === "0" || params === "39") return undefined;
  const parts = params.split(";").map((p) => Number(p));
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 38 && parts[i + 1] === 2) {
      const r = parts[i + 2];
      const g = parts[i + 3];
      const b = parts[i + 4];
      if (r === undefined || g === undefined || b === undefined) return fg;
      return { r, g, b };
    }
    if (parts[i] === 39 || parts[i] === 0) return undefined;
  }
  return fg;
}

/** One line of SGR-colored text → cells. Newlines in `line` are ignored. */
export function ansiToCells(line: string): Cell[] {
  const cells: Cell[] = [];
  let i = 0;
  let fg: Rgb | undefined;
  while (i < line.length) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i + 2);
      if (end === -1) break;
      fg = applySgr(line.slice(i + 2, end), fg);
      i = end + 1;
      continue;
    }
    if (line[i] === "\n" || line[i] === "\r") {
      i += 1;
      continue;
    }
    const cp = String.fromCodePoint(line.codePointAt(i)!);
    i += cp.length;
    cells.push({ ch: cp, fg });
  }
  return cells;
}

export function ansiLinesToRows(lines: readonly string[]): Rows {
  const rows = lines.map(ansiToCells);
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => {
    if (r.length >= width) return r;
    const pad: Cell[] = Array.from({ length: width - r.length }, () => ({ ch: " " }));
    return [...r, ...pad];
  });
}

export function rgbCss(c: Rgb): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export function rgbHex(c: Rgb): string {
  const h = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
