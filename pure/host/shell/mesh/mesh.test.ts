// The connections of a Host, as data: a handshake in lines, a message routed to the connection of its peer, a line that
// is not the peer's refused, and the one dial a pair needs. Two meshes and two real Hosts, no socket.
import { describe, expect, test } from "bun:test";
import type { Outbound } from "../../../entity/model.ts";
import { unwrapOr } from "../../../kernel/core/result.ts";
import { entityOf, hostFor } from "../../fixtures.ts";
import type { Host } from "../../model.ts";
import { keyOf, type Key, type Peer } from "../link/link.ts";
import { accepted, closed, dialed, dials, line, linked, route, startMesh, wanted, type Mesh } from "./mesh.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const keyFrom = (n: number): Key =>
  unwrapOr(keyOf(Uint8Array.from({ length: 32 }, () => n)), () => expect.unreachable("key"));

const [LOW, HIGH] = [keyFrom(1), keyFrom(2)].toSorted((a, b) => (a.runtime < b.runtime ? -1 : 1)) as [Key, Key];

const peer = (key: Key, ...entities: Peer["entities"]): Peer => ({ runtime: key.runtime, entities, endpoint: "tcp" });
const TABLE = [peer(LOW, ALICE), peer(HIGH, BOB)];

const nonce = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, () => n);

const must = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T =>
  (r.ok ? r.value : expect.unreachable(`unexpected ${JSON.stringify(r.error)}`));

type Side = Readonly<{ mesh: Mesh; host: Host }>;

/** Alice (the lower runtime, who dials) and Bob over connection 1 on both ends, handshake done. */
const connected = (): Readonly<{ alice: Side; bob: Side }> => {
  const alice0 = { mesh: startMesh(LOW, TABLE), host: hostFor(ALICE) };
  const bob0 = { mesh: accepted(startMesh(HIGH, TABLE), 1), host: hostFor(BOB) };
  const hello = dialed(alice0.mesh, TABLE[1] as Peer, 1, nonce(1));
  const reply = must(line(bob0.mesh, bob0.host, 1, hello.write.text, nonce(2)));
  const finish = must(line(hello.mesh, alice0.host, 1, reply.write?.text ?? "", nonce(3)));
  const bob = must(line(reply.mesh, bob0.host, 1, finish.write?.text ?? "", nonce(4)));
  return { alice: { mesh: finish.mesh, host: alice0.host }, bob: { mesh: bob.mesh, host: bob0.host } };
};

const ack = (from: Outbound["from"], to: Outbound["to"]): Outbound =>
  ({ from, to, msg: { _tag: "ack", hash: `0x${"cd".repeat(32)}` as never } });

describe("host/shell/mesh a pair of Runtimes connects once, from the lower id", () => {
  test("R-MESH only the Runtime with the smaller id dials, and a peer that is not up is wanted", () => {
    expect(dials(startMesh(LOW, TABLE), TABLE[1] as Peer)).toBe(true);
    expect(dials(startMesh(HIGH, TABLE), TABLE[0] as Peer)).toBe(false);
    expect(wanted(startMesh(LOW, TABLE)).map((p) => p.runtime)).toEqual([HIGH.runtime]);
    expect(wanted(startMesh(HIGH, TABLE))).toEqual([]);
  });

  test("R-MESH a handshake in lines leaves both ends up, and a closed connection is wanted again", () => {
    const { alice, bob } = connected();
    expect(linked(alice.mesh)).toEqual([HIGH.runtime]);
    expect(linked(bob.mesh)).toEqual([LOW.runtime]);
    expect(wanted(alice.mesh)).toEqual([]);
    const gone = closed(alice.mesh, 1);
    expect(linked(gone)).toEqual([]);
    expect(wanted(gone).map((p) => p.runtime)).toEqual([HIGH.runtime]);
  });
});

describe("host/shell/mesh a message goes to the connection of the peer that speaks for its Entity", () => {
  test("R-MESH a message is sealed on the peer's connection, and arrives at the peer's Host from the peer", () => {
    const { alice, bob } = connected();
    const routed = route(alice.mesh, [ack(ALICE, BOB)]);
    expect(routed.dropped).toEqual([]);
    expect(routed.writes.map((w) => w.conn)).toEqual([1]);
    const heard = must(line(bob.mesh, bob.host, 1, routed.writes[0]?.text ?? "", nonce(5)));
    expect(heard.delivered).toBe(true);
    expect(heard.host.queue).toHaveLength(1);
    expect(heard.host.queue[0]).toMatchObject({ to: BOB, input: { _tag: "peer_message", from: ALICE } });
  });

  test("R-MESH a message for a peer not up, or for an Entity no peer speaks for, is dropped and said", () => {
    const alone = startMesh(LOW, TABLE);
    expect(route(alone, [ack(ALICE, BOB)]).dropped).toEqual([ack(ALICE, BOB)]);
    const { alice } = connected();
    const stranger = ack(ALICE, entityOf(9));
    expect(route(alice.mesh, [stranger]).dropped).toEqual([stranger]);
  });

  test("R-LINK-AUTH a record that is altered, repeated, or sent before the handshake is refused", () => {
    const { alice, bob } = connected();
    const text = route(alice.mesh, [ack(ALICE, BOB)]).writes[0]?.text ?? "";
    const altered = text.replace("data", "dat4");
    expect(line(bob.mesh, bob.host, 1, altered, nonce(6))).toMatchObject({ ok: false, error: { conn: 1 } });
    const first = must(line(bob.mesh, bob.host, 1, text, nonce(6)));
    expect(line(first.mesh, first.host, 1, text, nonce(7)))
      .toMatchObject({ ok: false, error: { fault: { _tag: "replay" } } });
    const fresh = accepted(startMesh(HIGH, TABLE), 2);
    expect(line(fresh, bob.host, 2, text, nonce(8))).toMatchObject({ ok: false, error: { conn: 2 } });
    expect(line(fresh, bob.host, 3, text, nonce(8)))
      .toMatchObject({ ok: false, error: { fault: { _tag: "unknown_conn" } } });
  });
});
