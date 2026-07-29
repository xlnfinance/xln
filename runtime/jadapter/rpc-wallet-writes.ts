import type { Provider, Signer } from 'ethers';
import { ethers } from 'ethers';
import { normalizeEntityId } from '../entity/id';
import { resolveApprovalReceiptLogIndex, type ApprovalReceiptLog } from './rpc-public';
import type { JAdapter, JEvent } from './types';

type FeeOverrides = { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
type TxOverrides = FeeOverrides & { gasLimit?: bigint; nonce?: number };
type RpcReceipt = { hash: string; blockNumber: number; blockHash: string; logs: readonly ApprovalReceiptLog[] };
type WalletMethods = Pick<JAdapter, 'getErc20Allowance' | 'approveErc20' | 'transferErc20' | 'transferNative'>;
type ApprovalDeltaContext = {
  entityId?: string;
  tokenId?: number;
  tokenAddress: string;
  owner: string;
  spender: string;
};

type RpcWalletWriteDeps = {
  provider: Provider;
  signerForPrivateKey(privateKey: string): Promise<Signer>;
  buildFeeOverrides(): Promise<FeeOverrides>;
  waitForReceipt(tx: unknown, label: string): Promise<RpcReceipt>;
  asRpcTxResponse(tx: unknown): { hash: string };
  runSerializedBatchFor<T>(signer: Signer, work: () => Promise<T>): Promise<T>;
  sendSignerTxWithExplicitNonce(
    signer: Signer,
    label: string,
    send: (nonce: number, feeOverrides: FeeOverrides) => Promise<unknown>,
  ): Promise<RpcReceipt>;
};

const buildApprovalDelta = (receipt: RpcReceipt, allowance: bigint, context: ApprovalDeltaContext): JEvent[] => {
  const entityId = normalizeEntityId(context.entityId || '');
  const tokenId = Number(context.tokenId);
  if (!entityId || !Number.isInteger(tokenId) || tokenId < 0) return [];
  const logIndex = resolveApprovalReceiptLogIndex({
    receiptHash: receipt.hash,
    logs: receipt.logs,
    tokenAddress: context.tokenAddress,
    owner: context.owner,
    spender: context.spender,
    allowance,
  });
  return [
    {
      name: 'ExternalWalletDelta',
      args: {
        entityId,
        owner: context.owner.toLowerCase(),
        tokenAddress: context.tokenAddress.toLowerCase(),
        tokenId,
        spender: context.spender.toLowerCase(),
        allowance: allowance.toString(),
      },
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      transactionHash: receipt.hash,
      logIndex,
    },
  ];
};

/** External-wallet writes are serialized per signer to prevent EOA nonce races. */
export const createRpcWalletWriteMethods = (deps: RpcWalletWriteDeps): WalletMethods => {
  const {
    provider,
    signerForPrivateKey,
    buildFeeOverrides,
    waitForReceipt,
    asRpcTxResponse,
    runSerializedBatchFor,
    sendSignerTxWithExplicitNonce,
  } = deps;
  return {
    async getErc20Allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
      const erc20 = new ethers.Contract(
        tokenAddress,
        ['function allowance(address owner, address spender) view returns (uint256)'],
        provider,
      );
      const allowanceFn = erc20.getFunction('allowance') as (
        ownerAddress: string,
        spenderAddress: string,
      ) => Promise<bigint>;
      return allowanceFn(owner, spender);
    },

    async approveErc20(
      signerPrivateKey: Uint8Array,
      tokenAddress: string,
      spender: string,
      amount: bigint,
      options?: {
        entityId?: string;
        tokenId?: number;
      },
    ): Promise<JEvent[]> {
      const signerWallet = await signerForPrivateKey(`0x${Buffer.from(signerPrivateKey).toString('hex')}`);
      const signerAddress = await signerWallet.getAddress();
      const erc20 = new ethers.Contract(
        tokenAddress,
        [
          'function allowance(address owner, address spender) view returns (uint256)',
          'function approve(address spender, uint256 amount) returns (bool)',
          'event Approval(address indexed owner, address indexed spender, uint256 value)',
        ],
        signerWallet,
      );
      const allowanceFn = erc20.getFunction('allowance') as (
        ownerAddress: string,
        spenderAddress: string,
      ) => Promise<bigint>;
      const approveFn = erc20.getFunction('approve') as (
        spenderAddress: string,
        approvalAmount: bigint,
        overrides?: TxOverrides,
      ) => Promise<unknown>;
      const [tokenCode, spenderCode] = await Promise.all([provider.getCode(tokenAddress), provider.getCode(spender)]);
      if (!tokenCode || tokenCode === '0x') {
        throw new Error(`approveErc20 invalid token contract: ${tokenAddress}`);
      }
      if (!spenderCode || spenderCode === '0x') {
        throw new Error(`approveErc20 invalid spender contract: ${spender}`);
      }
      const currentAllowance = await allowanceFn(signerAddress, spender);
      if (currentAllowance === amount) return [];
      const approvalContext: ApprovalDeltaContext = {
        ...options,
        tokenAddress,
        owner: signerAddress,
        spender,
      };
      try {
        return await runSerializedBatchFor(signerWallet, async () => {
          const events: JEvent[] = [];
          if (currentAllowance > 0n && currentAllowance !== amount) {
            const resetReceipt = await sendSignerTxWithExplicitNonce(
              signerWallet,
              'approveErc20Reset',
              (nonce, feeOverrides) =>
                approveFn(spender, 0n, {
                  ...feeOverrides,
                  nonce,
                }),
            );
            events.push(...buildApprovalDelta(resetReceipt, 0n, approvalContext));
          }
          const receipt = await sendSignerTxWithExplicitNonce(signerWallet, 'approveErc20', (nonce, feeOverrides) =>
            approveFn(spender, amount, {
              ...feeOverrides,
              nonce,
            }),
          );
          events.push(...buildApprovalDelta(receipt, amount, approvalContext));
          return events;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const nativeBalance = await provider.getBalance(signerAddress).catch(() => null);
        throw new Error(
          `approveErc20 failed owner=${signerAddress} token=${tokenAddress} spender=${spender} currentAllowance=${currentAllowance} requested=${amount} nativeBalance=${nativeBalance ?? 'unknown'} cause=${message}`,
        );
      }
    },

    async transferErc20(
      signerPrivateKey: Uint8Array,
      tokenAddress: string,
      to: string,
      amount: bigint,
    ): Promise<string> {
      const signerWallet = await signerForPrivateKey(`0x${Buffer.from(signerPrivateKey).toString('hex')}`);
      const erc20 = new ethers.Contract(
        tokenAddress,
        ['function transfer(address to, uint256 amount) returns (bool)'],
        signerWallet,
      );
      const transferFn = erc20.getFunction('transfer') as (
        recipient: string,
        transferAmount: bigint,
        overrides?: FeeOverrides,
      ) => Promise<unknown>;
      const tx = await transferFn(to, amount, await buildFeeOverrides());
      await waitForReceipt(tx, 'transferErc20');
      return asRpcTxResponse(tx).hash;
    },

    async transferNative(signerPrivateKey: Uint8Array, to: string, amount: bigint): Promise<string> {
      const signerWallet = await signerForPrivateKey(`0x${Buffer.from(signerPrivateKey).toString('hex')}`);
      const tx = await signerWallet.sendTransaction({
        to,
        value: amount,
        ...(await buildFeeOverrides()),
      });
      await waitForReceipt(tx, 'transferNative');
      return tx.hash;
    },
  };
};
