import { expect, test } from "bun:test";
import { unfired } from "./fired.ts";

const FIRED = {
  "P1:checked": 1, "P2:ledgers": 40, "P2:probeDirect": 1, "P2:probeLock": 1, "P2:probeHoldSame": 1, "P2:probeHold": 1,
  "P4:signatures": 6, "P4:heightPairs": 9, "P-BELIEF:accounts": 3, "P-BELIEF:atRest": 1,
};

test("every property firing in some walk of the area is clean", () => {
  expect(unfired("core", [{ "P1:skipped": 1, ...FIRED, "P1:checked": 0 }, { "P1:checked": 1 }, { ...FIRED }])).toEqual([]);
});

test("P1 skipped in every walk of an area is red, and names the property and the area", () => {
  const lines = unfired("settlement", [{ ...FIRED, "P1:checked": 0, "P1:skipped": 1 }, { ...FIRED, "P1:checked": 0 }]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("UNFIRED P1 on settlement");
});

test("a property whose counter never rose is red even when the others fired", () => {
  expect(unfired("model", [{ ...FIRED, "P4:heightPairs": 0 }]).join("\n")).toContain("UNFIRED P4 on model: P4:heightPairs");
  expect(unfired("model", [{ ...FIRED, "P-BELIEF:accounts": 0 }]).join("\n")).toContain("P-BELIEF");
});

test("a probe counter that never rose is red on its own, the property's other counters having fired", () => {
  const lines = unfired("core", [{ ...FIRED, "P2:probeHold": 0, "P2:probeLock": 0 }]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("UNFIRED P2 on core: P2:probeLock, P2:probeHold never rose");
});

test("a counter excused with a reason is not red, and only that counter in only that area", () => {
  expect(unfired("model", [{ ...FIRED, "P2:probeLock": 0, "P2:probeHoldSame": 0, "P2:probeHold": 0 }])).toEqual([]);
  expect(unfired("model", [{ ...FIRED, "P2:probeLock": 0, "P2:probeDirect": 0 }]).join("\n")).toContain("P2:probeDirect never rose");
  expect(unfired("core", [{ ...FIRED, "P2:probeLock": 0 }])).toHaveLength(1);
});

test("no walk at all fires nothing", () => {
  expect(unfired("lending", [])).toHaveLength(4);
});
