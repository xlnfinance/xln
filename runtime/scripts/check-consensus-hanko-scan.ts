#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

const readText = (path: string): string => readFileSync(path, 'utf8');

const assertIncludes = (text: string, needle: string, path: string): void => {
  if (!text.includes(needle)) throw new Error(`${path} is missing required text: ${needle}`);
};

const assertNotMatches = (text: string, pattern: RegExp, path: string, label: string): void => {
  if (pattern.test(text)) throw new Error(`${path} contains forbidden pattern: ${label}`);
};

const assertOrder = (text: string, path: string, markers: string[]): void => {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1);
    if (next < 0) throw new Error(`${path} missing ordered marker: ${marker}`);
    if (next <= cursor) throw new Error(`${path} marker order failed: ${marker}`);
    cursor = next;
  }
};

const accountConsensusPath = 'runtime/account-consensus.ts';
const accountProposePath = 'runtime/account-consensus/propose.ts';
const accountFramePath = 'runtime/account-consensus-frame.ts';
const entityConsensusPath = 'runtime/entity-consensus.ts';
const entityFramePath = 'runtime/entity-consensus-frame.ts';
const hankoSigningPath = 'runtime/hanko/signing.ts';
const hankoBatchPath = 'runtime/hanko/batch.ts';
const jBatchPath = 'runtime/j-batch.ts';
const depositoryPath = 'jurisdictions/contracts/Depository.sol';
const accountContractPath = 'jurisdictions/contracts/Account.sol';
const auditDocPath = 'docs/security/consensus-hanko-scan.md';

const accountConsensus = readText(accountConsensusPath);
const accountPropose = readText(accountProposePath);
const accountFrame = readText(accountFramePath);
const entityConsensus = readText(entityConsensusPath);
const entityFrame = readText(entityFramePath);
const hankoSigning = readText(hankoSigningPath);
const hankoBatch = readText(hankoBatchPath);
const jBatch = readText(jBatchPath);
const depository = readText(depositoryPath);
const accountContract = readText(accountContractPath);
const auditDoc = readText(auditDocPath);

assertNotMatches(accountConsensus, /\bjHeight\s*\|\|/g, accountConsensusPath, 'jHeight || fallback');
assertNotMatches(accountPropose, /\bjHeight\s*\|\||entityJHeight\s*\|\|/g, accountProposePath, 'jHeight/entityJHeight || fallback');
assertIncludes(accountPropose, 'const frameJHeight = entityJHeight ?? accountMachine.lastFinalizedJHeight ?? 0;', accountProposePath);
assertIncludes(accountConsensus, 'const pendingJHeight = accountMachine.pendingFrame.jHeight ?? accountMachine.lastFinalizedJHeight ?? 0;', accountConsensusPath);
assertIncludes(accountConsensus, 'const currentJHeight = accountMachine.lastFinalizedJHeight ?? 0;', accountConsensusPath);
assertIncludes(accountConsensus, 'const frameJHeight = receivedFrame.jHeight ?? currentJHeight;', accountConsensusPath);
assertIncludes(accountFrame, "if (typeof frame.jHeight !== 'number' || frame.jHeight < 0)", accountFramePath);
assertIncludes(accountFrame, 'jHeight: frame.jHeight,', accountFramePath);

assertOrder(accountConsensus, accountConsensusPath, [
  'async function validateIncomingFrameOnClone',
  'const clonedMachine = cloneAccountMachine(accountMachine);',
  'const result = await applyAccountTx(',
  'clonedMachine,',
  'true,',
  "assertNoUnilateralSettlementMutation(clonedMachine, beforeSettlement, accountTx, 'receiver/validate');",
  'const stateMismatch = verifyReceiverStateMatchesFrame',
  'const bilateralMismatch = verifyReceiverBilateralDeltas',
  'const frameHashMismatch = await verifySenderFrameHash',
]);

assertOrder(accountConsensus, accountConsensusPath, [
  'async function commitIncomingFrameOnRealState',
  'const commitResult = await applyAccountTx(',
  'accountMachine,',
  'false,',
  "throw new Error(`Frame ${receivedFrame.height} commit failed: ${tx.type} - ${commitResult.error}`);",
  "assertNoUnilateralSettlementMutation(accountMachine, beforeSettlement, tx, 'receiver/commit');",
  'const committedFrame = cloneAccountFrame(receivedFrame);',
  'recordAccountFrameHistory(env, {',
]);

assertOrder(entityConsensus, entityConsensusPath, [
  'const getEntityMempoolAdmissionError = (',
  'if (incoming > LIMITS.MEMPOOL_SIZE)',
  'if (next > LIMITS.MEMPOOL_SIZE)',
  'const admissionError = getEntityMempoolAdmissionError(entityReplica, entityInput);',
  'if (admissionError) {',
  'const workingReplica = cloneEntityReplica(entityReplica);',
  'workingReplica.mempool.push(...entityInput.entityTxs);',
]);
assertIncludes(entityConsensus, 'if (!verifyHashPrecommitSignatures(', entityConsensusPath);
assertIncludes(entityConsensus, 'const committedHankos: HankoString[] = [];', entityConsensusPath);
assertIncludes(entityConsensus, 'const hanko = await buildQuorumHanko(', entityConsensusPath);
assertIncludes(entityConsensus, 'attachHankoWitnessToOutputs(', entityConsensusPath);
assertIncludes(entityConsensus, 'entityOutbox.push(...commitOutputs);', entityConsensusPath);
assertIncludes(entityConsensus, 'jOutbox.push(...commitJOutputs);', entityConsensusPath);

assertIncludes(accountFrame, 'canonicalJurisdictionEventsHash(events)', accountFramePath);
assertIncludes(accountFrame, 'const encoded = safeStringify(frameData);', accountFramePath);
assertIncludes(accountFrame, 'return ethers.keccak256(ethers.toUtf8Bytes(encoded));', accountFramePath);
assertIncludes(entityFrame, 'const encoded = safeStringify(frameData);', entityFramePath);
assertIncludes(entityFrame, 'const hash = ethers.keccak256(ethers.toUtf8Bytes(encoded));', entityFramePath);
assertIncludes(entityFrame, 'lastFinalizedJHeight: newState.lastFinalizedJHeight,', entityFramePath);

assertIncludes(hankoSigning, 'throw new Error(`CRYPTO_DETERMINISM_VIOLATION: signEntityHashes called without env.runtimeSeed', hankoSigningPath);
assertIncludes(hankoSigning, 'const reconstructedEntityId = generateLazyEntityId([signerAddress], 1n).toLowerCase();', hankoSigningPath);
assertIncludes(hankoSigning, 'if (reconstructedEntityId !== entityId.toLowerCase())', hankoSigningPath);
assertIncludes(hankoSigning, 'const eoaSignatures = unpackRealSignatures(hanko.packedSignatures);', hankoSigningPath);
assertIncludes(hankoSigning, 'if (eoaSignatures.length === 0)', hankoSigningPath);
assertIncludes(hankoSigning, 'if (reconstructedBoardHash !== expectedEntityId.toLowerCase())', hankoSigningPath);
assertIncludes(hankoSigning, 'const targetRecovered = recovered.yesEntities.some((entity) =>', hankoSigningPath);

assertIncludes(jBatch, "const BATCH_DOMAIN_SEPARATOR = ethers.keccak256(ethers.toUtf8Bytes('XLN_DEPOSITORY_HANKO_V1'));", jBatchPath);
assertIncludes(jBatch, '[BATCH_DOMAIN_SEPARATOR, chainId, depositoryAddress, encodedBatch, nonce]', jBatchPath);
assertIncludes(hankoBatch, 'const batchHash = computeBatchHankoHash(chainId, depositoryAddress, encodedBatch, nextNonce);', hankoBatchPath);
assertIncludes(depository, 'bytes32 public constant DOMAIN_SEPARATOR = keccak256("XLN_DEPOSITORY_HANKO_V1");', depositoryPath);
assertIncludes(depository, 'Account.computeBatchHankoHash(DOMAIN_SEPARATOR, block.chainid, address(this), encodedBatch, nonce)', depositoryPath);
assertIncludes(depository, 'if (nonce != entityNonces[entityId] + 1) revert E2();', depositoryPath);
assertIncludes(accountContract, 'return keccak256(abi.encodePacked(domainSep, chainId, depository, encodedBatch, nonce));', accountContractPath);

for (const marker of [
  '# Consensus And Hanko Production Scan',
  'Last refreshed: 2026-07-09',
  'bun run security:consensus-hanko',
  'Account frame receive keeps `jHeight=0` valid',
  'Receiver validation runs on a clone before committing',
  'Entity mempool admission is checked before cloning',
  'Batch Hanko domain is bound to `XLN_DEPOSITORY_HANKO_V1`',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

console.log('consensus hanko scan check passed');
