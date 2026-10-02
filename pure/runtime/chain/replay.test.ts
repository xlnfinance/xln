// Review A of PR 99: a replay sees every field of the chain actions this slice adds. A row whose deposit or counter
// names another peer, token, amount, nonce or head does not replay: the Runtime halts on it (R-DURABLE).
import { describe, expect, test } from "bun:test";
import { tokenOf, viewOf } from "../../account/fixtures.ts";
import type { FrameHash } from "../../account/frame/frame.ts";
import { emptyEntity, type Command, type JAction, type PeerMessage } from "../../entity/model.ts";
import type { Row } from "../model.ts";
import { recover } from "../tick.ts";
import { type Cluster, credit, entityOf, feed, GOLD, hostOf, open, settle, start } from "../fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const CAROL = entityOf(3);

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const framed = (c: Cluster): Cluster => settle(feed(c, BOB, credit(ALICE, 100n)));
const atEpoch = (c: Cluster): Cluster => {
  const alice = feed(c, ALICE, { _tag: "j_epoch", peer: BOB, epoch: 1n, stored: 5n });
  return feed(alice, BOB, { _tag: "j_epoch", peer: ALICE, epoch: 1n, stored: 5n });
};

const deposit: Command = { _tag: "deposit", peer: BOB, token: GOLD, amount: 10n };
const deposited = feed(framed(opened), ALICE, deposit);
const started = feed(framed(opened), ALICE, { _tag: "dispute", peer: BOB });
const finalizing = feed(
  feed(started, ALICE, { _tag: "j_dispute", peer: BOB, epoch: 0n, by: "left", timeout: 500n }),
  ALICE, { _tag: "j_window_over", peer: BOB },
);
const countered = feed(
  framed(atEpoch(opened)), ALICE, { _tag: "j_dispute", peer: BOB, epoch: 1n, by: "right", timeout: 5n },
);

/** Alice's WAL with the actions of its last row changed as the test says; what the Runtime says of replaying it. */
const replayed = (c: Cluster, change: Partial<JAction>) => {
  const alice = hostOf(c, ALICE);
  const last = alice.wal.at(-1) ?? expect.unreachable("no row");
  const action = last.chain[0] ?? expect.unreachable("no action in the last row");
  const row = { ...last, chain: [{ ...action, ...change } as JAction] };
  return { height: last.height, result: recover(alice.setup, [emptyEntity(ALICE)], [...alice.wal.slice(0, -1), row]) };
};

const diverged = (height: bigint) => ({ ok: false as const, error: { _tag: "replay_diverged" as const, height } });

describe("runtime/chain replay review A: a replay sees every field of a deposit and of a counter", () => {
  test("control: the row as it was made replays", () => {
    expect(replayed(deposited, {}).result.ok).toBe(true);
    expect(replayed(countered, {}).result.ok).toBe(true);
    expect(replayed(started, {}).result.ok).toBe(true);
    expect(replayed(finalizing, {}).result.ok).toBe(true);
  });

  test.each([
    ["peer", { peer: CAROL }], ["token", { token: tokenOf(2n) }], ["amount", { amount: 11n }],
  ] as const)("R-DURABLE a WAL whose deposit names another %s does not replay", (_field, change) => {
    const { height, result } = replayed(deposited, change);
    expect(result).toEqual(diverged(height));
  });

  test("R-DURABLE a WAL whose dispute start names another peer, nonce, epoch, author or sig does not replay", () => {
    const changes = [
      { peer: CAROL }, { nonce: 99n }, { epoch: 9n }, { proposerIsLeft: true }, { sig: "0x7e58" },
    ] as const;
    changes.forEach((change) => {
      const { height, result } = replayed(started, change);
      expect(result).toEqual(diverged(height));
    });
  });

  test("R-DURABLE a WAL whose dispute start carries another proof body does not replay", () => {
    const row = hostOf(started, ALICE).wal.at(-1)?.chain[0];
    const body = row?._tag === "dispute_start" ? row.body : expect.unreachable("no dispute start");
    const { height, result } = replayed(started, { body: { ...body, offdeltas: [...body.offdeltas, 1n] } });
    expect(result).toEqual(diverged(height));
  });

  test("R-DURABLE a WAL whose dispute finalize names another peer, nonce, author, side or body does not replay", () => {
    const row = hostOf(finalizing, ALICE).wal.at(-1)?.chain[0];
    const ask = row?._tag === "dispute_finalize" ? row : expect.unreachable("no dispute finalize");
    const changes = [
      { peer: CAROL }, { nonce: 99n }, { proposerIsLeft: !ask.proposerIsLeft }, { startedByLeft: !ask.startedByLeft },
      { body: { ...ask.body, offdeltas: [...ask.body.offdeltas, 1n] } },
    ] as const;
    changes.forEach((change) => {
      const { height, result } = replayed(finalizing, change);
      expect(result).toEqual(diverged(height));
    });
  });

  test.each([
    ["peer", { peer: CAROL }], ["nonce", { nonce: 99n }], ["head", { head: `0x${"11".repeat(32)}` as FrameHash }],
  ] as const)("R-DURABLE a WAL whose counter names another %s does not replay", (_field, change) => {
    const { height, result } = replayed(countered, change);
    expect(result).toEqual(diverged(height));
  });
});

describe("runtime/chain replay R-SIGNED-HEADS-ON-THE-WIRE: a peer's signature is in the row that committed it", () => {
  const alice = hostOf(framed(opened), ALICE);
  const heardAPeer = (r: Row): boolean =>
    r.input._tag === "entity" && r.input.inputs.some((i) => i._tag === "peer_message");
  const row = alice.wal.findLast(heardAPeer) ?? expect.unreachable("no row heard a peer's message");

  const withSig = (i: PeerMessage, sig: string | undefined): PeerMessage =>
    (sig === undefined ? { _tag: i._tag, from: i.from, msg: i.msg } : { ...i, sig });

  /** The row with the signature on its peer messages changed by `sig`: replaying it is what the Runtime says. */
  const resigned = (sig: (s: string | undefined) => string | undefined) => {
    const { input: before } = row;
    const input = before._tag === "entity"
      ? { ...before, inputs: before.inputs.map((i) => (i._tag === "peer_message" ? withSig(i, sig(i.sig)) : i)) }
      : before;
    const wal = alice.wal.map((r) => (r === row ? { ...row, input } : r));
    return recover(alice.setup, [emptyEntity(ALICE)], wal);
  };

  test("R-DURABLE a restart keeps the proofs: the replay holds the peer's signature over the committed head", () => {
    const back = recover(alice.setup, [emptyEntity(ALICE)], alice.wal);
    const proofs = alice.entities.get(ALICE)?.proofs;
    expect(proofs?.size).toBeGreaterThan(0);
    expect(back.ok && back.value.entities.get(ALICE)?.proofs).toEqual(proofs);
  });

  test("R-DURABLE a WAL whose peer message lost its signature, or has another, does not replay", () => {
    expect(resigned((s) => s).ok).toBe(true);
    expect(resigned(() => undefined)).toEqual(diverged(row.height));
    expect(resigned(() => "0x7e58")).toEqual(diverged(row.height));
  });
});
