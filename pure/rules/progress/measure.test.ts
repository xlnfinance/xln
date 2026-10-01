import { describe, expect, test } from "bun:test";
import { evaluate } from "../evaluate.ts";
import { LAYERS, type Cell, type Layer, type Name, type Register, type Row } from "../model.ts";
import { addedSince, columnsOf, milestonesOf, percentOf, registerColumns, renderProgress, totalOf, type Deployment } from "./measure.ts";

const held: Cell = { _tag: "hold" };
const owed: Cell = { _tag: "owed", by: "someone" };
const absent: Cell = { _tag: "absent" };

const row = (id: string, cells: Partial<Record<Layer, Cell>>, overrides: Partial<Row> = {}): Row => ({
  id,
  statement: "s",
  source: "src",
  cells: { arrival: absent, quint: absent, contract: absent, rig: absent, ts: absent, ...cells },
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
  test("a rule whose cell is `-` is not required and is counted apart, so a quiet column is not read as a finished one", () => {
    expect(columnOf(register, names, "ts")?.unclaimed).toBe(1);
    expect(columnOf(register, names, "quint")).toMatchObject({ held: 0, owed: 0, required: 0, unclaimed: 4 });
  });
  test("a `-` cell stays unclaimed when a name already carries the id there: nothing is required of it yet", () => {
    expect(columnOf(register, [carrier("quint", "R-ONE")], "quint")).toMatchObject({ required: 0, unclaimed: 4 });
  });
  test("a hold cell no name carries is required but not held (the gate is red there)", () => {
    expect(columnOf(register, [], "ts")).toMatchObject({ held: 0, owed: 1, required: 3 });
  });
  test("an owed cell the code already satisfies still counts as owed until it is promoted", () => {
    expect(columnOf(register, [carrier("ts", "R-TWO")], "ts")).toMatchObject({ held: 0, owed: 1 });
  });
  test("a retired rule is in no column, in the numerator or the denominator", () => {
    const withRetired: Register = [...register, row("R-OLD", { ts: held }, { retiredBy: ["R-ONE"] })];
    expect(columnOf(withRetired, names, "ts")).toMatchObject({ held: 2, required: 3, unclaimed: 1 });
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
      { layer: "arrival", held: 19, owed: 45, required: 64, unclaimed: 0 },
      { layer: "ts", held: 40, owed: 9, required: 49, unclaimed: 0 },
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
  test("a hold cell counts as held, an owed cell as owed, a `-` as unclaimed, a retired row not at all", () => {
    const columns = registerColumns(register);
    expect(columns.find((column) => column.layer === "ts")).toEqual({ layer: "ts", held: 1, owed: 1, required: 2, unclaimed: 0 });
    expect(columns.find((column) => column.layer === "arrival")).toEqual({ layer: "arrival", held: 0, owed: 1, required: 1, unclaimed: 1 });
  });
  test("on a green tree the cell columns equal the columns the names give", () => {
    const names = [carrier("ts", "R-ONE")];
    expect(registerColumns(register.slice(0, 2))).toEqual(columnsOf(reportsOf(register.slice(0, 2), names)));
  });
});

describe("rules added since a commit", () => {
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
});

const column = (layer: Layer, heldCount: number, owedCount: number, unclaimed = 0) =>
  ({ layer, held: heldCount, owed: owedCount, required: heldCount + owedCount, unclaimed }) as const;

const allDone = LAYERS.map((layer) => column(layer, 4, 0));
const deployed: Deployment = { deployed: true, detail: "status deployed on ethereum-sepolia" };
const notDeployed: Deployment = { deployed: false, detail: "status prepared" };

const statusOf = (name: string, columns: ReturnType<typeof columnsOf>, deployment: Deployment) =>
  milestonesOf(columns, deployment).find((milestone) => milestone.name === name)?.status;

describe("the six goal milestones, each decided by a check that exists", () => {
  test("six of them, in the order of the goal, and the last one is the Sepolia run", () => {
    expect(milestonesOf(allDone, deployed).map((milestone) => milestone.name)).toEqual([
      "Arrival on main",
      "Quint on main",
      "Contracts reviewed and deployed",
      "xln.ts cut to the spec",
      "Walk checks the spec against the contracts",
      "End-to-end run on Sepolia",
    ]);
  });
  test("a column that holds everything it must carry makes its milestone done", () => {
    expect(statusOf("Arrival on main", allDone, deployed)).toBe("done");
    expect(statusOf("Quint on main", allDone, deployed)).toBe("done");
    expect(statusOf("xln.ts cut to the spec", allDone, deployed)).toBe("done");
    expect(statusOf("Walk checks the spec against the contracts", allDone, deployed)).toBe("done");
  });
  test("one owed cell in the column keeps it not done", () => {
    const columns = allDone.map((each) => (each.layer === "arrival" ? column("arrival", 63, 1) : each));
    expect(statusOf("Arrival on main", columns, deployed)).toBe("not done");
    expect(statusOf("Quint on main", columns, deployed)).toBe("done");
  });
  test("an empty column is not done: nothing held is not everything held", () => {
    const columns = allDone.map((each) => (each.layer === "quint" ? column("quint", 0, 0, 12) : each));
    expect(statusOf("Quint on main", columns, deployed)).toBe("not done");
  });
  test("a hold cell with no name (held below required) is not done", () => {
    const columns = allDone.map((each) => (each.layer === "ts" ? { ...each, held: 3, required: 4 } : each));
    expect(statusOf("xln.ts cut to the spec", columns, deployed)).toBe("not done");
  });
  test("contracts are done only when the contract column is complete and the manifest says deployed", () => {
    expect(statusOf("Contracts reviewed and deployed", allDone, deployed)).toBe("done");
    expect(statusOf("Contracts reviewed and deployed", allDone, notDeployed)).toBe("not done");
    const open = allDone.map((each) => (each.layer === "contract" ? column("contract", 21, 1) : each));
    expect(statusOf("Contracts reviewed and deployed", open, deployed)).toBe("not done");
  });
  test("the Sepolia run has no check yet, so it is unchecked whatever else is done", () => {
    expect(statusOf("End-to-end run on Sepolia", allDone, deployed)).toBe("unchecked");
    expect(milestonesOf(allDone, deployed).find((milestone) => milestone.name === "End-to-end run on Sepolia")?.detail).toContain(
      "open, pay, HTLC across hubs, swap, dispute",
    );
  });
  test("each detail carries the numbers the status rests on", () => {
    const columns = allDone.map((each) => (each.layer === "arrival" ? column("arrival", 19, 45) : each));
    expect(milestonesOf(columns, deployed)[0]?.detail).toContain("19 of 64");
  });
});

describe("the printed report", () => {
  const columns = [column("arrival", 19, 45), column("quint", 0, 67), column("ts", 40, 9, 3), column("contract", 22, 0), column("rig", 1, 2)];
  const text = renderProgress({
    at: "abc1234",
    liveRules: 93,
    columns,
    milestones: milestonesOf(columns, notDeployed),
    since: undefined,
    problems: 0,
  });
  test("names the five columns in the coordinator's words, with held, required and percent", () => {
    const lines = text.split("\n");
    expect(lines.find((line) => line.startsWith("Arrival"))).toMatch(/19\s+64\s+29\.7%/);
    expect(lines.find((line) => line.startsWith("Quint"))).toMatch(/0\s+67\s+0\.0%/);
    expect(lines.find((line) => line.startsWith("ts code"))).toMatch(/40\s+49\s+81\.6%/);
    expect(lines.find((line) => line.startsWith("contracts"))).toMatch(/22\s+22\s+100\.0%/);
    expect(lines.find((line) => line.startsWith("walk"))).toMatch(/1\s+3\s+33\.3%/);
  });
  test("prints the total over every column", () => {
    expect(text.split("\n").find((line) => line.startsWith("Total"))).toMatch(/82\s+205\s+40\.0%/);
  });
  test("prints each milestone with its status, and the unchecked one as unchecked", () => {
    expect(text).toContain("[not done]  Arrival on main");
    expect(text).toContain("[unchecked] End-to-end run on Sepolia");
    expect(text).toContain("Milestones: 0 done, 5 not done, 1 unchecked, of 6");
  });
  test("says when the gate is red, since the numbers then rest on a tree the gate refuses", () => {
    expect(text).not.toContain("the gate is red");
    expect(renderProgress({ at: "abc1234", liveRules: 93, columns, milestones: [], since: undefined, problems: 2 })).toContain(
      "the gate is red here (2 problems)",
    );
  });
  test("one rule added reads as one rule", () => {
    const one = renderProgress({ at: "abc1234", liveRules: 93, columns, milestones: [], since: { ref: "def5678", added: ["R-C"], then: columns }, problems: 0 });
    expect(one).toContain("Since def5678: 1 rule added (R-C)");
  });
  test("a long list of new rules prints the count and no list", () => {
    const ids = Array.from({ length: 11 }, (_, index) => `R-N${index}`);
    const many = renderProgress({ at: "abc1234", liveRules: 93, columns, milestones: [], since: { ref: "def5678", added: ids, then: columns }, problems: 0 });
    expect(many).toContain("Since def5678: 11 rules added\n");
  });
  test("with --since it prints how many rules were added and how each column's denominator moved", () => {
    const withSince = renderProgress({
      at: "abc1234",
      liveRules: 93,
      columns,
      milestones: [],
      since: { ref: "def5678", added: ["R-C", "R-D"], then: [column("arrival", 10, 30), column("quint", 0, 0), column("ts", 30, 5), column("contract", 22, 0), column("rig", 1, 2)] },
      problems: 0,
    });
    expect(withSince).toContain("Since def5678: 2 rules added (R-C, R-D)");
    expect(withSince.split("\n").find((line) => line.startsWith("Arrival") && line.includes("then"))).toMatch(/then 25\.0% of 40, now 29\.7% of 64/);
    expect(withSince.split("\n").find((line) => line.startsWith("Quint") && line.includes("then"))).toMatch(/then - of 0, now 0\.0% of 67/);
  });
});

describe("the real tree", () => {
  const run = (...args: string[]) => Bun.spawnSync(["bun", "rules/progress.ts", ...args], { cwd: `${import.meta.dir}/../..` });

  test("prints five columns, a total and the six milestones, and the Sepolia run is unchecked", () => {
    const done = run();
    const out = done.stdout.toString();
    expect(done.exitCode).toBe(0);
    ["Arrival", "Quint", "ts code", "contracts", "walk", "Total"].forEach((label) => expect(out).toContain(label));
    expect(out).toContain("[unchecked] End-to-end run on Sepolia");
    expect(out.split("\n").filter((line) => /^\[(done|not done|unchecked)\]/.test(line))).toHaveLength(6);
  });
  test("--since HEAD adds no rules; a ref that is not there is an error, never an empty answer", () => {
    expect(run("--since", "HEAD").stdout.toString()).toContain("0 rules added");
    const missing = run("--since", "no-such-ref-anywhere");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("no-such-ref-anywhere");
  });
  test("an unknown argument is an error", () => expect(run("--bogus").exitCode).toBe(1));
});
