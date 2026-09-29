/**
 * note-sink — per-run model-facing side channels (`notes`/`display` on RunContext), leaf
 * sinks scoped to ONE run, drained once at end of call. Model: docs/execution.md §SINKS
 * (return-channel-never-lies; arrival binds no `(display …)` of its own).
 *
 * FOOTER: NoteSink lines render as `#| ── environment notes ── |#` reader-comment (zero
 * forms) — bookkeeping vs answer at a glance. Not for per-statement teaching or answer content.
 */

/** A per-run collector for model-facing bookkeeping. Push at the point the fact becomes true;
 *  the renderer drains once, at the end of the call. */
export interface NoteSink {
  push(line: string): void;
  /** Take everything pushed so far, leaving the sink empty. Called once per call by the renderer. */
  drain(): readonly string[];
}

export function createNoteSink(): NoteSink {
  const lines: string[] = [];
  return {
    push(line: string): void {
      // Dedup: one tolerance can fire on several calls to the same tool in one program;
      // the model needs the fact once.
      if (!lines.includes(line)) lines.push(line);
    },
    drain(): readonly string[] {
      // eslint-disable-next-line unicorn/prefer-spread -- snapshot-then-clear; slice is the copy, not a rest-spread
      const out = lines.slice();
      lines.length = 0;
      return out;
    },
  };
}

/** One `(display …)` occurrence: the ORIGINAL source of the call, and the value it saw. */
export interface DisplayRecord {
  readonly src: string;
  readonly value: unknown;
}

export interface DisplaySink {
  push(record: DisplayRecord): void;
  drain(): readonly DisplayRecord[];
}

export function createDisplaySink(): DisplaySink {
  const records: DisplayRecord[] = [];
  return {
    push(record: DisplayRecord): void {
      records.push(record);
    },
    drain(): readonly DisplayRecord[] {
      // eslint-disable-next-line unicorn/prefer-spread -- snapshot-then-clear; slice is the copy, not a rest-spread
      const out = records.slice();
      records.length = 0;
      return out;
    },
  };
}
