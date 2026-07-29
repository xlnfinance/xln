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

const accountConsensusPaths = [
  'runtime/account/consensus/index.ts',
  'runtime/account/consensus/ack-commit.ts',
  'runtime/account/consensus/incoming-preflight.ts',
];
const accountConsensusPath = accountConsensusPaths.join(', ');
const accountHandlerPaths = [
  'runtime/entity/tx/handlers/account.ts',
  'runtime/entity/tx/handlers/account/committed-input.ts',
];
const accountHandlerPath = accountHandlerPaths.join(', ');
const accountProposePaths = [
  'runtime/account/consensus/propose.ts',
  'runtime/account/consensus/proposal-admission.ts',
];
const accountProposePath = accountProposePaths.join(', ');
const accountFramePath = 'runtime/account/consensus/frame.ts';
const entityConsensusPaths = [
  'runtime/entity/consensus/shared.ts',
  'runtime/entity/consensus/input-ingress.ts',
  'runtime/entity/consensus/input-admission.ts',
  'runtime/entity/consensus/input-consensus.ts',
  'runtime/entity/consensus/frame-application.ts',
  'runtime/entity/consensus/commit-finalization.ts',
  'runtime/entity/consensus/single-signer-frame.ts',
];
const entityConsensusPath = entityConsensusPaths.join(', ');
const envEventsPath = 'runtime/runtime/env-events.ts';
const entityEffectPublicationPath = 'runtime/runtime/entity-input-output.ts';
const entityFramePath = 'runtime/entity/consensus/frame.ts';
const hankoSigningPath = 'runtime/hanko/signing.ts';
const hankoCodecPath = 'runtime/hanko/codec.ts';
const hankoClaimsPath = 'runtime/hanko/claims.ts';
const hankoBatchPath = 'runtime/hanko/batch.ts';
const onchainHankoDomainPath = 'runtime/hanko/onchain-domain.ts';
const jBatchPath = 'runtime/jurisdiction/batch.ts';
const rpcAdapterPaths = [
  'runtime/jadapter/rpc-public.ts',
  'runtime/jadapter/rpc-adapter.ts',
  'runtime/jadapter/rpc-batch-dispute-debug.ts',
  'runtime/jadapter/rpc-lifecycle.ts',
  'runtime/jadapter/rpc-reads.ts',
  'runtime/jadapter/rpc-wallet-writes.ts',
];
const rpcAdapterPath = rpcAdapterPaths.join(', ');
const depositoryPath = 'jurisdictions/contracts/Depository.sol';
const accountContractPath = 'jurisdictions/contracts/Account.sol';
const auditDocPath = 'docs/security/consensus-hanko-scan.md';

const accountConsensus = accountConsensusPaths.map(readText).join('\n');
const accountHandler = accountHandlerPaths.map(readText).join('\n');
const accountPropose = accountProposePaths.map(readText).join('\n');
const accountFrame = readText(accountFramePath);
const entityConsensus = entityConsensusPaths.map(readText).join('\n');
const envEvents = readText(envEventsPath);
const entityEffectPublication = readText(entityEffectPublicationPath);
const entityFrame = readText(entityFramePath);
const hankoSigning = readText(hankoSigningPath);
const hankoCodec = readText(hankoCodecPath);
const hankoClaims = readText(hankoClaimsPath);
const hankoBatch = readText(hankoBatchPath);
const onchainHankoDomain = readText(onchainHankoDomainPath);
const jBatch = readText(jBatchPath);
const rpcAdapter = rpcAdapterPaths.map(readText).join('\n');
const depository = readText(depositoryPath);
const accountContract = readText(accountContractPath);
const auditDoc = readText(auditDocPath);

assertNotMatches(accountConsensus, /\bjHeight\s*\|\|/g, accountConsensusPath, 'jHeight || fallback');
assertNotMatches(accountPropose, /\bjHeight\s*\|\||entityJHeight\s*\|\|/g, accountProposePath, 'jHeight/entityJHeight || fallback');
assertIncludes(
  accountPropose,
  'frameJHeight: entityJHeight ?? account.lastFinalizedJHeight ?? 0,',
  accountProposePath,
);
assertIncludes(accountConsensus, 'const jHeight = pendingFrame.jHeight ?? account.lastFinalizedJHeight ?? 0;', accountConsensusPath);
assertIncludes(
  accountConsensus,
  'frameJHeight: receivedFrame.jHeight ?? account.lastFinalizedJHeight ?? 0,',
  accountConsensusPath,
);
assertIncludes(accountFrame, 'if (!Number.isSafeInteger(frame.jHeight) || frame.jHeight < 0)', accountFramePath);
assertIncludes(accountFrame, 'jHeight: frame.jHeight,', accountFramePath);

assertOrder(accountConsensus, accountConsensusPath, [
  'async function validateIncomingFrameOnClone',
  'const clonedMachine = cloneAccountState(account);',
  'const replayResult = await replayIncomingFrameOnClone(',
  'const frameHashMismatch = await verifySenderFrameHash',
  'const localAccountStateRoot = computeAccountStateRoot(clonedMachine);',
  'localAccountStateRoot !== receivedFrame.accountStateRoot',
  '!accountFrameDeltasEqual(ourFinalDeltas, receivedFrame.deltas)',
  'const proofResult = buildAccountProofBodyFromJurisdictions(env, clonedMachine);',
  'const localProofBodyHash = proofResult.proofBodyHash;',
  'const frameSealError = getDisputeSealRequirementError(',
]);

assertOrder(accountConsensus, accountConsensusPath, [
  'const reexecuteIncomingFrame = async (',
  'const commitResult = await applyAccountTx(',
  'account,',
  'false,',
  "throw new Error(`Frame ${receivedFrame.height} commit failed: ${tx.type} - ${commitResult.error}`);",
  "assertNoUnilateralSettlementMutation(account, beforeSettlement, tx, 'receiver/commit');",
]);
assertOrder(accountConsensus, accountConsensusPath, [
  'async function commitIncomingFrameOnRealState',
  'await reexecuteIncomingFrame(',
  'forkAccountCommitmentCache(validation.clonedMachine, account);',
  'assertLiveCommitMatchesFrame(',
  'account.currentFrame = structuredClone(receivedFrame);',
  'const committedFrame = cloneAccountFrame(receivedFrame);',
  'committedFrames.push({ frame: committedFrame, committedViaNewFrame: true });',
]);
assertNotMatches(
  accountConsensus,
  /\brecordAccountFrameHistory\b/,
  accountConsensusPath,
  'speculative Account history publication',
);
assertOrder(accountHandler, accountHandlerPath, [
  'for (const { frame, committedViaNewFrame } of result.committedFrames ?? []) {',
  'effects.candidateEffects.push({',
  "kind: 'accountFrameHistory',",
]);
assertOrder(envEvents, envEventsPath, [
  'export const publishEntityCandidateEffects = (',
  "if (effect.kind === 'accountFrameHistory') {",
  'recordAccountFrameHistory(env, effect);',
]);
const candidatePublicationCount =
  entityEffectPublication.match(/publishEntityCandidateEffects\(env, /g)?.length ?? 0;
if (candidatePublicationCount !== 1) {
  throw new Error(
    `${entityEffectPublicationPath} must publish candidate effects exactly once after Entity commit; found ${candidatePublicationCount}`,
  );
}
assertOrder(entityConsensus, entityConsensusPath, [
  'const getEntityMempoolAdmissionError = (',
  'if (incoming > LIMITS.MEMPOOL_SIZE)',
  'if (next > LIMITS.MEMPOOL_SIZE)',
  'const admissionError = getEntityMempoolAdmissionError(',
  'replica,',
  'ingressInput,',
  'trustedLocalCrossJurisdiction,',
  'if (admissionError) {',
  'const workingReplica = forkEntityReplicaForInput(replica);',
  'if (!isEntityInputWellFormed(ingressInput)) {',
  'const input = cloneIsolatedEntityInput(ingressInput);',
  'normalizeProposedFrameCollectedSigs(input.proposedFrame);',
  'if (!isEntityInputWellFormed(input)) {',
]);
assertIncludes(entityConsensus, 'const supplied = entityInput.entityTxs ?? [];', entityConsensusPath);
assertIncludes(entityConsensus, 'const secretAware =', entityConsensusPath);
assertIncludes(entityConsensus, 'await appendDefaultProposerAcceptedHtlcReveals(', entityConsensusPath);
assertIncludes(entityConsensus, 'const admitted = appendDefaultProposerCrossJMaterializations(', entityConsensusPath);
assertIncludes(entityConsensus, 'workingReplica.mempool = prioritizeScheduledWakeTransactions(', entityConsensusPath);
assertIncludes(entityConsensus, 'if (!verifyHashPrecommitSignatures(', entityConsensusPath);
assertIncludes(entityConsensus, 'const hankos: HankoString[] = [];', entityConsensusPath);
assertIncludes(entityConsensus, 'await buildQuorumHanko(', entityConsensusPath);
assertIncludes(entityConsensus, 'attachHankoWitnessToOutputs(', entityConsensusPath);
assertIncludes(entityConsensus, 'entityOutbox.push(...commitOutputs);', entityConsensusPath);
assertIncludes(entityConsensus, 'if (isEmitter) jOutbox.push(...execution.jOutputs);', entityConsensusPath);

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
  "version: 'xln:entity-frame:v1',",
  'txs: txs.map(canonicalEntityTxForFrameHash),',
  'stateRoot: stateRoot.toLowerCase(),',
  'authorityRoot: authorityRoot.toLowerCase(),',
  'const encoded = encodeCanonicalConsensusValue(frameData);',
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
