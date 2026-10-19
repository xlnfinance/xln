import { Interface, Transaction } from 'ethers';
import { safeStringify } from '../../../protocol/serialization';

// Forward actual Anvil replies while mining approval after the client has read
// its head. This reproduces Ethers' cached-head race without fabricated RPC data.
type Request = { jsonrpc: string; id: number; method: string; params: unknown[] };
type Reply = {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; data?: string; message: string };
};

export const approvalOrderingProxy = (rpc: string) => {
  let lastClientHead: string | undefined;
  let headReadsAfterApproval = 0;
  let approval:
    | {
        cachedHead: string;
        receiptBlock: string;
        status: string;
        hash: string;
        oldAllowance: Reply;
        confirmedAllowance: Reply;
      }
    | undefined;
  let deposit: Record<string, unknown> | undefined;
  let sequence = 100000;
  const forward = async (request: Request): Promise<Reply> => {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: safeStringify(request),
      signal: AbortSignal.timeout(1000),
    });
    return (await response.json()) as Reply;
  };
  const call = (method: string, params: unknown[]) => forward({ jsonrpc: '2.0', id: sequence++, method, params });
  const route = async (request: Request): Promise<Reply> => {
    if (request.method === 'eth_blockNumber') {
      if (approval) headReadsAfterApproval++;
      const reply = await forward(request);
      lastClientHead = reply.result as string;
      return reply;
    }
    if (
      request.method === 'eth_sendRawTransaction' &&
      Transaction.from(request.params[0] as string).data.startsWith('0x095ea7b3')
    ) {
      if (!lastClientHead) throw new Error('APPROVAL_ORDERING_CLIENT_HEAD_MISSING');
      const cachedHead = lastClientHead;
      const reply = await forward(request);
      if (reply.error) return reply;
      const mined = await call('evm_mine', []);
      if (mined.error) throw new Error(safeStringify(mined.error));
      const receipt = (await call('eth_getTransactionReceipt', [reply.result])).result as {
        blockNumber: string;
        status: string;
      };
      const tx = Transaction.from(request.params[0] as string);
      const abi = new Interface([
        'function approve(address,uint256)',
        'function allowance(address,address) view returns (uint256)',
      ]);
      const spender = abi.decodeFunctionData('approve', tx.data)[0];
      const allowance = { to: tx.to, data: abi.encodeFunctionData('allowance', [tx.from, spender]) };
      const [oldAllowance, confirmedAllowance] = await Promise.all([
        call('eth_call', [allowance, cachedHead]),
        call('eth_call', [allowance, receipt.blockNumber]),
      ]);
      approval = {
        cachedHead,
        receiptBlock: receipt.blockNumber,
        status: receipt.status,
        hash: reply.result as string,
        oldAllowance,
        confirmedAllowance,
      };
      return reply;
    }
    const tx = request.params[0] as { data?: string } | undefined;
    if (!deposit && approval && request.method === 'eth_estimateGas' && tx?.data?.startsWith('0x7a4ef025')) {
      const [oldEstimate, confirmedEstimate, actual] = await Promise.all([
        call('eth_estimateGas', [tx, approval.cachedHead]),
        call('eth_estimateGas', [tx, approval.receiptBlock]),
        forward(request),
      ]);
      deposit = { blockTag: request.params[1], oldEstimate, confirmedEstimate, actual, headReadsAfterApproval };
      console.log('APPROVAL_ORDERING_EVIDENCE:' + safeStringify({ approval, deposit }));
      return actual;
    }
    return forward(request);
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as Request | Request[];
      if (!Array.isArray(payload)) return Response.json(await route(payload));
      // Ethers can batch its broadcast head and raw transaction in one HTTP call.
      // Forward real head reads before mining approval; never manufacture a reply.
      const replies = new Map<number, Reply>();
      for (const item of payload.filter(item => item.method === 'eth_blockNumber'))
        replies.set(item.id, await route(item));
      await Promise.all(
        payload
          .filter(item => item.method !== 'eth_blockNumber')
          .map(async item => {
            replies.set(item.id, await route(item));
          }),
      );
      return Response.json(payload.map(item => replies.get(item.id)));
    },
  });
  return { url: server.url.toString(), stop: () => server.stop(true), evidence: () => ({ approval, deposit }) };
};
