import { expect, type Page, type Response } from '@playwright/test';
import { Interface } from 'ethers';

export type WalletRequest = {
  entityId: string;
  owner: string;
  tokenAddresses: string[];
  allowances: Array<{ tokenAddress: string; spender: string }>;
};
export type WalletSnapshot = {
  success: boolean;
  entityId: string;
  owner: string;
  sourceHeight: number;
  sourceHash: string;
  blockNumber: number;
  blockHash: string;
  nativeBalance: string;
  tokenBalances: Array<{ tokenAddress: string; balance: string; error?: string }>;
  allowances: Array<{ tokenAddress: string; spender: string; allowance: string; error?: string }>;
  tokenErrors?: unknown[];
  allowanceErrors?: unknown[];
};
const erc20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);

export const verifyWalletSnapshot = async (page: Page, input: WalletRequest, snapshot: WalletSnapshot, entityJurisdiction?: { address: string; chainId: number }): Promise<void> => {
  expect(snapshot.success).toBe(true);
  expect(snapshot.entityId).toBe(input.entityId);
  expect(snapshot.owner).toBe(input.owner.toLowerCase());
  expect(Number.isSafeInteger(snapshot.sourceHeight)).toBe(true);
  expect(snapshot.sourceHeight).toBeGreaterThanOrEqual(0);
  expect(snapshot.blockNumber).toBe(snapshot.sourceHeight);
  expect(snapshot.blockHash).toBe(snapshot.sourceHash);
  expect(snapshot.tokenErrors ?? []).toEqual([]);
  expect(snapshot.allowanceErrors ?? []).toEqual([]);
  const jurisdiction = entityJurisdiction ?? await page.evaluate(async entityId => {
    const scope = window as typeof window & { __xln?: { adapter?: {
      query: { viewFrame: (query: { entityId: string; accountsLimit: number; booksLimit: number }) => Promise<{ activeEntity: { core: { config: { jurisdiction: { address: string; chainId: number } } } } }> };
    } } };
    if (!scope.__xln?.adapter) throw new Error('E2E_REMOTE_ADAPTER_MISSING');
    return (await scope.__xln.adapter.query.viewFrame({ entityId, accountsLimit: 1, booksLimit: 1 })).activeEntity.core.config.jurisdiction;
  }, input.entityId);
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const result = await page.request.post(jurisdiction.address, { data: { jsonrpc: '2.0', id: 1, method, params } });
    expect(result.ok()).toBe(true);
    const body = await result.json() as { result?: unknown; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    return body.result;
  };
  expect(BigInt(await rpc('eth_chainId', []) as string)).toBe(BigInt(jurisdiction.chainId));
  const blockTag = `0x${snapshot.sourceHeight.toString(16)}`;
  const block = await rpc('eth_getBlockByNumber', [blockTag, false]) as { hash: string };
  expect(snapshot.sourceHash.toLowerCase()).toBe(block.hash.toLowerCase());
  expect(BigInt(snapshot.nativeBalance)).toBe(BigInt(await rpc('eth_getBalance', [input.owner, blockTag]) as string));
  if (input.tokenAddresses.length > 0) {
    expect(snapshot.tokenBalances.map(row => row.tokenAddress)).toEqual(input.tokenAddresses.map(address => address.toLowerCase()));
  }
  expect(snapshot.tokenBalances.length).toBeGreaterThan(0);
  for (const row of snapshot.tokenBalances) {
    expect(row.error).toBeUndefined();
    const data = erc20.encodeFunctionData('balanceOf', [input.owner]);
    const raw = await rpc('eth_call', [{ to: row.tokenAddress, data }, blockTag]);
    expect(BigInt(row.balance)).toBe(erc20.decodeFunctionResult('balanceOf', raw as string)[0]);
  }
  expect(snapshot.allowances.map(row => [row.tokenAddress, row.spender])).toEqual(
    input.allowances.map(row => [row.tokenAddress.toLowerCase(), row.spender.toLowerCase()]),
  );
  for (const row of snapshot.allowances) {
    expect(row.error).toBeUndefined();
    const data = erc20.encodeFunctionData('allowance', [input.owner, row.spender]);
    const raw = await rpc('eth_call', [{ to: row.tokenAddress, data }, blockTag]);
    expect(BigInt(row.allowance)).toBe(erc20.decodeFunctionResult('allowance', raw as string)[0]);
  }
};

export const verifyExternalWalletSnapshotEvidence = async (page: Page, response: Response): Promise<WalletRequest> => {
  expect(response.status()).toBe(200);
  const input = response.request().postDataJSON() as WalletRequest;
  await verifyWalletSnapshot(page, input, await response.json() as WalletSnapshot);
  return input;
};

export const verifySiblingWalletDomains = async (page: Page, endpoint: string, initial: WalletRequest, runtimeId: string): Promise<void> => {
  const siblings = await page.evaluate(async ownerRuntimeId => {
    type Entity = { entityId: string; runtimeId: string; jurisdiction: { address: string; chainId: number; depositoryAddress: string } };
    const scope = window as typeof window & { __xln?: { adapter?: { query: { entities: () => Promise<Entity[]> } } } };
    if (!scope.__xln?.adapter) throw new Error('E2E_REMOTE_ADAPTER_MISSING');
    return (await scope.__xln.adapter.query.entities()).filter(row => row.runtimeId.toLowerCase() === ownerRuntimeId.toLowerCase());
  }, runtimeId);
  expect(new Set(siblings.map(row => row.jurisdiction.chainId)).size).toBeGreaterThanOrEqual(2);
  const sourceHashes = new Set<string>();
  for (const entity of siblings) {
    const input = { ...initial, entityId: entity.entityId, tokenAddresses: [], allowances: [] };
    const response = await page.request.post(endpoint, { data: input });
    expect(response.status()).toBe(200);
    const snapshot = await response.json() as WalletSnapshot;
    await verifyWalletSnapshot(page, input, snapshot, entity.jurisdiction);
    sourceHashes.add(snapshot.sourceHash);
    // Use actual tokens returned for this Entity's chain, never the active-J catalogue.
    const allowanceInput = { ...input, tokenAddresses: snapshot.tokenBalances.map(row => row.tokenAddress),
      allowances: snapshot.tokenBalances.map(row => ({ tokenAddress: row.tokenAddress, spender: entity.jurisdiction.depositoryAddress })) };
    expect(allowanceInput.allowances.length).toBeGreaterThan(0);
    const allowances = await page.request.post(endpoint, { data: allowanceInput });
    expect(allowances.status()).toBe(200);
    await verifyWalletSnapshot(page, allowanceInput, await allowances.json() as WalletSnapshot, entity.jurisdiction);
  }
  expect(sourceHashes.size).toBeGreaterThanOrEqual(2);
};
