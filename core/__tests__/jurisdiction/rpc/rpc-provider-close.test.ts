import { afterAll, beforeAll, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { createXlnJsonRpcProvider, DEFAULT_PRIVATE_KEY } from '../../../jurisdiction/adapter/kernel/factory';
import { createRpcChainIo } from '../../../jurisdiction/adapter/rpc/rpc-chain-io';

let anvil: Bun.Subprocess;
let rpcUrl: string;

beforeAll(async () => {
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  rpcUrl = `http://127.0.0.1:${reservation.port}`;
  const port = reservation.port;
  await reservation.stop(true);
  anvil = Bun.spawn(['anvil', '--host', '127.0.0.1', '--port', String(port), '--quiet'], {
    stdout: 'ignore',
    stderr: 'inherit',
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      });
      if (response.ok) return;
    } catch {
      // Only readiness of this test-owned real Anvil socket is retried.
    }
    await Bun.sleep(25);
  }
  throw new Error('RPC_CLOSE_ANVIL_START_TIMEOUT');
});

afterAll(async () => {
  anvil.kill('SIGTERM');
  await anvil.exited;
});

test('closing waits for an in-flight real RPC read before destroying its provider', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (body.includes('"eth_blockNumber"')) {
        entered.resolve();
        await release.promise;
      }
      return response;
    },
  });
  const provider = createXlnJsonRpcProvider(`http://127.0.0.1:${proxy.port}`, 31337);
  try {
    const read = provider.getBlockNumber();
    await entered.promise;
    let closed = false;
    const close = Promise.resolve(provider.destroy()).then(() => {
      closed = true;
    });
    await Bun.sleep(20);
    expect(closed).toBe(false);
    expect(provider.destroyed).toBe(false);
    release.resolve();
    expect(await read).toBeGreaterThanOrEqual(0);
    await close;
    expect(provider.destroyed).toBe(true);
    await expect(provider.getBlockNumber()).rejects.toThrow('provider destroyed');
  } finally {
    release.resolve();
    await provider.destroy();
    await proxy.stop(true);
  }
});

test('real receipt polling settles before immediate adapter-provider shutdown', async () => {
  const provider = createXlnJsonRpcProvider(rpcUrl, 31337);
  const wallet = new ethers.Wallet(DEFAULT_PRIVATE_KEY, provider);
  const receiver = `0x${'12'.repeat(20)}`;
  const before = await provider.getBalance(receiver);
  const io = createRpcChainIo({ mode: 'rpc', chainId: 31337, rpcUrl }, provider, wallet);
  provider.pollingInterval = 1;
  try {
    await provider.send('evm_setAutomine', [false]);
    const tx = await wallet.sendTransaction({ to: receiver, value: 1n });
    const receipt = io.waitForReceipt(tx, 'close-race');
    await Bun.sleep(20);
    await provider.send('evm_mine', []);
    await Promise.all([provider.send('evm_mine', []), provider.send('evm_mine', [])]);
    expect((await receipt).hash).toBe(tx.hash);
    await provider.destroy();
    const observer = createXlnJsonRpcProvider(rpcUrl, 31337);
    try {
      expect(await observer.getBalance(receiver)).toBe(before + 1n);
      expect((await observer.getTransactionReceipt(tx.hash))?.status).toBe(1);
    } finally {
      await observer.destroy();
    }
  } finally {
    await provider.destroy();
  }
}, 15_000);
