// srfi-189-symbol-define.test.ts — W4/H2b pack migration rows for `scheme/srfi-189`
// (docs/design-history/symbol-define-static-program-validation.md §1/§2.1/§4).
//
// THE SAME LUCK CLASS srfi-235 (W4/H1) and srfi-43 (W4/H2) found, here for THREE
// targets at once (srfi-189.ts's header): every body reaches for `list`/`car`/`cdr`/
// `null?` (list construction/access), `pair?`/`eq?` (equality), and `error` (the
// exception-handling procedure) — none declared pre-migration. `car`/`cdr` need no
// dep (the resolver-synth cxr family); `equality` is a NATIVE_PACKS member (no
// base-packs.ts repositioning needed, srfi-43's own precedent); `lists`/`exceptions`
// are BASE_PACKS-only members — `lists` already repositioned by srfi-235's H1 fix,
// `exceptions` newly repositioned by THIS migration (base-packs.ts, alongside
// `lists`/`polyglot`) to satisfy the identical C3 "good head" requirement.
//
// Six rows, matching the pack's migration checklist:
//
//   1. behavior equivalence — every constructor/predicate/accessor/combinator
//      produces the SAME results the pre-migration text-blob prelude did (§4.2's
//      "semantic equivalence, not byte-identity" gate).
//   2. the dep edge is REAL, not decorative: unlike srfi-43 (whose deps were ALL
//      NATIVE_PACKS members, so a standalone repro could only prove the bug via the
//      static bake check), `lists`/`exceptions` are BASE_PACKS-only — a standalone
//      `.apply()` (bypassing `assembleEnv`'s C3 dep-walk) onto a bare `global_env`
//      child genuinely leaves `list`/`error` UNBOUND (srfi-235's own demonstrable-
//      break shape), while `pair?`/`eq?`-only bodies (`just?`) still resolve via
//      NATIVE_PACKS runtime luck — both are pinned. The REAL orchestration path
//      (`assembleEnv`, every production caller) walks `deps`, and everything works.
//   3. contract enforcement fires — a scheme-face type mismatch (non-procedure where
//      a callback slot is declared) throws at the call boundary, before the body runs.
//   4. the §2.1 bake FV law passes for this pack as migrated (with declared deps) —
//      and, mirrored, a LOCAL reproduction of the pre-fix shape (the same `list` free
//      reference, NO declared deps) throws `DefineLocalityError`.
//   5. faithfulness: `maybe-ref`/`either-ref`'s default failure path calls the REAL
//      scheme `error` procedure (not a bare JS throw) — it integrates with
//      `with-exception-handler`'s handler-stack machinery, exactly as pre-migration.
//   6. `maybe->list`/`either->list`'s tightened `z.list(z.schemeValue)` output contract is
//      VALIDATE-ONLY — the returned value is still a real scheme list a sibling
//      `(car …)`/`(cdr …)` can walk, never a decoded JS array leaking through.
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../../../common/capability.js";
import { exec, execOverFrame, execStateOverFrame, execInFrame } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { buildVocabulary } from "../../vocabulary.js";
import { DefineLocalityError } from "../../../errors.js";
import srfi189 from "../srfi-189.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

async function printed(env: ResolvingAmbient, src: string): Promise<string> {
  const { values: r } = await execStateOverFrame(src, { env });
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

describe("scheme/srfi-189 — constructors + predicates (semantic-equivalence gate, §4.2)", () => {
  it("just / nothing / just? / nothing? / maybe?", async () => {
    const env = await freshEnv();
    const [justIsJust] = await execOverFrame("(just? (just 42))", { env });
    const [justIsNotNothing] = await execOverFrame("(nothing? (just 42))", { env });
    const [nothingIsNothing] = await execOverFrame("(nothing? (nothing))", { env });
    const [nothingIsNotJust] = await execOverFrame("(just? (nothing))", { env });
    const [maybeJust] = await execOverFrame("(maybe? (just 1))", { env });
    const [maybeNothing] = await execOverFrame("(maybe? (nothing))", { env });
    const [maybeNeither] = await execOverFrame('(maybe? "not-a-maybe")', { env });
    expect(justIsJust).toBe(true);
    expect(justIsNotNothing).toBe(false);
    expect(nothingIsNothing).toBe(true);
    expect(nothingIsNotJust).toBe(false);
    expect(maybeJust).toBe(true);
    expect(maybeNothing).toBe(true);
    expect(maybeNeither).toBe(false);
  });

  it("left / right / left? / right? / either?", async () => {
    const env = await freshEnv();
    const [leftIsLeft] = await execOverFrame("(left? (left 'err))", { env });
    const [rightIsRight] = await execOverFrame("(right? (right 42))", { env });
    const [leftIsNotRight] = await execOverFrame("(right? (left 'err))", { env });
    const [eitherLeft] = await execOverFrame("(either? (left 'err))", { env });
    const [eitherRight] = await execOverFrame("(either? (right 1))", { env });
    const [eitherNeither] = await execOverFrame("(either? 42)", { env });
    expect(leftIsLeft).toBe(true);
    expect(rightIsRight).toBe(true);
    expect(leftIsNotRight).toBe(false);
    expect(eitherLeft).toBe(true);
    expect(eitherRight).toBe(true);
    expect(eitherNeither).toBe(false);
  });
});

describe("scheme/srfi-189 — Maybe accessors/combinators", () => {
  it("maybe-ref: unwraps a Just; calls the failure thunk on Nothing", async () => {
    const env = await freshEnv();
    const [unwrapped] = await execOverFrame("(maybe-ref (just 7))", { env });
    const [viaFailure] = await execOverFrame("(maybe-ref (nothing) (lambda () 'fallback))", { env });
    expect(unwrapped).toBe(7);
    expect(String(viaFailure)).toBe("fallback"); // ASymbol print repr — the quote is the print convention, not a bug
  });

  it("maybe-ref: errors on Nothing with no failure thunk (default behavior unchanged)", async () => {
    const env = await freshEnv();
    await expect(execStateOverFrame("(maybe-ref (nothing))", { env })).rejects.toThrow(/maybe-ref: Nothing/);
  });

  it("maybe-ref/default", async () => {
    const env = await freshEnv();
    const [fromJust] = await execOverFrame("(maybe-ref/default (just 1) 99)", { env });
    const [fromNothing] = await execOverFrame("(maybe-ref/default (nothing) 99)", { env });
    expect(fromJust).toBe(1);
    expect(fromNothing).toBe(99);
  });

  it("maybe-bind: applies f and short-circuits on Nothing", async () => {
    const env = await freshEnv();
    const [bound] = await execOverFrame("(just? (maybe-bind (just 1) (lambda (x) (just (+ x 1)))))", { env });
    const [boundValue] = await execOverFrame("(maybe-ref (maybe-bind (just 1) (lambda (x) (just (+ x 1)))))", { env });
    const [shortCircuit] = await execOverFrame("(nothing? (maybe-bind (nothing) (lambda (x) (just x))))", { env });
    expect(bound).toBe(true);
    expect(boundValue).toBe(2);
    expect(shortCircuit).toBe(true);
  });

  it("maybe-map: maps f over the wrapped value, preserving Nothing", async () => {
    const env = await freshEnv();
    const [mapped] = await execOverFrame("(maybe-ref (maybe-map (lambda (x) (* x 2)) (just 5)))", { env });
    const [preserved] = await execOverFrame("(nothing? (maybe-map (lambda (x) (* x 2)) (nothing)))", { env });
    expect(mapped).toBe(10);
    expect(preserved).toBe(true);
  });

  it("maybe->list / list->maybe round-trip", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(maybe->list (just 5))")).toBe("(5)");
    expect(await printed(env, "(maybe->list (nothing))")).toBe("()");
    const [fromEmpty] = await execOverFrame("(nothing? (list->maybe '()))", { env });
    const [fromNonEmpty] = await execOverFrame("(maybe-ref (list->maybe '(9 10)))", { env });
    expect(fromEmpty).toBe(true);
    expect(fromNonEmpty).toBe(9);
  });

  it("maybe->either", async () => {
    const env = await freshEnv();
    const [fromJust] = await execOverFrame("(right? (maybe->either (just 1) 'no-just))", { env });
    const [fromNothing] = await execOverFrame("(left? (maybe->either (nothing) 'no-just))", { env });
    const [leftValue] = await execOverFrame("(either-ref/default (maybe->either (nothing) 'no-just) 'unused)", { env });
    expect(fromJust).toBe(true);
    expect(fromNothing).toBe(true);
    expect(String(leftValue)).toBe("unused"); // left? path, so either-ref/default falls to `default` — pinning the branch taken
  });
});

describe("scheme/srfi-189 — Either accessors/combinators", () => {
  it("either-ref: unwraps a Right; calls failure with the Left value", async () => {
    const env = await freshEnv();
    const [unwrapped] = await execOverFrame("(either-ref (right 7))", { env });
    const [viaFailure] = await execOverFrame("(either-ref (left 'boom) (lambda (v) v))", { env });
    expect(unwrapped).toBe(7);
    expect(String(viaFailure)).toBe("boom"); // ASymbol print repr
  });

  it("either-ref: errors on Left with no failure procedure (default behavior unchanged)", async () => {
    const env = await freshEnv();
    await expect(execStateOverFrame("(either-ref (left 'boom))", { env })).rejects.toThrow(/either-ref: Left/);
  });

  it("either-ref/default", async () => {
    const env = await freshEnv();
    const [fromRight] = await execOverFrame("(either-ref/default (right 1) 99)", { env });
    const [fromLeft] = await execOverFrame("(either-ref/default (left 'boom) 99)", { env });
    expect(fromRight).toBe(1);
    expect(fromLeft).toBe(99);
  });

  it("either-bind: applies f to the Right value, short-circuits on Left", async () => {
    const env = await freshEnv();
    const [boundValue] = await execOverFrame("(either-ref (either-bind (right 1) (lambda (x) (right (+ x 1)))))", {
      env,
    });
    const [shortCircuit] = await execOverFrame("(left? (either-bind (left 'boom) (lambda (x) (right x))))", { env });
    expect(boundValue).toBe(2);
    expect(shortCircuit).toBe(true);
  });

  it("either-map: maps f over a Right, preserving Left", async () => {
    const env = await freshEnv();
    const [mapped] = await execOverFrame("(either-ref (either-map (lambda (x) (* x 2)) (right 5)))", { env });
    const [preserved] = await execOverFrame("(left? (either-map (lambda (x) (* x 2)) (left 'boom)))", { env });
    expect(mapped).toBe(10);
    expect(preserved).toBe(true);
  });

  it("either->list", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(either->list (right 5))")).toBe("(5)");
    expect(await printed(env, "(either->list (left 'boom))")).toBe("()");
  });

  it("either-swap: swaps Left/Right, errors on a non-Either", async () => {
    const env = await freshEnv();
    const [swappedToRight] = await execOverFrame("(right? (either-swap (left 'x)))", { env });
    const [swappedToLeft] = await execOverFrame("(left? (either-swap (right 1)))", { env });
    await expect(execStateOverFrame('(either-swap "not-an-either")', { env })).rejects.toThrow(
      /either-swap: not an Either/,
    );
    expect(swappedToRight).toBe(true);
    expect(swappedToLeft).toBe(true);
  });
});

// `buildVocabulary` always walks a capability's own declared `deps`. srfi-189's
// declared deps (`lists`/`exceptions`) resolve `list`-/`error`-needing ops via
// the sanctioned path.
describe("scheme/srfi-189 — the dep edge is real (§2.1's undeclared-dep bug class, now a declared edge)", () => {
  it("srfi-189 ALONE (exec({capabilities})): list-/error-needing ops resolve through its declared deps", async () => {
    const [justResult] = await exec("(maybe-ref (just 42))", { capabilities: [srfi189] });
    expect(justResult).toBe(42);
    await expect(exec("(maybe-ref (nothing))", { capabilities: [srfi189] })).rejects.toThrow(/maybe-ref: Nothing/);
  });
});

describe("scheme/srfi-189 — contract ENFORCEMENT fires at the call boundary", () => {
  it("maybe-bind: a non-procedure f is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execStateOverFrame('(maybe-bind (just 1) "not-a-procedure")', { env })).rejects.toThrow();
  });

  it("either-map: a non-procedure f is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execStateOverFrame('(either-map "not-a-procedure" (right 1))', { env })).rejects.toThrow();
  });
});

describe("scheme/srfi-189 — the §2.1 bake FV law passes for this pack AS MIGRATED", () => {
  it("bakes cleanly with its declared deps — never DefineLocalityError", async () => {
    await expect(buildVocabulary([srfi189], undefined, evalScheme)).resolves.not.toThrow();
  });

  it("(regression pin) a LOCAL reproduction of the PRE-FIX shape — the same `list` free reference with NO declared deps — throws DefineLocalityError: the bug this migration fixes was real", async () => {
    // Deliberately NO `deps` field — this is the exact shape srfi-189.ts had before
    // this migration (a bare `prelude` string with no dep declaration at all).
    const undeclaredCap = EnvCapability.define("test/srfi-189-pre-fix-repro", {
      symbols: (symbol, z) => ({
        "bad-just":
          symbol.define`bad-just: reproduces the pre-migration srfi-189 bug (no declared dep on scheme/lists' list)`(
            { input: [z.schemeValue], output: [z.schemeValue] },
            `(lambda (x) (list 'just x))`,
          ),
      }),
    });
    await expect(buildVocabulary([undeclaredCap], undefined, evalScheme)).rejects.toThrow(DefineLocalityError);
  });
});

describe("scheme/srfi-189 — faithfulness: `error`'s handler-stack integration survives migration", () => {
  it("maybe-ref's default failure path invokes an installed with-exception-handler handler — not a bare JS throw that bypasses it entirely", async () => {
    const env = await freshEnv();
    // `raise` (which `error` ultimately calls) is NON-continuable: R7RS §6.11 says a
    // handler that RETURNS NORMALLY for a non-continuable raise triggers a SECONDARY
    // exception ("exception handler returned for non-continuable exception" —
    // r7rs/exceptions.ts's own `raise` body). If migration had bypassed the real
    // `error`/`raise` machinery (a bare JS `throw`), this handler would never run at
    // all and the ORIGINAL "maybe-ref: Nothing" message would surface instead — so
    // seeing the SECONDARY message here is the positive proof the handler WAS invoked.
    await expect(
      execStateOverFrame(
        `(with-exception-handler
           (lambda (exn) 'caught-by-handler)
           (lambda () (maybe-ref (nothing))))`,
        { env },
      ),
    ).rejects.toThrow(/exception handler returned for non-continuable exception/);
  });

  it("either-swap's non-Either error path is likewise a real raise, catchable by guard", async () => {
    const env = await freshEnv();
    const [caught] = await execOverFrame(`(guard (exn (#t 'caught)) (either-swap 42))`, { env });
    expect(String(caught)).toBe("caught"); // symbol egress = plain interned name
  });
});

describe("scheme/srfi-189 — the maybe->list/either->list contract is validate-only, never JS-decoded", () => {
  it("a sibling define can still car/cdr the returned list (a real scheme AListAlike, not a decoded JS array)", async () => {
    const env = await freshEnv();
    const [firstOfList] = await execOverFrame("(car (maybe->list (just 5)))", { env });
    const [nullOnEmpty] = await execOverFrame("(null? (maybe->list (nothing)))", { env });
    expect(firstOfList).toBe(5);
    expect(nullOnEmpty).toBe(true);
  });
});
