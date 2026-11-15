import { Transaction } from 'ethers';
import type { Fixture } from './standalone-deployment-transactions-support';

export const pendingFeeRpc = (fixture: Fixture) => {
  let tail = Promise.resolve();
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  };
  let originalRaw = '';
  let broadcasts = 0;
  let repropagations = 0;
  const emptyBlocks: Array<{ number: string; hash: string; gasLimit: string }> = [];
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => exclusive(async () => {
    const body = await request.text();
    const input = JSON.parse(body);
    for (const message of Array.isArray(input) ? input : [input]) {
      if (message.method !== 'eth_sendRawTransaction' || Transaction.from(message.params[0]).nonce !== fixture.initialNonce) continue;
      originalRaw ||= message.params[0];
      broadcasts += 1;
    }
    const response = await fetch(fixture.request.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return new Response(await response.text(), { status: response.status, headers: { 'content-type': 'application/json' } });
  }) });
  return {
    url: `http://127.0.0.1:${proxy.port}`,
    originalRaw: () => originalRaw,
    repropagations: () => repropagations,
    emptyBlocks: () => emptyBlocks,
    mineEmptyBlock: () => exclusive(async () => {
      if (broadcasts >= 2) return;
      const hash = Transaction.from(originalRaw).hash;
      // Mining is real, with the ordinary block gas limit and fee policy.
      // Native RPCs wait while the exact already-signed transaction is removed
      // and re-propagated; they never observe the controller's transient gap.
      await fixture.provider.send('anvil_dropTransaction', [hash]);
      await fixture.provider.send('anvil_mine', ['0x1']);
      const block = await fixture.provider.send('eth_getBlockByNumber', ['latest', false]);
      const receipt = await fixture.provider.send('eth_getTransactionReceipt', [hash]);
      if (block.transactions.length !== 0 || BigInt(block.gasLimit) !== 60_000_000n || receipt !== null)
        throw new Error('FEE_PROBE_BLOCK_NOT_EMPTY_OR_PENDING');
      emptyBlocks.push({ number: block.number, hash: block.hash, gasLimit: block.gasLimit });
      if (await fixture.provider.send('eth_sendRawTransaction', [originalRaw]) !== hash)
        throw new Error('FEE_PROBE_REPROPAGATION_HASH_CONFLICT');
      if (await fixture.provider.getTransaction(hash!) === null)
        throw new Error('FEE_PROBE_PENDING_TRANSACTION_MISSING');
      repropagations += 1;
    }),
    close: async () => { await proxy.stop(true); await tail; },
  };
};
