// The Host's op for an Entity's chain action: the deposit and the reveal an Entity asks for become the Depository's
// own ops, and the builder accepts them and encodes them as the contract reads them. The reveal is the one Bob's
// Runtime asks for in runtime/htlc/reveal.test.ts, taken out of a real WAL row.
import { describe, expect, test } from "bun:test";
import { holdOf, secretOf, tokenOf, viewOf } from "../account/fixtures.ts";
import { holdId } from "../account/model.ts";
import { encodeBatch } from "../chain/batch/batch.ts";
import type { Command, JAction } from "../entity/model.ts";
import { assemble } from "../j/op/assemble.ts";
import { openJBatch, queue } from "../j/batch/jbatch.ts";
import { credit, feed, GOLD, open, rise, settle, start } from "../runtime/fixtures.ts";
import { entityOf } from "./fixtures.ts";
import { opOf } from "./ops.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const WORLD = { transformer: "0x1111111111111111111111111111111111111111" };

const lockIn = (id: bigint, deadline: bigint): Command =>
  ({ _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 30n, id, deadline, 1) });

const resolveOf = (id: bigint): Command =>
  ({ _tag: "resolve", peer: ALICE, token: GOLD, id: holdId(id), secret: secretOf(1) });

const unacked = feed(
  settle(feed(settle(feed(settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE))), BOB, credit(ALICE, 100n))), ALICE, lockIn(1n, 115n))),
  BOB, resolveOf(1n),
);

const asked = rise(unacked, BOB, 114n).chain;

const deposit: JAction = { _tag: "deposit", peer: BOB, token: GOLD, amount: 40n };

describe("host/ops an Entity's action is the Depository's op", () => {
  test("a deposit funds the Account of the asker with its peer, from the asker's own reserve", () => {
    expect(opOf(ALICE, deposit, WORLD)).toEqual({
      ok: true,
      value: {
        _tag: "reserve_to_collateral",
        funding: { tokenId: GOLD, receivingEntity: ALICE, pairs: [{ entity: BOB, amount: 40n }] },
      },
    });
  });

  test("R-HTLC-CLOCK the reveal Bob's Runtime asks for becomes a revealSecrets op of the canonical transformer", () => {
    const reveal = asked[0] ?? expect.unreachable("no reveal asked");
    expect(reveal._tag).toBe("reveal");
    expect(opOf(BOB, reveal, WORLD)).toEqual({
      ok: true, value: { _tag: "reveal_secret", reveal: { transformer: WORLD.transformer, secret: `0x${"01".repeat(32)}` } },
    });
  });

  test("the builder queues what the Host made, and the batch encodes", () => {
    const ops = [deposit, ...asked].map((a) => {
      const made = opOf(BOB, a, WORLD);
      return made.ok ? made.value : expect.unreachable("no op");
    });
    const queued = ops.reduce((j, op) => {
      const out = queue(j, op);
      return out._tag === "queued" ? out.jbatch : expect.unreachable(`not queued: ${out._tag}`);
    }, openJBatch(BOB, 0n));
    expect(queued.draft).toEqual(ops);
    expect(encodeBatch(assemble(500_000n, ops)).ok).toBe(true);
  });

  test("a counter, a C2R and a settlement hold signed material the Entity does not keep: named, not made", () => {
    const needing: readonly JAction[] = [
      { _tag: "counter", peer: BOB, nonce: 3n, head: `0x${"00".repeat(32)}` as never },
      { _tag: "c2r", peer: BOB, serial: 1n, token: GOLD, amount: 1n },
      { _tag: "settle", peer: BOB, serial: 1n, token: GOLD, amount: 1n, folds: [] },
    ];
    expect(needing.map((a) => opOf(ALICE, a, WORLD))).toEqual(
      needing.map((a) => ({ ok: false, error: { _tag: "needs_signature", action: a._tag } })),
    );
  });

  test("a deposit of token 7 names token 7 in the funding, not the faucet token's id", () => {
    expect(opOf(ALICE, { _tag: "deposit", peer: BOB, token: tokenOf(7n), amount: 5n }, WORLD)).toEqual({
      ok: true,
      value: { _tag: "reserve_to_collateral", funding: { tokenId: 7n, receivingEntity: ALICE, pairs: [{ entity: BOB, amount: 5n }] } },
    });
  });

  test("a reveal carries the secret's 32 bytes in their order", () => {
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const reveal: JAction = { _tag: "reveal", peer: BOB, token: GOLD, id: holdId(1n), hashlock: "0x00", secret };
    const made = opOf(BOB, reveal, WORLD);
    const hex = Array.from(secret, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(made.ok && made.value._tag === "reveal_secret" ? made.value.reveal.secret : "no op").toBe(`0x${hex}`);
  });
});
