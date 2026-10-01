// The node's JSON-RPC over http: a reply is a result or a fault the port can name, and a node that is not there is a
// fault and never a throw. The server here is a local one that answers what it is told to.
import { describe, expect, test } from "bun:test";
import { httpRpc, resultOf } from "./rpc.ts";

const answering = (body: string, status: number) => Bun.serve({ port: 0, fetch: () => new Response(body, { status }) });

describe("host/shell/node a JSON-RPC reply is read for its result or its error", () => {
  test("R-DURABLE a reply with a result is the result, and one with an error is the node's own message", () => {
    expect(resultOf({ jsonrpc: "2.0", id: 1, result: "0x5" })).toEqual({ ok: true, value: "0x5" });
    expect(resultOf({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nonce too low" } }))
      .toEqual({ ok: false, error: { _tag: "rpc", reason: "nonce too low" } });
    expect(resultOf({ jsonrpc: "2.0", id: 1, error: null }).ok).toBe(false);
  });

  test("R-DURABLE a reply that is not JSON-RPC, or has no result, is a fault", () => {
    [null, "0x5", ["0x5"], 7, { jsonrpc: "2.0", id: 1 }].forEach((reply) => {
      expect(resultOf(reply).ok).toBe(false);
    });
  });
});

describe("host/shell/node the call goes over http to the node's url", () => {
  test("R-DURABLE a node that answers is read, and the call carries its method and params", async () => {
    const echo = Bun.serve({
      port: 0,
      fetch: async (request) => Response.json({ jsonrpc: "2.0", id: 1, result: await request.json() }),
    });
    const answer = await httpRpc(`http://127.0.0.1:${echo.port}`)("eth_blockNumber", []);
    await echo.stop();
    expect(answer).toEqual({ ok: true, value: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] } });
  });

  test("R-DURABLE a node that answers text, or is not there, is a fault the submit path reads", async () => {
    const text = answering("not json", 502);
    const refused = await httpRpc(`http://127.0.0.1:${text.port}`)("eth_blockNumber", []);
    await text.stop();
    expect(refused.ok).toBe(false);
    const gone = answering("", 200);
    const url = `http://127.0.0.1:${gone.port}`;
    await gone.stop();
    expect((await httpRpc(url)("eth_blockNumber", [])).ok).toBe(false);
  });
});
