import type { Provider } from 'ethers';
import { ethers } from 'ethers';
import { readOptionalRpcBatchBigInt, readRequiredRpcBatchBigInt } from './rpc-public';
import { sendRpcBatch, type RpcBatchRequest } from './rpc-utils';
import type { JWalletSnapshot, JWalletSnapshotRequest } from './types';

type SnapshotDeps = {
  provider: Provider;
  rpcUrl?: string;
};

type ViewResult = { ok: true; value: bigint } | { ok: false; error: string };

const ERC20_INTERFACE = new ethers.Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const rpcBlockTag = (blockTag: number | string): string =>
  typeof blockTag === 'number' ? `0x${Math.max(0, Math.floor(blockTag)).toString(16)}` : blockTag;

const readBatchedWalletSnapshot = async (
  rpcUrl: string,
  request: JWalletSnapshotRequest,
  blockTag: number | string,
): Promise<JWalletSnapshot> => {
  const allowances = request.allowances ?? [];
  const batch: RpcBatchRequest[] = [];
  const nextId = (): number => batch.length + 1;
  const nativeBalanceId = request.includeNativeBalance === false ? null : nextId();
  if (nativeBalanceId !== null) {
    batch.push({
      id: nativeBalanceId,
      jsonrpc: '2.0',
      method: 'eth_getBalance',
      params: [request.owner, rpcBlockTag(blockTag)],
    });
  }
  const tokenIds = request.tokenAddresses.map(tokenAddress => {
    const id = nextId();
    batch.push({
      id,
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [
        {
          to: tokenAddress,
          data: ERC20_INTERFACE.encodeFunctionData('balanceOf', [request.owner]),
        },
        rpcBlockTag(blockTag),
      ],
    });
    return id;
  });
  const allowanceIds = allowances.map(item => {
    const id = nextId();
    batch.push({
      id,
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [
        {
          to: item.tokenAddress,
          data: ERC20_INTERFACE.encodeFunctionData('allowance', [request.owner, item.spender]),
        },
        rpcBlockTag(blockTag),
      ],
    });
    return id;
  });

  const responses = await sendRpcBatch(rpcUrl, batch);
  const tokenErrors: NonNullable<JWalletSnapshot['tokenErrors']> = [];
  const allowanceErrors: NonNullable<JWalletSnapshot['allowanceErrors']> = [];
  const tokenBalances = tokenIds.map((id, index) => {
    const tokenAddress = request.tokenAddresses[index] ?? 'unknown';
    const result = readOptionalRpcBatchBigInt(responses, id, `balance:${tokenAddress}:${request.owner}`);
    if (result.ok) return result.value;
    tokenErrors.push({ tokenAddress, error: result.error });
    return 0n;
  });
  const allowanceValues = allowanceIds.map((id, index) => {
    const item = allowances[index];
    const tokenAddress = item?.tokenAddress ?? 'unknown';
    const spender = item?.spender ?? 'unknown';
    const result = readOptionalRpcBatchBigInt(responses, id, `allowance:${tokenAddress}:${request.owner}:${spender}`);
    if (result.ok) return result.value;
    allowanceErrors.push({ tokenAddress, spender, error: result.error });
    return 0n;
  });
  return {
    nativeBalance:
      nativeBalanceId === null
        ? null
        : readRequiredRpcBatchBigInt(responses, nativeBalanceId, `native:${request.owner}`),
    tokenBalances,
    allowances: allowanceValues,
    ...(tokenErrors.length ? { tokenErrors } : {}),
    ...(allowanceErrors.length ? { allowanceErrors } : {}),
  };
};

const readViewUint = async (
  provider: Provider,
  blockTag: number | string,
  functionName: 'balanceOf' | 'allowance',
  to: string,
  parameters: string[],
): Promise<ViewResult> => {
  try {
    const data = ERC20_INTERFACE.encodeFunctionData(functionName, parameters);
    const encoded = await provider.call({ to, data, blockTag });
    const decoded = ERC20_INTERFACE.decodeFunctionResult(functionName, encoded);
    return { ok: true, value: BigInt(decoded[0] ?? 0n) };
  } catch (error) {
    return {
      ok: false,
      error:
        `EXTERNAL_WALLET_SNAPSHOT_CALL_FAILED:${functionName}:${to}:` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const readProviderWalletSnapshot = async (
  provider: Provider,
  request: JWalletSnapshotRequest,
  blockTag: number | string,
): Promise<JWalletSnapshot> => {
  const allowances = request.allowances ?? [];
  const [nativeBalance, tokenResults, allowanceResults] = await Promise.all([
    request.includeNativeBalance === false
      ? Promise.resolve<bigint | null>(null)
      : provider.getBalance(request.owner, blockTag),
    Promise.all(
      request.tokenAddresses.map(address => readViewUint(provider, blockTag, 'balanceOf', address, [request.owner])),
    ),
    Promise.all(
      allowances.map(item =>
        readViewUint(provider, blockTag, 'allowance', item.tokenAddress, [request.owner, item.spender]),
      ),
    ),
  ]);
  const tokenErrors: NonNullable<JWalletSnapshot['tokenErrors']> = [];
  const allowanceErrors: NonNullable<JWalletSnapshot['allowanceErrors']> = [];
  const tokenBalances = tokenResults.map((result, index) => {
    if (result.ok) return result.value;
    tokenErrors.push({
      tokenAddress: request.tokenAddresses[index] ?? 'unknown',
      error: result.error,
    });
    return 0n;
  });
  const allowanceValues = allowanceResults.map((result, index) => {
    if (result.ok) return result.value;
    const item = allowances[index];
    allowanceErrors.push({
      tokenAddress: item?.tokenAddress ?? 'unknown',
      spender: item?.spender ?? 'unknown',
      error: result.error,
    });
    return 0n;
  });
  return {
    nativeBalance,
    tokenBalances,
    allowances: allowanceValues,
    ...(tokenErrors.length ? { tokenErrors } : {}),
    ...(allowanceErrors.length ? { allowanceErrors } : {}),
  };
};

export const readRpcWalletSnapshot = (
  deps: SnapshotDeps,
  request: JWalletSnapshotRequest,
): Promise<JWalletSnapshot> => {
  const blockTag = request.blockTag ?? 'latest';
  return deps.rpcUrl?.startsWith('http')
    ? readBatchedWalletSnapshot(deps.rpcUrl, request, blockTag)
    : readProviderWalletSnapshot(deps.provider, request, blockTag);
};
