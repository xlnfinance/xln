// An id is what the chain's account key is made of: its text order must be its numeric order, so one spelling only.
import { describe, expect, test } from "bun:test";
import { entityOf } from "./fixtures.ts";
import { entityId, sideOf } from "./model.ts";

describe("entity/model ids", () => {
  const upper = `0x${"A".repeat(64)}`;

  test("an id has one spelling: 0x and 64 lowercase hex digits, no more, no fewer, no capitals", () => {
    expect(entityId(entityOf(7)).ok).toBe(true);
    expect(entityId(upper)).toEqual({ ok: false, error: { _tag: "bad_entity_id", text: upper } });
    expect(entityId(`0x${"a".repeat(63)}`).ok).toBe(false);
    expect(entityId(`0x${"a".repeat(65)}`).ok).toBe(false);
    expect(entityId(`0X${"a".repeat(64)}`).ok).toBe(false);
  });

  test("the text order of two ids is their numeric order, so the Left of a pair is the same on both ends", () => {
    expect(sideOf(entityOf(10), entityOf(255))).toBe("left");
    expect(sideOf(entityOf(255), entityOf(10))).toBe("right");
  });
});
