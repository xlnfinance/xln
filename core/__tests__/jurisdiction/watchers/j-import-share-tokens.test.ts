import { expect, test } from 'bun:test';
import { createEmptyEnv } from '../../../runtime';
import { normalizeJurisdictionImportRequest } from '../../../runtime/j-submit/jurisdiction-import-request';
import {
  applyCompleteImportJurisdiction,
  buildJurisdictionImportRequestHash,
} from '../../../runtime/j-submit/jurisdiction-import';
import type { JurisdictionImportResult } from '../../../runtime/types';

function importShares(externalIds: bigint[]) {
  const env = createEmptyEnv('share-token-import');
  const contracts = {
    depository: `0x${'11'.repeat(20)}`,
    entityProvider: `0x${'22'.repeat(20)}`,
    account: `0x${'33'.repeat(20)}`,
    deltaTransformer: `0x${'44'.repeat(20)}`,
  };
  const request = normalizeJurisdictionImportRequest({
    name: 'Shares',
    chainId: 31337,
    ticker: 'ETH',
    rpcs: ['http://127.0.0.1:8545'],
    entityProviderDeploymentBlock: 1,
    contracts,
  });
  const requestHash = buildJurisdictionImportRequestHash(request);
  env.infrastructure ??= {};
  env.infrastructure.pendingJurisdictionImports = new Map([
    [requestHash, { importId: requestHash, requestHash, request }],
  ]);
  const data: JurisdictionImportResult = {
    ...request,
    importId: requestHash,
    requestHash,
    blockNumber: '1',
    stateRoot: null,
    watcherConfirmationDepth: 0,
    entityProviderDeploymentBlock: 1,
    contracts,
    tokenRegistry: externalIds.map((externalTokenId, index) => ({
      tokenId: index + 1,
      tokenType: 2,
      address: contracts.entityProvider,
      externalTokenId,
      decimals: 0,
      name: 'Company share',
      symbol: `SHARE${index}`,
    })),
  };
  return { env, apply: () => applyCompleteImportJurisdiction(env, { type: 'completeImportJ', data }) };
}

test('completeImportJ accepts different ERC1155 company share ids at one EntityProvider', () => {
  const { env, apply } = importShares([4n, 5n, 6n, 7n]);
  apply();
  expect(env.state.jReplicas.get('Shares')!.tokenRegistry!.map(token => token.externalTokenId)).toEqual([
    4n,
    5n,
    6n,
    7n,
  ]);
  apply(); // Exact re-delivery remains idempotent.
  expect(env.state.jReplicas.size).toBe(1);
});

test('completeImportJ rejects the same ERC1155 identity under two internal ids before publishing', () => {
  const { env, apply } = importShares([4n, 4n]);
  expect(apply).toThrow('IMPORT_J_RESULT_TOKEN_1_REFERENCE_DUPLICATE');
  expect(env.state.jReplicas.size).toBe(0);
});
