import { describe, expect, test } from 'bun:test';
import { TronWeb } from 'tronweb';
import { DepositoryBounds__factory } from '../../../../../jurisdictions/typechain-types/factories/DepositoryBounds__factory';
import { encodeSignedTronTransaction } from '../../../../jurisdiction/adapter/operations/tron-broadcast';
import { safeStringify } from '../../../../protocol/serialization';

const tron = new TronWeb({ fullHost: 'http://127.0.0.1:1', privateKey: '11'.repeat(32) });
const blockHeader = {
  ref_block_bytes: '000d', ref_block_hash: 'c6a630b3da97ccf2',
  timestamp: 1_788_566_778_000, expiration: 1_788_566_838_000,
};

const signedDeployment = async () => tron.trx.sign(await tron.transactionBuilder.createSmartContract({
  abi: safeStringify(DepositoryBounds__factory.abi), bytecode: DepositoryBounds__factory.bytecode,
  feeLimit: 15_000_000_000, blockHeader,
}));

describe('native TRON signed protobuf broadcast', () => {
  test.each(['esm', 'commonjs'])('loads %s native transfer protobuf first in a clean process', (format) => {
    // The upstream generated module extended the unrelated global `proto`.
    // A previous import could hide the crash; real native startup exposed it.
    const path = import.meta.resolve('tronweb')
      .replace('/lib/esm/index.js', `/lib/${format}/protocol/core/contract/balance_contract_pb.cjs`);
    const result = Bun.spawnSync([process.execPath, '-e', `
      const { TransferContract } = await import(${safeStringify(path)});
      const tx = new TransferContract();
      tx.setOwnerAddress(Buffer.from('41' + '11'.repeat(20), 'hex'));
      tx.setToAddress(Buffer.from('41' + '22'.repeat(20), 'hex'));
      tx.setAmount(1);
      console.log(Buffer.from(tx.serializeBinary()).toString('hex'));
    `]);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(`0a1541${'11'.repeat(20)}121541${'22'.repeat(20)}1801`);
  });

  test('preserves the signed deep-ABI deployment payload and signature', async () => {
    // Real java-tron rejected the JSON form at nesting depth 21 > 20.
    // The native protobuf transport must preserve authority and signed bytes.
    const signed = await signedDeployment();
    const encoded = encodeSignedTronTransaction(tron, signed);
    expect(encoded).toContain(signed.raw_data_hex.toLowerCase());
    expect(signed.signature).toHaveLength(1);
    expect(encoded.endsWith(`1241${signed.signature.join('').toLowerCase()}`)).toBe(true);
    expect(tron.trx.ecRecover(signed)).toBe(tron.defaultAddress.base58);
  });

  test('rejects changed transaction identity, raw payload and missing signatures', async () => {
    const signed = await signedDeployment();
    expect(() => encodeSignedTronTransaction(tron, { ...signed, txID: '00'.repeat(32) }))
      .toThrow('TRON_BROADCAST_SIGNED_PAYLOAD_MISMATCH');
    expect(() => encodeSignedTronTransaction(tron, { ...signed, raw_data_hex: `${signed.raw_data_hex}00` }))
      .toThrow('TRON_BROADCAST_SIGNED_PAYLOAD_MISMATCH');
    expect(() => encodeSignedTronTransaction(tron, { ...signed, signature: [] }))
      .toThrow('TRON_TRANSACTION_SIGNATURE_MISSING');
  });

  test('rejects changing signed TAPOS or expiration while retaining the original digest', async () => {
    const signed = await signedDeployment();
    // A retry may rebroadcast these signed bytes, but refreshing its block
    // reference or lifetime requires a new signature over a new transaction.
    for (const mutation of [
      { ref_block_bytes: '000e' },
      { ref_block_hash: '00'.repeat(8) },
      { expiration: signed.raw_data.expiration + 1 },
    ]) {
      expect(() => encodeSignedTronTransaction(tron, {
        ...signed, raw_data: { ...signed.raw_data, ...mutation },
      })).toThrow('TRON_BROADCAST_SIGNED_PAYLOAD_MISMATCH');
    }
  });

  test('rejects malformed signatures before native protobuf broadcast', async () => {
    const signed = await signedDeployment();
    for (const signature of ['', '00'.repeat(64), '00'.repeat(66), 'gg'.repeat(65)]) {
      expect(() => encodeSignedTronTransaction(tron, { ...signed, signature: [signature] }))
        .toThrow('TRON_TRANSACTION_SIGNATURE_INVALID');
    }
  });
});
