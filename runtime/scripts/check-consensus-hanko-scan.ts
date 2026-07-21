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

const accountConsensusPath = 'runtime/account/consensus/index.ts';
const accountProposePath = 'runtime/account/consensus/propose.ts';
const accountFramePath = 'runtime/account/consensus/frame.ts';
const entityConsensusPath = 'runtime/entity/consensus/index.ts';
const entityFramePath = 'runtime/entity/consensus/frame.ts';
const hankoSigningPath = 'runtime/hanko/signing.ts';
const hankoCodecPath = 'runtime/hanko/codec.ts';
const hankoClaimsPath = 'runtime/hanko/claims.ts';
const hankoBatchPath = 'runtime/hanko/batch.ts';
const onchainHankoDomainPath = 'runtime/hanko/onchain-domain.ts';
const jBatchPath = 'runtime/jurisdiction/batch.ts';
const rpcAdapterPath = 'runtime/jadapter/rpc.ts';
const depositoryPath = 'jurisdictions/contracts/Depository.sol';
const accountContractPath = 'jurisdictions/contracts/Account.sol';
const auditDocPath = 'docs/security/consensus-hanko-scan.md';

const accountConsensus = readText(accountConsensusPath);
const accountPropose = readText(accountProposePath);
const accountFrame = readText(accountFramePath);
const entityConsensus = readText(entityConsensusPath);
const entityFrame = readText(entityFramePath);
const hankoSigning = readText(hankoSigningPath);
const hankoCodec = readText(hankoCodecPath);
const hankoClaims = readText(hankoClaimsPath);
const hankoBatch = readText(hankoBatchPath);
const onchainHankoDomain = readText(onchainHankoDomainPath);
const jBatch = readText(jBatchPath);
const rpcAdapter = readText(rpcAdapterPath);
const depository = readText(depositoryPath);
const accountContract = readText(accountContractPath);
const auditDoc = readText(auditDocPath);

assertNotMatches(accountConsensus, /\bjHeight\s*\|\|/g, accountConsensusPath, 'jHeight || fallback');
assertNotMatches(accountPropose, /\bjHeight\s*\|\||entityJHeight\s*\|\|/g, accountProposePath, 'jHeight/entityJHeight || fallback');
assertIncludes(accountPropose, 'const frameJHeight = entityJHeight ?? accountMachine.lastFinalizedJHeight ?? 0;', accountProposePath);
assertIncludes(accountConsensus, 'const pendingJHeight = accountMachine.pendingFrame.jHeight ?? accountMachine.lastFinalizedJHeight ?? 0;', accountConsensusPath);
assertIncludes(accountConsensus, 'const currentJHeight = accountMachine.lastFinalizedJHeight ?? 0;', accountConsensusPath);
assertIncludes(accountConsensus, 'const frameJHeight = receivedFrame.jHeight ?? currentJHeight;', accountConsensusPath);
assertIncludes(accountFrame, 'if (!Number.isSafeInteger(frame.jHeight) || frame.jHeight < 0)', accountFramePath);
assertIncludes(accountFrame, 'jHeight: frame.jHeight,', accountFramePath);

assertOrder(accountConsensus, accountConsensusPath, [
  'async function validateIncomingFrameOnClone',
  'const clonedMachine = cloneAccountMachine(accountMachine);',
  'const result = await applyAccountTx(',
  'clonedMachine,',
  'true,',
  "assertNoUnilateralSettlementMutation(clonedMachine, beforeSettlement, accountTx, 'receiver/validate');",
  'const frameHashMismatch = await verifySenderFrameHash',
  'const localAccountStateRoot = computeAccountStateRoot(clonedMachine);',
  'localAccountStateRoot !== receivedFrame.accountStateRoot',
  '!accountFrameDeltasEqual(ourFinalDeltas, receivedFrame.deltas)',
  'const proofResult = buildAccountProofBodyFromEnv(env, clonedMachine);',
  'const localProofBodyHash = proofResult.proofBodyHash;',
  'const frameSealError = disputeSealRequirementError(',
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
  'const admissionError = getEntityMempoolAdmissionError(',
  'entityReplica,',
  'entityInput,',
  'trustedLocalCrossJurisdiction,',
  'if (admissionError) {',
  'const ingressEntityInput = entityInput;',
  'const workingReplica = cloneEntityReplica(entityReplica);',
  'if (!validateEntityInput(ingressEntityInput)) {',
  'entityInput = cloneIsolatedEntityInput(ingressEntityInput);',
  'const suppliedEntityTxs = entityInput.entityTxs ?? [];',
  'const secretAwareEntityTxs = localCanPropose && suppliedEntityTxs.length > 0',
  '? await appendDefaultProposerAcceptedHtlcReveals(env, workingReplica, suppliedEntityTxs)',
  ': suppliedEntityTxs;',
  'const admittedEntityTxs = appendDefaultProposerCrossJMaterializations(',
  'secretAwareEntityTxs,',
  'workingReplica.mempool = prioritizeScheduledWakeTransactions(',
  'prepareLocallyAuthoredEntityTxs(env, workingReplica.state, workingReplica.signerId, [',
  '...workingReplica.mempool,',
  '...admittedEntityTxs,',
]);
assertIncludes(entityConsensus, 'if (!verifyHashPrecommitSignatures(', entityConsensusPath);
assertIncludes(entityConsensus, 'const committedHankos: HankoString[] = [];', entityConsensusPath);
assertIncludes(entityConsensus, 'const hanko = await buildQuorumHanko(', entityConsensusPath);
assertIncludes(entityConsensus, 'attachHankoWitnessToOutputs(', entityConsensusPath);
assertIncludes(entityConsensus, 'entityOutbox.push(...commitOutputs);', entityConsensusPath);
assertIncludes(entityConsensus, 'if (isFrameLeader) jOutbox.push(...execution.jOutputs);', entityConsensusPath);

assertIncludes(accountFrame, 'canonicalJurisdictionEventsHash(events)', accountFramePath);
assertOrder(accountFrame, accountFramePath, [
  "return computeCanonicalMerkleRoot('account.frame', [",
  "['transition', {",
  "['transactions', frame.accountTxs.map(canonicalAccountTxForFrameHash)],",
  "['deltas', frame.deltas],",
  "['accountStateRoot', frame.accountStateRoot],",
]);
assertOrder(entityFrame, entityFramePath, [
  'const frameData = {',
  "version: 'xln:entity-frame:v4',",
  'txs: txs.map(canonicalEntityTxForFrameHash),',
  'stateRoot: stateRoot.toLowerCase(),',
  'authorityRoot: authorityRoot.toLowerCase(),',
  'const encoded = encodeCanonicalEntityConsensusValue(frameData);',
  'const hash = ethers.keccak256(ethers.toUtf8Bytes(encoded));',
  'return hash;',
]);
assertOrder(entityFrame, entityFramePath, [
  'const stateRoot = computeCanonicalEntityConsensusStateHash(newState);',
  'const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(newState));',
  'const hash = createEntityFrameHashFromStateRoot(',
]);

assertIncludes(hankoSigning, 'throw new Error(`CRYPTO_DETERMINISM_VIOLATION: signEntityHashes called without env.runtimeSeed', hankoSigningPath);
assertIncludes(hankoSigning, 'const normalizedEntityId = encodeQuorumEntityId(entityId);', hankoSigningPath);
assertIncludes(hankoSigning, 'const reconstructedEntityId = generateLazyEntityId([signerAddress], 1n).toLowerCase();', hankoSigningPath);
assertIncludes(hankoSigning, 'if (reconstructedEntityId !== normalizedEntityId)', hankoSigningPath);
assertIncludes(hankoSigning, 'const verified = verifyCanonicalHanko({', hankoSigningPath);
assertIncludes(hankoSigning, 'validateBoardAuthority: (entityId, reconstructedBoardHash) => {', hankoSigningPath);
assertIncludes(hankoCodec, 'HANKO_PACKED_SIGNATURE_PADDING_NONZERO', hankoCodecPath);
assertIncludes(hankoCodec, 'if (encodeHankoEnvelope(envelope).toLowerCase() !== canonicalInput)', hankoCodecPath);
assertIncludes(hankoClaims, 'HANKO_FIRST_MEMBER_EOA_REQUIRED', hankoClaimsPath);
assertIncludes(hankoClaims, "if (reachable.size !== claims.length) throw new Error('HANKO_UNUSED_CLAIM');", hankoClaimsPath);
assertIncludes(hankoClaims, 'claim.delays.boardChangeDelay', hankoClaimsPath);

assertIncludes(onchainHankoDomain, "ethers.toUtf8Bytes('XLN_DEPOSITORY_HANKO_V1')", onchainHankoDomainPath);
assertIncludes(onchainHankoDomain, '[DEPOSITORY_BATCH_HANKO_DOMAIN, chainId, depositoryAddress, encodedBatch, requireUint(nonce,', onchainHankoDomainPath);
assertIncludes(jBatch, 'return hashDepositoryBatchHankoPayload(', jBatchPath);
assertIncludes(hankoBatch, 'const batchHash = computeBatchHankoHash(chainId, depositoryAddress, encodedBatch, nextNonce);', hankoBatchPath);
assertIncludes(depository, 'bytes32 public constant DOMAIN_SEPARATOR = keccak256("XLN_DEPOSITORY_HANKO_V1");', depositoryPath);
assertIncludes(depository, 'Account.computeBatchHankoHash(DOMAIN_SEPARATOR, encodedBatch, nonce)', depositoryPath);
assertIncludes(depository, 'if (nonce != entityNonces[entityId] + 1) revert E2();', depositoryPath);
assertIncludes(accountContract, 'return HankoEncoding.encodeBatch(', accountContractPath);
assertIncludes(accountContract, 'return HankoEncoding.encodeCooperativeUpdate(', accountContractPath);
assertIncludes(accountContract, 'return HankoEncoding.encodeDisputeProof(', accountContractPath);
assertIncludes(accountContract, 'return HankoEncoding.encodeCooperativeDisputeProof(', accountContractPath);
assertIncludes(accountContract, 'block.chainid,\n      address(this),', accountContractPath);
assertIncludes(rpcAdapter, 'const disputeHash = hashDisputeProofHankoPayload(', rpcAdapterPath);
assertNotMatches(
  rpcAdapter,
  /\['uint8',\s*'address',\s*'bytes',\s*'uint256',\s*'bytes32',\s*'bytes32'\]/g,
  rpcAdapterPath,
  'legacy chainless dispute Hanko recomputation',
);

for (const marker of [
  '# Consensus And Hanko Production Scan',
  'Last refreshed: 2026-07-14',
  'bun run security:consensus-hanko',
  'Account frame receive keeps `jHeight=0` valid',
  'Receiver validation runs on a clone before committing',
  'Entity mempool admission is checked before cloning',
  'Batch Hanko domain is bound to `XLN_DEPOSITORY_HANKO_V1`',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

console.log('consensus hanko scan check passed');
