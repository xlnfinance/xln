// syntax-rules can expand to KERNEL SPECIAL FORMS — the keyword unlock.
//
// A hygienic macro's template references core forms (`if`/`begin`/`let`). The engine
// renames each template identifier to a fresh gensym and binds that gensym to the
// identifier's value in the macro's definition env (syntax-rules.ts rename()). A
// name-dispatched special form has NO env value, so the renamed `#:if` was unbound and
// no derived form could expand to the primitives. With `if`/`begin`/`let` as keyword
// markers (env-bound Keyword values), the gensym resolves to the marker and value-first
// dispatch fires the kernel handler regardless of the renamed spelling.
//
// This is the foundation the §7.3 derived-conditional migration stands on. It also pins
// the gensym-head dispatch fix: the head's lookup key is its raw __name__ (a JS symbol
// for a gensym), NOT symbol_name's string description — the two differ for gensyms, and
// looking up by the description silently fell through to (failed) application.
import { describe, expect, it } from "vitest";
import { execOverFrame as exec } from "../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../env/inference-env.js";

// `exec` already unwraps via `toJS`.
const val = (rs: readonly unknown[]) => rs[rs.length - 1];

describe("syntax-rules → kernel special forms (keyword unlock)", () => {
  it("a macro expanding to `if` + `begin` dispatches the kernel handlers", async () => {
    const src = `
      (define-syntax my-when
        (syntax-rules ()
          ((my-when test body ...) (if test (begin body ...)))))
      (my-when #t 1 2 42)`;
    expect(val(await exec(src, { env: sandboxedEnv.child("sf1") }))).toBe(42);
  });

  it("a macro expanding to `let` introduces a (hygienic) binding", async () => {
    const src = `
      (define-syntax with-ten
        (syntax-rules ()
          ((with-ten name body ...) (let ((name 10)) body ...))))
      (with-ten n (* n n))`;
    expect(val(await exec(src, { env: sandboxedEnv.child("sf2") }))).toBe(100);
  });

  it("HYGIENE: a template-introduced binding does not capture a user identifier", async () => {
    // The macro binds its own `tmp`; the user's `tmp` passed in as `body` must keep
    // referring to the OUTER tmp=7, not the macro's tmp=999.
    const src = `
      (define-syntax shadowing
        (syntax-rules ()
          ((shadowing body) (let ((tmp 999)) body))))
      (define tmp 7)
      (shadowing tmp)`;
    expect(val(await exec(src, { env: sandboxedEnv.child("sf3") }))).toBe(7);
  });

  it("recursive macro expansion through `if` terminates and selects the right branch", async () => {
    const src = `
      (define-syntax pick
        (syntax-rules ()
          ((pick) 0)
          ((pick (t r) clause ...) (if t r (pick clause ...)))))
      (pick (#f 1) (#f 2) (#t 3) (#t 4))`;
    expect(val(await exec(src, { env: sandboxedEnv.child("sf4") }))).toBe(3);
  });
});
