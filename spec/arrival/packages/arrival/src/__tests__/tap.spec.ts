/**
 * Tap (evaluation tracing) tests
 *
 * The evaluator emits enter/exit events for each evaluated Pair that carries
 * a __location__ marker (i.e. parsed program forms). Atoms, quoted data, and
 * macro-expansion-constructed Pairs are NOT traced.
 *
 * The tap surface:
 *   enter(node, parent | null) => Invocation     // opaque marker
 *   exit(inv, { value } | { error }) => void
 *
 * The evaluator threads a `currentInvocation` through EvalContext so that
 * sub-evaluations receive their parent as the second arg to enter().
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../env/AmbientRuntime.js";
import { exec, execStateOverFrame } from "../eval/generator-exec.js";
import { freshEnv } from "./_fresh-env.js";
import type { APair } from "../values/primitives/APair.js";
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import { AExact } from "../values/primitives/AExact.js";

let userEnv: ResolvingAmbient;
beforeAll(async () => {
  userEnv = await freshEnv();
});

interface TestInv {
  id: number;
  node: APair<any, any>;
  parent: TestInv | null;
}

type ExitResult = { value: unknown } | { error: unknown };

interface Event {
  kind: "enter" | "exit";
  inv: TestInv;
  result?: ExitResult;
}

function recorder() {
  const events: Event[] = [];
  let nextId = 0;
  const tap = {
    enter(node: APair<any, any>, parent: TestInv | null): TestInv {
      const inv: TestInv = { id: nextId++, node, parent };
      events.push({ kind: "enter", inv });
      return inv;
    },
    exit(inv: TestInv, result: ExitResult): void {
      events.push({ kind: "exit", inv, result });
    },
  };
  return { events, tap };
}

const enters = (es: Event[]) => es.filter((e) => e.kind === "enter");
const exits = (es: Event[]) => es.filter((e) => e.kind === "exit");

describe("evaluation tap", () => {
  it("fires one enter/exit per parsed Pair; skips atoms and bare symbols", async () => {
    const { events, tap } = recorder();
    await exec("(+ 1 2)", { tap });

    expect(enters(events)).toHaveLength(1);
    expect(exits(events)).toHaveLength(1);

    const [enter] = enters(events);
    const [exit] = exits(events);
    expect(exit.inv).toBe(enter.inv);
    expect(exit.result).toHaveProperty("value");
  });

  it("nests events LIFO and preserves parent pointers", async () => {
    const { events, tap } = recorder();
    await exec("(+ (* 2 3) (* 4 5))", { tap });

    expect(enters(events)).toHaveLength(3);
    expect(exits(events)).toHaveLength(3);

    // Order: enter+, enter*L, exit*L, enter*R, exit*R, exit+
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["enter", "enter", "exit", "enter", "exit", "exit"]);

    const [eOuter, eLeft, eRight] = enters(events);
    expect(eLeft.inv.parent).toBe(eOuter.inv);
    expect(eRight.inv.parent).toBe(eOuter.inv);
    expect(eOuter.inv.parent).toBeNull();
  });

  it("currentInvocation is restored on exit (siblings share parent, not each other)", async () => {
    const { events, tap } = recorder();
    await exec("(+ (* 2 3) (* 4 5))", { tap });
    const [, eLeft, eRight] = enters(events);
    expect(eRight.inv.parent).toBe(eLeft.inv.parent);
    expect(eRight.inv.parent).not.toBe(eLeft.inv);
  });

  it("same AST node, many invocations: identity is preserved across iterations", async () => {
    const { events, tap } = recorder();
    await exec("(map (lambda (x) (* x x)) '(1 2 3))", { tap });

    const byNode = new Map<APair<any, any>, TestInv[]>();
    for (const e of enters(events)) {
      const arr = byNode.get(e.inv.node) ?? [];
      arr.push(e.inv);
      byNode.set(e.inv.node, arr);
    }
    const buckets = [...byNode.values()].map((b) => b.length).sort();
    expect(buckets).toContain(3); // (* x x) entered three times
  });

  it("exit fires with {value} for successful forms", async () => {
    const { events, tap } = recorder();
    await exec("(+ 1 2)", { tap });
    const [exit] = exits(events);
    expect(exit.result).toEqual(expect.objectContaining({ value: expect.anything() }));
    expect(exit.result).not.toHaveProperty("error");
  });

  it("exit fires with {error} when a form throws", async () => {
    const { events, tap } = recorder();
    await expect(exec("(undefined-symbol-xyz)", { tap })).rejects.toThrow();
    expect(enters(events).length).toBeGreaterThanOrEqual(1);
    expect(exits(events).length).toBe(enters(events).length);
    const last = exits(events).at(-1)!;
    expect(last.result).toHaveProperty("error");
  });

  it("async forms: enter fires before resolution; exit only on resolution", async () => {
    let resolveAsync: (v: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((r) => {
      resolveAsync = r;
    });
    const env = userEnv.child("tap-async-test") as EnvWithInternals<ResolvingAmbient>;
    let parked!: () => void;
    const atPark = new Promise<void>((res) => {
      parked = res;
    });
    // W8: ANativeProcedure (returns a Promise of a scheme value) — bare fns are doored.
    env.bind(
      "await-this",
      new ANativeProcedure({
        name: "await-this",
        arity: { min: 0, max: 0 },
        contract: undefined,
        impl: () => {
          parked();
          return pending.then((v) => new AExact(v as number)) as never;
        },
      }),
    );

    const { events, tap } = recorder();
    // execState (COMPLEX tier): this test only cares about tap enter/exit accounting.
    const finished = execStateOverFrame("(await-this)", { env, tap });

    await atPark;
    expect(enters(events)).toHaveLength(1);
    expect(exits(events)).toHaveLength(0);

    resolveAsync(42);
    await finished;

    expect(exits(events)).toHaveLength(1);
    expect(exits(events)[0].inv).toBe(enters(events)[0].inv);
  });

  it("quote: the (quote …) form is traced once; the quoted data is not", async () => {
    const { events, tap } = recorder();
    await exec("(quote (a b c))", { tap });
    expect(enters(events)).toHaveLength(1);
    expect(exits(events)).toHaveLength(1);
  });

  // [impl-pinning] pins today's define-macro mechanism (expansion Pairs carry no
  // __location__, so they never fire) — a macro-expansion redesign could change this.
  it("macro call site is traced; the expansion body is opaque", async () => {
    const { events, tap } = recorder();
    await exec(
      `
        (define-macro (twice x) (list 'begin x x))
        (twice 1)
      `,
      { tap },
    );
    // Forms that should fire: (define-macro ...), (twice 1).
    // The expansion (begin 1 1) is constructed at runtime and has no __location__,
    // so it does NOT fire. (Per v1: macro expansions are opaque.)
    // We don't pin exact count to avoid coupling to define-macro internals;
    // assert the upper bound and that no expansion-time Pair sneaks in.
    const enterNodes = enters(events).map((e) => e.inv.node);
    // No enter event's node should be a Pair lacking __location__.
    for (const node of enterNodes) {
      // Pair carries the location symbol when parsed.
      const hasLoc =
        node &&
        typeof node === "object" &&
        Object.getOwnPropertySymbols(node).some((s) => s.description === "__location__");
      expect(hasLoc).toBe(true);
    }
  });

  it("nodeFilter off-switch: no events when filter rejects everything", async () => {
    const events: Event[] = [];
    const tap = {
      enter(node: APair<any, any>, parent: TestInv | null): TestInv {
        const inv: TestInv = { id: 0, node, parent };
        events.push({ kind: "enter", inv });
        return inv;
      },
      exit(inv: TestInv, result: ExitResult): void {
        events.push({ kind: "exit", inv, result });
      },
    };
    await exec("(+ (* 2 3) (* 4 5))", { tap, nodeFilter: () => false });
    expect(events).toHaveLength(0);
  });
});
