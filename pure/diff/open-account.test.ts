// openAccount refusals through the runtime loop: og's handler throws a plain Error, which halts og's Runtime, so the
// rewrite must refuse the same frame with og's exact text (the lane compares it). A mixed-case target is not a
// refusal: og keys the Account by the lowercase id and commits. Seed 0xc0ffe7 frame 5 first showed the duplicate.
import { describe, expect, test } from "bun:test";
import { HUB, openWorld, type World } from "./world.ts";
import type { EntityId, EntityTx } from "../xln.ts";

type Case = {
  readonly name: string;
  /** The open Entity 0 authors, from the world after the hub Accounts are open. */
  readonly open: (w: World) => EntityTx;
  /** How og's halt text starts, or `commits` when og commits the frame. */
  readonly og: string;
};
const toward = (w: World, target: string): EntityTx => {
  const base = w.open(0, 2, 5n);
  return { ...base, data: { ...base.data, targetEntityId: target as EntityId } } as EntityTx;
};
const CASES: readonly Case[] = [
  { name: "an Account that exists", open: (w) => w.open(0, HUB, 5n), og: "OPEN_ACCOUNT_ALREADY_EXISTS: entity=" },
  { name: "a target that is no bytes32 id", open: (w) => toward(w, "0x12"), og: "INVALID_ENTITY_ID: openAccount" },
  { name: "the Entity itself", open: (w) => toward(w, w.ids[0]!), og: "ACCOUNT_AUTHORITY_ENTITY_STAGE_APPLY_DISCARD_FAILED" },
  { name: "a mixed-case target", open: (w) => toward(w, `0x${w.ids[2]!.slice(2).toUpperCase()}`), og: "commits" },
];

describe("openAccount refusals, og processRuntime vs the rewrite", () => {
  CASES.forEach(({ name, open, og }) =>
    test(`MATCH (og open-account.ts): ${name}`, async () => {
      const w = await openWorld(0x0a11, `open-${name.replaceAll(" ", "-")}`);
      try {
        const [imports, opens] = w.importAll();
        expect(await w.lane.tick(imports, [])).toEqual([]);
        expect(await w.lane.tick([], opens)).toEqual([]);
        expect(await w.lane.tick([], [w.user(0, [open(w)])])).toEqual([]);
        const texts = w.coverage.haltTexts;
        if (og === "commits") expect(texts).toEqual([]);
        else expect(texts.map((t) => t.slice(0, og.length))).toEqual([og]);
      } finally {
        await w.close();
      }
    }, 300_000));
});
