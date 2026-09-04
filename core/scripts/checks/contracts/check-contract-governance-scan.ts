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

const assertOccurrenceCount = (text: string, needle: string, expected: number, path: string): void => {
  const actual = text.split(needle).length - 1;
  if (actual !== expected) throw new Error(`${path} expected ${expected} occurrences of ${needle}, got ${actual}`);
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

const getFunctionBody = (source: string, name: string, path: string): string => {
  const header = getFunctionHeader(source, name, path);
  const headerStart = source.indexOf(header.replace(/ /g, ''));
  const nameOffset = source.indexOf(`function ${name}`);
  const bodyStart = source.indexOf('{', Math.max(0, nameOffset, headerStart));
  if (bodyStart < 0) throw new Error(`${path} ${name} body missing`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(bodyStart, index + 1);
  }
  throw new Error(`${path} ${name} body is unterminated`);
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
const hankoVerifierPath = 'jurisdictions/contracts/HankoVerifier.sol';
const accountPath = 'jurisdictions/contracts/Account.sol';
const deltaTransformerPath = 'jurisdictions/contracts/DeltaTransformer.sol';
const auditDocPath = 'docs/security/contract-governance-scan.md';

const depository = readText(depositoryPath);
const entityProvider = readText(entityProviderPath);
const hankoVerifier = readText(hankoVerifierPath);
const account = readText(accountPath);
const deltaTransformer = readText(deltaTransformerPath);
const auditDoc = readText(auditDocPath);

for (const [path, source] of [
  [depositoryPath, depository],
  [entityProviderPath, entityProvider],
  [hankoVerifierPath, hankoVerifier],
  [accountPath, account],
  [deltaTransformerPath, deltaTransformer],
] as const) {
  for (const forbidden of ['tx.origin', 'selfdestruct', 'onlyOwner', 'Ownable']) {
    assertNotIncludes(source, forbidden, path);
  }
}

assertFunctionAllowlist(depository, depositoryPath, [
  'adminRegisterExternalToken',
  'computeWatchtowerCounterDisputeHash',
  'enforceDebts',
  'getHashLadderReveal',
  'getTokensLength',
  'mintToReserve',
  'onERC1155Received',
  'processBatch',
  'registerExternalToken',
  'watchtowerCounterDispute',
]);

assertFunctionAllowlist(deltaTransformer, deltaTransformerPath, [
  'applyBatch',
  'containsPull',
  'decodeArgumentsStrict',
  'decodeTransformerArgumentListStrict',
  'encodeBatch',
  'revealSecret',
]);

assertFunctionAllowlist(entityProvider, entityProviderPath, [
  'activateBoard',
  'bindShareDepository',
  'cancelBoardProposal',
  'commitBoard',
  'dividendBalanceAt',
  'foundationAddShareDepository',
  'foundationRegisterExternalToken',
  'shareDepositories',
  'shareDepository',
  'computeWatchtowerMinSequenceHankoHash',
  'setWatchtowerMinSequence',
  'cancelEntityProviderAction',
  'computeBoardProposalCancelHash',
  'computeBoardProposalHash',
  'computeFoundationActionHash',
  'entityTransferTokens',
  'encodeEntityTransferHankoPayload',
  'encodeBoardProposalCancelHankoPayload',
  'encodeBoardProposalHankoPayload',
  'computeEntityTransferHankoHash',
  'encodeCancelEntityProviderActionHankoPayload',
  'computeCancelEntityProviderActionHankoHash',
  'encodeReleaseControlSharesHankoPayload',
  'computeReleaseControlSharesHankoHash',
  'foundationRegisterEntity',
  'getEntityInfo',
  'getTokenIds',
  'proposeBoard',
  'registerNumberedEntitiesBatch',
  'registerNumberedEntity',
  'releaseControlShares',
  'verifyHankoSignature',
  'verifyCurrentHankoSignature',
]);
// Removed dead surface (zero production callers): resolveEntityId,
// getGovernanceInfo, getEntityFromToken. Do not reintroduce without callers.

// Deployment authority is deliberately not a public protocol surface. It is
// used only by chain-gated local-dev helpers and must remain immutable.
assertIncludes(depository, 'address private immutable admin;', depositoryPath);
assertIncludes(depository, 'uint256 private constant LOCAL_DEV_CHAIN_ID = 31337;', depositoryPath);
assertIncludes(depository, 'uint256 private constant SECONDARY_LOCAL_DEV_CHAIN_ID = 31338;', depositoryPath);
assertIncludes(depository, 'msg.sender != admin', depositoryPath);
assertIncludes(depository, 'block.chainid != LOCAL_DEV_CHAIN_ID', depositoryPath);
assertIncludes(depository, 'block.chainid != SECONDARY_LOCAL_DEV_CHAIN_ID', depositoryPath);
assertFunctionHeaderIncludes(depository, depositoryPath, 'processBatch', 'external nonReentrant');
assertFunctionHeaderIncludes(depository, depositoryPath, 'watchtowerCounterDispute', 'external nonReentrant');
assertFunctionHeaderIncludes(depository, depositoryPath, 'mintToReserve', 'external onlyLocalDevAdmin');
assertFunctionHeaderIncludes(depository, depositoryPath, 'adminRegisterExternalToken', 'external onlyLocalDevAdmin nonReentrant');
const tokenRegistration = getFunctionBody(depository, 'registerExternalToken', depositoryPath);
// Listing authority is the EntityProvider (Foundation Hanko), never a key.
assertIncludes(
  tokenRegistration,
  'if (msg.sender != entityProvider) revert E2();',
  `${depositoryPath}:registerExternalToken`,
);
assertNotIncludes(tokenRegistration, 'admin', `${depositoryPath}:registerExternalToken`);
assertFunctionHeaderIncludes(depository, depositoryPath, 'enforceDebts', 'external nonReentrant');
const erc1155Receiver = getFunctionBody(depository, 'onERC1155Received', depositoryPath);
assertIncludes(erc1155Receiver, 'msg.sender != entityProvider', `${depositoryPath}:onERC1155Received`);
assertIncludes(
  erc1155Receiver,
  'from != entityTreasury(entityNumber)',
  `${depositoryPath}:onERC1155Received`,
);
assertIncludes(depository, 'Account.computeBatchHankoHash(DOMAIN_SEPARATOR, encodedBatch, nonce)', depositoryPath);
assertIncludes(depository, 'if (nonce != entityNonces[entityId] + 1) revert E2();', depositoryPath);
assertIncludes(depository, 'entityNonces[entityId] = nonce;', depositoryPath);
const watchtowerRegistration = getFunctionBody(account, 'registerWatchtowerCounterDispute', accountPath);
assertIncludes(
  watchtowerRegistration,
  'if (account.disputeHash == bytes32(0)) revert IDepositoryDelegateErrorAbi.E5();',
  `${accountPath}:registerWatchtowerCounterDispute`,
);
assertIncludes(
  watchtowerRegistration,
  'if (params.cooperative || params.sig.length == 0) revert E2();',
  `${accountPath}:registerWatchtowerCounterDispute`,
);
assertIncludes(
  watchtowerRegistration,
  'block.timestamp + lastResortWindowSeconds < account.disputeTimeout',
  `${accountPath}:registerWatchtowerCounterDispute`,
);
const watchtowerEntry = getFunctionBody(depository, 'watchtowerCounterDispute', depositoryPath);
assertIncludes(watchtowerEntry, 'Account.registerWatchtowerCounterDispute(', `${depositoryPath}:watchtowerCounterDispute`);
assertIncludes(watchtowerEntry, 'msg.sender,', `${depositoryPath}:watchtowerCounterDispute`);
assertIncludes(watchtowerEntry, 'entityId,', `${depositoryPath}:watchtowerCounterDispute`);
assertIncludes(
  watchtowerRegistration,
  'if (!valid || recoveredEntity != entityId) revert E4();',
  `${accountPath}:registerWatchtowerCounterDispute`,
);

// Historical board authority exists only for bilateral dispute evidence. Every
// direct money/governance action must keep using the current-board verifier.
assertOccurrenceCount(account, '.verifyHankoSignature(', 2, accountPath);
for (const name of ['verifyDisputeProofHanko', '_disputeStart'] as const) {
  assertIncludes(getFunctionBody(account, name, accountPath), '.verifyHankoSignature(', `${accountPath}:${name}`);
}

assertNotIncludes(entityProvider, 'onlyFoundation', entityProviderPath);
assertIncludes(entityProvider, '_verifyCurrentHankoSignature(hankoData, actionHash)', entityProviderPath);
assertIncludes(entityProvider, 'entityActionNonces[foundationId] = actionNonce;', entityProviderPath);
for (const name of [
  'foundationRegisterEntity',
  'foundationRegisterExternalToken',
  'foundationAddShareDepository',
] as const) {
  assertIncludes(
    getFunctionBody(entityProvider, name, entityProviderPath),
    '_authorizeFoundation(',
    `${entityProviderPath}:${name}`,
  );
}
for (const [name, requiredText] of [
  ['proposeBoard', '_requireBoardAuthority(entityId, proposerType, proposalHash, authorizations);'],
  ['cancelBoardProposal', '_requireBoardAuthority(entityId, proposerType, cancelHash, authorizations);'],
  ['entityTransferTokens', '(bytes32 recoveredEntityId, bool valid) = _verifyCurrentHankoSignature(hankoData, transferHash);'],
  ['releaseControlShares', '(bytes32 recoveredEntityId, bool valid) = _verifyCurrentHankoSignature(hankoData, releaseHash);'],
  ['cancelEntityProviderAction', '(bytes32 recoveredEntityId, bool valid) = _verifyCurrentHankoSignature(hankoData, cancelHash);'],
] as const) {
  assertIncludes(entityProvider, requiredText, `${entityProviderPath}:${name}`);
}
assertIncludes(
  getFunctionBody(entityProvider, 'activateBoard', entityProviderPath),
  'require(block.timestamp >= entity.activateAt, "Delay period not met");',
  `${entityProviderPath}:activateBoard`,
);
assertIncludes(hankoVerifier, 'if (hanko.claims.length == 0) return (bytes32(0), false);', hankoVerifierPath);
assertIncludes(hankoVerifier, 'if (signatureCount == 0 && memberCount == 0) return (bytes32(0), false);', hankoVerifierPath);
assertIncludes(hankoVerifier, 'if (signer == address(0)) return new address[](0);', hankoVerifierPath);
assertIncludes(hankoVerifier, 'if (nestedIndex >= claimIndex) revert InvalidHankoClaimOrder();', hankoVerifierPath);
assertIncludes(hankoVerifier, 'revert DuplicateHankoClaimEntity();', hankoVerifierPath);
assertNotIncludes(entityProvider, 'eoaVotingPower', entityProviderPath);
assertIncludes(entityProvider, 'entityActionNonces[entityId] = actionNonce;', entityProviderPath);
assertIncludes(entityProvider, 'event EntityProviderActionExecuted(', entityProviderPath);
assertIncludes(entityProvider, 'event EntityProviderActionCancelled(', entityProviderPath);
assertIncludes(entityProvider, 'EntityProviderActionKind.ENTITY_TRANSFER', entityProviderPath);
assertIncludes(entityProvider, 'EntityProviderActionKind.RELEASE_CONTROL_SHARES', entityProviderPath);
assertNotIncludes(entityProvider, 'boardHashToEntityId', entityProviderPath);
assertNotIncludes(entityProvider, 'Board hash already registered', entityProviderPath);
assertNotIncludes(entityProvider, 'function recoverEntity(', entityProviderPath);

for (const marker of [
  '# Contract Governance And Access-Control Scan',
  'Last refreshed: 2026-08-09',
  'bun run security:contract-governance',
  'Depository production write path is `processBatch()`',
  'Local-dev helpers are chain-gated',
  'Foundation-only naming/quota functions require a replay-protected Hanko',
  'No `tx.origin`, `selfdestruct`, `Ownable`, or `onlyOwner` usage',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

checkOnchainHankoAst();
console.log('contract governance scan check passed');
