#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import * as ts from 'typescript';

const readText = (path: string): string => readFileSync(path, 'utf8');

const assertIncludes = (text: string, needle: string, path: string): void => {
  if (!text.includes(needle)) throw new Error(`${path} is missing required text: ${needle}`);
};

/**
 * Require an exact TypeScript initializer while ignoring harmless formatting.
 * This is used for consensus fallbacks whose operator and state ownership are
 * protocol invariants; raw substring checks made the release gate go stale
 * when AccountReplica fields moved under its committed `state` envelope.
 */
const assertInitializer = (path: string, name: string, expected: string): void => {
  const text = readText(path);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const canonical = (value: string): string => value.replace(/\s+/g, '');
  let matched = false;
  const visit = (node: ts.Node): void => {
    const variableInitializer =
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
        ? node.initializer
        : undefined;
    const propertyInitializer =
      ts.isPropertyAssignment(node) && node.name.getText(source) === name ? node.initializer : undefined;
    const initializer = variableInitializer ?? propertyInitializer;
    if (initializer && canonical(initializer.getText(source)) === canonical(expected)) matched = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!matched) throw new Error(`${path} is missing ${name} initializer: ${expected}`);
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

const assertDirectCallCount = (path: string, callee: string, expected: number): void => {
  const text = readText(path);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (count !== expected) throw new Error(`${path} expected ${expected} direct ${callee} call(s), found ${count}`);
};

const accountConsensusPaths = [
  'core/account/consensus/index.ts',
  'core/account/consensus/incoming/ack-commit.ts',
  'core/account/consensus/incoming/preflight.ts',
];
const accountConsensusPath = accountConsensusPaths.join(', ');
const accountHandlerPaths = [
  'core/entity/tx/handlers/account/index.ts',
  'core/entity/tx/handlers/account/committed-input.ts',
];
const accountHandlerPath = accountHandlerPaths.join(', ');
const accountProposePaths = [
  'core/account/consensus/proposal/propose.ts',
  'core/account/consensus/proposal/admission.ts',
];
const accountProposePath = accountProposePaths.join(', ');
const accountFramePath = 'core/account/consensus/frame/hash.ts';
const accountCommitTransitionPath = 'core/account/consensus/frame/commit-transition.ts';
const entityConsensusPaths = [
  'core/entity/consensus/replica-validation.ts',
  'core/entity/consensus/leader/certificates.ts',
  'core/entity/consensus/j-prefix/prefix-round.ts',
  'core/entity/consensus/input/ingress.ts',
  'core/entity/consensus/input/admission.ts',
  'core/entity/consensus/input/consensus.ts',
  'core/entity/consensus/frame/application.ts',
  'core/entity/consensus/commit/finalization.ts',
  'core/entity/consensus/proposal/start.ts',
];
const entityConsensusPath = entityConsensusPaths.join(', ');
const envEventsPath = 'core/runtime/observability/env-events.ts';
const entityEffectPublicationPath = 'core/runtime/admit/entity-input-output.ts';
const entityFramePath = 'core/entity/consensus/frame.ts';
const hankoSigningPath = 'core/hanko/signing.ts';
const hankoCodecPath = 'core/hanko/codec.ts';
const hankoClaimsPath = 'core/hanko/claims.ts';
const hankoBatchPath = 'core/hanko/batch.ts';
const onchainHankoDomainPath = 'core/hanko/onchain-domain.ts';
const jBatchPath = 'core/jurisdiction/machine/batch/index.ts';
const rpcAdapterPaths = [
  'core/jurisdiction/adapter/rpc-public.ts',
  'core/jurisdiction/adapter/rpc/rpc-adapter.ts',
  'core/jurisdiction/adapter/rpc/write/rpc-batch-dispute-debug.ts',
  'core/jurisdiction/adapter/rpc/rpc-lifecycle.ts',
  'core/jurisdiction/adapter/rpc/rpc-reads.ts',
  'core/jurisdiction/adapter/rpc/wallet/rpc-wallet-writes.ts',
];
const rpcAdapterPath = rpcAdapterPaths.join(', ');
const depositoryPath = 'jurisdictions/contracts/Depository.sol';
const accountContractPath = 'jurisdictions/contracts/Account.sol';
const auditDocPath = 'docs/security/consensus-hanko-scan.md';

const accountConsensus = accountConsensusPaths.map(readText).join('\n');
const accountHandler = accountHandlerPaths.map(readText).join('\n');
const accountPropose = accountProposePaths.map(readText).join('\n');
const accountFrame = readText(accountFramePath);
const accountCommitTransition = readText(accountCommitTransitionPath);
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
assertInitializer(
  'core/account/consensus/proposal/admission.ts',
  'frameJHeight',
  'entityJHeight ?? account.state.lastFinalizedJHeight ?? 0',
);
assertInitializer(
  accountCommitTransitionPath,
  'jHeight',
  'frame.jHeight ?? account.state.lastFinalizedJHeight ?? 0',
);
assertInitializer(
  'core/account/consensus/incoming/preflight.ts',
  'frameJHeight',
  'receivedFrame.jHeight ?? account.state.lastFinalizedJHeight ?? 0',
);
assertIncludes(accountFrame, 'if (!Number.isSafeInteger(frame.jHeight) || frame.jHeight < 0)', accountFramePath);
assertIncludes(accountFrame, 'jHeight: frame.jHeight,', accountFramePath);

assertOrder(accountConsensus, accountConsensusPath, [
  'async function validateIncomingFrameOnDraft',
  "'account.receive.frameHash'",
  '() => verifySenderFrameHash(receivedFrame, events)',
  'const transition = timePerfPhase(',
  '() => beginAccountTransition(account)',
  'const clonedMachine = accountTransitionView(transition);',
  'const replayResult = await timePerfPhase(',
  '() => replayIncomingFrameOnClone(',
  'const committed = timePerfPhase(',
  "() => commitAccountTransition(transition, 'incomingValidation')",
  'const validatedMachine = committed.account;',
  'const stateMismatch = validateIncomingCommittedState(',
  'committed.accountStateRoot,',
  'const proofResult = timePerfPhase(',
  '() => buildAccountProofBodyFromJurisdictions(context, validatedMachine)',
  'const localProofBodyHash = proofResult.proofBodyHash;',
  'const frameSealError = getDisputeSealRequirementError(',
]);

assertOrder(accountCommitTransition, accountCommitTransitionPath, [
  'const owner = timePerfPhase(',
  '() => beginAccountTransition(account)',
  'const draft = accountTransitionView(owner);',
  'for (const tx of frame.accountTxs) {',
  'const result = await applyAccountTx(',
  'const committed = timePerfPhase(',
  "() => commitAccountTransition(owner, 'frameCommit')",
  'publishAccountOverlay(account, committed.account);',
  'assertLiveCommitMatchesFrame(',
]);
assertDirectCallCount(accountCommitTransitionPath, 'beginAccountTransition', 1);
assertDirectCallCount(accountCommitTransitionPath, 'commitAccountTransition', 1);
assertDirectCallCount('core/account/consensus/index.ts', 'commitAccountFrameTransition', 0);
assertDirectCallCount('core/account/consensus/incoming/ack-commit.ts', 'commitAccountFrameTransition', 1);
assertOrder(accountConsensus, accountConsensusPath, [
  'async function handleIncomingAccountFrame',
  'if (preflight.rollbackPendingFrame) {',
  'applySameHeightIncomingFrameRollback(account, preflight.receivedFrame, events);',
  'await commitIncomingFrameOnRealState(',
]);
assertOrder(accountConsensus, accountConsensusPath, [
  'async function commitIncomingFrameOnRealState',
  'publishAccountOverlay(account, validation.clonedMachine);',
  'ACCOUNT_OVERLAY_PUBLISH_STATE_IDENTITY_MISMATCH',
  'account.currentFrame = cloneAccountFrame(receivedFrame);',
  'const committedFrame = cloneAccountFrame(receivedFrame);',
  'committedFrames.push({ frame: committedFrame, committedViaNewFrame: true });',
]);
assertNotMatches(
  accountConsensus,
  /\bpending-proposal-replica\b|takePendingProposalReplica|stashPendingProposalReplica/,
  accountConsensusPath,
  'Account pending-proposal replica stash',
);
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
  'if (!isEntityInputWellFormed(ingressInput)) {',
  'const accountInputOnly = Boolean(',
  'const workingReplica = forkEntityReplicaForInput(replica, accountInputOnly);',
  'const input = cloneIsolatedEntityInput(ingressInput);',
  'normalizeProposedFrameCollectedSigs(input.proposedFrame);',
]);
assertIncludes(entityConsensus, 'const supplied = entityInput.entityTxs ?? [];', entityConsensusPath);
assertIncludes(entityConsensus, "if (admitted.every(tx => tx.type === 'accountInput')) {", entityConsensusPath);
assertInitializer(
  'core/entity/consensus/input/admission.ts',
  'admitted',
  'accountWorkOnly ? [] : appendDefaultProposerCrossJMaterializations(env, workingReplica, supplied,)',
);
assertIncludes(entityConsensus, 'workingReplica.mempool = prioritizeScheduledWakeTransactions(', entityConsensusPath);
assertIncludes(entityConsensus, 'if (!verifyHashPrecommitSignatures(', entityConsensusPath);
assertIncludes(entityConsensus, 'const hankos: HankoString[] = [];', entityConsensusPath);
assertIncludes(entityConsensus, 'await buildQuorumHanko(', entityConsensusPath);
assertIncludes(entityConsensus, 'attachHankoWitnessToOutputs(', entityConsensusPath);
assertIncludes(entityConsensus, '...wrapCertifiedEntityOutputs(', entityConsensusPath);
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
  'export const assertEntityFrameTotalByteBudget',
  'const encoded = encodeCanonicalConsensusValue({',
  "domain: 'xln:entity-frame',",
  'txs: canonicalEntityTxsForFrameHash(input.txs),',
  'return encoded;',
  'export function createEntityFrameHashFromStateRoot',
  'stateRoot: stateRoot.toLowerCase(),',
  'authorityRoot: authorityRoot.toLowerCase(),',
  'const encoded = assertEntityFrameTotalByteBudget(frameData);',
  'const hash = keccakTextHash(encoded);',
  'return hash;',
]);
assertOrder(entityFrame, entityFramePath, [
  'const stateRoot = computeCanonicalEntityConsensusStateHash(newState);',
  'const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(newState));',
  'const hash = createEntityFrameHashFromStateRoot(',
]);

assertIncludes(hankoSigning, 'throw new Error(`CRYPTO_DETERMINISM_VIOLATION: signEntityHashes called without env.runtimeSeed', hankoSigningPath);
assertIncludes(hankoSigning, 'const normalizedEntityId = encodeQuorumEntityId(entityId);', hankoSigningPath);
assertIncludes(hankoSigning, 'const singleSignerBoardHash = hashBoard(encodeBoard({', hankoSigningPath);
assertIncludes(hankoSigning, 'if (singleSignerBoardHash !== normalizedEntityId)', hankoSigningPath);
assertNotMatches(
  hankoSigning,
  /\bgenerateLazyEntityId\b/g,
  hankoSigningPath,
  'duplicate lazy board reconstruction',
);
assertDirectCallCount(hankoSigningPath, 'hashBoard', 1);
assertIncludes(hankoSigning, 'const verified = verifyCanonicalHanko({', hankoSigningPath);
assertIncludes(hankoSigning, 'validateBoardAuthority: (entityId, reconstructedBoardHash) => {', hankoSigningPath);
assertIncludes(hankoCodec, 'HANKO_PACKED_SIGNATURE_PADDING_NONZERO', hankoCodecPath);
assertIncludes(hankoCodec, 'if (encodeHankoEnvelope(envelope).toLowerCase() !== canonicalInput)', hankoCodecPath);
assertIncludes(hankoClaims, 'HANKO_FIRST_MEMBER_EOA_REQUIRED', hankoClaimsPath);
assertIncludes(hankoClaims, "if (reachable.size !== claims.length) invalidHanko('HANKO_UNUSED_CLAIM');", hankoClaimsPath);
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
