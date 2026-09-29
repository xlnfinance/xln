/**
 * Cursor / region control — the painter's "full-frame diff" primitive and the Ink
 * session's autowrap bracket. Color SGR does not live here: every tint/hex/attribute
 * goes through `tints.ts` (chalk). This file is the one place a cursor-compat fix
 * ever lands.
 */

const ESC = "\u001B[";

// ── Cursor / region control — the painter's "full-frame diff" primitive: move the
// cursor up `n` lines (to the top of the region just painted), then clear from there
// to the end of the screen, then repaint. No partial line-diffing — a small enough
// region (a handful of blocks + a prompt) that redrawing it whole is imperceptible,
// and "no jank" matters more than cleverness here.
export function cursorUp(n: number): string {
  return n <= 0 ? "" : `${ESC}${n}A`;
}
export const CLEAR_TO_END = `${ESC}0J`;
export const HIDE_CURSOR = `${ESC}?25l`;
export const SHOW_CURSOR = `${ESC}?25h`;
// Autowrap (DECAWM). Ink lays out line widths itself (Yoga), so the terminal's own autowrap
// is redundant: a line that fills exactly to the edge (a right-aligned status) leaves the
// terminal in pending-wrap, and its next advance is a PHANTOM newline on top of Ink's break.
// Disable for the Ink session, restore on cleanup.
export const DISABLE_AUTOWRAP = `${ESC}?7l`;
export const ENABLE_AUTOWRAP = `${ESC}?7h`;
export const CARRIAGE_RETURN = "\r";
/** Full clear + cursor-home — `,lens`'s replay uses this (repl.ts): unlike
 *  `paintRegion`'s cursor-up (which only reaches lines still on-screen), a lens flip
 *  re-renders the WHOLE turn history, so it starts from a known blank slate instead of
 *  guessing how many lines have scrolled off. */
export const CLEAR_SCREEN = `${ESC}2J`;
export const CURSOR_HOME = `${ESC}H`;
