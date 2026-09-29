// B2 (the manifold benchmark-defect register, private monorepo docs) — the
// `:key` keyword accessor (`AKeywordSymbol["arrival/tagless-final/apply"]`, ASymbol.ts)
// used to fall through to `nil` whenever its receiver declared no
// `arrival/tagless-final/get` term at all — conflating two different facts:
//   • dict/object MISSING a key            → legitimate absence, nil is correct.
//   • a STRING/NUMBER/BOOLEAN/CHAR receiver → has NO member protocol whatsoever; a
//     type error wearing absence's clothes. met-museum's trajectory called `:title` on
//     an unparsed string 20 times, got `nil` every time, and burned 45 rounds guessing
//     why every field read back empty instead of learning "you handed this a string."
//
// Fix: a leaf/no-`get` receiver throws, naming the receiver's kind and routing to
// `(detect-parse s)` (the manifold's own parser prelude — see unbound-variable.ts's
// existing NEEDS_PARSING_HINT for the same phrasing). `nil → nil` (an ABSENT receiver)
// MUST survive — pinned separately by `projection-nil-tolerance.test.ts` (car/cdr) and
// here for the accessor itself.
//
// PLUS (V's ruling, read-side tolerance only): `arrival/tagless-final/get` on APair now
// answers a key lookup when the receiver's spine is alist-shaped — `(:term (list (cons
// 'term "cancer")))` → `"cancer"`. Nothing is converted or promoted: the pair stays a
// pair, every other pair op is untouched; this is one extra capability the receiver
// offers when explicitly ASKED for it via `:key`, never general shape-sniffing.
import { describe, expect, it } from "vitest";
import { execOverFrame, execStateOverFrame } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import { CONSTANT_CTX } from "../run/RunContext.js";
import { jsToScheme } from "../membrane/rosetta.js";

async function execOneBoxed(expr: string, env = inferenceEnv): Promise<any> {
  const { values } = await execStateOverFrame(expr, { env });
  return values[0];
}

describe("B2 — :key on a leaf receiver (no member protocol) throws, naming the kind", () => {
  it('(:title "some string") throws, names "string", and routes to (detect-parse s)', async () => {
    await expect(
      execOverFrame('(:title "some string")', { env: inferenceEnv.child("kw-leaf-string") }),
    ).rejects.toThrow(/string/i);
    await expect(
      execOverFrame('(:title "some string")', { env: inferenceEnv.child("kw-leaf-string-2") }),
    ).rejects.toThrow(/detect-parse/i);
  });

  it("(:title 5) throws — a number has no members either", async () => {
    await expect(execOverFrame("(:title 5)", { env: inferenceEnv.child("kw-leaf-number") })).rejects.toThrow(/number/i);
  });

  it("(:title #t) throws — a boolean has no members either", async () => {
    await expect(execOverFrame("(:title #t)", { env: inferenceEnv.child("kw-leaf-bool") })).rejects.toThrow(/bool/i);
  });
});

describe("B2 — nil/missing-key tolerance is UNCHANGED (never regress absence)", () => {
  it("(:missing obj) on an object still reads as nil (dict-missing-key stays absence)", async () => {
    const env = inferenceEnv.child("kw-missing-key", {
      obj: jsToScheme(CONSTANT_CTX, { a: 1 }),
    });
    const result = await execOneBoxed("(:missing obj)", env);
    expect(result.constructor.name).toBe("ANil");
  });

  it("(:key nil) still reads as nil — nil is an absent receiver, not a leaf type error", async () => {
    const result = await execOneBoxed("(:key '())", inferenceEnv.child("kw-on-nil"));
    expect(result.constructor.name).toBe("ANil");
  });
});

describe("B2 PLUS — APair answers an alist-shaped key lookup on the read side", () => {
  it('(:term (list (cons \'term "cancer"))) reads the alist entry', async () => {
    const result = await execOneBoxed(`(:term (list (cons 'term "cancer")))`, inferenceEnv.child("kw-alist-get"));
    expect(result.toString()).toBe("cancer");
  });

  it("a non-matching key on an alist still reads as nil (missing key, not a type error)", async () => {
    const result = await execOneBoxed(`(:other (list (cons 'term "cancer")))`, inferenceEnv.child("kw-alist-miss"));
    expect(result.constructor.name).toBe("ANil");
  });

  it("car/cdr on the alist pair are UNCHANGED (the pair stays a pair, nothing promoted)", async () => {
    const result = await execOneBoxed(`(car (car (list (cons 'term "cancer"))))`, inferenceEnv.child("kw-alist-car"));
    expect(result.toString()).toBe("term");
  });
});
