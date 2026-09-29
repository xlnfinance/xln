/**
 * Type-error provenance at the wrapOperator boundary.
 *
 * War story: fuzz audit #42 (`(- (* 0 "") (- (- 0 0) 0))`) used to surface
 * as "Unbound variable `-'" — two layers of masking pointed at a downstream
 * env lookup rather than the actual cause (string passed to `*`). Fix lives
 * in bridge.ts:wrapOperator — coerceNumeric failures now throw a TypeError naming
 * the operator + arg types, with the original membrane invariant attached
 * via `cause`.
 *
 * These guards lock the user-visible error shape so the masking can't
 * silently regress.
 */

import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec.js";

describe("wrapOperator: type-error provenance (audit #42)", () => {
  it('(* 0 "") names the operator + arg types', async () => {
    let caught: Error | undefined;
    try {
      await exec('(* 0 "")');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught!.message).toMatch(/cannot apply \*/i);
    expect(caught!.message).toContain("number");
    expect(caught!.message).toContain("string");
    // Original coerceNumeric invariant remains reachable via cause.
    expect((caught as TypeError).cause).toBeInstanceOf(Error);
    expect(((caught as TypeError).cause as Error).message).toMatch(/scheme.?numeric/i);
  });

  it('(- (* 0 "") (- (- 0 0) 0)) — the original fuzz repro — surfaces a clean type error', async () => {
    let caught: Error | undefined;
    try {
      await exec('(- (* 0 "") (- (- 0 0) 0))');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught!.message).toMatch(/cannot apply \*/i);
    // CRUCIAL: must NOT say "Unbound variable `-`" — that was the masking
    // bug. The error origin is `*`, not `-`.
    expect(caught!.message).not.toMatch(/unbound variable/i);
  });

  it("(+ 1 'foo) catches non-numeric symbol args at the same boundary", async () => {
    let caught: Error | undefined;
    try {
      await exec("(+ 1 'foo)");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught!.message).toMatch(/cannot apply \+/i);
  });

  it("preserves the original throw via cause-chain for sandbox/security debugging", async () => {
    let caught: Error | undefined;
    try {
      await exec('(* "a" "b")');
    } catch (e) {
      caught = e as Error;
    }
    // Cause must be the membrane's original "Cannot convert to SchemeNumeric"
    // invariant — that's the frame sandbox-boundary.ts threw from. Losing it
    // would hide the actual security boundary in audits.
    const cause = (caught as { cause?: unknown })?.cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(/cannot convert to schemenumeric/i);
  });

  it("happy path: numeric ops still return numbers (no regression)", async () => {
    const r = await exec("(* 6 7)");
    expect(Number((r as unknown[])[0]?.valueOf())).toBe(42);
  });
});
