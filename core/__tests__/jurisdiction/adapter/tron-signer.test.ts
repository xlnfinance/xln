import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { createXlnJsonRpcProvider, resolveJAdapterPrivateKey } from '../../../jurisdiction/adapter';
import { createTronSigner } from '../../../jurisdiction/adapter/operations/tron-signer';

import { encodeSignedTronTransaction } from '../../../jurisdiction/adapter/operations/tron-broadcast';
import { parseNativeTronHeader, assertTronRpcHeaderBinding } from '../../../jurisdiction/adapter/operations/tron-authority';
import fixture from '../../../../rscore/fixtures/native-tron-receipts-v1.json';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;
// Match the production boundary. TronWeb 6.4's published ESM protobuf bundle
// relies on undeclared global `proto`; its CommonJS export owns that bootstrap
// correctly and remains deterministic when Bun loads the full test graph.
const tronWebModule: typeof import('tronweb') = createRequire(import.meta.url)('tronweb');
const { TronWeb } = tronWebModule;

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

  test('rejects contract creation before requesting native transaction preparation', async () => {
    const provider = createXlnJsonRpcProvider('http://127.0.0.1:1/jsonrpc', 3448148188);
    const signer = await createTronSigner({
      provider,
      privateKey: PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1/jsonrpc',
    });
    await expect(signer.signTransaction({})).rejects.toThrow('TRON_CONTRACT_CREATION_USES_DEPLOY_MATRIX');
    await provider.destroy();
  });

  test('real native TRX wire preserves owner, amount, TAPOS and SHA256 signature without an energy fee', async () => {
    const web = new TronWeb({ fullHost: 'http://127.0.0.1:1', privateKey: PRIVATE_KEY.slice(2) });
    const header = parseNativeTronHeader(fixture.solid);
    assertTronRpcHeaderBinding(header, fixture.solidBlock.result);
    const blockHeader = {
      ref_block_bytes: ethers.toBeHex(header.blockNumber, 8).slice(-4),
      ref_block_hash: header.blockHash.slice(18, 34),
      timestamp: header.timestamp,
      expiration: header.timestamp + 60_000,
    };
    // Actual SDK protobuf creation/signing is offline when supplied a captured header.
    // This is wire evidence; live sendTransaction broadcast remains an integration gate.
    const unsigned = await web.transactionBuilder.sendTrx(
      `41${'22'.repeat(20)}`, 1, web.defaultAddress.hex, { blockHeader },
    );
    const signed = await web.trx.sign(unsigned, PRIVATE_KEY.slice(2));
    const encoded = encodeSignedTronTransaction(web, signed);
    const template = web.utils.transaction.txJsonToPb(signed);
    const codec = template.constructor as { deserializeBinary(bytes: Uint8Array): typeof template };
    const decoded = codec.deserializeBinary(ethers.getBytes(`0x${encoded}`));
    const raw = web.utils.transaction.txPbToRawDataHex(decoded);
    expect(raw.toLowerCase()).toBe(signed.raw_data_hex.toLowerCase());
    expect(ethers.sha256(`0x${raw}`).slice(2)).toBe(signed.txID);
    expect(decoded.getSignatureList().map((signature: Uint8Array) => ethers.hexlify(signature).slice(2)))
      .toEqual(signed.signature.map(signature => signature.toLowerCase()));
    expect(ethers.recoverAddress(`0x${signed.txID}`, `0x${signed.signature[0]}`))
      .toBe(new ethers.Wallet(PRIVATE_KEY).address);
    expect(signed.raw_data.contract[0]?.type).toBe('TransferContract');
    expect(signed.raw_data.contract[0]?.parameter.value).toEqual({
      owner_address: web.defaultAddress.hex,
      to_address: `41${'22'.repeat(20)}`,
      amount: 1,
    });
    expect(signed.raw_data.ref_block_bytes).toBe(blockHeader.ref_block_bytes);
    expect(signed.raw_data.ref_block_hash).toBe(blockHeader.ref_block_hash);
    expect(signed.raw_data.expiration).toBe(blockHeader.expiration);
    expect(signed.raw_data.fee_limit).toBeUndefined();
  });
});
