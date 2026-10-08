/** Real TVM regression shared by the existing native Rust financial/recovery stand. */
import { strict as assert } from 'node:assert';
import { Interface } from 'ethers';
import type { JAdapter } from '../../../core/jurisdiction/adapter/types';
import { readExternalWalletSnapshotSource } from '../../../core/api/public/external-wallet/http';
import { safeStringify } from '../../../core/protocol/serialization';

type SnapshotGate = {
  adapter: JAdapter; entityId: string; owner: string; tokenAddress: string; spender: string;
  apiUrl: string; solidityHost: string; evidencePath: string; expiredSourceHeight?: number;
};
const abi = new Interface(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)']);
const solidityRead = async (host: string, method: string, body: unknown): Promise<string> => {
  const response = await fetch(`${host}/walletsolidity/${method}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  assert(response.ok, `native Solidity ${method}: ${response.status}`);
  return response.text();
};
const constantRead = async (input: SnapshotGate, selector: string, args: string[]): Promise<bigint> => {
  const value = JSON.parse(await solidityRead(input.solidityHost, 'triggerconstantcontract', {
    owner_address: `41${input.owner.slice(2)}`, contract_address: `41${input.tokenAddress.slice(2)}`,
    function_selector: selector, parameter: abi.encodeFunctionData(selector, args).slice(10), visible: false,
  }));
  assert.equal(value.result.result, true); assert.equal(value.constant_result.length, 1);
  assert.match(value.constant_result[0], /^[0-9a-f]{64}$/i);
  return BigInt(`0x${value.constant_result[0]}`);
};

export const verifyNativeWalletSnapshot = async (input: SnapshotGate): Promise<number> => {
  assert.equal(input.adapter.mode, 'tron', 'genuine TVM adapter required');
  const request = { entityId: input.entityId, owner: input.owner, tokenAddresses: [input.tokenAddress],
    allowances: [{ tokenAddress: input.tokenAddress, spender: input.spender }] };
  const response = await fetch(`${input.apiUrl}/api/external-wallet/snapshot`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(10_000) });
  const result = await response.json();
  await Bun.write(`${input.evidencePath}.response.json`, JSON.stringify(result, null, 2));
  assert.equal(response.status, 200); assert.equal(result.success, true);
  assert.equal(result.entityId, input.entityId); assert.equal(result.owner, input.owner);
  assert.equal(result.finalityDepth, 0); assert(!result.tokenErrors); assert(!result.allowanceErrors);
  const source = await readExternalWalletSnapshotSource(input.adapter);
  assert.equal(result.sourceHeight, source.sourceHeight); assert.equal(result.sourceHash, source.sourceHash);
  assert.equal(result.blockHash, result.sourceHash);
  const accountText = await solidityRead(input.solidityHost, 'getaccount', { address: `41${input.owner.slice(2)}`, visible: false });
  const account = JSON.parse(accountText, (key: string, value: unknown, context?: { source?: string }) => {
    if (key !== 'balance') return value;
    assert(context?.source && /^\d+$/.test(context.source), 'exact native integer source');
    return BigInt(context.source);
  });
  assert.equal(account.address, `41${input.owner.slice(2)}`);
  const native = account.balance;
  const balance = await constantRead(input, 'balanceOf(address)', [input.owner]);
  const allowance = await constantRead(input, 'allowance(address,address)', [input.owner, input.spender]);
  const snapshot = await input.adapter.readWalletSnapshot({ ...request, includeNativeBalance: true, blockTag: source.sourceHeight });
  assert.equal(snapshot.nativeBalance, native); assert.equal(snapshot.tokenBalances[0], balance);
  assert.equal(snapshot.allowances[0], allowance); assert(!snapshot.tokenErrors); assert(!snapshot.allowanceErrors);
  const after = JSON.parse(await solidityRead(input.solidityHost, 'getnowblock', {}));
  assert.equal(after.block_header.raw_data.number, source.sourceHeight, 'Rust/TS/independent reads share the same solid head');
  assert.equal(`0x${after.blockID}`, source.sourceHash);
  assert(native > 0n); assert(balance > 0n); assert(allowance > 0n);
  assert.equal(result.nativeBalance, String(native)); assert.equal(result.tokenBalances[0].balance, String(balance));
  assert.equal(result.tokenBalances[0].tokenId, 1); assert.equal(result.allowances[0].allowance, String(allowance));
  if (input.expiredSourceHeight !== undefined) {
    assert(source.sourceHeight > input.expiredSourceHeight, 'actual financial transaction advanced native solid head');
    await assert.rejects(input.adapter.readWalletSnapshot({ ...request, includeNativeBalance: true,
      blockTag: input.expiredSourceHeight }), /TRON_SNAPSHOT_SOURCE_CHANGED/);
  }
  await Bun.write(`${input.evidencePath}.verified.json`, safeStringify({ chainId: input.adapter.chainId,
    sourceHeight: source.sourceHeight, sourceHash: source.sourceHash, native, balance, allowance,
    engines: ['native-rust', 'typescript'], independentNativeRest: true,
    ...(input.expiredSourceHeight === undefined ? {} : { rejectedOldSourceHeight: input.expiredSourceHeight }) }, 2));
  return source.sourceHeight;
};
