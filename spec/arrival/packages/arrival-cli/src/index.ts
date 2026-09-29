/**
 * The public factory surface. arrival-cli IS the terminal repl/run/compile machinery a
 * host CLI composes — NOT a product in itself; the standalone `arrival` bin (cli.ts) is a
 * DX convenience over exactly these pieces. A host (inhuman) assembles its OWN session —
 * its capability vocabulary, its infer / loader armed into the ambient — and hands it to
 * `replFromSession` to get the same bottom-anchored TUI, syntax highlighting, and history.
 *
 * Import boundary: consumers use this barrel, never a deep `@inhuman.tools/arrival-cli/dist/…`
 * path (there is no such export). The `arrival` bin is unaffected — it imports the same
 * modules directly.
 */
export { replFromSession, repl } from "./repl.js";
export { replInk, type ReplAppProps } from "./repl-ink.js";
export { budgets, loaderSession, type LoaderSession } from "./session.js";
export { readOwnVersion } from "./greeting.js";
export { colorMode, streamColorMode, type ColorMode } from "./tints.js";
