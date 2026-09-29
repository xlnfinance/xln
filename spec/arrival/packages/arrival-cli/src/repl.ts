/**
 * `arrival repl` — TWO renderers over ONE persistent session (the loader-armed ambient
 * paired with a single session scope — defines land in the scope and accumulate across
 * turns, unchanged from before):
 *
 *   • TTY (`replInteractive`): the greeting (default: a shibboleth quote, not a
 *     wordmark — greeting.ts), provenance-tinted blocks that cascade
 *     pending→running→done/error/skipped as `ReplEvent`s land (form-emitter.ts →
 *     mcp-substrate's `foldReplEvent` → painter.ts), and the sugarcoat lens (`,lens`
 *     flips scrollback rendering — lens.ts).
 *   • non-TTY (`replPlain`): BYTE-IDENTICAL to the pre-wave-1 REPL — no painter, no
 *     greeting, no ANSI. Piped input (the existing test suite, `arrival watch`-style
 *     non-interactive consumers) must keep working exactly as before; the fancy
 *     experience is strictly additive (design doc §6.2's "falls back to the current
 *     plain readline when !isTTY").
 *
 * Multi-line continuation is the oracle's own structural scanner (`scan(src).closeable`),
 * shared by both renderers — the reader is the one place that lexes `#\(`, strings, and
 * `#|…|#` faithfully, not a hand-rolled paren counter.
 */
import readline from "node:readline";

import { disposeRunContext, execState } from "@inhuman.tools/arrival";
import { scan } from "@inhuman.tools/arrival/lsp-internals";
import { EMPTY_REPL_MODEL, foldReplEvent, type ReplBlock, type ReplFoldModel } from "./repl-model/repl-fold.js";

import { CLEAR_SCREEN, CURSOR_HOME } from "./ansi.js";
import type { ArmedCapabilities } from "./capabilities.js";
import { emitForms } from "./form-emitter.js";
import {
  bannerLines,
  greetingLines,
  identityLine,
  readOwnVersion,
  resolveBanner,
  type BannerKind,
} from "./greeting.js";
import type { Lens } from "./lens.js";
import { paintRegion, renderTurn } from "./painter.js";
import { replInk } from "./repl-ink.js";
import { budgets, loaderSession, printError, printSchemeValue, type LoaderSession } from "./session.js";
import { attuneTerminal } from "./tints.js";

const PROMPT = "arrival> ";
const CONTINUE = "     ... ";

function closeable(src: string): boolean {
  try {
    return scan(src).closeable;
  } catch {
    return true; // outside the scanner's model — let the reader's own error teach
  }
}

/** The pre-painter loop, verbatim in behavior: one value per top-level form on
 *  stdout, errors as teaching-door text on stderr, the session survives every error. */
async function replPlain(session: LoaderSession): Promise<number> {
  const { capabilities, config, runCtx, scope } = session;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let buffer = "";
  rl.on("SIGINT", () => {
    if (buffer === "") {
      rl.close();
      return;
    }
    buffer = "";
  });
  for await (const line of rl) {
    buffer = buffer === "" ? line : `${buffer}\n${line}`;
    if (buffer.trim() === "") {
      buffer = "";
      continue;
    }
    if (!closeable(buffer)) continue;
    const src = buffer;
    buffer = "";
    try {
      const { values } = await execState(src, { capabilities, config, runCtx, scope, ...budgets() });
      for (const v of values) printSchemeValue(v);
    } catch (error) {
      printError(error);
    }
  }
  await disposeRunContext(runCtx);
  return 0;
}

/** The greeting + every settled turn so far, re-rendered through `lens` — `,lens`'s
 *  flip. A full clear+replay (not a cursor-up repaint): the history can be longer than
 *  the visible screen, so "how many lines do I own" isn't knowable; a blank slate is. */
async function replay(history: readonly (readonly ReplBlock[])[], lens: Lens, capabilityCount: number): Promise<void> {
  process.stdout.write(CLEAR_SCREEN + CURSOR_HOME);
  const version = await readOwnVersion();
  process.stdout.write(`${identityLine({ version, capabilityCount, lens })}\n\n`);
  for (const turn of history) {
    if (turn.length === 0) continue;
    process.stdout.write(`${renderTurn(turn, lens).join("\n")}\n\n`);
  }
}

/** The wave-1 TTY experience: greeting, then per-submission provenance-tint cascades,
 *  then a frozen scrollback record — `,lens` replays the whole record in the other lens. */
async function replInteractive(
  session: LoaderSession,
  opts: { capabilityCount: number; banner: BannerKind; version: string },
): Promise<number> {
  const { capabilities, config, runCtx, scope } = session;
  let lens: Lens = "sugarcoat"; // D3: sugarcoat ON by default — it's the marketing surface
  const { capabilityCount, banner, version } = opts;
  const history: ReplBlock[][] = []; // settled turns, oldest → newest

  process.stdout.write(
    `${greetingLines({ version, capabilityCount, lens }, undefined, { kind: banner }).join("\n")}\n\n`,
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let buffer = "";
  const prompt = (): void => {
    process.stdout.write(buffer === "" ? PROMPT : CONTINUE);
  };
  rl.on("SIGINT", () => {
    if (buffer === "") {
      rl.close();
      return;
    }
    buffer = "";
    process.stdout.write(`\n${PROMPT}`);
  });

  prompt();
  for await (const line of rl) {
    buffer = buffer === "" ? line : `${buffer}\n${line}`;
    if (buffer.trim() === "") {
      buffer = "";
      prompt();
      continue;
    }
    if (buffer.trim() === ",lens") {
      buffer = "";
      lens = lens === "sugarcoat" ? "scheme" : "sugarcoat";
      await replay(history, lens, capabilityCount);
      prompt();
      continue;
    }
    if (!closeable(buffer)) {
      prompt();
      continue;
    }
    const src = buffer;
    buffer = "";
    let model: ReplFoldModel = EMPTY_REPL_MODEL;
    let painted = 0;
    // The provenance-tint cascade: every ReplEvent folds into `model`, and every fold
    // step repaints THIS turn's region in place — pending → running → done/error/
    // skipped, settling frame by frame as forms actually execute (§5's clip).
    await emitForms(src, {
      capabilities,
      config,
      runCtx,
      scope,
      ...budgets(),
      onEvent: (event) => {
        model = foldReplEvent(model, event);
        painted = paintRegion(renderTurn(model.blocks, lens), painted);
      },
    });
    process.stdout.write("\n");
    history.push([...model.blocks]);
    prompt();
  }
  process.stdout.write("\n");
  await disposeRunContext(runCtx);
  return 0;
}

/**
 * Render an interactive session a HOST already assembled — the reuse seam (inhuman's
 * `inhuman repl`, and the `arrival` bin below both go through here). The host owns the
 * capability VOCABULARY — its infer / loader / extras armed into `session.runCtx`; this
 * owns only the TERMINAL — budget defaults, the bottom-anchored Ink TUI, syntax
 * highlighting, history recall. Non-TTY falls to the plain reader; `ARRIVAL_REPL=classic`
 * to the painter path. Disposes the session's `runCtx` on exit.
 *
 * `opts.version` labels the vanishing status line (a host passes its OWN version; default
 * = arrival-cli's). `opts.capabilityCount` is the count shown beside it.
 */
export async function replFromSession(
  session: LoaderSession,
  opts: { version?: string; capabilityCount?: number; banner?: string } = {},
): Promise<number> {
  const interactive = process.stdin.isTTY === true;
  if (!interactive) return replPlain(session);
  await attuneTerminal();
  const version = opts.version ?? (await readOwnVersion());
  const capabilityCount = opts.capabilityCount ?? 0;
  const banner = resolveBanner(process.env, opts.banner);
  // `ARRIVAL_REPL=classic` keeps the pre-Ink painter path — the escape hatch if the TUI
  // misbehaves on some terminal.
  if (process.env.ARRIVAL_REPL === "classic") {
    return replInteractive(session, { capabilityCount, banner, version });
  }
  // Default TTY: quote/wordmark above the Ink region (identity rides the prompt).
  const top = bannerLines({ kind: banner });
  if (top.length > 0) process.stdout.write(`${top.join("\n")}\n\n`);
  try {
    await replInk({
      session,
      ...budgets(),
      capabilityCount,
      version,
    });
  } finally {
    await disposeRunContext(session.runCtx);
  }
  return 0;
}

/** `armed` — the host-armed capability set (`--with` / config file), assembled into
 *  the session ambient at start; the whole session sees one vocabulary. The `arrival`
 *  bin's own repl: assemble the loader session here, then render via the host seam. */
export async function repl(armed?: ArmedCapabilities, opts: { banner?: string } = {}): Promise<number> {
  const session = await loaderSession(process.cwd(), "arrival-repl", armed);
  return replFromSession(session, { capabilityCount: armed?.capabilities.length ?? 0, banner: opts.banner });
}
