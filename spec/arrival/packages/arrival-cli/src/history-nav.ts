/**
 * Prefix-match history navigation (zsh `history-search-backward`, Chrome DevTools console):
 * arrow-up cycles only the history entries that START WITH what you've typed, so `(map ` +
 * Up walks past `(define …)` straight to your last `(map …)`. Empty prefix ⇒ every entry
 * (plain history). Arrow-down walks forward through the same matches; past the newest match
 * it restores the draft you'd typed before navigating.
 *
 * Pure and self-contained (no Ink, no refs) so the cycling logic is unit-tested directly;
 * `repl-ink.tsx` owns only the "apply this entry to the input buffer" side effect.
 *
 * The prefix is LOCKED at the moment navigation starts (the line as it then was) — editing
 * the recalled text resets nav to null (the caller's job), so the next Up re-derives a fresh
 * prefix. The `index` is an absolute position into `history` (oldest→newest).
 */

export interface NavState {
  /** The typed text nav is matching against — locked when nav began. */
  readonly prefix: string;
  /** Absolute index into history of the currently-shown entry. */
  readonly index: number;
}

export interface Recall {
  /** The entry (or restored draft) to place in the input. */
  readonly entry: string;
  /** The nav state after this step; `null` means "back at the live draft, not navigating". */
  readonly nav: NavState | null;
}

/**
 * Arrow-up. From just older than the current position (or the newest entry, when starting),
 * the nearest entry that `startsWith(prefix)`. Starting prefix is the current `line`.
 * `null` ⇒ no older match; the caller leaves the input untouched.
 */
export function recallPrev(history: readonly string[], nav: NavState | null, line: string): Recall | null {
  const prefix = nav === null ? line : nav.prefix;
  const from = nav === null ? history.length - 1 : nav.index - 1;
  for (let i = from; i >= 0; i--) {
    if (history[i]!.startsWith(prefix)) return { entry: history[i]!, nav: { prefix, index: i } };
  }
  return null;
}

/**
 * Arrow-down. The nearest entry NEWER than the current position that `startsWith(prefix)`;
 * past the newest match, restore the typed draft (the prefix) and exit nav. `null` ⇒ not
 * navigating, nothing to do.
 */
export function recallNext(history: readonly string[], nav: NavState | null): Recall | null {
  if (nav === null) return null;
  for (let i = nav.index + 1; i < history.length; i++) {
    if (history[i]!.startsWith(nav.prefix)) return { entry: history[i]!, nav: { prefix: nav.prefix, index: i } };
  }
  return { entry: nav.prefix, nav: null };
}

/** Append a submission to history, skipping a consecutive duplicate (zsh `hist_ignore_dups`).
 *  Returns a new array — callers holding a ref reassign `.current`. */
export function pushHistory(history: readonly string[], entry: string): string[] {
  if (entry === "" || history.at(-1) === entry) return [...history];
  return [...history, entry];
}
