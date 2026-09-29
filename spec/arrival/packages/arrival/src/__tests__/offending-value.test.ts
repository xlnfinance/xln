/**
 * OFFENDING_VALUE — symbol-keyed metadata (errors.ts) riding a collection-type-error's
 * thrown object: the value a collection op refused because it wasn't a collection at
 * all (classically: a model-produced STRING that is actually a serialized payload it
 * forgot to parse). Mirrors `arrival-manifold/bind.ts`'s ARGS_REJECTION discipline —
 * metadata on the error OBJECT, `error.message` untouched — so a downstream door can
 * read the offending value's `.provenance` and teach the right parser.
 *
 * `failAndWrap` (eval/evaluator.ts) wraps every propagating native throw in a fresh
 * `ArrivalError` (message copied verbatim, own symbol props empty, original error rides
 * `.cause`), so every real-eval assertion below reads the metadata off the CAUGHT
 * top-level error via `offendingValueOf`'s bounded `.cause` walk — never off a bare
 * `err[OFFENDING_VALUE]` — proving the walk is load-bearing, not incidental.
 */
import { describe, expect, it } from "vitest";

import { execStateOverFrame } from "../eval/generator-exec.js";
import { attachOffendingValue, offendingValueOf } from "../errors.js";
import { AString } from "../values/primitives/AString.js";
import { toJS } from "../membrane/rosetta.js";
import { freshEnv } from "./_fresh-env.js";

/** Run `src`, catch whatever propagates, and return it — the tests below assert on
 *  the caught value directly (not `.rejects.toThrow`) because they need to read
 *  {@link offendingValueOf} off it, not just its message. */
async function catchEval(env: Awaited<ReturnType<typeof freshEnv>>, src: string): Promise<unknown> {
  try {
    await execStateOverFrame(src, { env });
    throw new Error(`expected ${JSON.stringify(src)} to throw, it didn't`);
  } catch (e) {
    return e;
  }
}

describe("OFFENDING_VALUE — collection-type-error metadata", () => {
  it('(take "not-a-list" 2) — offendingValueOf recovers the offending string; message unchanged', async () => {
    const env = await freshEnv();
    const err = await catchEval(env, '(take "not-a-list" 2)');
    expect(err).toBeInstanceOf(Error);
    // Message is BYTE-IDENTICAL to what srfi-1.ts's `take` impl has always thrown —
    // the discipline under test is "attach metadata, never touch the message".
    expect((err as Error).message).toBe(
      "take: the object operand does not support take (no arrival/tagless-final/take).",
    );
    const offending = offendingValueOf(err);
    expect(offending).toBeInstanceOf(AString);
    expect(toJS(offending as AString, {})).toBe("not-a-list");
  });

  it('(vector-ref "hello" 0) — offendingValueOf recovers the offending string; message unchanged', async () => {
    const env = await freshEnv();
    const err = await catchEval(env, '(vector-ref "hello" 0)');
    expect((err as Error).message).toBe(
      "vector-ref: arg 1 is not a vector (declares no arrival/tagless-final/vector-ref)",
    );
    const offending = offendingValueOf(err);
    expect(offending).toBeInstanceOf(AString);
    expect(toJS(offending as AString, {})).toBe("hello");
  });

  it('(car "not-a-pair") — the kernel cxr-unfold throw (Resolver.ts) also carries the offending value', async () => {
    const env = await freshEnv();
    const err = await catchEval(env, '(car "not-a-pair")');
    expect((err as Error).message).toBe(
      "car: the string primitive does not support car (no arrival/tagless-final/car).",
    );
    const offending = offendingValueOf(err);
    expect(offending).toBeInstanceOf(AString);
    expect(toJS(offending as AString, {})).toBe("not-a-pair");
  });

  it('(reduce + 0 "nope") — the symbol.tagless dispatcher door (common/symbols/tagless.ts) also carries it', async () => {
    const env = await freshEnv();
    const err = await catchEval(env, '(reduce + 0 "nope")');
    const offending = offendingValueOf(err);
    expect(offending).toBeInstanceOf(AString);
    expect(toJS(offending as AString, {})).toBe("nope");
  });

  it("a NON-type error (unbound variable) never carries offending-value metadata", async () => {
    const env = await freshEnv();
    const err = await catchEval(env, "(this-name-is-never-bound 1 2)");
    expect(offendingValueOf(err)).toBeUndefined();
  });

  it(
    "SUPERSEDED by benchmark-defect-register.md's B2: (:key obj) on a STRING now throws, naming the\n" +
      "     offending value — a string has no member protocol, so silently answering nil (the old\n" +
      "     behavior this test used to pin) is a type error wearing absence's clothes, not real absence.\n" +
      "     `(:key nil)` is the one receiver shape that still stays silently nil (real, legitimate\n" +
      "     absence — see keyword-accessor-leaf-door.test.ts). This is now a throw-site regression\n" +
      "     guard, mirroring every other collection-type-error door in this file.",
    async () => {
      const env = await freshEnv();
      const err = await catchEval(env, '(:field "a string, not a dict")');
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/string/i);
      expect(offendingValueOf(err)).toBeInstanceOf(AString);
    },
  );

  it("attachOffendingValue is safe on a frozen error — never throws, error still propagates unharmed", () => {
    const err = Object.freeze(new TypeError("frozen"));
    // A plain symbol-keyed assignment on a frozen object throws under ESM's implicit
    // strict mode — attachOffendingValue must swallow that internally, never let the
    // ATTACHER'S OWN throw mask the real error the caller is already raising.
    expect(() => attachOffendingValue(err, "would-be-offender")).not.toThrow();
    // The assignment silently failed (frozen), so there is nothing to read back —
    // this is the honest, safe degradation the try/catch buys, not a lie.
    expect(offendingValueOf(err)).toBeUndefined();
  });

  it("attachOffendingValue returns the SAME error by reference (inline-throw ergonomics) and is idempotent", () => {
    const err = new TypeError("plain");
    const returned = attachOffendingValue(err, "first");
    expect(returned).toBe(err);
    expect(offendingValueOf(err)).toBe("first");
    attachOffendingValue(err, "second");
    expect(offendingValueOf(err)).toBe("second");
  });

  it("offendingValueOf walks a bounded .cause chain (mirrors ARGS_REJECTION's findArgsRejection)", () => {
    const inner = attachOffendingValue(new TypeError("inner"), "the-value");
    const outer = new Error("outer", { cause: inner });
    expect(offendingValueOf(outer)).toBe("the-value");
    expect(offendingValueOf(inner)).toBe("the-value");
    expect(offendingValueOf(new Error("no cause here"))).toBeUndefined();
  });
});
