// R-HOP-SLACK through a Runtime (runtime/tick.ts): the second of the J block at the view reaches the Entities with
// the height (or the Setup), so a hub that hosts the next hop forwards only if the seconds leave room. One Runtime
// hosts Alice, a hub and Bob, and what leaves one Entity is told to the next as the Host would.
import { describe, expect, test } from "bun:test";
import { holdId } from "../../account/model.ts";
import { ledgerOf } from "../../account/state.ts";
import { clockParams } from "../../account/clause/clock.ts";
import { heightOf } from "../../account/fixtures.ts";
import { credit, entityOf, GOLD, open, TEST_SIG } from "../fixtures.ts";
import { emptyEntity, type EntityId, type EntityState } from "../model.ts";
import { keccakHex } from "../../kernel/encoding/bytes.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import type { Input, Runtime, Setup } from "../../runtime/model.ts";
import { heightAt, inputFor, setup, tick } from "../../runtime/fixtures.ts";
import { startRuntime } from "../../runtime/tick.ts";

const ALICE = entityOf(1);
const HUB = entityOf(2);
const BOB = entityOf(3);
const HASHLOCK = keccakHex(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const clock = unwrapOr(
  clockParams(2n, 5n, 100n, 1n, { slot: 12n, missed: 1n, pollDelay: 2n }),
  (fault) => expect.unreachable(`refused: ${fault._tag}`),
);

/** One input to the Runtime, and then every message that leaves it, until none does. */
const step = (rt: Runtime, input: Input): Runtime => {
  const ticked = tick(rt, input);
  return ticked.leaving.reduce((acc, out) =>
    step(acc, inputFor(out.to, 1n, { _tag: "peer_message", from: out.from, msg: out.msg, sig: TEST_SIG })),
  ticked.runtime);
};

const entityAt = (rt: Runtime, id: EntityId): EntityState => rt.entities.get(id) ?? expect.unreachable("no entity");

/** Alice's lock to the hub, due at `deadline`, forwarded to Bob if the hub's Runtime knows the seconds of its view. */
const locked = (from: Setup, heights: readonly Input[], deadline: bigint): Runtime => {
  const links = [[ALICE, HUB], [HUB, ALICE], [HUB, BOB], [BOB, HUB]] as const;
  const started = startRuntime(from, [ALICE, HUB, BOB].map(emptyEntity));
  const opened = links.reduce((rt, [self, peer]) => step(rt, inputFor(self, 1n, open(peer))), started);
  const credited = links.reduce((rt, [self, peer]) => step(rt, inputFor(self, 1n, credit(peer, 1000n))), opened);
  const routed = step(credited, inputFor(HUB, 1n, { _tag: "forward", hashlock: HASHLOCK, from: ALICE, to: BOB }));
  const risen = heights.reduce(step, routed);
  const side = entityAt(risen, ALICE).accounts.get(HUB)?.side ?? expect.unreachable("no account");
  const hold = { id: holdId(1n), payer: side, amount: 10n, hashlock: HASHLOCK, deadline: heightOf(deadline) };
  return step(risen, inputFor(ALICE, 1n, { _tag: "lock", peer: HUB, token: GOLD, hold }));
};

const onward = (rt: Runtime): number =>
  ledgerOf(entityAt(rt, HUB).accounts.get(BOB)?.state ?? expect.unreachable("no account"), GOLD).holds.length;

/** The tests' time map is 1000 s plus 12 s a height: the block at height 100 is at second 2200. */
const paced: Setup = { ...setup, clock };

describe("runtime/slack the second of the view's block reaches the Entities (R-HOP-SLACK)", () => {
  test("R-HOP-SLACK a Runtime started with the second of its view forwards a lock whose claims fit", () => {
    expect(onward(locked({ ...paced, seconds: 2200n }, [], 110n))).toBe(1);
    expect(onward(locked({ ...paced, seconds: 2224n }, [], 110n))).toBe(0);
  });

  test("R-HOP-SLACK a Runtime that does not know the second of its view forwards nothing until a height does", () => {
    expect(onward(locked(paced, [], 110n))).toBe(0);
    expect(onward(locked(paced, [heightAt(1n, 101n, 2212n)], 111n))).toBe(1);
    expect(onward(locked(paced, [heightAt(1n, 101n, 2212n + 24n)], 111n))).toBe(0);
    expect(onward(locked(paced, [heightAt(1n, 101n)], 111n))).toBe(0);
  });

  test("R-HOP-SLACK the second of a block the view has passed is not taken back by a height that does not rise", () => {
    const heights = [heightAt(1n, 101n, 2212n), heightAt(2n, 101n, 9999n), heightAt(3n, 100n, 9999n)];
    expect(onward(locked(paced, heights, 111n))).toBe(1);
  });
});
