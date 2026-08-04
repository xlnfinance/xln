import type { JAdapter, RuntimeReplica } from '@xln/runtime/api/public/runtime-module';
import { Wallet, hexlify, isAddress, ZeroAddress } from 'ethers';

import { getXLN } from '$lib/stores/xlnRuntimeLoader';
import { runtimesStateExternalStore } from '$lib/stores/vaultStore';
import { runtimesExternalStore } from '$lib/stores/runtimeStore';
import { runtimeControllerHandleExternalStore } from '$lib/stores/runtimeControllerStore';
import { unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import { runWalletIntentOnce } from './wallet-financial-actions';

type ExternalActionOwner = Readonly<{
  entityId: string;
  signerId: string;
}>;

type ExternalActionContext = Readonly<{
  env: RuntimeReplica;
  jadapter: JAdapter;
  owner: string;
  privateKey: Uint8Array;
  spender: string;
}>;

const requireExternalActionContext = async (
  owner: ExternalActionOwner,
): Promise<ExternalActionContext> => {
  const vault = runtimesStateExternalStore.getSnapshot();
  const handle = runtimeControllerHandleExternalStore.getSnapshot();
  const runtimeId = String(vault.activeRuntimeId || handle.runtimeId || handle.id).trim().toLowerCase();
  const runtimeEntry = runtimesExternalStore.getSnapshot().get(runtimeId);
  const vaultRuntime = runtimeId ? vault.runtimes[runtimeId] : null;
  const envView = runtimeEntry?.env ?? vaultRuntime?.env ?? null;
  const env = unwrapLiveRuntimeEnv(envView) ?? envView;
  if (!env) throw new Error('WALLET_EXTERNAL_RUNTIME_NOT_LOCAL');
  const xln = await getXLN();
  const privateKey = xln.getCachedSignerPrivateKey?.(env, owner.signerId);
  if (!privateKey) throw new Error(`WALLET_EXTERNAL_SIGNER_KEY_MISSING:${owner.signerId}`);
  const jadapter = xln.getEntityJAdapter?.(env, owner.entityId, owner.signerId)
    ?? xln.getActiveJAdapter?.(env);
  if (!jadapter) throw new Error('WALLET_EXTERNAL_JADAPTER_MISSING');
  const spender = String(jadapter.addresses.depository || '').trim();
  if (!isAddress(spender) || spender === ZeroAddress) {
    throw new Error('WALLET_EXTERNAL_DEPOSITORY_MISSING');
  }
  return Object.freeze({
    env,
    jadapter,
    privateKey,
    owner: new Wallet(hexlify(privateKey)).address.toLowerCase(),
    spender,
  });
};

export const readWalletExternalActionContext = async (
  owner: ExternalActionOwner,
): Promise<Pick<ExternalActionContext, 'jadapter' | 'owner' | 'spender'>> => {
  const context = await requireExternalActionContext(owner);
  return Object.freeze({ jadapter: context.jadapter, owner: context.owner, spender: context.spender });
};

export const approveWalletExternalAllowance = async (input: ExternalActionOwner & Readonly<{
  tokenAddress: string;
  tokenId: number;
  amount: bigint;
}>): Promise<bigint> => {
  if (!isAddress(input.tokenAddress) || input.tokenAddress === ZeroAddress) {
    throw new Error('WALLET_EXTERNAL_APPROVAL_TOKEN_INVALID');
  }
  if (input.amount <= 0n) throw new Error('WALLET_EXTERNAL_APPROVAL_AMOUNT_NOT_POSITIVE');
  const key = ['wallet-external-approve', input.entityId, input.tokenAddress, input.amount].join(':');
  return runWalletIntentOnce(key, async () => {
    const context = await requireExternalActionContext(input);
    await context.jadapter.approveErc20(
      context.privateKey,
      input.tokenAddress,
      context.spender,
      input.amount,
      { entityId: input.entityId, tokenId: input.tokenId },
    );
    const observed = await context.jadapter.getErc20Allowance(
      input.tokenAddress,
      context.owner,
      context.spender,
    );
    if (observed < input.amount) {
      throw new Error(`WALLET_EXTERNAL_APPROVAL_POSTCONDITION_FAILED:${observed}:${input.amount}`);
    }
    return observed;
  });
};

export const sendWalletExternalAsset = async (input: ExternalActionOwner & Readonly<{
  tokenAddress: string;
  recipientEoa: string;
  amount: bigint;
}>): Promise<string> => {
  if (!isAddress(input.tokenAddress)) throw new Error('WALLET_EXTERNAL_TOKEN_INVALID');
  if (!isAddress(input.recipientEoa)) throw new Error('WALLET_EXTERNAL_RECIPIENT_INVALID');
  if (input.amount <= 0n) throw new Error('WALLET_EXTERNAL_AMOUNT_NOT_POSITIVE');
  const key = ['wallet-external-transfer', input.entityId, input.tokenAddress, input.recipientEoa, input.amount].join(':');
  return runWalletIntentOnce(key, async () => {
    const context = await requireExternalActionContext(input);
    if (context.owner === input.recipientEoa.toLowerCase()) {
      throw new Error('WALLET_EXTERNAL_RECIPIENT_IS_SELF');
    }
    return input.tokenAddress === ZeroAddress
      ? context.jadapter.transferNative(context.privateKey, input.recipientEoa, input.amount)
      : context.jadapter.transferErc20(context.privateKey, input.tokenAddress, input.recipientEoa, input.amount);
  });
};
