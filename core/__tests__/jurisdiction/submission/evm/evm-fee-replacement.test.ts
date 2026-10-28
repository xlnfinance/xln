import vector from '../../../../../rscore/fixtures/evm-fee-authorization-v1.json';
import { authorizedEvmFeeLimits, evmFeeAuthorizationMessage, validateEvmFeeAuthorization, validateEvmFeeLimits } from '../../../../runtime/j-submit/evm/evm-fee-authorization';
import { expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { suggestReplacementFees, validateEvmReplacement } from '../../../../runtime/j-submit/evm/evm-fees';

const payer = new ethers.Wallet(`0x${'21'.repeat(32)}`);
const request = {
  type: 2,
  chainId: 31337,
  nonce: 7,
  to: `0x${'22'.repeat(20)}`,
  data: '0x1234',
  value: 0n,
  gasLimit: 50000n,
  maxFeePerGas: 100n,
  maxPriorityFeePerGas: 10n,
};
test('both EIP-1559 caps round upward and respect a configured node minimum', () => {
  expect(
    suggestReplacementFees(ethers.Transaction.from(request), { maxFeePerGas: 105n, maxPriorityFeePerGas: 11n }, 2500),
  ).toEqual({ maxFeePerGas: 125n, maxPriorityFeePerGas: 13n });
  expect(
    suggestReplacementFees(
      ethers.Transaction.from({ ...request, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      {},
      1000,
    ),
  ).toEqual({ maxFeePerGas: 3n, maxPriorityFeePerGas: 2n });
});
test('only fees may change: signer, nonce, chain, destination, value, calldata and gas remain exact', async () => {
  const old = await payer.signTransaction(request);
  const next = { ...request, maxFeePerGas: 125n, maxPriorityFeePerGas: 13n };
  const raw = await payer.signTransaction(next);
  expect(() => validateEvmReplacement(old, raw, ethers.keccak256(old), 2500)).not.toThrow();
  for (const changed of [
    { nonce: 8 },
    { chainId: 1 },
    { to: ethers.ZeroAddress },
    { value: 1n },
    { data: '0xab' },
    { gasLimit: 50001n },
    { maxFeePerGas: 124n },
    { maxPriorityFeePerGas: 12n },
  ]) {
    const forged = await payer.signTransaction({ ...next, ...changed });
    expect(() => validateEvmReplacement(old, forged, ethers.keccak256(old), 2500)).toThrow();
  }
  const forged = await ethers.Wallet.createRandom().signTransaction(next);
  expect(() => validateEvmReplacement(old, forged, ethers.keccak256(old), 2500)).toThrow();
});


test('payer authorization has identical TS/Rust bytes and rejects altered authority or limits', () => {
  const limits = { maxFeePerGasWei: vector.maxFeePerGasWei, maxPriorityFeePerGasWei: vector.maxPriorityFeePerGasWei };
  const auth = { ...limits, signature: vector.signature };
  expect(evmFeeAuthorizationMessage(vector.jurisdictionName, vector.attemptId, vector.rawTransaction, limits)).toBe(vector.message);
  expect(ethers.hashMessage(ethers.getBytes(vector.message))).toBe(vector.digest);
  expect(authorizedEvmFeeLimits(vector.jurisdictionName, vector.attemptId, vector.rawTransaction, auth)).toEqual(limits);
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const signature = ethers.getBytes(vector.signature);
  signature.set(ethers.getBytes(ethers.toBeHex(order - BigInt(ethers.hexlify(signature.slice(32, 64))), 32)), 32);
  signature[64] = signature[64] === 27 ? 28 : 27;
  expect(() => authorizedEvmFeeLimits(vector.jurisdictionName, vector.attemptId, vector.rawTransaction, { ...auth, signature: ethers.hexlify(signature) })).toThrow();
  for (const [jurisdiction, id] of [['OtherNet', vector.attemptId], [vector.jurisdictionName, 'next-attempt']]) {
    expect(() => authorizedEvmFeeLimits(jurisdiction!, id!, vector.rawTransaction, auth)).toThrow('EVM_FEE_AUTHORIZATION_PAYER');
  }
  expect(() => authorizedEvmFeeLimits(vector.jurisdictionName, vector.attemptId, vector.rawTransaction, { ...auth, maxPriorityFeePerGasWei: '21' })).toThrow('EVM_FEE_AUTHORIZATION_PAYER');
  for (const max of ['-1', '01', '1e2', String(1n << 256n)]) expect(() => validateEvmFeeLimits({ maxFeePerGasWei: max, maxPriorityFeePerGasWei: '0' })).toThrow();
  expect(() => validateEvmFeeLimits({ maxFeePerGasWei: '1', maxPriorityFeePerGasWei: '2' })).toThrow();
  expect(() => validateEvmFeeAuthorization({ ...auth, extra: 1 })).toThrow();
});


test('q61: TS rejects recovery bytes rejected by Rust, including ethers-normalized EIP-155 v', () => {
  const auth = { maxFeePerGasWei: vector.maxFeePerGasWei, maxPriorityFeePerGasWei: vector.maxPriorityFeePerGasWei, signature: vector.signature };
  for (const v of ['02', '22', '23', '24', 'ff']) {
    expect(() => validateEvmFeeAuthorization({ ...auth, signature: `${vector.signature.slice(0, -2)}${v}` })).toThrow('EVM_FEE_AUTHORIZATION_SIGNATURE');
  }
});
