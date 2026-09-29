// Diagnostic paint — formatDiagnostic stays the plain identity; paintDiagnostic
// adds a severity tint only when a color mode is on.
import { describe, expect, it } from "vitest";

import type { Diagnostic } from "@inhuman.tools/arrival/lsp-internals";

import { formatDiagnostic, paintDiagnostic } from "../session.js";
import { stripAnsi } from "./ansi-strip.js";

const errorDiag: Diagnostic = {
  severity: "error",
  code: "unbound-symbol",
  sites: [],
  message: "Unbound symbol `fliter` Referenced at 1:0 — this program would crash there.",
  publicMessage: "Unbound symbol `fliter`",
};

const warnDiag: Diagnostic = {
  ...errorDiag,
  severity: "warning",
  message: "something advisory",
  publicMessage: "something advisory",
};

describe("paintDiagnostic", () => {
  it("mode none is formatDiagnostic (exact identity)", () => {
    expect(paintDiagnostic(errorDiag, "none")).toBe(formatDiagnostic(errorDiag));
    expect(formatDiagnostic(errorDiag)).toBe(
      "error: Unbound symbol `fliter` Referenced at 1:0 — this program would crash there.",
    );
  });

  it("truecolor tints the line and strips back to the same teaching text", () => {
    const painted = paintDiagnostic(errorDiag, "truecolor");
    expect(painted).not.toBe(formatDiagnostic(errorDiag));
    expect(stripAnsi(painted)).toBe(formatDiagnostic(errorDiag));
  });

  it("warning uses a different tint than error", () => {
    expect(paintDiagnostic(errorDiag, "truecolor")).not.toBe(paintDiagnostic(warnDiag, "truecolor"));
  });
});
