import { expect, test } from 'bun:test';
import { decodeDeploymentExecutionBlock } from '../../../jurisdiction/adapter/stack-manager/execution-block';

// Public Arbitrum Sepolia EntityProvider creation: the original native CLI
// rejected registrationBlock 12128839 against receipt height 328950104.
const deployment = {
  transactionHash: '0x4e33e08e7794286b478902a50121a88ac2f1a0a31c4192535bf5ed51881ee28c',
  deploymentBlock: 328950104,
};
const blockHash = '0x3327fe7971ad6d768a66c33641a7b800c8b6c29ec5263c44cb6f8791aca7b3dc';
const receipt = {
  transactionHash: deployment.transactionHash,
  status: '0x1',
  blockNumber: `0x${deployment.deploymentBlock.toString(16)}`,
  blockHash,
  l1BlockNumber: `0x${(12128839).toString(16)}`,
};
const block = { number: receipt.blockNumber, hash: blockHash, l1BlockNumber: receipt.l1BlockNumber };

test.each([42161, 421614])('Nitro chain %d validates registration in L1 coordinates and inclusion in L2', chainId => {
  expect(decodeDeploymentExecutionBlock(chainId, deployment, receipt, block)).toBe(12128839n);
  expect(deployment.deploymentBlock).toBe(328950104);
});

test('Ethereum registration uses the canonical receipt height', () => {
  const tx = {
    transactionHash: '0x95f88c5359bf761e450fd01b80adddd72cf00b0521251e717c8cf51d5817564c',
    deploymentBlock: 12128807,
  };
  const hash = '0x70e7635ce252c8ea01699018418bbb2713865d2a2ee38ff511fb3f43ff4d5989';
  const r = { transactionHash: tx.transactionHash, status: '0x1', blockNumber: `0x${tx.deploymentBlock.toString(16)}`, blockHash: hash };
  expect(decodeDeploymentExecutionBlock(11155111, tx, r, { number: r.blockNumber, hash })).toBe(12128807n);
});

test.each([undefined, null, 12128839, '12128839', '0x', '0x-1', '0x00'])('Nitro rejects invalid/missing L1 context %p', value => {
  expect(() => decodeDeploymentExecutionBlock(421614, deployment, { ...receipt, l1BlockNumber: value }, block))
    .toThrow('STACK_MANAGER_EXECUTION_BLOCK_INVALID');
});

test('Nitro rejects disagreement with the canonical block L1 context', () => {
  expect(() => decodeDeploymentExecutionBlock(421614, deployment, receipt, { ...block, l1BlockNumber: '0x1' }))
    .toThrow('STACK_MANAGER_EXECUTION_BLOCK_CONFLICT');
  expect(() => decodeDeploymentExecutionBlock(421614, deployment, receipt, { number: block.number, hash: blockHash }))
    .toThrow('STACK_MANAGER_EXECUTION_BLOCK_INVALID');
});

test.each([
  { ...receipt, transactionHash: '0x' + '1'.repeat(64) },
  { ...receipt, status: '0x0' },
  { ...receipt, blockNumber: '0x1' },
  { ...receipt, blockHash: undefined },
])('rejects an unrelated, reverted or inconsistent creation receipt', value => {
  expect(() => decodeDeploymentExecutionBlock(421614, deployment, value, block))
    .toThrow('STACK_MANAGER_EXECUTION_BLOCK_CONFLICT');
});

test('rejects a noncanonical header and malformed receipt container', () => {
  expect(() => decodeDeploymentExecutionBlock(421614, deployment, receipt, { ...block, hash: '0x' + '2'.repeat(64) }))
    .toThrow('STACK_MANAGER_EXECUTION_BLOCK_CONFLICT');
  expect(() => decodeDeploymentExecutionBlock(421614, deployment, [], block))
    .toThrow('STACK_MANAGER_EXECUTION_BLOCK_INVALID');
});
