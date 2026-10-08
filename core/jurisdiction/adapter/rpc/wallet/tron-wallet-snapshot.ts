import type { Provider } from 'ethers';
import { ethers } from 'ethers';
import type { JAdapterConfig, JWalletSnapshot, JWalletSnapshotRequest } from '../../types';
import { assertTronRpcHeaderBinding, parseNativeTronHeader } from '../../operations/tron-authority';
import { safeStringify } from '../../../../protocol/serialization';

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TRON_SNAPSHOT_RECORD_INVALID');
  return value as Record<string, unknown>;
};
const hexAddress = (address: string): string => `41${ethers.getAddress(address).slice(2).toLowerCase()}`;

/** Native protobuf JSON omits zero scalar fields; numeric source text prevents SUN rounding. */
export const parseTronAccountBalance = (text: string, owner: string): bigint => {
  const account = record(JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (key !== 'balance') return value;
    const source = context?.source ?? (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '');
    if (!/^\d+$/.test(source)) throw new Error('TRON_SNAPSHOT_BALANCE_INVALID');
    return BigInt(source);
  }));
  if (Object.keys(account).length === 0) return 0n; // Native getaccount: absent account has no balance.
  if (account['address'] !== hexAddress(owner)) throw new Error('TRON_SNAPSHOT_ACCOUNT_OWNER_MISMATCH');
  const balance = account['balance'] ?? 0n; // Protobuf int64 default, after account identity validation.
  if (typeof balance !== 'bigint' || balance < 0n || balance > 0x7fffffffffffffffn) {
    throw new Error('TRON_SNAPSHOT_BALANCE_INVALID');
  }
  return balance;
};

export const parseTronConstantUint = (value: unknown): bigint => {
  const response = record(value);
  const result = record(response['result']);
  const words = response['constant_result'];
  if (result['result'] !== true || !Array.isArray(words) || words.length !== 1
    || typeof words[0] !== 'string' || !/^[0-9a-f]{64}$/i.test(words[0])) {
    throw new Error('TRON_SNAPSHOT_CONSTANT_UINT_INVALID');
  }
  return BigInt(`0x${words[0]}`);
};

const solidityReader = (config: JAdapterConfig) => {
  if (config.mode !== 'tron') throw new Error('TRON_SNAPSHOT_NATIVE_POLICY_REQUIRED');
  const host = String(config.tronSolidityHost || config.tronFullHost || config.rpcUrl)
    .replace(/\/jsonrpc\/?$/i, '').replace(/\/$/, '');
  const apiKey = config.tronApiKey || process.env['TRONGRID_API_KEY'];
  return async (method: string, body: unknown): Promise<string> => {
    const response = await fetch(`${host}/walletsolidity/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) },
      body: safeStringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`TRON_SNAPSHOT_HTTP:${method}:${response.status}`);
    return response.text();
  };
};

/** Current SOLIDITY cursor only: prove it stayed at the requested pinned source for the complete read. */
export const readNativeTronWalletSnapshot = async (
  config: JAdapterConfig, provider: Provider, request: JWalletSnapshotRequest,
): Promise<JWalletSnapshot> => {
  const read = solidityReader(config);
  const before = parseNativeTronHeader(JSON.parse(await read('getnowblock', {})));
  if (request.blockTag !== undefined && request.blockTag !== 'latest'
    && BigInt(request.blockTag) !== BigInt(before.blockNumber)) throw new Error('TRON_SNAPSHOT_SOURCE_CHANGED');
  if (!(provider instanceof ethers.JsonRpcProvider)) throw new Error('TRON_SNAPSHOT_JSON_RPC_PROVIDER_REQUIRED');
  const block = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(before.blockNumber), false]);
  assertTronRpcHeaderBinding(before, block);
  const owner = hexAddress(request.owner);
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const view = async (token: string, selector: string, addresses: string[]) => parseTronConstantUint(JSON.parse(await read(
    'triggerconstantcontract', { owner_address: owner, contract_address: hexAddress(token),
      function_selector: selector, parameter: abi.encode(addresses.map(() => 'address'), addresses).slice(2), visible: false },
  )));
  const tokenErrors: NonNullable<JWalletSnapshot['tokenErrors']> = [];
  const allowanceErrors: NonNullable<JWalletSnapshot['allowanceErrors']> = [];
  const [nativeBalance, tokenBalances, allowances] = await Promise.all([
    request.includeNativeBalance === false ? Promise.resolve(null)
      : read('getaccount', { address: owner, visible: false }).then(text => parseTronAccountBalance(text, request.owner)),
    Promise.all(request.tokenAddresses.map(async tokenAddress => {
      try { return await view(tokenAddress, 'balanceOf(address)', [request.owner]); }
      catch (error) { tokenErrors.push({ tokenAddress, error: String(error) }); return 0n; }
    })),
    Promise.all((request.allowances ?? []).map(async entry => {
      try { return await view(entry.tokenAddress, 'allowance(address,address)', [request.owner, entry.spender]); }
      catch (error) { allowanceErrors.push({ ...entry, error: String(error) }); return 0n; }
    })),
  ]);
  const after = parseNativeTronHeader(JSON.parse(await read('getnowblock', {})));
  if (after.blockNumber !== before.blockNumber || after.blockHash !== before.blockHash || after.timestamp !== before.timestamp) {
    throw new Error('TRON_SNAPSHOT_SOURCE_CHANGED');
  }
  return { nativeBalance, tokenBalances, allowances,
    ...(tokenErrors.length ? { tokenErrors } : {}), ...(allowanceErrors.length ? { allowanceErrors } : {}) };
};
