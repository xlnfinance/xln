import { createVM } from '@ethereumjs/vm';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { bytesToHex, createAddressFromString, createAccount } from '@ethereumjs/util';
import { getBytes, JsonRpcProvider, keccak256 } from 'ethers';
import { RPCStateManager } from '@ethereumjs/statemanager';
import { createBlock } from '@ethereumjs/block';
import { customTransformerInterface, parseClauseFields } from '../../protocol/dispute/custom-contract-abi';
import { encodeInt768, decodeInt768 } from '../../protocol/crypto/abi-money';
import type { ClauseSchemas, ClauseSimulationInput } from './types';

const execute = async (runtimeBytecode: string, calldata: string | ((timestamp: number) => string), context?: ClauseSimulationInput) => {
  const common = createCustomCommon({ chainId: context?.chainId ?? 31337 }, Mainnet, { hardfork: Hardfork.Cancun });
  const rpcUrl = context?.rpcUrl;
  const provider = rpcUrl ? new JsonRpcProvider(rpcUrl) : undefined;
  try {
  const head = provider ? await provider.getBlock('latest') : undefined;
  if (provider && (!head || Number((await provider.getNetwork()).chainId) !== context?.chainId)) throw new Error('CLAUSE_J_CONTEXT_MISMATCH');
  const vm = await createVM({ common, ...(rpcUrl && head ? {
    stateManager: new RPCStateManager({ provider: rpcUrl, blockTag: BigInt(head.number), common }),
  } : {}) });
  const to = createAddressFromString(context?.transformerAddress ?? '0x0000000000000000000000000000000000000001');
  const account = await vm.stateManager.getAccount(to) ?? createAccount({ nonce: 1n });
  account.codeHash = getBytes(keccak256(runtimeBytecode));
  await vm.stateManager.putAccount(to, account);
  await vm.stateManager.putCode(to, getBytes(runtimeBytecode));
  const timestamp = head?.timestamp ?? context?.timestamp ?? 0;
  const result = await vm.evm.runCode({
    code: getBytes(runtimeBytecode), data: getBytes(typeof calldata === 'string' ? calldata : calldata(timestamp)), isStatic: true, gasLimit: 1_000_000n,
    to,
    caller: createAddressFromString(context?.depositoryAddress ?? '0x0000000000000000000000000000000000000002'),
    block: createBlock({ header: { timestamp: BigInt(head?.timestamp ?? context?.timestamp ?? 0),
      number: BigInt(head?.number ?? 0), gasLimit: head?.gasLimit ?? 6_000_000n,
      baseFeePerGas: head?.baseFeePerGas ?? 0n } }, { common }),
  });
  if (result.exceptionError) throw new Error(`CLAUSE_EXECUTION_FAILED:${result.exceptionError.error}`);
  return { result: bytesToHex(result.returnValue), gas: result.executionGasUsed };
  } finally { provider?.destroy(); }
};

export async function readClauseSchemas(runtimeBytecode: string): Promise<ClauseSchemas> {
  const read = async (name: string) => {
    const execution = await execute(runtimeBytecode, customTransformerInterface.encodeFunctionData(name));
    const decoded: unknown = customTransformerInterface.decodeFunctionResult(name, execution.result)[0];
    if (typeof decoded !== 'string') throw new Error('CLAUSE_SCHEMA_RETURN_INVALID');
    return parseClauseFields(decoded);
  };
  return { params: await read('paramsSchema'), leftArguments: await read('leftArgsSchema'), rightArguments: await read('rightArgsSchema') };
}

export async function simulateCustomContract(input: ClauseSimulationInput): Promise<{ deltas: bigint[]; gas: bigint }> {
  if (input.deltas.length !== input.tokenIds.length) throw new Error('CLAUSE_TOKEN_DIMENSIONS_INVALID');
  const calldata = (timestamp: number) => customTransformerInterface.encodeFunctionData('applyBatch', [
    input.deltas.map(encodeInt768), input.tokenIds, input.encodedBatch,
    input.leftArguments, input.rightArguments, timestamp, timestamp,
    input.leftEntity, input.rightEntity, timestamp, timestamp, 0, 0,
  ]);
  const execution = await execute(input.artifact.runtimeBytecode, calldata, input);
  const result: unknown = customTransformerInterface.decodeFunctionResult('applyBatch', execution.result)[0];
  if (!Array.isArray(result) || result.length !== input.deltas.length) throw new Error('CLAUSE_DELTA_DIMENSIONS_INVALID');
  return { deltas: result.map(decodeInt768), gas: execution.gas };
}
