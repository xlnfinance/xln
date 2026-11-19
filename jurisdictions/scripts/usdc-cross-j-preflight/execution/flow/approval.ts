import { Interface, Transaction, Wallet } from 'ethers';
import { deriveRuntimeSignerPrivateKey } from '../../../../../core/storage/recovery/bundle/seed-identity';
import type { PocUser } from '../../../../../core/scenarios/usdc-poc/user';
import { readNonceReceipt } from '../nonce-receipt';
import { validateAuthorizedWire } from '../calls';
import type { ExecutionAuthority, ChainAuthority } from '../authority';
import type { ExecutionProviders } from '../providers';

const erc20 = new Interface(['function approve(address,uint256) returns(bool)']);

export const ensureSourceApproval = async (
  user: PocUser,
  authority: ExecutionAuthority,
  providers: ExecutionProviders,
  chain: ChainAuthority,
  runIndex: number,
): Promise<void> => {
  const payer = chain.payers.find(value => value.role === 'source-user')!;
  const nonce = payer.firstNonce + runIndex * 3;
  const existing = await readNonceReceipt(providers, chain, payer, nonce);
  if (existing) {
    validateAuthorizedWire(authority, chain, Transaction.from(existing.transaction).serialized);
    return;
  }
  const provider = providers.current;
  const data = erc20.encodeFunctionData('approve', [chain.depository, 1_000_000n]);
  const [fees, block, estimate] = await Promise.all([
    provider.getFeeData(),
    provider.getBlock('latest'),
    provider.estimateGas({ from: payer.address, to: chain.token, data }),
  ]);
  if (!block || block.baseFeePerGas === null || fees.maxFeePerGas === null || fees.maxPriorityFeePerGas === null)
    throw new Error('USDC_EXECUTION_FEE_QUOTE_MISSING');
  const maxFeePerGas = fees.maxFeePerGas < payer.maxFeePerGasWei ? fees.maxFeePerGas : payer.maxFeePerGasWei;
  const maxPriorityFeePerGas =
    fees.maxPriorityFeePerGas < payer.maxPriorityFeePerGasWei
      ? fees.maxPriorityFeePerGas
      : payer.maxPriorityFeePerGasWei;
  if (estimate > payer.gasLimit || maxFeePerGas < block.baseFeePerGas + maxPriorityFeePerGas)
    throw new Error('USDC_EXECUTION_APPROVAL_LIMIT_INSUFFICIENT');
  const signer = new Wallet(deriveRuntimeSignerPrivateKey(user.seed, 0));
  const raw = await signer.signTransaction({
    type: 2,
    chainId: chain.chainId,
    nonce,
    to: chain.token,
    data,
    value: 0n,
    gasLimit: payer.gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  validateAuthorizedWire(authority, chain, raw);
  const response = await provider.broadcastTransaction(raw);
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error('USDC_EXECUTION_APPROVAL_FAILED');
};
