import type { JsonRpcProvider } from 'ethers';

type Deployment = Readonly<{ transactionHash: string; deploymentBlock: number }>;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('STACK_MANAGER_EXECUTION_BLOCK_INVALID');
  return value as Record<string, unknown>;
};

const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))
    throw new Error('STACK_MANAGER_EXECUTION_BLOCK_INVALID');
  return BigInt(value);
};

export const decodeDeploymentExecutionBlock = (
  chainId: number, deployment: Deployment, receiptValue: unknown, blockValue: unknown,
): bigint => {
  const receipt = record(receiptValue);
  const block = record(blockValue);
  const number = quantity(receipt['blockNumber']);
  const hash = receipt['blockHash'];
  if (receipt['transactionHash'] !== deployment.transactionHash || receipt['status'] !== '0x1'
    || number !== BigInt(deployment.deploymentBlock) || quantity(block['number']) !== number
    || typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash) || block['hash'] !== hash)
    throw new Error('STACK_MANAGER_EXECUTION_BLOCK_CONFLICT');
  // Nitro exposes Solidity block.number in L1 coordinates, while canonical
  // receipt/depth checks stay in L2 coordinates. Comparing registrationBlock
  // to the L2 receipt would reject a correctly deployed Foundation. Missing or
  // inconsistent L1 context rejects; it never falls back to the L2 height.
  if (chainId === 42161 || chainId === 421614) {
    const parent = quantity(receipt['l1BlockNumber']);
    if (parent !== quantity(block['l1BlockNumber'])) throw new Error('STACK_MANAGER_EXECUTION_BLOCK_CONFLICT');
    return parent;
  }
  return number;
};

export const readDeploymentExecutionBlock = async (
  provider: JsonRpcProvider, chainId: number, deployment: Deployment,
): Promise<bigint> => {
  const receipt: unknown = await provider.send('eth_getTransactionReceipt', [deployment.transactionHash]);
  const number = quantity(record(receipt)['blockNumber']);
  const block: unknown = await provider.send('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]);
  return decodeDeploymentExecutionBlock(chainId, deployment, receipt, block);
};
