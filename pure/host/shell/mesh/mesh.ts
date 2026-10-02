// The Host's connections to its peers, as data (Q-T-4, Q-T-5, R-LINK-AUTH). A connection is whatever carries lines of
// text between two Runtimes; this module knows nothing of sockets. It keeps one `Link` per connection, takes a line
// that arrived on one and says what to write back, and takes the messages the Host sends and says which connection
// each goes to. A line that is not the peer's, or not in order, ends its connection and no more: the Host is never
// told, because a message that is not authenticated is not a message (R-LINK-AUTH).
//
// The Runtime with the smaller id dials, the other listens, so a pair has one connection to make. A message for a
// peer that has no connection up is dropped: the link promises nothing, and the Account's own resend (the Host's
// `resend_due` timer) is what sends a lost frame again.
import type { Outbound } from "../../../entity/model.ts";
import { mapDelete, mapSet } from "../../../kernel/core/collections.ts";
import { err, ok, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import type { Host, HostNotice } from "../../model.ts";
import {
  accept, answer, dial, finish, hear, seal, type Key, type Link, type LinkFault, type Peer, type RuntimeId,
} from "../link/link.ts";

export type ConnId = number;

/** An accepted connection has said nothing yet: it is `fresh` until its hello is read. */
type Conn = Link | Tagged<"fresh">;

/** `table` is static: who the peers are, which Entities each speaks for, and where each is (Q-T-4). */
export type Mesh = Readonly<{ self: Key; table: readonly Peer[]; conns: ReadonlyMap<ConnId, Conn> }>;

export const startMesh = (self: Key, table: readonly Peer[]): Mesh => ({ self, table, conns: new Map() });

/** A line to write on a connection. */
export type Write = Readonly<{ conn: ConnId; text: string }>;

const withConn = (mesh: Mesh, conn: ConnId, state: Conn): Mesh =>
  ({ ...mesh, conns: mapSet(mesh.conns, conn, state) });

/** The pair is dialed by the Runtime with the smaller id: the one connection both sides agree to make. */
export const dials = (mesh: Mesh, peer: Peer): boolean => mesh.self.runtime < peer.runtime;

/** The peers this Runtime dials, which are the ones that are not up. */
export const wanted = (mesh: Mesh): readonly Peer[] =>
  mesh.table.filter((peer) => dials(mesh, peer) && !linked(mesh).includes(peer.runtime));

/** A connection this Runtime opened to `peer`: the hello to write on it. */
export const dialed = (
  mesh: Mesh, peer: Peer, conn: ConnId, nonce: Uint8Array,
): Readonly<{ mesh: Mesh; write: Write }> => {
  const hello = dial(mesh.self, peer, nonce);
  return { mesh: withConn(mesh, conn, hello.link), write: { conn, text: hello.hello } };
};

/** A connection a peer opened to this Runtime. */
export const accepted = (mesh: Mesh, conn: ConnId): Mesh => withConn(mesh, conn, { _tag: "fresh" });

/** The connection is gone, from either end. */
export const closed = (mesh: Mesh, conn: ConnId): Mesh =>
  ({ ...mesh, conns: mapDelete(mesh.conns, conn) });

/** A line the peer's Runtime did not send as its own: its connection is to be closed, and nothing is delivered. */
export type Refused = Tagged<"refused", { conn: ConnId; fault: LinkFault | Tagged<"unknown_conn"> }>;

export type Heard = Readonly<{
  mesh: Mesh; host: Host; notices: readonly HostNotice[]; write: Write | undefined; delivered: boolean;
}>;

const stayed = (mesh: Mesh, host: Host, write?: Write): Heard =>
  ({ mesh, host, notices: [], write, delivered: false });

const refused = (conn: ConnId, fault: Refused["fault"]): Result<never, Refused> =>
  err({ _tag: "refused", conn, fault });

/**
 * A line that arrived on `conn`. Before the link is up it is a step of the handshake (`nonce` is the fresh challenge
 * a responder gives); after, it is a record sealed to the proof, opened as the peer's own and handed to the Host.
 */
export const line = (
  mesh: Mesh, host: Host, conn: ConnId, text: string, nonce: Uint8Array,
): Result<Heard, Refused> => {
  const state = mesh.conns.get(conn);
  if (state === undefined) return refused(conn, { _tag: "unknown_conn" });
  switch (state._tag) {
    case "fresh": {
      const heard = answer(mesh.self, mesh.table, nonce, text);
      return heard.ok
        ? ok(stayed(withConn(mesh, conn, heard.value.link), host, { conn, text: heard.value.reply }))
        : refused(conn, heard.error);
    }
    case "dialing": {
      const finished = finish(state, text);
      return finished.ok
        ? ok(stayed(withConn(mesh, conn, finished.value.link), host, { conn, text: finished.value.finish }))
        : refused(conn, finished.error);
    }
    case "answered": {
      const up = accept(state, text);
      return up.ok ? ok(stayed(withConn(mesh, conn, up.value), host)) : refused(conn, up.error);
    }
    case "up": {
      const heard = hear(host, state, text);
      return heard.ok
        ? ok({ mesh: withConn(mesh, conn, heard.value.link), host: heard.value.host, notices: heard.value.notices,
          write: undefined, delivered: true })
        : refused(conn, heard.error);
    }
  }
};

/** The Runtimes whose link is up. */
export const linked = (mesh: Mesh): readonly RuntimeId[] =>
  [...mesh.conns.values()].flatMap((state) => (state._tag === "up" ? [state.session.peer.runtime] : []));

type Up = Readonly<{ conn: ConnId; link: Link }>;

const NO_UP: Up | undefined = undefined;

/** The connection a peer's messages go to: its newest one that is up. */
const upTo = (mesh: Mesh, runtime: RuntimeId): Up | undefined =>
  [...mesh.conns].reduce<Up | undefined>((newest, [conn, link]) =>
    (link._tag === "up" && link.session.peer.runtime === runtime && (newest === undefined || conn > newest.conn)
      ? { conn, link }
      : newest), NO_UP);

export type Routed = Readonly<{ mesh: Mesh; writes: readonly Write[]; dropped: readonly Outbound[] }>;

const toward = (mesh: Mesh, message: Outbound): Peer | undefined =>
  mesh.table.find((peer) => peer.entities.includes(message.to));

const dropped = (routed: Routed, message: Outbound): Routed =>
  ({ ...routed, dropped: [...routed.dropped, message] });

const sealedOn = (routed: Routed, up: Up, message: Outbound): Routed => {
  const sealed = seal(up.link, message);
  return sealed.ok
    ? { mesh: withConn(routed.mesh, up.conn, sealed.value.link), dropped: routed.dropped,
      writes: [...routed.writes, { conn: up.conn, text: sealed.value.data }] }
    : dropped(routed, message);
};

/** The Host's messages, each sealed for its peer's connection. One that has no connection up is dropped, and said. */
export const route = (mesh: Mesh, messages: readonly Outbound[]): Routed =>
  messages.reduce<Routed>((routed, message) => {
    const peer = toward(routed.mesh, message);
    const up = peer === undefined ? undefined : upTo(routed.mesh, peer.runtime);
    return up === undefined ? dropped(routed, message) : sealedOn(routed, up, message);
  }, { mesh, writes: [], dropped: [] });
