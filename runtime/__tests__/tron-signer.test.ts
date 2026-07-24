import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { TronWeb } from 'tronweb';
import { createXlnJsonRpcProvider, resolveJAdapterPrivateKey } from '../jadapter';
import { createTronSigner, TronSigner } from '../jadapter/tron-signer';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;

describe('TRON signer boundary', () => {
  test('requires an explicit watch-only boundary when a public-chain signer is absent', async () => {
    const config = {
      mode: 'tron' as const,
      chainId: 3448148188,
    };
    expect(() => resolveJAdapterPrivateKey(config)).toThrow('privateKey is required');
    expect(resolveJAdapterPrivateKey({ ...config, watchOnly: true })).toBeUndefined();
  });

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

  test('native TRX transfer bypasses smart-contract energy estimation', async () => {
    const provider = createXlnJsonRpcProvider('http://127.0.0.1:1/jsonrpc', 3448148188);
    const ownerHex = `41${new ethers.Wallet(PRIVATE_KEY).address.slice(2)}`;
    const owner = TronWeb.address.fromHex(ownerHex);
    let sendTrxCalls = 0;
    let estimateEnergyCalls = 0;
    class FakeTronWeb {
      defaultAddress = { base58: owner };
      address = {
        toHex: () => ownerHex,
        fromHex: (value: string) => value,
      };
      transactionBuilder = {
        sendTrx: async () => {
          sendTrxCalls += 1;
          return { raw_data: {} };
        },
        estimateEnergy: async () => {
          estimateEnergyCalls += 1;
          throw new Error('must not estimate Energy for TRX');
        },
      };
      trx = {
        sign: async (transaction: object) => ({
          ...transaction,
          signature: ['0x01'],
          txID: '11'.repeat(32),
        }),
        sendRawTransaction: async () => ({ result: true }),
      };
    }
    const signer = new TronSigner({
      provider,
      privateKey: PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1/jsonrpc',
    }, FakeTronWeb as unknown as typeof TronWeb);

    const response = await signer.sendTransaction({
      to: '0x2222222222222222222222222222222222222222',
      value: 1n,
    });
    expect(response.hash).toBe(`0x${'11'.repeat(32)}`);
    expect(sendTrxCalls).toBe(1);
    expect(estimateEnergyCalls).toBe(0);
    await provider.destroy();
  });
});
