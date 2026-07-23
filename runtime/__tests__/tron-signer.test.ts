import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { createXlnJsonRpcProvider } from '../jadapter';
import { createTronSigner } from '../jadapter/tron-signer';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;

describe('TRON signer boundary', () => {
  test('derives the same EVM caller from Ethereum and TRON address formats', async () => {
    const provider = createXlnJsonRpcProvider('http://127.0.0.1:1/jsonrpc', 3448148188);
    const signer = await createTronSigner({
      provider,
      privateKey: PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1/jsonrpc',
    });
    expect(await signer.getAddress()).toBe(new ethers.Wallet(PRIVATE_KEY).address);
    await provider.destroy();
  });

  test('refuses Ethereum raw transaction signing at the TRON boundary', async () => {
    const provider = createXlnJsonRpcProvider('http://127.0.0.1:1/jsonrpc', 3448148188);
    const signer = await createTronSigner({
      provider,
      privateKey: PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1/jsonrpc',
    });
    await expect(signer.signTransaction({})).rejects.toThrow('TRON_PROTOBUF_TRANSACTION_REQUIRED');
    await provider.destroy();
  });
});
