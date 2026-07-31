import { expect, test } from 'bun:test';
import { JsonRpcProvider, Wallet } from 'ethers';

import { createRpcChainIo } from '../jurisdiction/adapter/rpc-chain-io';

test('RPC writes fail closed when gas estimation fails', async () => {
  const provider = new JsonRpcProvider('http://127.0.0.1:1', 31_337, {
    staticNetwork: true,
  });
  const signer = Wallet.createRandom().connect(provider);
  const chainIo = createRpcChainIo(
    { mode: 'rpc', chainId: 31_337, rpcUrl: 'http://127.0.0.1:1' },
    provider,
    signer,
  );

  await expect(chainIo.estimateGas(async () => {
    throw new Error('execution reverted');
  })).rejects.toThrow('execution reverted');
  await expect(chainIo.estimateGas(async () => 100_000n)).resolves.toBe(120_000n);
});
