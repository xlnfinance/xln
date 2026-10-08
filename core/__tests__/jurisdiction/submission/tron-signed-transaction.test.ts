import { createJAdapter } from '../../../jurisdiction/adapter';
import { createSignerNonceSequencer } from '../../../jurisdiction/adapter/rpc/write/rpc-transaction-sequencer';
import { ethers } from 'ethers';
import { validatePreparedTransaction } from '../../../jurisdiction/adapter/rpc/write/prepared/durable-transaction';
import { expect, test } from 'bun:test';
import { decodeSignedTronTransaction } from '../../../jurisdiction/adapter/operations/tron-transaction';
import fixture from '../../../../rscore/fixtures/tron-signed-call-v1.json';

test('native TRON prepared transaction verifies the TronWeb wire and recovered owner', () => {
  const decoded = decodeSignedTronTransaction(`0x${fixture.raw}`);
  expect(decoded).toMatchObject({ hash: `0x${fixture.hash}`, from: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    to: `0x${fixture.to}`, data: `0x${fixture.data}`, value: 0n, nonce: 0 });
  expect(decoded.expiration - decoded.timestamp).toBe(60_000n);
});

test('native TRON prepared wire rejects altered TAPOS, expiry, calldata and signature', () => {
  const bytes = Buffer.from(fixture.raw, 'hex');
  for (const offset of [5, 14, 22, fixture.raw.indexOf(fixture.data) / 2, bytes.length - 2]) {
    const changed = Buffer.from(bytes);
    changed[offset] = (changed[offset] ?? 0) ^ 1;
    expect(() => decodeSignedTronTransaction(`0x${changed.toString('hex')}`)).toThrow();
  }
  expect(() => decodeSignedTronTransaction('0x00')).toThrow();
  expect(() => decodeSignedTronTransaction(`0x${fixture.raw}0801`)).toThrow();
});

test('native prepared acceptance rejects a valid signed wire for a different payer, target, value or call', () => {
  const raw = `0x${fixture.raw}`;
  const expected = { nativeTron: true, from: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    to: `0x${fixture.to}`, data: `0x${fixture.data}`, value: 0n, nonce: 0 };
  expect(validatePreparedTransaction(raw, expected)).toBe(`0x${fixture.hash}`);
  expect(() => validatePreparedTransaction(raw, { ...expected, from: ethers.ZeroAddress })).toThrow('SIGNER_MISMATCH');
  expect(() => validatePreparedTransaction(raw, { ...expected, to: ethers.ZeroAddress })).toThrow('CALL_MISMATCH');
  expect(() => validatePreparedTransaction(raw, { ...expected, value: 1n })).toThrow('CALL_MISMATCH');
  expect(() => validatePreparedTransaction(raw, { ...expected, data: '0xdeadbeef' })).toThrow('CALL_MISMATCH');
  expect(() => validatePreparedTransaction(raw, { ...expected, nonce: 1 })).toThrow('NONCE_MISMATCH');
});

test('EVM prepared acceptance binds signature, chain and nonce before the WAL callback', async () => {
  const signer = new ethers.Wallet(`0x${fixture.key}`);
  const request = { to: `0x${fixture.to}`, data: `0x${fixture.data}`, value: 0n, nonce: 4,
    chainId: 31337n, gasLimit: 50000n, gasPrice: 1n, type: 0 };
  const raw = await signer.signTransaction(request);
  const expected = { ...request, nativeTron: false, from: signer.address };
  expect(validatePreparedTransaction(raw, expected)).toBe(ethers.keccak256(raw));
  expect(() => validatePreparedTransaction(raw, { ...expected, chainId: 1n })).toThrow('CHAIN_MISMATCH');
  expect(() => validatePreparedTransaction(raw, { ...expected, nonce: 5 })).toThrow('NONCE_MISMATCH');
  expect(() => validatePreparedTransaction(raw, { ...expected, from: ethers.ZeroAddress })).toThrow('SIGNER_MISMATCH');
});


test('retired never-broadcast prepared nonce is released from the Runtime-owned reservation source', async () => {
  const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_337 });
  const signer = new ethers.Wallet(`0x${'01'.padStart(64, '0')}`, adapter.provider);
  const sequencer = createSignerNonceSequencer(adapter.provider, true);
  let pending: string[] = [];
  sequencer.setPendingSignedTransactionSource(() => pending);
  try {
    const nonce = await sequencer.runFor(signer, () => sequencer.allocateFor(signer));
    expect(nonce).toBe(0);
    pending = [await signer.signTransaction({ chainId: 31_337, nonce, to: signer.address,
      value: 0n, gasLimit: 21_000n, gasPrice: 1n })];
    expect(await sequencer.runFor(signer, () => sequencer.allocateFor(signer))).toBe(1);
    // Authenticated finality retired this intent before any bytes were published.
    // The live allocation cache is not an independent durable reservation owner.
    pending = [];
    expect(await adapter.provider.getTransactionCount(signer.address, 'pending')).toBe(0);
    expect(await sequencer.runFor(signer, () => sequencer.allocateFor(signer))).toBe(0);
  } finally {
    sequencer.setPendingSignedTransactionSource(null);
    await adapter.close();
  }
});
