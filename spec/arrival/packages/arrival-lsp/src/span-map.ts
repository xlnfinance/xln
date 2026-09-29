// span-map — the bidirectional position lens over `emitTypes`'s `Mapping[]`.
//
// `emitTypes` produces a span lens: each `Mapping` says a `[tsStart, tsLength)`
// range of the emitted virtual TS came from a `[schemeStart, schemeLength)` range
// of the source `.scm`. CodeMirror integrations need to walk this lens in BOTH
// directions:
//   • toScheme — lift a tsc DIAGNOSTIC span OUT to Scheme coordinates: errors
//     computed in TS, surfaced on the source.
//   • toTs — map a CURSOR POSITION IN to the emitted TS, the direction hover /
//     completion / go-to-definition need: the user points at a Scheme offset, we
//     query the TS service there.
// Plus line/col ↔ offset helpers for BOTH coordinate systems, since CodeMirror
// works in either and a consumer may need to convert at the boundary.

import type { Mapping } from "@inhuman.tools/arrival-types-bridge";

export type { Mapping } from "@inhuman.tools/arrival-types-bridge";

/** A `[start, start+length)` half-open range, in the LSP/`ts.TextSpan` shape. */
export interface Span {
  start: number;
  length: number;
}

/** A 0-based line / 0-based column position (CodeMirror's `{ line, ch }` shape,
 *  exposed as `{ line, character }` to mirror LSP `Position`). */
export interface LineCol {
  line: number;
  character: number;
}

/**
 * A bidirectional position mapper over one `emitTypes` result. Construct once per
 * (scheme source + emitted TS + mappings) triple; cheap to query repeatedly.
 */
export class Mapper {
  private readonly mappings: readonly Mapping[];
  private readonly schemeLineStarts: number[];
  private readonly tsLineStarts: number[];

  constructor(mappings: readonly Mapping[], schemeSource: string, tsSource: string) {
    this.mappings = mappings;
    this.schemeLineStarts = lineStarts(schemeSource);
    this.tsLineStarts = lineStarts(tsSource);
  }

  /**
   * Lift a TS offset OUT to a Scheme span. Picks the TIGHTEST mapping whose TS
   * range `[tsStart, tsStart+tsLength)` contains `tsOffset` — the innermost
   * emitted construct — so a diagnostic on `5` inside `car(5)` lifts onto
   * the `5` form, not the whole call. Returns `null` when no mapping covers the
   * offset (unmapped prelude/infrastructure span — never surface a wrong position).
   */
  toScheme(tsOffset: number): Span | null {
    let best: Mapping | null = null;
    for (const m of this.mappings) {
      if (tsOffset < m.tsStart || tsOffset >= m.tsStart + m.tsLength) continue;
      // Tightest = smallest TS extent (innermost spanned run).
      if (best === null || m.tsLength < best.tsLength) best = m;
    }
    return best === null ? null : { start: best.schemeStart, length: best.schemeLength };
  }

  /**
   * Map a Scheme offset IN to a TS offset. Picks the TIGHTEST mapping whose Scheme
   * range `[schemeStart, schemeStart+schemeLength)` contains `schemeOffset` (the
   * innermost form under the cursor), then projects the offset to the same
   * relative position inside the TS run — clamped to the TS run so a longer Scheme
   * source span (e.g. `car` → `car`) still lands inside the emitted text.
   * Returns `null` when no mapping covers the offset.
   */
  toTs(schemeOffset: number): number | null {
    let best: Mapping | null = null;
    for (const m of this.mappings) {
      if (schemeOffset < m.schemeStart || schemeOffset >= m.schemeStart + m.schemeLength) continue;
      if (best === null || m.schemeLength < best.schemeLength) best = m;
    }
    if (best === null) return null;
    const rel = schemeOffset - best.schemeStart;
    // Clamp into the TS run: the TS and Scheme extents need not be equal length
    // (e.g. `(car …)` head `car` → `car`), so a relative offset past the TS
    // run's end pins to its last position rather than escaping the mapping.
    const clamped = rel < best.tsLength ? rel : Math.max(0, best.tsLength - 1);
    return best.tsStart + clamped;
  }

  // ── line/col ↔ offset (Scheme source) ──────────────────────────────────────

  schemeOffsetToLineCol(offset: number): LineCol {
    return offsetToLineCol(offset, this.schemeLineStarts);
  }

  schemeLineColToOffset(pos: LineCol): number {
    return lineColToOffset(pos, this.schemeLineStarts);
  }

  // ── line/col ↔ offset (emitted TS) ──────────────────────────────────────────

  tsOffsetToLineCol(offset: number): LineCol {
    return offsetToLineCol(offset, this.tsLineStarts);
  }

  tsLineColToOffset(pos: LineCol): number {
    return lineColToOffset(pos, this.tsLineStarts);
  }
}

/** Byte offsets where each line begins (`lineStarts[0] === 0`). */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.codePointAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** Offset → 0-based line/character via binary search over line starts. */
function offsetToLineCol(offset: number, starts: readonly number[]): LineCol {
  // Largest line start <= offset.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo]! };
}

/** 0-based line/character → offset. */
function lineColToOffset(pos: LineCol, starts: readonly number[]): number {
  const base = starts[pos.line] ?? starts.at(-1) ?? 0;
  return base + pos.character;
}
