import { Interface, Wallet, type JsonRpcProvider } from 'ethers';
import { deriveRuntimeSignerPrivateKey } from '../../../../../core/storage/recovery/bundle/seed-identity';
import { waitFor, type PocUser } from '../../../../../core/scenarios/usdc-poc/user';
import { enqueueRuntimeInput, registerRuntimeFrameCommitCallback } from '../../../../../core/runtime';
import {
  createEvmWalletApprovalTx,
  readEvmWalletApproval,
} from '../../../../../core/runtime/j-submit/evm/wallet-approval';
import type { RuntimeReplica } from '../../../../../core/runtime/types';
import { readNonceReceipt } from '../nonce-receipt';
import { validateAuthorizedWire } from '../calls';
import { receiptSlots, verifyAuthorizedReceipt } from '../receipt-event';
import type { ExecutionAuthority, PayerGrant } from '../authority';
import type { ExecutionProviders } from '../providers';

const erc20 = new Interface(['function approve(address,uint256) returns(bool)']);

export const reconcileSourceApproval = async (
  authority: ExecutionAuthority,
  providers: ExecutionProviders,
  runIndex: number,
  env: RuntimeReplica,
): Promise<boolean> => {
  const [, , chain, payer, nonce] = receiptSlots(authority, runIndex)[0];
  const recorded = readEvmWalletApproval(env, chain.chainId);
  const existing = await readNonceReceipt(providers, chain, payer, nonce);
  if (existing) {
    const { receipt } = verifyAuthorizedReceipt(authority, chain, payer, nonce, existing);
    if (recorded?.nonce === nonce && recorded.hash !== receipt.hash)
      throw new Error(`USDC_EXECUTION_APPROVAL_HASH_MISMATCH:${receipt.hash}`);
    return true;
  }
  // A free nonce on this provider cannot prove that an attempted approval
  // disappeared from other nodes. The original grant does not allow a replacement.
  if (recorded?.nonce === nonce) throw new Error(`USDC_EXECUTION_APPROVAL_UNRESOLVED:${recorded.hash}`);
  if (recorded && recorded.nonce > nonce) throw new Error('USDC_EXECUTION_APPROVAL_NONCE_BEHIND_WAL');
  return false;
};

const commitApproval = async (env: RuntimeReplica, chainId: number, raw: string): Promise<void> => {
  let committed = false;
  const unsubscribe = registerRuntimeFrameCommitCallback(env, ({ runtimeInput }) => {
    if (runtimeInput.runtimeTxs.some(tx => tx.type === 'recordEvmWalletApproval' && tx.data.rawTransaction === raw))
      committed = true;
  });
  try {
    enqueueRuntimeInput(env, { runtimeTxs: [createEvmWalletApprovalTx(raw)], entityInputs: [] });
    await waitFor('execution-approval-wal-committed', () => committed);
  } finally {
    unsubscribe();
  }
  if (readEvmWalletApproval(env, chainId)?.rawTransaction !== raw)
    throw new Error('USDC_EXECUTION_APPROVAL_WAL_COMMIT_MISMATCH');
};

const approvalFees = async (provider: JsonRpcProvider, payer: PayerGrant, to: string, data: string) => {
  const [fees, block, estimate] = await Promise.all([
    provider.getFeeData(),
    provider.getBlock('latest'),
    provider.estimateGas({ from: payer.address, to, data }),
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
  return { maxFeePerGas, maxPriorityFeePerGas };
};

export const submitSourceApproval = async (
  user: PocUser,
  authority: ExecutionAuthority,
  provider: JsonRpcProvider,
  runIndex: number,
  verifyBeforeSign: () => void | Promise<void>,
  recordAttempt: (hash: string) => void,
): Promise<void> => {
  const [, , chain, payer, nonce] = receiptSlots(authority, runIndex)[0];
  const data = erc20.encodeFunctionData('approve', [chain.depository, 1_000_000n]);
  const fees = await approvalFees(provider, payer, chain.token, data);
  await verifyBeforeSign();
  const signer = new Wallet(deriveRuntimeSignerPrivateKey(user.seed, 0));
  const raw = await signer.signTransaction({
    type: 2,
    chainId: chain.chainId,
    nonce,
    to: chain.token,
    data,
    value: 0n,
    gasLimit: payer.gasLimit,
    ...fees,
  });
  const validated = validateAuthorizedWire(authority, chain, raw);
  await commitApproval(user.env, chain.chainId, raw);
  recordAttempt(validated.transaction.hash!);
  const response = await provider.broadcastTransaction(raw);
  const receipt = await response.wait(1, Math.max(1, authority.expiresAt - Date.now()));
  if (!receipt || receipt.status !== 1) throw new Error('USDC_EXECUTION_APPROVAL_FAILED');
};
