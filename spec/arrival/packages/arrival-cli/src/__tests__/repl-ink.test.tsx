// repl-ink — the Ink bottom-anchored TUI. Driven headlessly via ink-testing-library:
// write keystrokes to the mock stdin, assert the rendered frames. `mode="none"` keeps
// frames uncolored so assertions read the plain text. A real loader session backs it, so
// `(+ 1 2)` genuinely evaluates through emitForms/foldReplEvent.
import { disposeRunContext } from "@inhuman.tools/arrival";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReplApp } from "../repl-ink.js";
import { clipboardSet, COMMAND_START, commandDone } from "../osc.js";
import { loaderSession, type LoaderSession } from "../session.js";
import { stripAnsi } from "./ansi-strip.js";

const UP = "[A";
const DOWN = "[B";

/** The live input line (last line carrying the `>` / `.` prompt), stripped of color/cursor
 *  escapes. When at a fresh prompt it also carries the right-aligned `arrival …` status. */
function promptLine(frame: string | undefined): string {
  const lines = stripAnsi(frame ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    // `>`/`.` prompt (a trailing-space-only line is trimmed to just the glyph by Ink).
    if (l.startsWith(">") || l.startsWith(".")) return l;
  }
  return "";
}

let session: LoaderSession;

beforeEach(async () => {
  session = await loaderSession(process.cwd(), "test-repl-ink");
});
afterEach(async () => {
  await disposeRunContext(session.runCtx);
});

function mount(extra: { now?: () => number; notifyAfterMs?: number } = {}) {
  return render(
    <ReplApp session={session} budgetMs={30_000} capabilityCount={0} version="test" mode="none" {...extra} />,
  );
}

async function waitUntil(get: () => string | undefined, pred: (s: string) => boolean, ms = 30_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const frame = get() ?? "";
    if (pred(frame)) return frame;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitUntil timed out after ${ms}ms; last frame:\n${get() ?? ""}`);
}

describe("replInk", () => {
  it("shows a minimal `>` prompt with right-aligned version status on mount", () => {
    const { lastFrame, unmount } = mount();
    const p = promptLine(lastFrame());
    expect(p.startsWith(">")).toBe(true);
    expect(p).toContain("arrival test"); // the far-right status
    unmount();
  });

  it("echoes typed input and HIDES the status once typing starts", async () => {
    const { stdin, lastFrame, unmount } = mount();
    expect(promptLine(lastFrame())).toContain("arrival test"); // shown at a fresh prompt
    stdin.write("(+ 1 2)");
    const frame = await waitUntil(lastFrame, (f) => promptLine(f).includes("(+ 1 2)"));
    expect(promptLine(frame)).toContain("(+ 1 2)");
    expect(promptLine(frame).startsWith(">")).toBe(true); // still at the prompt
    expect(promptLine(frame)).not.toContain("arrival test"); // status vanished on typing
    unmount();
  });

  it("evaluates a submitted form and shows the value in scrollback", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1 2)\r"); // \r = Enter
    const frame = await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    expect(frame).toMatch(/\b3\b/); // the value
    unmount();
  });

  it("holds a multi-line form open until it closes (continuation)", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1\r"); // unbalanced → continuation, NOT submitted
    const cont = await waitUntil(lastFrame, (f) => promptLine(f).startsWith("."));
    expect(promptLine(cont).startsWith(".")).toBe(true); // the `.` continuation prompt
    expect(stripAnsi(cont)).toContain("(+ 1"); // the pending line held above
    stdin.write(" 2)\r"); // now it closes
    const done = await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    expect(done).toMatch(/\b3\b/);
    unmount();
  });

  it("arrow-up recalls previous submissions (newest first)", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1 2)\r");
    await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    stdin.write("(* 6 7)\r");
    await waitUntil(lastFrame, (f) => /\b42\b/.test(f));

    stdin.write(UP); // recall the newest — "(* 6 7)" — onto the prompt line
    const up1 = await waitUntil(lastFrame, (f) => promptLine(f).includes("(* 6 7)"));
    expect(promptLine(up1)).toContain("(* 6 7)");

    stdin.write(UP); // older — "(+ 1 2)"
    const up2 = await waitUntil(lastFrame, (f) => promptLine(f).includes("(+ 1 2)"));
    expect(promptLine(up2)).toContain("(+ 1 2)");
    unmount();
  });

  it("prefix match: typed text filters recall to matching entries", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(define a 1)\r");
    await waitUntil(lastFrame, (f) => f.includes("define"));
    stdin.write("(list 9)\r");
    await waitUntil(lastFrame, (f) => /\b9\b/.test(f));

    // type "(def" then Up → should jump past "(list 9)" straight to "(define a 1)"
    stdin.write("(def");
    await waitUntil(lastFrame, (f) => promptLine(f).includes("(def"));
    stdin.write(UP);
    const recalled = await waitUntil(lastFrame, (f) => promptLine(f).includes("(define a 1)"));
    expect(promptLine(recalled)).toContain("(define a 1)");
    expect(promptLine(recalled)).not.toContain("(list 9)"); // prefix filtered it out
    unmount();
  });
});

const CTRL_A = "";
const CTRL_W = "";
const ALT_F = "f";

describe("replInk block render", () => {
  it("shows execution time on the right", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1 2)\r");
    const frame = await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    expect(stripAnsi(frame)).toMatch(/\dms/);
    unmount();
  });
});

describe("replInk cursor navigation", () => {
  const line = (f: string | undefined): string => promptLine(f).replace(/^>\s?/, "");
  it("Ctrl-A jumps to line start (insert lands at the front)", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("abc");
    await waitUntil(lastFrame, (f) => line(f).includes("abc"));
    stdin.write(CTRL_A);
    stdin.write("X");
    const f = await waitUntil(lastFrame, (ff) => line(ff).includes("Xabc"));
    expect(line(f)).toContain("Xabc");
    unmount();
  });
  it("Ctrl-W deletes the word before the cursor", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("foo bar");
    await waitUntil(lastFrame, (f) => line(f).includes("foo bar"));
    stdin.write(CTRL_W);
    const f = await waitUntil(lastFrame, (ff) => !line(ff).includes("bar"));
    expect(line(f).trimEnd()).toBe("foo");
    unmount();
  });
  it("Alt-f moves forward by word", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("foo bar");
    await waitUntil(lastFrame, (f) => line(f).includes("foo bar"));
    stdin.write(CTRL_A); // → line start
    stdin.write(ALT_F); // → after "foo"
    stdin.write("Z");
    const f = await waitUntil(lastFrame, (ff) => line(ff).includes("fooZ"));
    expect(line(f)).toContain("fooZ bar");
    unmount();
  });
});

describe("replInk multi-line paste", () => {
  it("submits EVERY complete form in one batched chunk, not just the first", async () => {
    const { stdin, lastFrame, unmount } = mount();
    // A single write — the shape Ink's input parser hands a bracketed paste to this
    // handler: one `ch` string with both newlines still embedded.
    stdin.write("(+ 1 2)\n(* 3 4)\n");
    const frame = await waitUntil(lastFrame, (f) => /\b3\b/.test(f) && /\b12\b/.test(f));
    expect(frame).toMatch(/\b3\b/); // first form's value
    expect(frame).toMatch(/\b12\b/); // second form's value — the bug dropped this
    unmount();
  });

  it("leaves an incomplete trailing form (no closing newline) on the input line", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1 2)\n(* 3 4");
    await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    const frame = await waitUntil(lastFrame, (f) => promptLine(f).includes("(* 3 4"));
    expect(promptLine(frame)).toContain("(* 3 4"); // typed, not submitted
    unmount();
  });
});

// OSC 133 marks never ride inside a `<Text>` child (Ink's `@alcalzone/ansi-tokenize` keeps
// SGR colors and OSC-8 hyperlinks but silently drops every other OSC control sequence), so
// they go out via Ink's `useStdout().write` side-channel — the SAME stream `lastFrame`/
// `frames` capture, but not folded into any single rendered frame. Assert against the
// concatenated write history (`frames`), which is what a real terminal's byte stream sees,
// rather than `lastFrame()` (one snapshot, which won't hold an out-of-band write once a
// later write lands).
describe("replInk OSC 133 command blocks", () => {
  it("writes COMMAND_START, then the turn settles, then commandDone(0) — in that order", async () => {
    const { stdin, frames, unmount } = mount();
    stdin.write("(+ 1 2)\r");
    const joined = await waitUntil(
      () => frames.join(""),
      (s) => s.includes(COMMAND_START) && s.includes(commandDone(0)),
    );
    expect(joined).toContain(COMMAND_START);
    expect(joined).toContain(commandDone(0));
    expect(joined.indexOf(COMMAND_START)).toBeLessThan(joined.indexOf(commandDone(0)));
    unmount();
  });

  it("never emits marks while a turn is still being typed (nothing has settled yet)", async () => {
    const { stdin, lastFrame, frames, unmount } = mount();
    stdin.write("(+ 1 2)"); // typed, not submitted
    await waitUntil(lastFrame, (f) => promptLine(f).includes("(+ 1 2)"));
    expect(frames.join("")).not.toContain(COMMAND_START);
    unmount();
  });
});

describe("replInk long-run notify (OSC 9)", () => {
  it("a fast turn does NOT fire a desktop notification", async () => {
    const { stdin, lastFrame, frames, unmount } = mount({ now: () => 0, notifyAfterMs: 4000 });
    stdin.write("(+ 1 2)\r");
    await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    expect(frames.join("")).not.toContain("]9;");
    unmount();
  });

  it("a turn that crosses notifyAfterMs fires OSC 9", async () => {
    let calls = 0;
    const { stdin, lastFrame, frames, unmount } = mount({
      now: () => {
        calls++;
        return calls === 1 ? 0 : 5000;
      },
      notifyAfterMs: 4000,
    });
    stdin.write("(+ 1 2)\r");
    await waitUntil(
      () => frames.join(""),
      (s) => s.includes("]9;"),
    );
    expect(stripAnsi(lastFrame() ?? "")).toMatch(/\b3\b/);
    unmount();
  });
});

describe("replInk ,copy", () => {
  it("writes the last settled turn's value via OSC 52", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1 2)\r");
    await waitUntil(lastFrame, (f) => /\b3\b/.test(f));

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      stdin.write(",copy\r");
      await waitUntil(
        () => (writeSpy.mock.calls.length > 0 ? "done" : ""),
        (s) => s === "done",
      );
      expect(writeSpy.mock.calls.some((call) => String(call[0]).includes(clipboardSet("3")))).toBe(true);
    } finally {
      writeSpy.mockRestore();
      unmount();
    }
  });

  it("is a no-op with no settled turn yet", async () => {
    const { stdin, lastFrame, unmount } = mount();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      stdin.write(",copy\r");
      await waitUntil(lastFrame, (f) => !promptLine(f).includes(",copy") && promptLine(f).startsWith(">"));
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      unmount();
    }
  });
});

describe("replInk markdown value rendering", () => {
  it("a markdown string VALUE renders as a markdown header line (no quotes/hash)", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write('"# Hello"\r');
    const frame = await waitUntil(lastFrame, (f) => stripAnsi(f).includes("Hello"));
    // The block SOURCE line still shows the typed `"# Hello"`; the rendered VALUE is a bare
    // markdown header line "Hello" (no `#`, no quotes) — assert that content line exists.
    const contentLines = stripAnsi(frame)
      .split("\n")
      .map((l) => l.trim());
    expect(contentLines).toContain("Hello");
    expect(contentLines).not.toContain('"# Hello"'); // the value is not shown as a raw literal line
    unmount();
  });
  it("a plain string value stays a quoted literal (not markdown)", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write('"just some text"\r');
    const frame = await waitUntil(lastFrame, (f) => stripAnsi(f).includes("just some text"));
    expect(stripAnsi(frame)).toContain('"just some text"'); // quotes preserved
    unmount();
  });
});
