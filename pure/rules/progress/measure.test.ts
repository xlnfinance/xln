import { describe, expect, test } from "bun:test";
import { evaluate } from "../evaluate.ts";
import { LAYERS, type Cell, type Layer, type Name, type Register, type Row } from "../model.ts";
import { addedSince, columnsOf, milestonesOf, percentOf, registerColumns, renderProgress, retiredSince, totalOf, type Deployment, type SpecAtMain } from "./measure.ts";

const held: Cell = { _tag: "hold" };
const owed: Cell = { _tag: "owed", by: "someone" };
const unstated: Cell = { _tag: "unstated" };
const na: Cell = { _tag: "na", reason: "no part in this rule" };

const row = (id: string, cells: Partial<Record<Layer, Cell>>, overrides: Partial<Row> = {}): Row => ({
  id,
  statement: "s",
  source: "src",
  cells: { arrival: unstated, quint: unstated, contract: unstated, rig: unstated, ts: unstated, ...cells },
  killers: [{ kind: "test", layer: "ts", name: "the killer" }],
  ...overrides,
});

// A name in `layer` that carries `id`, so a `hold` cell for that id is held.
const carrier = (layer: Layer, id: string): Name => ({ layer, kind: "title", text: `${id} is carried`, file: "f" });

const reportsOf = (register: Register, names: readonly Name[] = []) => evaluate(register, names).reports;

const columnOf = (register: Register, names: readonly Name[], layer: Layer) =>
  columnsOf(reportsOf(register, names)).find((column) => column.layer === layer);

describe("a column counts the rules it holds out of the rules it must carry", () => {
  const register: Register = [
    row("R-ONE", { ts: held, arrival: owed }),
    row("R-TWO", { ts: owed }),
    row("R-THREE", { ts: held }),
    row("R-FOUR", { arrival: held }),
  ];
  const names = [carrier("ts", "R-ONE"), carrier("ts", "R-THREE"), carrier("arrival", "R-FOUR")];

  test("held counts the cells a name carries, owed the cells still promised, required both", () => {
    expect(columnOf(register, names, "ts")).toMatchObject({ held: 2, owed: 1, required: 3 });
    expect(columnOf(register, names, "arrival")).toMatchObject({ held: 1, owed: 1, required: 2 });
  });
  test("a rule whose cell is left unstated is not required and is counted apart, so a quiet column is not read as a finished one", () => {
    expect(columnOf(register, names, "ts")?.unstated).toBe(1);
    expect(columnOf(register, names, "quint")).toMatchObject({ held: 0, owed: 0, required: 0, na: 0, unstated: 4 });
  });
  test("an unstated cell stays unstated when a name already carries the id there: nothing is required of it yet", () => {
    expect(columnOf(register, [carrier("quint", "R-ONE")], "quint")).toMatchObject({ required: 0, unstated: 4 });
  });
  test("a not-applicable cell is counted apart: not held, not owed, not required, and not unstated", () => {
    const withNa: Register = [...register, row("R-FIVE", { ts: na })];
    expect(columnOf(withNa, names, "ts")).toMatchObject({ held: 2, owed: 1, required: 3, na: 1, unstated: 1 });
  });
  test("a hold cell no name carries is required but not held (the gate is red there)", () => {
    expect(columnOf(register, [], "ts")).toMatchObject({ held: 0, owed: 1, required: 3 });
  });
  test("an owed cell the code already satisfies still counts as owed until it is promoted", () => {
    expect(columnOf(register, [carrier("ts", "R-TWO")], "ts")).toMatchObject({ held: 0, owed: 1 });
  });
  test("a retired rule is in no column, in the numerator or the denominator", () => {
    const withRetired: Register = [...register, row("R-OLD", { ts: held }, { retiredBy: ["R-ONE"] })];
    expect(columnOf(withRetired, names, "ts")).toMatchObject({ held: 2, required: 3, unstated: 1 });
  });
  test("every layer has a column, in the register's own order", () => {
    expect(columnsOf(reportsOf(register, names)).map((column) => column.layer)).toEqual([...LAYERS]);
  });
});

describe("percent and total", () => {
  test("percent is held over required to one decimal, and nothing when nothing is required", () => {
    expect(percentOf(19, 64)).toBe(29.7);
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(3, 3)).toBe(100);
    expect(percentOf(0, 7)).toBe(0);
    expect(percentOf(0, 0)).toBeUndefined();
  });
  test("the total adds held cells and required cells across every column", () => {
    const columns = [
      { layer: "arrival", held: 19, owed: 45, required: 64, na: 0, unstated: 0 },
      { layer: "ts", held: 40, owed: 9, required: 49, na: 0, unstated: 0 },
    ] as const;
    expect(totalOf(columns)).toEqual({ held: 59, required: 113 });
  });
});

describe("a register read from a commit has no names, so its columns come from the cells", () => {
  const register: Register = [
    row("R-ONE", { ts: held, arrival: owed }),
    row("R-TWO", { ts: owed }),
    row("R-OLD", { ts: held }, { retiredBy: ["R-ONE"] }),
  ];
  test("a hold cell counts as held, an owed cell as owed, n/a as not applicable, a `-` as unstated, a retired row not at all", () => {
    const columns = registerColumns([...register, row("R-THREE", { ts: na })]);
    expect(columns.find((column) => column.layer === "ts")).toEqual({ layer: "ts", held: 1, owed: 1, required: 2, na: 1, unstated: 0 });
    expect(columns.find((column) => column.layer === "arrival")).toEqual({ layer: "arrival", held: 0, owed: 1, required: 1, na: 0, unstated: 2 });
  });
  test("on a green tree the cell columns equal the columns the names give", () => {
    const names = [carrier("ts", "R-ONE")];
    expect(registerColumns(register.slice(0, 2))).toEqual(columnsOf(reportsOf(register.slice(0, 2), names)));
  });
});

describe("rules added and retired since a commit", () => {
  const then: Register = [row("R-A", { ts: held }), row("R-B", { ts: held })];
  const now: Register = [...then, row("R-C", { ts: owed }), row("R-D", { ts: held }, { retiredBy: ["R-A"] })];
  test("the new live ids, in register order", () => expect(addedSince(then, now)).toEqual(["R-C"]));
  test("a rule retired since is not added, and a rule that was already there is not added again", () => {
    expect(addedSince(now, now)).toEqual([]);
    expect(addedSince([], then)).toEqual(["R-A", "R-B"]);
  });
  test("a row that was retired then and is live now was not new", () => {
    expect(addedSince([row("R-A", { ts: held }, { retiredBy: ["R-B"] })], [row("R-A", { ts: held })])).toEqual([]);
  });
  test("a rule live then and retired now is retired since, so shrinking the denominator shows", () => {
    expect(retiredSince(then, [row("R-A", { ts: held }, { retiredBy: ["R-B"] }), row("R-B", { ts: held })])).toEqual(["R-A"]);
  });
  test("a rule live then and gone now is retired since too (the gate refuses it, the report still says so)", () => {
    expect(retiredSince(then, [row("R-B", { ts: held })])).toEqual(["R-A"]);
  });
  test("a rule that was already retired then is not retired since, and a live one stays live", () => {
    const retiredThen = [row("R-A", { ts: held }, { retiredBy: ["R-B"] }), row("R-B", { ts: held })];
    expect(retiredSince(retiredThen, retiredThen)).toEqual([]);
    expect(retiredSince(then, then)).toEqual([]);
  });
});

const column = (layer: Layer, heldCount: number, owedCount: number, unstated = 0, na = 0) =>
  ({ layer, held: heldCount, owed: owedCount, required: heldCount + owedCount, na, unstated }) as const;

const allDone = LAYERS.map((layer) => column(layer, 4, 0));
const recorded: Deployment = { recorded: true, detail: "status deployed on ethereum-sepolia" };
const notRecorded: Deployment = { recorded: false, detail: "status prepared" };
const onMain = (columns: ReturnType<typeof columnsOf>): SpecAtMain => ({ ref: "3ed971f", columns });
const mainDone = onMain(allDone);

// `main` defaults to a main whose columns are all done; `undefined` is passed on as origin/main being absent.
const milestone = (name: string, columns: ReturnType<typeof columnsOf>, deployment: Deployment, ...main: readonly [] | readonly [SpecAtMain | undefined]) =>
  milestonesOf(columns, deployment, main.length === 0 ? mainDone : main[0]).find((each) => each.name === name);

const statusOf = (name: string, columns: ReturnType<typeof columnsOf>, deployment: Deployment, ...main: readonly [] | readonly [SpecAtMain | undefined]) =>
  milestone(name, columns, deployment, ...main)?.status;

describe("the six goal milestones, each decided by a check that exists", () => {
  test("six of them, in the order of the goal, and the last one is the Sepolia run", () => {
    expect(milestonesOf(allDone, recorded, mainDone).map((each) => each.name)).toEqual([
      "Arrival on main",
      "Quint on main",
      "Contracts reviewed and deployed",
      "xln.ts cut to the spec",
      "Walk checks the spec against the contracts",
      "End-to-end run on Sepolia",
    ]);
  });
  test("a column that holds everything it must carry makes the checkout's milestones done", () => {
    expect(statusOf("xln.ts cut to the spec", allDone, recorded)).toBe("done");
    expect(statusOf("Walk checks the spec against the contracts", allDone, recorded)).toBe("done");
  });
  test("Arrival and Quint are judged on origin/main's columns, not the checkout's", () => {
    const owedHere = allDone.map((each) => (each.layer === "arrival" ? column("arrival", 3, 1) : each));
    expect(statusOf("Arrival on main", owedHere, recorded, mainDone)).toBe("done");
    expect(statusOf("Arrival on main", allDone, recorded, onMain(owedHere))).toBe("not done");
    expect(milestone("Arrival on main", allDone, recorded, onMain(owedHere))?.detail).toContain("3ed971f");
  });
  test("with no origin/main to read, Arrival and Quint are unchecked, never guessed from the checkout", () => {
    expect(statusOf("Arrival on main", allDone, recorded, undefined)).toBe("unchecked");
    expect(statusOf("Quint on main", allDone, recorded, undefined)).toBe("unchecked");
    expect(milestone("Quint on main", allDone, recorded, undefined)?.detail).toContain("origin/main");
  });
  test("Arrival and Quint are done only when every live rule states its cell there: retiring or blanking rows cannot finish them", () => {
    const blanked = allDone.map((each) => (each.layer === "quint" ? column("quint", 4, 0, 1) : each));
    expect(statusOf("Quint on main", allDone, recorded, onMain(blanked))).toBe("not done");
    expect(statusOf("Arrival on main", allDone, recorded, onMain(blanked))).toBe("done");
  });
  test("a column with an owed cell keeps its milestone not done", () => {
    const columns = allDone.map((each) => (each.layer === "ts" ? column("ts", 3, 1) : each));
    expect(statusOf("xln.ts cut to the spec", columns, recorded)).toBe("not done");
  });
  test("an empty column is not done: nothing held is not everything held", () => {
    const columns = allDone.map((each) => (each.layer === "rig" ? column("rig", 0, 0, 12) : each));
    expect(statusOf("Walk checks the spec against the contracts", columns, recorded)).toBe("not done");
    expect(statusOf("Quint on main", allDone, recorded, onMain(allDone.map((each) => (each.layer === "quint" ? column("quint", 0, 0, 12) : each))))).toBe("not done");
  });
  test("a hold cell with no name (held below required) is not done", () => {
    const columns = allDone.map((each) => (each.layer === "ts" ? { ...each, held: 3, required: 4 } : each));
    expect(statusOf("xln.ts cut to the spec", columns, recorded)).toBe("not done");
  });
  test("a cell left unstated keeps ts and the walk from done, whatever else the column holds", () => {
    const wide = allDone.map((each) => (each.layer === "ts" ? column("ts", 4, 0, 70) : each));
    const open = milestone("xln.ts cut to the spec", wide, recorded);
    expect(open?.status).toBe("not done");
    expect(open?.detail).toContain("70 of 74 live rules leave the cell unstated");
    const rig = allDone.map((each) => (each.layer === "rig" ? column("rig", 4, 0, 1) : each));
    expect(statusOf("Walk checks the spec against the contracts", rig, recorded)).toBe("not done");
  });
  test("rules that say not applicable, with a reason, do not keep a milestone from done, and the milestone says how many", () => {
    const wide = allDone.map((each) => (each.layer === "ts" ? column("ts", 4, 0, 0, 70) : each));
    const done = milestone("xln.ts cut to the spec", wide, recorded);
    expect(done?.status).toBe("done");
    expect(done?.detail).toContain("70 not applicable");
    const onMainWide = allDone.map((each) => (each.layer === "quint" ? column("quint", 4, 0, 0, 3) : each));
    expect(statusOf("Quint on main", allDone, recorded, onMain(onMainWide))).toBe("done");
  });
  test("a column where every rule says not applicable has finished nothing", () => {
    const empty = allDone.map((each) => (each.layer === "rig" ? column("rig", 0, 0, 0, 12) : each));
    expect(statusOf("Walk checks the spec against the contracts", empty, recorded)).toBe("not done");
  });
  test("contracts: an unstated cell in the column is not done, like an owed one", () => {
    const open = allDone.map((each) => (each.layer === "contract" ? column("contract", 22, 0, 1) : each));
    expect(statusOf("Contracts reviewed and deployed", open, recorded)).toBe("not done");
  });
  test("contracts: an incomplete column or a manifest that is not deployed is not done", () => {
    expect(statusOf("Contracts reviewed and deployed", allDone, notRecorded)).toBe("not done");
    const open = allDone.map((each) => (each.layer === "contract" ? column("contract", 21, 1) : each));
    expect(statusOf("Contracts reviewed and deployed", open, recorded)).toBe("not done");
  });
  test("contracts: a recorded deployment is never done, because nothing compares its code hashes with the build", () => {
    const found = milestone("Contracts reviewed and deployed", allDone, recorded);
    expect(found?.status).toBe("unchecked");
    expect(found?.detail).toContain("unverified");
    expect(found?.detail).toContain("code hashes");
  });
  test("the Sepolia run has no check in this report, so it is unchecked whatever else is done, and it makes no claim about records", () => {
    const found = milestone("End-to-end run on Sepolia", allDone, recorded);
    expect(found?.status).toBe("unchecked");
    expect(found?.detail).toContain("open, pay, HTLC across hubs, swap, dispute");
    expect(found?.detail).not.toContain("nothing reads");
  });
  test("each column milestone says it rests on names, not on a run", () => {
    ["Arrival on main", "Quint on main", "xln.ts cut to the spec", "Walk checks the spec against the contracts"].forEach((name) =>
      expect(milestone(name, allDone, recorded)?.by).toBe("by names, not by a run"),
    );
  });
  test("each detail carries the numbers the status rests on", () => {
    const columns = allDone.map((each) => (each.layer === "arrival" ? column("arrival", 19, 45) : each));
    expect(milestonesOf(allDone, recorded, onMain(columns))[0]?.detail).toContain("19 of 64");
  });
});

const columns = [column("arrival", 19, 45), column("quint", 0, 67), column("ts", 40, 9, 3, 2), column("contract", 22, 0), column("rig", 1, 2)];
const checkout = { branch: "claude/x", sha: "abc1234", changed: 0 } as const;
const report = (over: Partial<Parameters<typeof renderProgress>[0]> = {}) =>
  renderProgress({
    checkout,
    specFrom: "origin/main at 3ed971f",
    liveRules: 93,
    columns,
    milestones: milestonesOf(columns, notRecorded, onMain(columns)),
    since: undefined,
    problems: 0,
    ...over,
  });

describe("the printed report", () => {
  const text = report();
  test("names the five columns in the coordinator's words, with held, required and percent", () => {
    const lines = text.split("\n");
    expect(lines.find((line) => line.startsWith("Arrival"))).toMatch(/19\s+64\s+29\.7%/);
    expect(lines.find((line) => line.startsWith("Quint"))).toMatch(/0\s+67\s+0\.0%/);
    expect(lines.find((line) => line.startsWith("ts code"))).toMatch(/40\s+49\s+81\.6%/);
    expect(lines.find((line) => line.startsWith("contracts"))).toMatch(/22\s+22\s+100\.0%/);
    expect(lines.find((line) => line.startsWith("walk"))).toMatch(/1\s+3\s+33\.3%/);
  });
  test("prints how many cells are not applicable and how many are unstated in each column, so a shrunk denominator shows", () => {
    const lines = text.split("\n");
    expect(lines.find((line) => line.startsWith("Column"))).toContain("not applicable");
    expect(lines.find((line) => line.startsWith("Column"))).toContain("unstated");
    expect(lines.find((line) => line.startsWith("ts code"))).toMatch(/40\s+49\s+81\.6%\s+9\s+2\s+3$/);
    expect(lines.find((line) => line.startsWith("Arrival"))).toMatch(/19\s+64\s+29\.7%\s+45\s+0\s+0$/);
  });
  test("prints the total over every column", () => {
    expect(text.split("\n").find((line) => line.startsWith("Total"))).toMatch(/82\s+205\s+40\.0%/);
  });
  test("prints each milestone with its status and its basis, and the unchecked one as unchecked", () => {
    expect(text).toContain("[not done]  Arrival on main (by names, not by a run): ");
    expect(text).toContain("[unchecked] End-to-end run on Sepolia: ");
    expect(text).toContain("Milestones: 0 done, 5 not done, 1 unchecked, of 6");
  });
  test("says which branch and sha the checkout is, and whether it is clean or dirty", () => {
    expect(text).toContain("branch claude/x at abc1234, clean");
    expect(report({ checkout: { ...checkout, changed: 3 } })).toContain("branch claude/x at abc1234, dirty (3 changed files)");
    expect(report({ checkout: { ...checkout, changed: 1 } })).toContain("dirty (1 changed file)");
  });
  test("says where the spec milestones were read from", () => {
    expect(text).toContain("The Arrival and Quint milestones are read from origin/main at 3ed971f");
    expect(report({ specFrom: "no origin/main here" })).toContain("The Arrival and Quint milestones are read from no origin/main here");
  });
  test("says plainly that a red banner counts only the register, since the composed gate is more than that", () => {
    expect(text).not.toContain("register evaluation is red");
    const red = report({ problems: 2 });
    expect(red).toContain("the register evaluation is red (2 problems)");
    expect(red).toContain("bun rules/check.ts");
    expect(red).not.toContain("the gate is red");
  });
  test("one rule added reads as one rule", () => {
    const one = report({ since: { ref: "def5678", added: ["R-C"], retired: [], then: columns } });
    expect(one).toContain("Since def5678: 1 rule added (R-C), 0 rules retired");
  });
  test("a long list of new rules prints the count and no list", () => {
    const ids = Array.from({ length: 11 }, (_, index) => `R-N${index}`);
    const many = report({ since: { ref: "def5678", added: ids, retired: [], then: columns } });
    expect(many).toContain("Since def5678: 11 rules added, 0 rules retired\n");
  });
  test("retired rules are counted and listed, so a shrunk denominator is visible", () => {
    const retired = report({ since: { ref: "def5678", added: [], retired: ["R-OLD", "R-OLDER"], then: columns } });
    expect(retired).toContain("Since def5678: 0 rules added, 2 rules retired (R-OLD, R-OLDER)");
  });
  test("with --since it prints how each column's denominator moved, and that then comes from cell tags", () => {
    const withSince = report({
      since: { ref: "def5678", added: ["R-C", "R-D"], retired: [], then: [column("arrival", 10, 30), column("quint", 0, 0), column("ts", 30, 5), column("contract", 22, 0), column("rig", 1, 2)] },
    });
    expect(withSince).toContain("Since def5678: 2 rules added (R-C, R-D), 0 rules retired");
    expect(withSince.split("\n").find((line) => line.startsWith("Arrival") && line.includes("then"))).toMatch(/then 25\.0% of 40, now 29\.7% of 64/);
    expect(withSince.split("\n").find((line) => line.startsWith("Quint") && line.includes("then"))).toMatch(/then - of 0, now 0\.0% of 67/);
    expect(withSince).toContain("then is counted from the cells of that commit's register, now from the names");
  });
  test("with no base to compare with, it says so instead of printing nothing", () => {
    expect(report({ since: "no base" })).toContain("Since: no commit to compare with (origin/main is not fetched here)");
  });
});

describe("the real tree", () => {
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "rules/progress.ts", ...args], { cwd: `${import.meta.dir}/../..` });

  test("prints five columns, a total and the six milestones, and the Sepolia run is unchecked", () => {
    const done = run();
    const out = done.stdout.toString();
    expect(done.exitCode).toBe(0);
    ["Arrival", "Quint", "ts code", "contracts", "walk", "Total"].forEach((label) => expect(out).toContain(label));
    expect(out).toContain("[unchecked] End-to-end run on Sepolia");
    expect(out.split("\n").filter((line) => /^\[(done|not done|unchecked)\]/.test(line))).toHaveLength(6);
  });
  test("names the checkout's branch and says where the spec milestones were read from", () => {
    const out = run().stdout.toString();
    expect(out).toMatch(/Progress on branch \S+ at [0-9a-f]{7,}, (clean|dirty)/);
    expect(out).toContain("The Arrival and Quint milestones are read from");
  });
  test("--since HEAD adds and retires no rules; a ref that is not there is an error, never an empty answer", () => {
    expect(run("--since", "HEAD").stdout.toString()).toContain("0 rules added, 0 rules retired");
    const missing = run("--since", "no-such-ref-anywhere");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("no-such-ref-anywhere");
  });
  test("an unknown argument is an error", () => expect(run("--bogus").exitCode).toBe(1));
});
