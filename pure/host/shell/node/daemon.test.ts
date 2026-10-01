// Two Runtimes on real loopback sockets, each with its WAL on a real file: the handshake, a frame both sides commit,
// and what a lost message or a dead peer costs (R-NODE, R-LINK-AUTH). The chain is a port that answers nothing, because
// none of these commands asks the chain for anything.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { err } from "../../../kernel/core/result.ts";
import type { Outbound } from "../../../entity/model.ts";
import { credit, GOLD, open, pay } from "../../../runtime/fixtures.ts";
import type { Disk } from "../disk/disk.ts";
import { MAX_LINE } from "../link/link.ts";
import {
  accountOf, ALICE, agree, BOB, connected, fresh, LOCAL, must, nodeOf, QUICK, SECOND, seatOf, sleep, slowChain, SLOW,
  until, WAIT,
} from "./scene.ts";
import { dialTcp } from "./socket.ts";

describe("host/shell/node two Runtimes over loopback sockets", () => {
  test("R-NODE nodes that are connected open an Account and commit a frame together, no tick awaited", async () => {
    const [a, b] = [await seatOf(ALICE, fresh(), 0), await seatOf(BOB, fresh(), 0)];
    const [alice, bob] = [await nodeOf(a, b, { tickMs: SLOW }), await nodeOf(b, a, { tickMs: SLOW })];
    expect(await until(() => connected(alice, bob), WAIT)).toBe(true);
    await alice.tell(open(BOB));
    await bob.tell(open(ALICE));
    await bob.tell(credit(ALICE, 100n));
    expect(await until(() => agree(alice, bob), WAIT)).toBe(true);
    await alice.tell(pay(BOB, 10n));
    expect(await until(() => agree(alice, bob, SECOND), WAIT)).toBe(true);
    const [la, lb] = [await alice.stop(), await bob.stop()];
    expect(la.refused).toEqual([]);
    expect(lb.refused).toEqual([]);
    expect(la.counts.sent).toBe(lb.counts.heard);
    expect(lb.counts.sent).toBe(la.counts.heard);
    expect(la.counts.heard).toBeGreaterThan(0);
  });

  test("R-NODE a frame the link lost on its way out is sent again by the timer", async () => {
    const [a, b] = [await seatOf(ALICE, fresh(), 0), await seatOf(BOB, fresh(), 0)];
    const arm = `${a.dir}/armed`;
    const lostLog = `${a.dir}/lost.log`;
    appendFileSync(lostLog, "");
    const lose = (m: Outbound): boolean => {
      const armed = existsSync(arm) && m.from === ALICE && readFileSync(lostLog, "utf8") === "";
      if (armed) appendFileSync(lostLog, "lost\n");
      return armed;
    };
    const [alice, bob] = [await nodeOf(a, b, { tickMs: QUICK, lost: lose }), await nodeOf(b, a, { tickMs: QUICK })];
    await alice.tell(open(BOB));
    await bob.tell(open(ALICE));
    await bob.tell(credit(ALICE, 100n));
    expect(await until(() => agree(alice, bob), WAIT)).toBe(true);
    const before = accountOf(await alice.look(), ALICE, BOB)?.head;
    writeFileSync(arm, "armed");
    await alice.tell({ _tag: "set_credit", peer: BOB, token: GOLD, limit: 7n });
    expect(await until(async () => accountOf(await alice.look(), ALICE, BOB)?.head !== before, WAIT)).toBe(true);
    expect(await until(() => agree(alice, bob), WAIT)).toBe(true);
    expect(readFileSync(lostLog, "utf8")).toBe("lost\n");
    const la = await alice.stop();
    await bob.stop();
    expect(la.counts.dropped).toBe(1);
  });

  test("R-NODE a peer that went away and came back from its WAL is dialed again and told what it missed", async () => {
    const [a, b] = [await seatOf(ALICE, fresh(), 0), await seatOf(BOB, fresh(), 0)];
    const [alice, bob] = [await nodeOf(a, b, { tickMs: QUICK }), await nodeOf(b, a, { tickMs: QUICK })];
    await alice.tell(open(BOB));
    await bob.tell(open(ALICE));
    await bob.tell(credit(ALICE, 100n));
    expect(await until(() => agree(alice, bob), WAIT)).toBe(true);
    await bob.stop();
    expect(await until(async () => (await alice.look()).linked.length === 0, WAIT)).toBe(true);
    await alice.tell({ _tag: "set_credit", peer: BOB, token: GOLD, limit: 9n });
    const again = await seatOf(BOB, b.dir, b.listener.port);
    const back = await nodeOf(again, a, { tickMs: QUICK });
    expect(await until(() => agree(alice, back), WAIT)).toBe(true);
    const mine = accountOf(await alice.look(), ALICE, BOB);
    expect(mine?.head).toBe(accountOf(await back.look(), BOB, ALICE)?.head);
    await alice.stop();
    await back.stop();
  });

  test("R-LINK-AUTH a connection that does not open with the handshake is closed, and only that one", async () => {
    const [a, b] = [await seatOf(ALICE, fresh(), 0), await seatOf(BOB, fresh(), 0)];
    const alice = await nodeOf(a, b, { tickMs: SLOW });
    const first = must(await dialTcp(LOCAL, a.listener.port, MAX_LINE));
    const second = must(await dialTcp(LOCAL, a.listener.port, MAX_LINE));
    await first.write("this is not a hello");
    expect(await first.next("")).toBeUndefined();
    expect((await alice.look()).refused).toHaveLength(1);
    await second.write("nor is this");
    expect(await second.next("")).toBeUndefined();
    const look = await alice.stop();
    expect(look.refused).toHaveLength(2);
    expect(look.counts.heard).toBe(0);
    b.listener.close();
  });

  test("R-LINK-AUTH what a node remembers of refused lines is bounded", async () => {
    const [a, b] = [await seatOf(ALICE, fresh(), 0), await seatOf(BOB, fresh(), 0)];
    const alice = await nodeOf(a, b, { tickMs: SLOW });
    const MANY = 70;
    await Promise.all(Array.from({ length: MANY }, async () => {
      const stranger = must(await dialTcp(LOCAL, a.listener.port, MAX_LINE));
      await stranger.write("not a hello");
      await stranger.next("");
    }));
    const look = await alice.stop();
    expect(look.refused.length).toBeGreaterThan(0);
    expect(look.refused.length).toBeLessThan(MANY);
    b.listener.close();
  });

  test("R-DURABLE a node whose WAL fails sends nothing more and answers every request with the fault", async () => {
    const [a, b] = [await seatOf(ALICE, fresh(), 0), await seatOf(BOB, fresh(), 0)];
    const full = `${a.dir}/full`;
    const failing = (disk: Disk): Disk => ({
      ...disk,
      run: (ops) =>
        (existsSync(full) ? Promise.resolve(err({ _tag: "disk", op: "write", reason: "full" })) : disk.run(ops)),
    });
    const [alice, bob] = [await nodeOf(a, b, { tickMs: QUICK, wrap: failing }), await nodeOf(b, a, { tickMs: QUICK })];
    await alice.tell(open(BOB));
    await bob.tell(open(ALICE));
    await bob.tell(credit(ALICE, 100n));
    expect(await until(() => agree(alice, bob), WAIT)).toBe(true);
    const sent = (await alice.look()).counts.sent;
    writeFileSync(full, "full");
    const first = await alice.tell(pay(BOB, 1n));
    const second = await alice.tell(pay(BOB, 2n));
    expect(first.ok ? "ok" : first.error._tag).toBe("disk");
    expect(second.ok ? "ok" : second.error._tag).toBe("disk");
    rmSync(full);
    const third = await alice.tell(pay(BOB, 3n));
    expect(third.ok ? "ok" : third.error._tag).toBe("disk");
    await sleep(100);
    const look = await alice.look();
    expect(look.fatal?._tag).toBe("disk");
    expect(look.counts.sent).toBe(sent);
    await alice.stop();
    await bob.stop();
  });

  test("R-NODE a node dials a peer that is not there yet and connects when the peer is", async () => {
    const [a, b] = [await seatOf(ALICE, fresh(), 0), await seatOf(BOB, fresh(), 0)];
    a.listener.close();
    const bob = await nodeOf(b, a, { tickMs: QUICK });
    await sleep(150);
    expect((await bob.look()).linked).toEqual([]);
    const alice = await nodeOf(await seatOf(ALICE, a.dir, a.listener.port), b, { tickMs: QUICK });
    expect(await until(() => connected(alice, bob), WAIT)).toBe(true);
    await alice.stop();
    await bob.stop();
  });

  test("R-NODE a batch the chain has not answered is read again at each tick until it lands", async () => {
    const [a, b] = [await seatOf(ALICE, fresh(), 0), await seatOf(BOB, fresh(), 0)];
    const log = `${a.dir}/chain.log`;
    appendFileSync(log, "");
    const alice = await nodeOf(a, b, { tickMs: QUICK, chain: slowChain(log) });
    await alice.tell({ _tag: "fund", token: GOLD, amount: 25n });
    expect((await alice.look()).busy).toBe(true);
    expect(await until(async () => !(await alice.look()).busy, WAIT)).toBe(true);
    await alice.stop();
    b.listener.close();
  });
});
