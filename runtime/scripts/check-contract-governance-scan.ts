#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { checkOnchainHankoAst } from './check-onchain-hanko-ast.ts';

const readText = (path: string): string => readFileSync(path, 'utf8');

const assertIncludes = (text: string, needle: string, path: string): void => {
  if (!text.includes(needle)) throw new Error(`${path} is missing required text: ${needle}`);
};

const assertNotIncludes = (text: string, needle: string, path: string): void => {
  if (text.includes(needle)) throw new Error(`${path} contains forbidden text: ${needle}`);
};

const getFunctionHeader = (source: string, name: string, path: string): string => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*function\\s+${escaped}\\s*\\([\\s\\S]*?\\)\\s*([^\\{;]*)[\\{;]`, 'm')
    .exec(source);
  if (!match) throw new Error(`${path} missing function ${name}`);
  return match[0].replace(/\s+/g, ' ').trim();
};

const assertFunctionHeaderIncludes = (source: string, path: string, name: string, needle: string): void => {
  const header = getFunctionHeader(source, name, path);
  if (!header.includes(needle)) {
    throw new Error(`${path} ${name} header missing ${needle}: ${header}`);
  }
};

const externalOrPublicFunctions = (source: string): string[] => {
  const functions: string[] = [];
  const pattern = /^\s*function\s+([A-Za-z0-9_]+)\s*\([\s\S]*?\)\s*([^{;]*)[{;]/gm;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (!name) continue;
    const suffix = match[2] ?? '';
    if (/\b(external|public)\b/.test(suffix)) functions.push(name);
  }
  return Array.from(new Set(functions)).sort();
};

const stripInterfaceBlocks = (source: string): string =>
  source.replace(/^\s*interface\s+[A-Za-z0-9_]+\s*\{[\s\S]*?^\}/gm, '');

const assertFunctionAllowlist = (source: string, path: string, allowed: string[]): void => {
  const actual = externalOrPublicFunctions(stripInterfaceBlocks(source));
  const expected = [...allowed].sort();
  const unexpected = actual.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !actual.includes(name));
  if (unexpected.length || missing.length) {
    throw new Error(
      `${path} external/public surface drift: unexpected=${unexpected.join(',') || '-'} missing=${missing.join(',') || '-'}`,
    );
  }
};

const depositoryPath = 'jurisdictions/contracts/Depository.sol';
const entityProviderPath = 'jurisdictions/contracts/EntityProvider.sol';
const accountPath = 'jurisdictions/contracts/Account.sol';
const auditDocPath = 'docs/security/contract-governance-scan.md';

const depository = readText(depositoryPath);
const entityProvider = readText(entityProviderPath);
const account = readText(accountPath);
const auditDoc = readText(auditDocPath);

for (const [path, source] of [
  [depositoryPath, depository],
  [entityProviderPath, entityProvider],
  [accountPath, account],
] as const) {
  for (const forbidden of ['tx.origin', 'selfdestruct', 'onlyOwner', 'Ownable']) {
    assertNotIncludes(source, forbidden, path);
  }
}

assertFunctionAllowlist(depository, depositoryPath, [
  'accountKey',
  'adminRegisterExternalToken',
  'computeWatchtowerCounterDisputeHash',
  'decodeTransformerArgumentListStrict',
  'enforceDebts',
  'getTokensLength',
  'mintToReserve',
  'onERC1155BatchReceived',
  'onERC1155Received',
  'processBatch',
  'spendableReserve',
  'watchtowerCounterDispute',
]);

assertFunctionAllowlist(entityProvider, entityProviderPath, [
  'activateBoard',
  'assignName',
  'batchVerifyHankoSignatures',
  'cancelBoardProposal',
  'entityTransferTokens',
  'encodeEntityTransferHankoPayload',
  'computeEntityTransferHankoHash',
  'encodeReleaseControlSharesHankoPayload',
  'computeReleaseControlSharesHankoHash',
  'foundationRegisterEntity',
  'getEntityFromToken',
  'getEntityInfo',
  'getGovernanceInfo',
  'getTokenIds',
  'proposeBoard',
  'recoverEntity',
  'registerNumberedEntitiesBatch',
  'registerNumberedEntity',
  'releaseControlShares',
  'resolveEntityId',
  'setNameQuota',
  'setReservedName',
  'transferName',
  'verifyHankoSignature',
]);

assertIncludes(depository, 'address public immutable admin;', depositoryPath);
assertIncludes(depository, 'uint256 private constant LOCAL_DEV_CHAIN_ID = 31337;', depositoryPath);
assertIncludes(depository, 'uint256 private constant SECONDARY_LOCAL_DEV_CHAIN_ID = 31338;', depositoryPath);
assertIncludes(depository, 'msg.sender != admin', depositoryPath);
assertIncludes(depository, 'block.chainid != LOCAL_DEV_CHAIN_ID', depositoryPath);
assertIncludes(depository, 'block.chainid != SECONDARY_LOCAL_DEV_CHAIN_ID', depositoryPath);
assertFunctionHeaderIncludes(depository, depositoryPath, 'processBatch', 'external nonReentrant');
assertFunctionHeaderIncludes(depository, depositoryPath, 'watchtowerCounterDispute', 'external nonReentrant');
assertFunctionHeaderIncludes(depository, depositoryPath, 'mintToReserve', 'external onlyLocalDevAdmin');
assertFunctionHeaderIncludes(depository, depositoryPath, 'adminRegisterExternalToken', 'external onlyLocalDevAdmin nonReentrant');
assertIncludes(depository, 'Account.computeBatchHankoHash(DOMAIN_SEPARATOR, encodedBatch, nonce)', depositoryPath);
assertIncludes(depository, 'if (nonce != entityNonces[entityId] + 1) revert E2();', depositoryPath);
assertIncludes(depository, 'entityNonces[entityId] = nonce;', depositoryPath);
assertIncludes(depository, 'if (account.disputeHash == bytes32(0)) revert E5();', depositoryPath);
assertIncludes(depository, 'if (params.cooperative) revert E2();', depositoryPath);
assertIncludes(depository, 'if (params.sig.length == 0) revert E2();', depositoryPath);
assertIncludes(depository, 'if (block.number + lastResortWindowBlocks < account.disputeTimeout) revert E2();', depositoryPath);
assertIncludes(depository, 'msg.sender,\n          entityId,', depositoryPath);
assertIncludes(depository, 'if (!valid || recoveredEntity != entityId) revert E4();', depositoryPath);

for (const [name, required] of [
  ['assignName', 'external onlyFoundation'],
  ['transferName', 'external onlyFoundation'],
  ['setReservedName', 'external onlyFoundation'],
  ['setNameQuota', 'external onlyFoundation'],
  ['foundationRegisterEntity', 'external onlyFoundation'],
] as const) {
  assertFunctionHeaderIncludes(entityProvider, entityProviderPath, name, required);
}
for (const [name, requiredText] of [
  ['proposeBoard', '_validateGovernanceCaller(entityId, msg.sender, articles, proposerType);'],
  ['cancelBoardProposal', '_validateGovernanceCaller(entityId, msg.sender, articles, proposerType);'],
  ['entityTransferTokens', 'uint256 recoveredEntityId = recoverEntity(encodedBoard, encodedSignature, transferHash);'],
  ['releaseControlShares', 'uint256 recoveredEntityId = recoverEntity(encodedBoard, encodedSignature, releaseHash);'],
] as const) {
  assertIncludes(entityProvider, requiredText, `${entityProviderPath}:${name}`);
}
assertIncludes(entityProvider, 'require(block.number >= entities[entityId].activateAtBlock, "Delay period not met");', entityProviderPath);
assertIncludes(entityProvider, 'if (signatureCount == 0)', entityProviderPath);
assertIncludes(entityProvider, 'if (validSignerCount == 0) return (bytes32(0), false);', entityProviderPath);
assertIncludes(entityProvider, 'if (eoaVotingPower < claim.threshold)', entityProviderPath);
assertIncludes(entityProvider, 'entityActionNonces[entityId] = actionNonce;', entityProviderPath);

for (const marker of [
  '# Contract Governance And Access-Control Scan',
  'Last refreshed: 2026-07-09',
  'bun run security:contract-governance',
  'Depository production write path is `processBatch()`',
  'Local-dev helpers are chain-gated',
  'Foundation-only naming/quota functions are token-gated',
  'No `tx.origin`, `selfdestruct`, `Ownable`, or `onlyOwner` usage',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

checkOnchainHankoAst();
console.log('contract governance scan check passed');
