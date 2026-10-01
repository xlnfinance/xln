// The harness's own guards, run by `bun test testnet-e2e` (not part of the one gate): it sends transactions only to a
// loopback node, its exit code says how far from green a run is, and a step goes red when the piece it waits on lands.
import { describe, expect, test } from "bun:test";
import { isLoopback, assertLoopback } from "./lib/anvil.ts";
import { GAPS, type Gap, type GapKey } from "./lib/gaps.ts";
import { exitCode, gapsInMoneyOrder, renderReport, type StepResult } from "./lib/report.ts";
import { Blocked, runStep, type Step } from "./lib/runner.ts";

const step = (status: StepResult["status"], gaps: readonly GapKey[] = []): StepResult =>
  ({ id: status, title: status, status, checks: [], gaps, problem: null });

describe("loopback only", () => {
  test("a node on this machine may receive transactions", () => {
    ["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545"].forEach((url) => expect(isLoopback(url)).toBe(true));
  });
  test("public Sepolia, a lookalike host and junk are refused", () => {
    ["https://ethereum-sepolia-rpc.publicnode.com", "http://127.0.0.1.example.com", "http://10.0.0.5:8545", "not a url", ""]
      .forEach((url) => expect(isLoopback(url)).toBe(false));
    expect(() => assertLoopback("https://rpc.sepolia.org")).toThrow(/loopback/);
  });
});

describe("exit code", () => {
  test("0 only when every step is done", () => {
    expect(exitCode([step("done"), step("done")])).toBe(0);
    expect(exitCode([step("done"), step("scaffolded")])).toBe(1);
    expect(exitCode([step("done"), step("blocked")])).toBe(1);
    expect(exitCode([step("skipped")])).toBe(1);
  });
  test("a failed check is 2 whatever else ran", () => {
    expect(exitCode([step("blocked"), step("failed")])).toBe(2);
  });
});

const fake = (landed: boolean): Record<GapKey, Gap> =>
  Object.fromEntries(Object.entries(GAPS).map(([k, g]) => [k, { ...g, landed: () => landed }])) as Record<GapKey, Gap>;

const ok = (gaps: readonly GapKey[]): Step<null> => ({ id: "s", title: "s", needs: [], run: async () => ({ checks: [], gaps }) });
const stops = (gaps: readonly GapKey[]): Step<null> =>
  ({ id: "s", title: "s", needs: [], run: async () => { throw new Blocked(gaps, "missing"); } });

describe("a step judges itself", () => {
  test("a step with no stand-in is done, with one it is scaffolded, a stop is blocked", async () => {
    expect((await runStep(null, new Map(), ok([]), fake(false))).status).toBe("done");
    expect((await runStep(null, new Map(), ok(["jLoop"]), fake(false))).status).toBe("scaffolded");
    expect((await runStep(null, new Map(), stops(["entitySwapCommands"]), fake(false))).status).toBe("blocked");
  });
  test("a stand-in whose supplier has landed turns the step red", async () => {
    const result = await runStep(null, new Map(), ok(["jLoop"]), fake(true));
    expect(result.status).toBe("failed");
    expect(result.problem).toMatch(/tripwire/);
  });
  test("a blocked step turns red only when nothing it waits on is missing any more", async () => {
    const half = { ...fake(false), entitySwapCommands: { ...GAPS.entitySwapCommands, landed: () => true } };
    expect((await runStep(null, new Map(), stops(["entitySwapCommands", "hubMatching"]), half)).status).toBe("blocked");
    expect((await runStep(null, new Map(), stops(["entitySwapCommands", "hubMatching"]), fake(true))).status).toBe("failed");
  });
  test("a step whose predecessor did not finish is skipped, not run", async () => {
    const done = new Map([["fork", step("failed")]]);
    const result = await runStep(null, done, { ...ok([]), needs: ["fork"] }, fake(false));
    expect(result.status).toBe("skipped");
  });
  test("a thrown check is a failure with its message", async () => {
    const boom: Step<null> = { id: "s", title: "s", needs: [], run: async () => { throw new Error("payout 1 is not 2"); } };
    expect(await runStep(null, new Map(), boom, fake(false))).toMatchObject({ status: "failed", problem: "payout 1 is not 2" });
  });
});

describe("report", () => {
  test("missing pieces come in the order the first step needs them, once each", () => {
    const rows = gapsInMoneyOrder([step("done", ["jLoop"]), step("blocked", ["entitySwapCommands", "jLoop"])]);
    expect(rows.map(([g]) => g.id)).toEqual(["j-loop", "entity-swap-commands"]);
    expect(rows[0]![1]).toEqual(["done", "blocked"]);
  });
  test("every gap names who is expected to supply it", () => {
    Object.values(GAPS).forEach((g) => { expect(g.supplier.length).toBeGreaterThan(10); expect(g.piece.length).toBeGreaterThan(30); });
  });
  test("the report states the exit code and lists the steps in order", () => {
    const text = renderReport({ head: "abc", mode: "m", chainId: "1", block: "2", startedAt: "t", seconds: 1 }, [step("done"), step("blocked", ["entitySwapCommands"])]);
    expect(text).toContain("Exit 1");
    expect(text.indexOf("S0")).toBeLessThan(text.indexOf("S1"));
    expect(text).toContain("entity-swap-commands");
  });
});
