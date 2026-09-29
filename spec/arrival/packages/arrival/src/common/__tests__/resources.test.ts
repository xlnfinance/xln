// resources — the ResourceCell factory: lazy / single-flight / reconstruct / abort.
import { describe, expect, it, vi } from "vitest";

import { port, Resource, ResourceCell } from "../resources.js";

interface Socket {
  id: number;
  closed: boolean;
}

function countingSocket(): { resource: Resource<Socket>; opens: () => number; closes: () => number } {
  let opened = 0;
  let closed = 0;
  const resource: Resource<Socket> = {
    kind: "socket",
    acquire: async () => {
      const s: Socket = { id: ++opened, closed: false };
      return port(s, () => {
        s.closed = true;
        closed++;
      });
    },
  };
  return { resource, opens: () => opened, closes: () => closed };
}

const armed = () => new AbortController().signal;

describe("ResourceCell — the port factory", () => {
  it("is LAZY: no acquire until first get()", async () => {
    const { resource, opens } = countingSocket();
    const cell = new ResourceCell(resource);
    await cell.spinUp(armed()); // eager=false
    expect(opens()).toBe(0);
    expect(cell.isLive).toBe(false);
    expect(cell.peek()).toBeUndefined();

    const h = await cell.get();
    expect(opens()).toBe(1);
    expect(h.id).toBe(1);
    expect(cell.isLive).toBe(true);
  });

  it("is SINGLE-FLIGHT: N concurrent get()s share ONE acquire", async () => {
    const { resource, opens } = countingSocket();
    const cell = new ResourceCell(resource);
    const [a, b, c] = await Promise.all([cell.get(), cell.get(), cell.get()]);
    expect(opens()).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("RECONSTRUCTS: wind-down disposes; next get() opens a FRESH handle", async () => {
    const { resource, opens, closes } = countingSocket();
    const cell = new ResourceCell(resource);

    const h1 = await cell.get();
    expect(h1.id).toBe(1);
    await cell.windDown();
    expect(h1.closed).toBe(true);
    expect(closes()).toBe(1);
    expect(cell.isLive).toBe(false);

    const h2 = await cell.get();
    expect(h2.id).toBe(2);
    expect(opens()).toBe(2);
    expect(h2).not.toBe(h1);
  });

  it("EAGER pre-warms on spinUp(signal, true)", async () => {
    const { resource, opens } = countingSocket();
    const cell = new ResourceCell(resource);
    await cell.spinUp(armed(), true);
    expect(opens()).toBe(1);
    expect(cell.isLive).toBe(true);
  });

  it("ABORTS: a pre-aborted window makes get() reject and opens nothing", async () => {
    const { resource, opens } = countingSocket();
    const cell = new ResourceCell(resource);
    const ac = new AbortController();
    ac.abort(new Error("boom"));
    await cell.spinUp(ac.signal);
    await expect(cell.get()).rejects.toThrow("boom");
    expect(opens()).toBe(0);
    expect(cell.isLive).toBe(false);
  });

  it("ABORT mid-open disposes the just-opened handle (no leak)", async () => {
    const ac = new AbortController();
    let closedAfterAbort = false;
    const resource: Resource<Socket> = {
      kind: "socket",
      acquire: async ({ signal }) => {
        // open is in-flight; the window aborts during it
        ac.abort(new Error("mid"));
        const s: Socket = { id: 1, closed: false };
        void signal;
        return port(s, () => {
          s.closed = true;
          closedAfterAbort = true;
        });
      },
    };
    const cell = new ResourceCell(resource);
    await cell.spinUp(ac.signal);
    await expect(cell.get()).rejects.toThrow();
    expect(closedAfterAbort).toBe(true);
    expect(cell.isLive).toBe(false);
  });

  it("retries after a FAILED acquire (next get() opens again)", async () => {
    let n = 0;
    const resource: Resource<Socket> = {
      kind: "socket",
      acquire: async () => {
        n++;
        if (n === 1) throw new Error("flaky");
        return port({ id: n, closed: false }, () => {});
      },
    };
    const cell = new ResourceCell(resource);
    await expect(cell.get()).rejects.toThrow("flaky");
    const h = await cell.get();
    expect(h.id).toBe(2);
  });

  it("port() helper wires Symbol.asyncDispose to close()", async () => {
    const close = vi.fn();
    const h = port({ id: 1 }, close);
    await h[Symbol.asyncDispose]();
    expect(close).toHaveBeenCalledOnce();
  });
});
