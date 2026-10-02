// A node's JSON-RPC over http: one POST per call. The one place the chain port touches the network. A node that cannot
// be reached, that answers something that is not JSON-RPC, or that answers with an error is a fault the port reports;
// nothing here throws.
import { err, flatMap, ok, type Result } from "../../../kernel/core/result.ts";
import type { Rpc, RpcFault } from "../evm/port.ts";
import { attempt } from "./attempt.ts";

const rpcFault = (reason: string): RpcFault => ({ _tag: "rpc", reason });

/** The result of a JSON-RPC reply, or the error the node named. */
export const resultOf = (reply: unknown): Result<unknown, RpcFault> => {
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return err(rpcFault("not a JSON-RPC reply"));
  const { result, error } = reply as Readonly<Record<string, unknown>>;
  if (error !== undefined) {
    const named = (error as Readonly<{ message?: unknown }> | null)?.message;
    return err(rpcFault(typeof named === "string" ? named : "the node answered with an error"));
  }
  return result === undefined ? err(rpcFault("a JSON-RPC reply with no result")) : ok(result);
};

export const httpRpc = (url: string): Rpc => (method, params) =>
  attempt(
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then((response) => response.json()),
    rpcFault,
  ).then((reply) => flatMap(reply, resultOf));
