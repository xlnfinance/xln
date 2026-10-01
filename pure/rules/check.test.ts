import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { evaluate, layerCounts } from "./evaluate.ts";
import { LAYERS, describeProblem, type Cell, type Name, type Register, type Row } from "./model.ts";
import { carries, arrivalNames, quintNames, testFileNames } from "./names/names.ts";
import { parseCell, parseRegister } from "./register.ts";
import { readBase } from "./base.ts";
import { readRegisterFolder } from "./layout/store.ts";
import { renderMarkdown, renderText } from "./render.ts";
import { ratchet } from "./ratchet.ts";
import { scanNames } from "./scan.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const notApplicable: Cell = { _tag: "na", reason: "this layer has no part in the rule" };
const unstated: Cell = { _tag: "unstated" };

const name = (kind: Name["kind"], text: string, layer: Name["layer"] = "contract"): Name => ({ layer, kind, text, file: "f" });

const row = (id: string, overrides: Partial<Row> = {}): Row => ({
  id,
  statement: "s",
  source: "src",
  cells: { arrival: notApplicable, quint: notApplicable, contract: { _tag: "hold" }, rig: notApplicable, ts: notApplicable },
  killers: [{ kind: "test", layer: "contract", name: "the killer test" }],
  ...overrides,
});

// The row carries J5 in its contract layer through `carrier`, and its killer is the whole name `the killer test`.
const carrier = name("title", "J5 holds");
const killerName = name("title", "the killer test");

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
  test("mocha titles, including template literals", () => {
    const text = "// describe('J9 in a comment')\ndescribe('C1 epoch', () => { it(\"H1 waits\", () => {}); test(`J2 skip`, () => {}); });";
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
    expect(evaluate(register, [carrier, killerName]).problems).toEqual([]);
  });

  test("red: no contract name carries the id", () => {
    const { problems } = evaluate(register, [killerName]);
    expect(problems.map((problem) => problem._tag)).toEqual(["MissingInLayer"]);
    expect(describeProblem(problems[0]!)).toContain("J5");
  });

  test("a name in another layer does not satisfy the layer", () => {
    const { problems } = evaluate(register, [name("title", "J5 holds", "ts"), killerName]);
    expect(problems.map((problem) => problem._tag)).toEqual(["MissingInLayer", "NotApplicableButPresent"]);
  });

  test("red: a row with no killer", () => {
    const { problems } = evaluate([row("J5", { killers: [] })], [carrier]);
    expect(problems.map((problem) => problem._tag)).toEqual(["NoKiller"]);
  });

  test("red: a named killer that no name matches", () => {
    const { problems } = evaluate(register, [carrier]);
    expect(problems.map((problem) => problem._tag)).toEqual(["KillerNotFound"]);
  });

  test("a killer is matched by the kind it claims: a test title is not a planted bug", () => {
    const asBug = row("J5", { killers: [{ kind: "bug", layer: "contract", name: "the killer test" }] });
    expect(evaluate([asBug], [carrier, killerName]).problems.map((problem) => problem._tag)).toEqual(["KillerNotFound"]);
  });

  test("red: a killer is the whole name, not a fragment of one", () => {
    const fragment = row("J5", { killers: [{ kind: "test", layer: "contract", name: "J5" }] });
    expect(evaluate([fragment], [carrier]).problems.map((problem) => problem._tag)).toEqual(["KillerNotFound"]);
  });

  test("red: the same id listed twice", () => {
    expect(evaluate([row("J5"), row("J5")], [carrier, killerName]).problems.map((problem) => problem._tag)).toContain("DuplicateId");
  });
});

describe("owed cells and killers are open work, and go red once they are already satisfied", () => {
  const owedCell = { ...row("J5").cells, arrival: { _tag: "owed", by: "#41" } } as const;
  const owedKiller = { kind: "bug", layer: "arrival", name: "no-h1", owed: "#41" } as const;
  const owing = row("J5", { cells: owedCell, killers: [{ kind: "test", layer: "contract", name: "the killer test" }, owedKiller] });

  test("owed: no problem, counted as owed", () => {
    const evaluation = evaluate([owing], [carrier, killerName]);
    expect(evaluation.problems).toEqual([]);
    expect(layerCounts(evaluation.reports).find((count) => count.layer === "arrival")).toEqual({ layer: "arrival", held: 0, owed: 1, required: 1, na: 0, unstated: 0 });
  });

  test("red: the owed cell is already carried, so it must be promoted to hold", () => {
    const { problems } = evaluate([owing], [carrier, killerName, name("property", "J5 holds", "arrival")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["OwedButPresent"]);
  });

  test("red: the owed killer exists, so its owed mark must go", () => {
    const { problems } = evaluate([owing], [carrier, killerName, name("bug", "no-h1", "arrival")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["KillerOwedButPresent"]);
  });

  test("stale: a name carries the id but the layer models an earlier rule; no problem, counted as owed and never as held", () => {
    const staleCell = { ...row("J5").cells, arrival: { _tag: "stale", why: "models the rule before the revision; the spec thread brings the new page" } } as const;
    const evaluation = evaluate([row("J5", { cells: staleCell })], [carrier, killerName, name("property", "J5 holds", "arrival")]);
    expect(evaluation.problems).toEqual([]);
    expect(evaluation.reports[0]?.cells.arrival.verdict).toBe("stale");
    expect(layerCounts(evaluation.reports).find((count) => count.layer === "arrival")).toEqual({ layer: "arrival", held: 0, owed: 1, required: 1, na: 0, unstated: 0 });
  });

  test("stale is printed with its hits, its reason is trimmed, its problem names the layer, and a killer may sit in a stale layer", () => {
    const staleCell = { ...row("J5").cells, arrival: { _tag: "stale", why: "old version" } } as const;
    const carried = evaluate([row("J5", { cells: staleCell })], [carrier, killerName, name("property", "J5 holds", "arrival")]);
    expect(renderText(carried)).toContain("stale 1");
    expect(renderMarkdown(carried)).toContain("| stale 1 |");
    expect(parseCell("x", "stale:  old version  ")).toEqual({ ok: true, value: { _tag: "stale", why: "old version" } });
    const arrivalKiller = row("J5", { cells: staleCell, killers: [{ kind: "test", layer: "contract", name: "the killer test" }, { kind: "bug", layer: "arrival", name: "no-h1" }] });
    expect(evaluate([arrivalKiller], [carrier, killerName, name("property", "J5 holds", "arrival"), name("bug", "no-h1", "arrival")]).problems).toEqual([]);
    const absent = evaluate([row("J5", { cells: staleCell })], [carrier, killerName]).problems;
    expect(absent).toEqual([{ _tag: "StaleButAbsent", id: "J5", layer: "arrival", why: "old version" }]);
    expect(absent.map(describeProblem).join()).toContain("restore the name that carried it");
  });

  test("red: a stale cell no name carries is an owed cell, and still counts as required", () => {
    const staleCell = { ...row("J5").cells, arrival: { _tag: "stale", why: "old version" } } as const;
    const evaluation = evaluate([row("J5", { cells: staleCell })], []);
    expect(evaluation.problems.filter((problem) => problem.id === "J5").map((problem) => problem._tag)).toContain("StaleButAbsent");
    expect(layerCounts(evaluation.reports).find((count) => count.layer === "arrival")).toMatchObject({ held: 0, required: 1 });
  });

  test("red: a killer in a layer the row does not hold (not applicable or unstated)", () => {
    const stray = row("J5", { killers: [{ kind: "test", layer: "ts", name: "the killer test" }] });
    const { problems } = evaluate([stray], [carrier, name("title", "the killer test", "ts")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["KillerInUnclaimedLayer"]);
  });

});

describe("every live rule states every layer: held, owed, or not applicable with a reason", () => {
  const stated = row("J5");

  test("green: every layer stated, and a not-applicable cell no name in that layer carries", () => {
    expect(evaluate([stated], [carrier, killerName]).problems).toEqual([]);
  });

  test("red: a cell left unstated, in every layer it is left", () => {
    const cells = { ...stated.cells, quint: unstated, ts: unstated };
    const { problems } = evaluate([row("J5", { cells })], [carrier, killerName]);
    expect(problems.map((problem) => [problem._tag, "layer" in problem ? problem.layer : ""])).toEqual([["UnstatedCell", "quint"], ["UnstatedCell", "ts"]]);
    expect(describeProblem(problems[0]!)).toContain("J5");
    expect(describeProblem(problems[0]!)).toContain("quint");
  });

  test("red: an unstated cell stays red when a name in that layer already carries the id", () => {
    const cells = { ...stated.cells, ts: unstated };
    const { problems } = evaluate([row("J5", { cells })], [carrier, killerName, name("title", "J5 in ts", "ts")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["UnstatedCell"]);
  });

  test("red: a layer said to be not applicable that a name already carries the id in", () => {
    const { problems } = evaluate([stated], [carrier, killerName, name("property", "J5 holds", "ts")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["NotApplicableButPresent"]);
    expect(describeProblem(problems[0]!)).toContain("ts");
  });

  test("a not-applicable cell is neither held nor owed nor required, and is counted apart", () => {
    const evaluation = evaluate([stated], [carrier, killerName]);
    const counts = layerCounts(evaluation.reports);
    expect(counts.find((count) => count.layer === "ts")).toEqual({ layer: "ts", held: 0, owed: 0, required: 0, na: 1, unstated: 0 });
    expect(counts.find((count) => count.layer === "contract")).toEqual({ layer: "contract", held: 1, owed: 0, required: 1, na: 0, unstated: 0 });
  });

  test("red: a killer in a layer left unstated is a killer in a layer the row does not hold, besides the unstated cell", () => {
    const cells = { ...stated.cells, ts: unstated };
    const { problems } = evaluate([row("J5", { cells, killers: [{ kind: "test", layer: "ts", name: "the killer test" }] })], [carrier, name("title", "the killer test", "ts")]);
    expect(problems.map((problem) => problem._tag)).toEqual(["UnstatedCell", "KillerInUnclaimedLayer"]);
  });

  test("a not-applicable cell that a name carries is still counted as not applicable, besides being red", () => {
    const evaluation = evaluate([stated], [carrier, killerName, name("property", "J5 holds", "ts")]);
    expect(layerCounts(evaluation.reports).find((count) => count.layer === "ts")).toMatchObject({ required: 0, na: 1, unstated: 0 });
  });

  test("the matrix prints UNSTATED for an unstated cell and n/a for a not-applicable one", () => {
    const cells = { ...stated.cells, quint: unstated };
    const text = renderText(evaluate([row("J5", { cells })], [carrier, killerName]));
    expect(text).toContain("UNSTATED");
    expect(text).toContain("n/a");
    expect(text).toContain("1 n/a, 0 unstated");
    expect(renderMarkdown(evaluate([row("J5", { cells })], [carrier, killerName]))).toContain("| UNSTATED |");
  });

  test("a retired rule is in no count: its unstated cells are not the layer's", () => {
    const retired = row("R-OLD", { retiredBy: ["J5"], killers: [], cells: { ...stated.cells, contract: unstated, ts: unstated } });
    const counts = layerCounts(evaluate([retired, stated], [carrier, killerName]).reports);
    expect(counts.find((count) => count.layer === "ts")).toMatchObject({ na: 1, unstated: 0 });
    expect(counts.find((count) => count.layer === "contract")).toMatchObject({ held: 1, unstated: 0 });
  });

  test("a retired rule states nothing", () => {
    const retired = row("R-OLD", { retiredBy: ["J5"], killers: [], cells: { ...stated.cells, contract: unstated, ts: unstated } });
    expect(evaluate([retired, stated], [carrier, killerName]).problems).toEqual([]);
  });
});

describe("a retired rule", () => {
  const retired = row("R-OLD", { retiredBy: ["R-NEW"], killers: [], cells: row("x").cells });

  test("needs no killer and claims no name, when its successor is live", () => {
    const cells = { ...retired.cells, contract: unstated } as const;
    expect(evaluate([{ ...retired, cells }, row("R-NEW")], [name("title", "R-NEW holds"), name("title", "the killer test")]).problems).toEqual([]);
  });

  test("red when it points at a rule that is not a live row", () => {
    const cells = { ...retired.cells, contract: unstated } as const;
    const { problems } = evaluate([{ ...retired, cells }], []);
    expect(problems.map((problem) => problem._tag)).toEqual(["UnknownSuccessor"]);
  });
});

describe("the register folder", () => {
  const parsed = readRegisterFolder(`${import.meta.dir}/register`);

  test("parses", () => expect(parsed.ok).toBe(true));

  test("cells are -, hold, owed: <by> or n/a: <reason>", () => {
    expect(parseCell("x", "-")).toEqual({ ok: true, value: { _tag: "unstated" } });
    expect(parseCell("x", "owed: #41").ok).toBe(true);
    expect(parseCell("x", "owed:").ok).toBe(false);
    expect(parseCell("x", "yes").ok).toBe(false);
  });

  test("stale takes a reason, and a bare stale is refused", () => {
    expect(parseCell("x", "stale: models the rule before R-A1 was revised")).toEqual({ ok: true, value: { _tag: "stale", why: "models the rule before R-A1 was revised" } });
    ["stale", "stale:", "stale:   "].forEach((text) => expect(parseCell("x", text).ok).toBe(false));
  });

  test("n/a takes a one-line reason, and a bare n/a is refused", () => {
    expect(parseCell("x", "n/a: a contract-only rule")).toEqual({ ok: true, value: { _tag: "na", reason: "a contract-only rule" } });
    ["n/a", "n/a:", "n/a:   ", "na: reason"].forEach((text) => expect(parseCell("x", text).ok).toBe(false));
  });

  test("a layer a row does not mention is unstated, not applicable by silence", () => {
    const text = JSON.stringify({ rows: [{ id: "X", statement: "s", source: "s", layers: { contract: "hold" }, killers: [] }] });
    const result = parseRegister(text);
    expect(result.ok && result.value[0]?.cells.ts).toEqual({ _tag: "unstated" });
  });

  test("a row with an unknown layer is refused", () => {
    const bad = JSON.stringify({ rows: [{ id: "X", statement: "s", source: "s", layers: { moon: "hold" }, killers: [] }] });
    expect(parseRegister(bad).ok).toBe(false);
  });

  test("seeds the ids the brief names", () => {
    const ids = parsed.ok ? parsed.value.map((each) => each.id) : [];
    const seeded = ["C1", "C2", "H1", "H2", "H3", "H4", "J2", "J5", "J6", "R-FINAL-NONCE", "A12", "N3", "R-SIMULATE", "R-SPLIT", "R-COSIGN", "R-NONCE", "R-DURABLE", "R-CLOCK", "R-FUNDED", "R2C-DEBT-FIRST"];
    expect(seeded.filter((id) => !ids.includes(id))).toEqual([]);
    expect(ids.filter((id) => /^R-[EXAJRP]\d$/.test(id)).length).toBe(23);
  });

  test("the README carries the id policy: descriptive names, never bare numbers", () => {
    expect(readFileSync(`${import.meta.dir}/README.md`, "utf8")).toContain("descriptive names");
  });

  test("F1 is a finding id, not a rule; the rule is R-FINAL-NONCE, and R-X2 is retired into R-CLOCK and R-HTLC-CLOCK", () => {
    const rows = parsed.ok ? parsed.value : [];
    expect(rows.some((each) => each.id === "F1")).toBe(false);
    expect(rows.some((each) => each.id === "R-FINAL-NONCE")).toBe(true);
    expect(rows.find((each) => each.id === "R-X2")?.retiredBy).toEqual(["R-CLOCK", "R-HTLC-CLOCK"]);
  });

  test("every row names a layer cell for every layer", () => {
    const cells = parsed.ok ? parsed.value.flatMap((each) => LAYERS.map((layer) => each.cells[layer])) : [];
    expect(cells.length).toBe(LAYERS.length * (parsed.ok ? parsed.value.length : 0));
  });
});

describe("the real tree", () => {
  const parsed = readRegisterFolder(`${import.meta.dir}/register`);
  const register = parsed.ok ? parsed.value : [];
  const names = scanNames(`${import.meta.dir}/../..`);

  test("the gate is green on this checkout", () => {
    expect(evaluate(register, names).problems.map(describeProblem)).toEqual([]);
  });

  test("every live row states every layer, and every not-applicable cell gives a reason", () => {
    const live = register.filter((each) => each.retiredBy === undefined);
    const cells = live.flatMap((each) => LAYERS.map((layer) => ({ id: each.id, layer, cell: each.cells[layer] })));
    expect(cells.filter(({ cell }) => cell._tag === "unstated").map(({ id, layer }) => `${id}.${layer}`)).toEqual([]);
    expect(cells.filter(({ cell }) => cell._tag === "na" && cell.reason.trim().length < 12).map(({ id, layer }) => `${id}.${layer}`)).toEqual([]);
  });

  test("a --layer-root that does not exist is an error, not an empty layer", () => {
    const run = Bun.spawnSync(["bun", "rules/check.ts", "--layer-root", "arrival=/no/such/dir"], { cwd: `${import.meta.dir}/..` });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("no such directory");
  }, 30_000);

  test("the gate turns red when the names carrying C1 disappear from the contract tests", () => {
    const without = names.filter((each) => !(each.layer === "contract" && carries("C1", each)));
    const { problems } = evaluate(register, without);
    expect(problems.some((problem) => problem._tag === "MissingInLayer" && problem.id === "C1" && problem.layer === "contract")).toBe(true);
  });

  test("the gate turns red when a killer test is renamed", () => {
    const renamed = names.map((each) => (each.text === "C1 ondelta epoch" ? { ...each, text: "ondelta epoch" } : each));
    const { problems } = evaluate(register, renamed);
    expect(problems.some((problem) => problem._tag === "KillerNotFound" && problem.id === "C1")).toBe(true);
  });

  // The gate's own tests are registered (R-GATE-...): skipping or deleting one is a missing name, so the gate is red.
  test("the gate turns red when a gate test is skipped or deleted", () => {
    const gateRows = register.filter((each) => each.id.startsWith("R-GATE-"));
    const killers = gateRows.flatMap((row) => row.killers.map((killer) => ({ row, name: killer.name })));
    expect(killers.length).toBeGreaterThan(20);
    const missing = killers.filter(({ row, name }) => {
      const without = names.filter((each) => each.text !== name);
      return !evaluate([row], without).problems.some((problem) => problem._tag === "KillerNotFound" && problem.id === row.id);
    });
    expect(missing.map(({ name }) => name)).toEqual([]);
  });
});

describe("the register may only grow (ratchet against the base register)", () => {
  const held = row("H1");
  const base: Register = [held, row("H2")];
  const tags = (now: Register): readonly string[] => ratchet(base, now).problems.map((problem) => problem._tag);

  test("an unchanged register is fine, and so is a new row", () => {
    expect(tags([held, row("H2"), row("H9")])).toEqual([]);
  });

  test("red: a row deleted", () => expect(tags([held])).toEqual(["RowRemoved"]));

  test("red: every hold cell set to unstated", () => {
    const flat = { ...held.cells, contract: unstated } as const;
    expect(tags([row("H1", { cells: flat }), row("H2", { cells: flat })])).toEqual(["CellWeakened", "CellWeakened"]);
  });

  test("red: hold weakened to owed; owed weakened to absent", () => {
    const owedContract = { ...held.cells, contract: { _tag: "owed", by: "someone" } } as const;
    expect(tags([row("H1", { cells: owedContract }), row("H2")])).toEqual(["CellWeakened"]);
    const owingBase = [row("H1", { cells: owedContract })];
    const gone = ratchet(owingBase, [row("H1", { cells: { ...held.cells, contract: unstated } })]);
    expect(gone.problems.map((problem) => problem._tag)).toEqual(["CellWeakened"]);
  });

  test("red: a claim may not be dropped into not applicable: hold and owed both stay claims, so the denominator cannot shrink by a reason", () => {
    const asNa = { ...held.cells, contract: notApplicable } as const;
    expect(tags([row("H1", { cells: asNa }), row("H2")])).toEqual(["CellWeakened"]);
    const owedContract = { ...held.cells, contract: { _tag: "owed", by: "someone" } } as const;
    const owingBase = [row("H1", { cells: owedContract })];
    expect(ratchet(owingBase, [row("H1", { cells: asNa })]).problems.map((problem) => problem._tag)).toEqual(["CellWeakened"]);
  });

  test("a held cell may go stale when its rule is revised, and a stale cell may not fall back to owed; owed may become stale", () => {
    const stale = { ...held.cells, contract: { _tag: "stale", why: "old version" } } as const;
    const owedContract = { ...held.cells, contract: { _tag: "owed", by: "someone" } } as const;
    expect(ratchet([held], [row("H1", { cells: stale })]).problems).toEqual([]);
    expect(ratchet([row("H1", { cells: stale })], [held]).problems).toEqual([]);
    expect(ratchet([row("H1", { cells: owedContract })], [row("H1", { cells: stale })]).problems).toEqual([]);
    expect(ratchet([row("H1", { cells: stale })], [row("H1", { cells: owedContract })]).problems.map((problem) => problem._tag)).toEqual(["CellWeakened"]);
  });

  test("growing is fine: owed becomes hold, unstated becomes not applicable or owed, not applicable becomes owed", () => {
    const owedContract = { ...held.cells, contract: { _tag: "owed", by: "someone" } } as const;
    expect(ratchet([row("H1", { cells: owedContract })], [held]).problems).toEqual([]);
    const unstatedBase = [row("H1", { cells: { ...held.cells, ts: unstated } })];
    expect(ratchet(unstatedBase, [held]).problems).toEqual([]);
    expect(ratchet(unstatedBase, [row("H1", { cells: { ...held.cells, ts: { _tag: "owed", by: "someone" } } })]).problems).toEqual([]);
    expect(ratchet([held], [row("H1", { cells: { ...held.cells, ts: { _tag: "owed", by: "someone" } } })]).problems).toEqual([]);
  });

  test("red: a stated cell, even not applicable, may not go back to unstated", () => {
    expect(tags([row("H1", { cells: { ...held.cells, ts: unstated } }), row("H2")])).toEqual(["CellWeakened"]);
  });

  test("red: a killer the base named (not owed) disappears; an owed one may change", () => {
    const withOwed = row("H1", { killers: [{ kind: "test", layer: "contract", name: "the killer test" }, { kind: "bug", layer: "arrival", name: "x", owed: "#41" }] });
    const dropsReal = row("H1", { killers: [{ kind: "bug", layer: "arrival", name: "x", owed: "#41" }] });
    expect(ratchet([withOwed], [dropsReal]).problems.map((problem) => problem._tag)).toEqual(["KillerDropped"]);
    expect(ratchet([withOwed], [row("H1")]).problems).toEqual([]);
  });

  test("retiring a rule is allowed only into live successors, and is printed", () => {
    const retired = row("H2", { retiredBy: ["H1"], killers: [] });
    const result = ratchet(base, [held, retired]);
    expect(result.problems).toEqual([]);
    expect(result.retirements).toEqual(["H2 retired into H1"]);
    expect(evaluate([held, row("H2", { retiredBy: ["H7"], killers: [] })], [carrier, killerName]).problems.map((problem) => problem._tag)).toContain("UnknownSuccessor");
  });

  test("retiring a rule into another retired rule is red", () => {
    const chain = [row("A", { retiredBy: ["B"], killers: [] }), row("B", { retiredBy: ["C"], killers: [] }), row("C")];
    expect(evaluate(chain, [carrier, killerName]).problems.map((problem) => problem._tag)).toContain("UnknownSuccessor");
  });
});

describe("the base register is read from git, and a git failure is red", () => {
  const repo = mkdtempSync(`${tmpdir()}/rules-base-`);
  const sh = (...args: string[]): void => void Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
  const rowsJson = JSON.stringify({ rows: [{ id: "H1", statement: "s", source: "s", layers: { contract: "hold" }, killers: [{ kind: "test", layer: "contract", name: "t" }] }] });

  test("a base without the register is the introducing commit; a base with it is parsed; a bad ref is an error", () => {
    sh("init", "-q", "-b", "main");
    writeFileSync(`${repo}/a.txt`, "a");
    sh("add", "-A");
    sh("commit", "-q", "-m", "one");
    sh("branch", "base");
    const introduced = readBase(repo, "base");
    expect(introduced.ok && introduced.value._tag).toBe("Introduced");
    mkdirSync(`${repo}/pure/rules`, { recursive: true });
    writeFileSync(`${repo}/pure/rules/register.json`, rowsJson);
    sh("add", "-A");
    sh("commit", "-q", "-m", "two");
    sh("branch", "base2");
    sh("commit", "-q", "--allow-empty", "-m", "three");
    const based = readBase(repo, "base2");
    expect(based.ok && based.value._tag === "Base" && based.value.register.map((each) => each.id)).toEqual(["H1"]);
    expect(readBase(repo, "no-such-ref").ok).toBe(false);
  });

  test("a base that keeps the register as a folder of rule files is read the same way", () => {
    const folder = mkdtempSync(`${tmpdir()}/rules-base-folder-`);
    const run = (...args: string[]): void => void Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: folder });
    run("init", "-q", "-b", "main");
    mkdirSync(`${folder}/pure/rules/register`, { recursive: true });
    const first = JSON.parse(rowsJson).rows[0];
    writeFileSync(`${folder}/pure/rules/register/H1.json`, JSON.stringify(first, null, 1));
    run("add", "-A");
    run("commit", "-q", "-m", "one");
    run("branch", "base");
    run("commit", "-q", "--allow-empty", "-m", "two");
    const based = readBase(folder, "base");
    expect(based.ok && based.value._tag === "Base" && based.value.register.map((each) => each.id)).toEqual(["H1"]);
  });
});
