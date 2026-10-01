// The socket as lines: a line is whatever ends in a newline, however the bytes are cut; a peer that never sends one is
// cut off at the bound; a peer that goes away ends the read; and a port nobody listens on is a fault, not a throw.
import { describe, expect, test } from "bun:test";
import { dialTcp, listenTcp, type Wire } from "./socket.ts";

const HOST = "127.0.0.1";

const pair = async (max: number): Promise<Readonly<{ near: Wire; far: Wire; close: () => void }>> => {
  const listener = await listenTcp(HOST, 0, max);
  if (!listener.ok) return expect.unreachable("listen");
  const arriving = listener.value.accept();
  const dialed = await dialTcp(HOST, listener.value.port, max);
  const far = await arriving;
  if (!dialed.ok || far === undefined) return expect.unreachable("connect");
  return { near: dialed.value, far, close: () => { dialed.value.close(); far.close(); listener.value.close(); } };
};

describe("host/shell/node a TCP connection carries lines", () => {
  test("R-X1 lines arrive whole and in order, and a write that holds a newline is two lines", async () => {
    const { near, far, close } = await pair(1024);
    expect(await near.write("one")).toEqual({ ok: true, value: undefined });
    await near.write("two\nthr");
    await near.write("ee");
    const first = await far.next("");
    const second = await far.next(first?.rest ?? "");
    expect(first?.line).toBe("one");
    expect(second?.line).toBe("two");
    const third = await far.next(second?.rest ?? "");
    expect(third?.line).toBe("thr");
    expect((await far.next(third?.rest ?? ""))?.line).toBe("ee");
    const back = await far.write("héllo ✓");
    expect(back.ok).toBe(true);
    expect((await near.next(""))?.line).toBe("héllo ✓");
    close();
  });

  test("R-X1 a line over the bound is cut off, and a peer that goes away ends the read", async () => {
    const { near, far, close } = await pair(16);
    await near.write("x".repeat(64));
    expect(await far.next("")).toBeUndefined();
    far.close();
    expect(await near.next("")).toBeUndefined();
    close();
  });

  test("R-X1 a port nobody listens on is a fault the caller reads, not a throw", async () => {
    const listener = await listenTcp(HOST, 0, 16);
    if (!listener.ok) return expect.unreachable("listen");
    const { port } = listener.value;
    listener.value.close();
    await listener.value.accept();
    expect(await dialTcp(HOST, port, 16)).toMatchObject({ ok: false, error: { _tag: "socket" } });
  });
});
