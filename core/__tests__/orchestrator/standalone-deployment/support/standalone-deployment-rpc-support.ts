import type { Fixture } from './standalone-deployment-transactions-support';

export type RpcRequest = Readonly<{ method: string; params: any[]; id: number }>;
export const observeRpc = (
  fixture: Fixture,
  hooks: Readonly<{
    before?: (request: RpcRequest) => Promise<void>;
    after?: (request: RpcRequest, result: any) => Promise<void>;
  }> = {},
) => {
  const receipts = new Map<string, number>();
  let closed = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const input = JSON.parse(body);
      const messages: RpcRequest[] = Array.isArray(input) ? input : [input];
      for (const message of messages) if (hooks.before) await hooks.before(message);
      if (closed) return new Response('RPC observer closed', { status: 503 });
      const response = await fetch(fixture.request.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const text = await response.text();
      const parsed = JSON.parse(text);
      for (const message of messages) {
        const result = Array.isArray(parsed) ? parsed.find(entry => entry.id === message.id)?.result : parsed.result;
        if (message.method === 'eth_getTransactionReceipt') {
          const hash = String(message.params[0]);
          receipts.set(hash, (receipts.get(hash) || 0) + 1);
        }
        if (hooks.after) await hooks.after(message, result);
      }
      return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    receiptReads: (hash: string) => receipts.get(hash) || 0,
    close: () => { closed = true; return server.stop(true); },
  };
};
