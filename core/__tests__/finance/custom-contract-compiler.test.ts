import { describe, expect, test, beforeAll } from 'bun:test';
import { AbiCoder, keccak256 } from 'ethers';
import { compileCustomContract } from '../../runtime/custom-contracts/compiler';
import { CUSTOM_CONTRACT_TEMPLATES } from '../../runtime/custom-contracts/templates';
import { simulateCustomContract } from '../../runtime/custom-contracts/simulation';
import { encodeClauseFields } from '../../protocol/dispute/custom-contract-abi';
import type { CompiledClause } from '../../runtime/custom-contracts/types';

const coder = AbiCoder.defaultAbiCoder();
const entity = (byte: string) => `0x${byte.repeat(64)}`;
let conditional: CompiledClause;
let secret: CompiledClause;
beforeAll(async () => {
  const first = CUSTOM_CONTRACT_TEMPLATES[0]; const second = CUSTOM_CONTRACT_TEMPLATES[1];
  conditional = await compileCustomContract(first.source, first.contractName);
  secret = await compileCustomContract(second.source, second.contractName);
});
const simulate = (artifact: CompiledClause, params: unknown[], args: string, payerIsLeft = true, timestamp = 100) =>
  simulateCustomContract({ artifact, encodedBatch: encodeClauseFields(artifact.schemas.params, params),
    tokenIds: [7, 99], deltas: [1n << 300n, 0n], leftArguments: payerIsLeft ? '0x' : args,
    rightArguments: payerIsLeft ? args : '0x', timestamp, leftEntity: entity('1'), rightEntity: entity('2'),
    chainId: 31337, depositoryAddress: `0x${'1'.repeat(40)}`, transformerAddress: `0x${'2'.repeat(40)}` });

describe('wallet-authored Solidity compilation and Int768 execution', () => {
  test('conditional payment follows beneficiary arguments and stable token IDs', async () => {
    expect((await simulate(conditional, [7, 100, true], coder.encode(['bool'], [true]))).deltas).toEqual([(1n << 300n) - 100n, 0n]);
    expect((await simulate(conditional, [7, 100, true], coder.encode(['bool'], [false]))).deltas[0]).toBe(1n << 300n);
    expect((await simulate(conditional, [99, 100, false], coder.encode(['bool'], [true]), false)).deltas[1]).toBe(100n);
  });
  test('secret requires matching preimage before the timestamp deadline', async () => {
    const preimage = entity('a'); const args = coder.encode(['bytes32'], [preimage]);
    const params = [7, 100, true, keccak256(args), 100];
    expect((await simulate(secret, params, args)).deltas[0]).toBe((1n << 300n) - 100n);
    expect((await simulate(secret, params, args, true, 101)).deltas[0]).toBe(1n << 300n);
    expect((await simulate(secret, params, coder.encode(['bytes32'], [entity('b')]))).deltas[0]).toBe(1n << 300n);
    expect((await simulate(secret, params, '0x')).deltas[0]).toBe(1n << 300n);
  });
  test('fails loudly for malformed arguments or an unknown token', async () => {
    await expect(simulate(conditional, [7, 100, true], '0x01')).rejects.toThrow('CLAUSE_EXECUTION_FAILED');
    await expect(simulate(conditional, [55, 100, true], coder.encode(['bool'], [true]))).rejects.toThrow('CLAUSE_EXECUTION_FAILED');
  });
  test('constructor and storage are rejected before artifact admission', async () => {
    const template = CUSTOM_CONTRACT_TEMPLATES[0];
    await expect(compileCustomContract(template.source.replace('contract ConditionalPayment {', 'contract ConditionalPayment { constructor() {}'), template.contractName)).rejects.toThrow('CLAUSE_CONSTRUCTOR_NOT_SUPPORTED');
    await expect(compileCustomContract(template.source.replace('contract ConditionalPayment {', 'contract ConditionalPayment { uint256 stored;'), template.contractName)).rejects.toThrow('CLAUSE_STATE_VARIABLE_NOT_SUPPORTED');
  });
});
