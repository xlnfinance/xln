import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { evaluate, layerCounts } from "./evaluate.ts";
import { LAYERS, describeProblem, type Name, type Register, type Row } from "./model.ts";
import { carries, arrivalNames, quintNames, testFileNames } from "./names.ts";
import { parseCell, parseRegister } from "./register.ts";
import { scanNames } from "./scan.ts";

const name = (kind: Name["kind"], text: string, layer: Name["layer"] = "contract"): Name => ({ layer, kind, text, file: "f" });

const row = (id: string, overrides: Partial<Row> = {}): Row => ({
  id,
  statement: "s",
  source: "src",
  cells: { arrival: { _tag: "absent" }, quint: { _tag: "absent" }, contract: { _tag: "hold" }, rig: { _tag: "absent" }, ts: { _tag: "absent" } },
  killers: [{ kind: "test", layer: "contract", name: "killer test" }],
  ...overrides,
});

const killerName = name("title", "J5 killer test");

describe("an id is carried by a check's name, not by prose around it", () => {
  test("a title carries the id as a token", () => expect(carries("J5", name("title", "J5 a failing batch consumes its nonce"))).toBe(true));
  test("J5 is not in J50 or in a lowercase title", () => {
    expect(carries("J5", name("title", "J50 something"))).toBe(false);
    expect(carries("J5", name("title", "j5 something"))).toBe(false);
  });
  test("a file or function name matches in any case, across - and _", () => {
    expect(carries("J5", name("file", "j5-gas-exact"))).toBe(true);
    expect(carries("R-OOG", name("function", "test_R_OOG_guardAtSixGas"))).toBe(true);
  });
  test("R-CLOCK is not carried by R-HTLC-CLOCK", () => expect(carries("R-CLOCK", name("title", "R-HTLC-CLOCK a lock is live"))).toBe(false));
});

describe("names come from titles, functions, properties and mutants, never comments", () => {
  test("mocha titles, including .skip and template literals", () => {
    const text = "// describe('J9 in a comment')\ndescribe('C1 epoch', () => { it.skip(\"H1 waits\", () => {}); test(`J2 skip`, () => {}); });";
    const texts = testFileNames("contract", "x/c1.test.ts", text).map((n) => n.text);
    expect(texts).toContain("C1 epoch");
    expect(texts).toContain("H1 waits");
    expect(texts).toContain("J2 skip");
    expect(texts).toContain("c1");
    expect(texts).not.toContain("J9 in a comment");
  });
  test("a property mentioned only in a comment is not a name", () => {
    const text = ';; (property "J6 in a comment" (w) ok)\n(property "J2 real" (w) ok) ;; (property "J5 trailing" (w) ok)';
    expect(arrivalNames("x/j/batch.scm", text).filter((n) => n.kind === "property").map((n) => n.text)).toEqual(["J2 real"]);
  });
  test("Foundry contract and test function names", () => {
    const text = "contract J5Starve is Test {\n  function test_R_OOG_x() public {}\n  function helper() internal {}\n}";
    const texts = testFileNames("contract", "x/J5Starve.t.sol", text).map((n) => n.text);
    expect(texts).toContain("J5Starve");
    expect(texts).toContain("test_R_OOG_x");
    expect(texts).not.toContain("helper");
  });
  test("an Arrival property string and a planted-bug file name", () => {
    expect(arrivalNames("x/j/batch.scm", '(property "a deposit leg travels alone (J6)" (w) ok)').map((n) => n.text)).toContain("a deposit leg travels alone (J6)");
    expect(arrivalNames("x/dispute/bugs/no-h1.scm", "").map((n) => [n.kind, n.text])).toEqual([["bug", "no-h1"]]);
  });
  test("a Quint mutant is named by its id and by the rule its why opens with", () => {
    const json = JSON.stringify({ mutants: [{ id: "h1-wait-removed", why: "H1: the finalize no longer waits" }] });
    expect(quintNames("x/mutants/chain.json", json).map((n) => n.text)).toEqual(["h1-wait-removed", "H1"]);
  });
});

describe("the gate is red when an id is missing from a layer that must hold it", () => {
  const register: Register = [row("J5")];

  test("green when a contract name carries the id", () => {
    expect(evaluate(register, [killerName]).problems).toEqual([]);
  });

  test("red: no contract name carries the id", () => {
    const { problems } = evaluate(register, [name("title", "killer test")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["MissingInLayer"]);
    expect(describeProblem(problems[0]!)).toContain("J5");
  });

  test("a name in another layer does not satisfy the layer", () => {
    const { problems } = evaluate(register, [name("title", "J5 killer test", "ts"), name("title", "killer test")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["MissingInLayer"]);
  });

  test("red: a row with no killer", () => {
    const { problems } = evaluate([row("J5", { killers: [] })], [killerName]);
    expect(problems.map((problem) => problem._tag)).toEqual(["NoKiller"]);
  });

  test("red: a named killer that no name matches", () => {
    const { problems } = evaluate(register, [name("title", "J5 something else")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["KillerNotFound"]);
  });

  test("a killer is matched by the kind it claims: a test title is not a planted bug", () => {
    const asBug = row("J5", { killers: [{ kind: "bug", layer: "contract", name: "killer test" }] });
    expect(evaluate([asBug], [killerName]).problems.map((problem) => problem._tag)).toEqual(["KillerNotFound"]);
  });

  test("red: the same id listed twice", () => {
    expect(evaluate([row("J5"), row("J5")], [killerName]).problems.map((problem) => problem._tag)).toContain("DuplicateId");
  });
});

describe("owed cells and killers are open work, and go red once they are already satisfied", () => {
  const owedCell = { ...row("J5").cells, arrival: { _tag: "owed", by: "#41" } } as const;
  const owedKiller = { kind: "bug", layer: "arrival", name: "no-h1", owed: "#41" } as const;
  const owing = row("J5", { cells: owedCell, killers: [{ kind: "test", layer: "contract", name: "killer test" }, owedKiller] });

  test("owed and absent: no problem, counted as owed", () => {
    const evaluation = evaluate([owing], [killerName]);
    expect(evaluation.problems).toEqual([]);
    expect(layerCounts(evaluation.reports).find((count) => count.layer === "arrival")).toEqual({ layer: "arrival", held: 0, owed: 1, required: 1 });
  });

  test("red: the owed cell is already carried, so it must be promoted to hold", () => {
    const { problems } = evaluate([owing], [killerName, name("property", "J5 holds", "arrival")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["OwedButPresent"]);
  });

  test("red: the owed killer exists, so its owed mark must go", () => {
    const { problems } = evaluate([owing], [killerName, name("bug", "no-h1", "arrival")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["KillerOwedButPresent"]);
  });

  test("an absent cell never fails, even when a name in that layer carries the id", () => {
    const { problems } = evaluate([row("J5")], [killerName, name("property", "J5 holds", "ts")]);
    expect(problems).toEqual([]);
  });
});

describe("register.json", () => {
  const text = readFileSync(`${import.meta.dir}/register.json`, "utf8");
  const parsed = parseRegister(text);

  test("parses", () => expect(parsed.ok).toBe(true));

  test("cells are -, hold or owed: <by>", () => {
    expect(parseCell("x", "-").ok).toBe(true);
    expect(parseCell("x", "owed: #41").ok).toBe(true);
    expect(parseCell("x", "owed:").ok).toBe(false);
    expect(parseCell("x", "yes").ok).toBe(false);
  });

  test("a row with an unknown layer is refused", () => {
    const bad = JSON.stringify({ rows: [{ id: "X", statement: "s", source: "s", layers: { moon: "hold" }, killers: [] }] });
    expect(parseRegister(bad).ok).toBe(false);
  });

  test("seeds the ids the brief names", () => {
    const ids = parsed.ok ? parsed.value.map((each) => each.id) : [];
    const seeded = ["C1", "C2", "H1", "H2", "H3", "H4", "J2", "J5", "J6", "F1", "A12", "N3", "R-SIMULATE", "R-SPLIT", "R-COSIGN", "R-NONCE", "R-DURABLE", "R-CLOCK", "R-FUNDED", "R2C-DEBT-FIRST"];
    expect(seeded.filter((id) => !ids.includes(id))).toEqual([]);
    expect(ids.filter((id) => /^R-[EXAJRP]\d$/.test(id)).length).toBe(23);
  });

  test("every row names a layer cell for every layer", () => {
    const cells = parsed.ok ? parsed.value.flatMap((each) => LAYERS.map((layer) => each.cells[layer])) : [];
    expect(cells.length).toBe(LAYERS.length * (parsed.ok ? parsed.value.length : 0));
  });
});

describe("the real tree", () => {
  const parsed = parseRegister(readFileSync(`${import.meta.dir}/register.json`, "utf8"));
  const register = parsed.ok ? parsed.value : [];
  const names = scanNames(`${import.meta.dir}/../..`);

  test("the gate is green on this checkout", () => {
    expect(evaluate(register, names).problems.map(describeProblem)).toEqual([]);
  });

  test("the gate turns red when the names carrying C1 disappear from the contract tests", () => {
    const without = names.filter((each) => !(each.layer === "contract" && carries("C1", each)));
    const { problems } = evaluate(register, without);
    expect(problems.some((problem) => problem._tag === "MissingInLayer" && problem.id === "C1" && problem.layer === "contract")).toBe(true);
  });

  test("the gate turns red when a killer test is renamed", () => {
    const renamed = names.map((each) => (each.text.startsWith("C1 ondelta epoch") ? { ...each, text: "ondelta epoch" } : each));
    const { problems } = evaluate(register, renamed);
    expect(problems.some((problem) => problem._tag === "KillerNotFound" && problem.id === "C1")).toBe(true);
  });
});
