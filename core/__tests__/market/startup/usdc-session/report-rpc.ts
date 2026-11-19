import { JsonRpcProvider, Transaction } from 'ethers';
import { requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import { safeStringify } from '../../../../protocol/serialization';

type RpcCall = { id: number; method: string; params: unknown[] };

export const startReportRpc = (rpc: string, provider: JsonRpcProvider, withdrawalPayer: string) => {
  let insertedGap = false;
  const forward = async (call: RpcCall) => {
    if (call.method === 'eth_getLogs') {
      const filter = requireBoundaryRecord(call.params[0], 'TEST_LOG_FILTER');
      const { fromBlock, toBlock } = filter;
      if (
        typeof fromBlock === 'string' &&
        /^0x[0-9a-f]+$/i.test(fromBlock) &&
        typeof toBlock === 'string' &&
        /^0x[0-9a-f]+$/i.test(toBlock) &&
        BigInt(toBlock) - BigInt(fromBlock) >= 10n
      )
        return { jsonrpc: '2.0', id: call.id, error: { code: -32600, message: 'TEST_LOG_RANGE_EXCEEDS_10_BLOCKS' } };
    }
    if (
      !insertedGap &&
      call.method === 'eth_sendRawTransaction' &&
      Transaction.from(String(call.params[0])).from?.toLowerCase() === withdrawalPayer.toLowerCase()
    ) {
      insertedGap = true;
      await provider.send('anvil_mine', ['0xc']);
    }
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: safeStringify(call),
    });
    if (!response.ok) throw new Error(`TEST_REPORT_RPC_HTTP:${response.status}`);
    return response.json();
  };
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as RpcCall | RpcCall[];
      return Response.json(Array.isArray(payload) ? await Promise.all(payload.map(forward)) : await forward(payload));
    },
  });
};

export const reportReceipts = (report: Record<string, unknown>, field: 'ingress' | 'target') => {
  const { receipts } = requireBoundaryRecord(report[field], 'TEST_REPORT_RECEIPT_GROUP');
  if (!Array.isArray(receipts)) throw new Error('TEST_REPORT_RECEIPTS_MISSING');
  return receipts.map(value => {
    const { hash, blockNumber } = requireBoundaryRecord(value, 'TEST_REPORT_RECEIPT_INVALID');
    if (typeof hash !== 'string' || typeof blockNumber !== 'number') throw new Error('TEST_REPORT_RECEIPT_FIELDS');
    return { hash, blockNumber };
  });
};
