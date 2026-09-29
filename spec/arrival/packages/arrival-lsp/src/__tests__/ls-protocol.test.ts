// ls-protocol — the worker RPC, headless over a real MessageChannel.
//
// `serveSchemeLs` on port1, `connectSchemeLs` on port2 — the exact wire path a
// (Shared)Worker uses, minus the worker: node's MessageChannel does structured
// clone and async delivery, so this proves the protocol (init handshake,
// method dispatch, error propagation, JSON-able payloads) against the REAL
// browser-build service.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).
//
// `onmessage` assignment is the LsPort contract (it auto-starts MessagePorts —
// addEventListener would need port.start(); see ls-protocol.ts).
/* eslint-disable unicorn/prefer-add-event-listener */

import { describe, expect, it } from "vitest";

import { connectSchemeLs, peekSharedService, serveSchemeLs, type LsPort } from "../ls-protocol.js";

function pair(): { server: LsPort; client: LsPort } {
  const ch = new MessageChannel();
  // MessagePort satisfies LsPort structurally (onmessage assignment starts it).
  return { server: ch.port1 as unknown as LsPort, client: ch.port2 as unknown as LsPort };
}

describe("scheme-ls over a message port", () => {
  it("init handshake + the full method surface answers in scheme coordinates", async () => {
    const { server, client } = pair();
    serveSchemeLs(server);
    const ls = await connectSchemeLs(client, { compilerOptions: { noImplicitAny: false } });

    const scheme = `(define z (car 5))`;
    const diags = await ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    expect(scheme.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe("5");

    const clean = `(define xs (list 1 2 3))\n(car xs)`;
    expect(await ls.getSemanticDiagnostics(clean)).toHaveLength(0);
    const hover = await ls.getQuickInfoAtPosition(clean, clean.lastIndexOf("xs") + 1);
    // Fixed-arity list → TS tuple under PRE; List<> is the homogeneous fallthrough.
    expect(hover?.displayText).toMatch(/\[number,\s*number,\s*number\]|List<number>/);
    const completions = await ls.getCompletionsAtPosition(clean, clean.lastIndexOf("car") + 1);
    expect(completions.map((e) => e.name)).toContain("xs");
    const spans = await ls.getSemanticClassifications(`(define (f x) (string-append "a" x))`);
    expect(spans.some((s) => s.kind === "parameter")).toBe(true);
    const narrowed = await ls.getTypeValidCandidates("(car ", 5, ["list", "odd?"]);
    expect(narrowed).toEqual(["list"]);
  });

  it("server errors propagate as rejections; the connection survives them", async () => {
    const { server, client } = pair();
    serveSchemeLs(server);
    const ls = await connectSchemeLs(client, {});
    // unknown method goes through the raw wire — a hostile/buggy caller
    const raw = client;
    const reply = new Promise((resolve) => {
      const prev = raw.onmessage;
      raw.onmessage = (ev) => {
        resolve(ev.data);
        raw.onmessage = prev;
      };
    });
    raw.postMessage({ kind: "call", id: 999, method: "evilMethod", args: [] });
    expect(await reply).toMatchObject({ id: 999, ok: false });
    // …and the connection still answers real calls afterwards
    expect(await ls.getSemanticDiagnostics(`(define x 1)`)).toHaveLength(0);
  });

  it("setProjectFiles enables (require …) resolution over the wire", async () => {
    const { server, client } = pair();
    serveSchemeLs(server);
    const ls = await connectSchemeLs(client, { compilerOptions: { noImplicitAny: false } });
    await ls.setProjectFiles({ "lib/util.scm": `(define greeting "hello")` });
    const scheme = `(require "lib/util.scm")\n(define loud (car greeting))`;
    const diags = await ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1); // greeting RESOLVED (string) → real bite at car
    expect(scheme.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe("greeting");
    // without files, the same program degrades to the soft suggestion
    await ls.setProjectFiles({});
    const soft = await ls.getSemanticDiagnostics(scheme);
    expect(soft.every((d) => d.severity === "suggestion")).toBe(true);
  });

  it("two connections with the same options share one service (memoized)", async () => {
    const opts = { compilerOptions: { noImplicitAny: false } };
    const a = pair();
    const b = pair();
    serveSchemeLs(a.server);
    serveSchemeLs(b.server);
    const lsA = await connectSchemeLs(a.client, opts);
    const first = peekSharedService(opts);
    const lsB = await connectSchemeLs(b.client, opts);
    expect(peekSharedService(opts)).toBe(first);
    expect(await lsA.getSemanticDiagnostics(`(define x 1)`)).toHaveLength(0);
    expect(await lsB.getSemanticDiagnostics(`(define y 2)`)).toHaveLength(0);
  });
});
