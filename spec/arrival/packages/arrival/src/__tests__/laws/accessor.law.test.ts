/**
 * LAW — keyword-as-accessor: `(:key obj)` extracts `obj[key]` (P0/P8).
 *
 * Survivor of `keyword-syntax.test.ts` (retired in the 2026-07-09 suite
 * consolidation):
 * that file's three vacuous exploratory blocks were deleted by the 2026-07-08
 * invariant-verdict sweep (G1); the remaining real cases move here as ONE law with
 * a small table, per docs/test-suite-architecture.md's F1 convention (one invariant × its subjects).
 *
 * THE LAW: a bare `:key` symbol, applied to a single argument, is a getter — it reads
 * `key` off the argument the same way `(dict-ref obj 'key)` or a JS `obj.key` would.
 * This falls out of `:key` being ordinary applicable data (no special evaluation rule),
 * so the SAME accessor composes for free wherever a procedure is expected — `map`,
 * `filter`, anywhere a callable slot exists. A missing key reads as `nil` (the
 * membrane's universal "absent" value), never `undefined`/a thrown error.
 */
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { execOverFrame as exec, execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { jsToScheme, toJS } from "../../membrane/rosetta.js";

async function execOne(expr: string, env = inferenceEnv): Promise<any> {
  const results = await exec(expr, { env });
  return results[0];
}

async function execOneBoxed(expr: string, env = inferenceEnv): Promise<any> {
  const { values } = await execState(expr, { env });
  return values[0];
}

describe("keyword-as-getter: (:key obj) reads obj[key]", () => {
  it("bare :keyword applies as a getter", async () => {
    const result = await execOne(
      "(:pasword obj)",
      inferenceEnv.child("keyword-accessor-getter", {
        obj: jsToScheme(CONSTANT_CTX, { pasword: "swordfish" }),
      }),
    );
    expect(result.toString()).toBe("swordfish");
  });

  it("a missing key reads as nil, not undefined or a thrown error", async () => {
    const obj = { name: "test" };
    const env = inferenceEnv.child("keyword-accessor-missing", {
      obj: jsToScheme(CONSTANT_CTX, obj),
    });
    const result = await execOneBoxed(`(:missing obj)`, env);
    expect(result.constructor.name).toBe("ANil");
  });
});

describe("keyword-as-getter composes: it's ordinary callable data, so HOFs take it for free", () => {
  it("(map :name users) — the getter extracts one field per element", async () => {
    const users = [
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
      { id: "3", name: "Charlie" },
    ];
    const env = inferenceEnv.child("keyword-accessor-map", {
      users: jsToScheme(CONSTANT_CTX, users),
    });
    expect(await execOne(`(map :name users)`, env)).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("(filter :active items) — the getter doubles as a predicate", async () => {
    const items = [
      { active: true, name: "Item 1" },
      { active: false, name: "Item 2" },
      { active: true, name: "Item 3" },
    ];
    const env = inferenceEnv.child("keyword-accessor-filter", {
      items: jsToScheme(CONSTANT_CTX, items),
    });
    const filtered = await execOne(`(filter :active items)`, env);
    expect(filtered).toHaveLength(2);
    expect(filtered[0].name).toBe("Item 1");
    expect(filtered[1].name).toBe("Item 3");
  });
});

// Co-located rather than dropped: this exercises pipe-quoted-symbol-as-VARIABLE
// resolution (`|24|`), a reader/binding case adjacent to keyword syntax (both are
// identifier-namespace edge cases) but NOT itself an accessor law — kept here so the
// coverage isn't lost in the keyword-syntax.test.ts retirement (no closer-fitting home
// exists yet; see the keyword-syntax.test.ts retirement in the 2026-07-09 suite consolidation).
describe("adjacent reader case: a pipe-quoted symbol resolves as an ordinary variable", () => {
  it("(list |24|) — |24| is a bound identifier, not a numeric literal", async () => {
    const result = await execOneBoxed(
      `(list |24|)`,
      inferenceEnv.child("pipe-symbol-variable", {
        "24": jsToScheme(CONSTANT_CTX, "unqouted"),
      }),
    );
    expect(result.car.toString()).toEqual("unqouted");
  });
});
