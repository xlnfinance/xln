const frameApplicationPath =
  'core/entity/consensus/frame/application.ts';
const singleSignerPath =
  'core/entity/consensus/proposal/single-signer-frame.ts';
const multiSignerPath =
  'core/entity/consensus/proposal/multi-signer.ts';
const runtimeProcessPath = 'core/runtime/frame/process.ts';
const entityInputStagingPath =
  'core/runtime/admit/entity-input-staging.ts';
const entityInputOutputPath =
  'core/runtime/admit/entity-input-output.ts';

const frameApplication = await Bun.file(frameApplicationPath).text();
const singleSigner = await Bun.file(singleSignerPath).text();
const multiSigner = await Bun.file(multiSignerPath).text();
const runtimeProcess = await Bun.file(runtimeProcessPath).text();
const entityInputStaging = await Bun.file(entityInputStagingPath).text();
const entityInputOutput = await Bun.file(entityInputOutputPath).text();

if (
  !frameApplication.includes(
    '? createEntityFrameCandidateState(normalized)',
  )
) {
  throw new Error('ENTITY_FRAME_TOUCHED_CANDIDATE_MISSING');
}
if (frameApplication.includes('cloneEntityState(normalized)')) {
  throw new Error('ENTITY_FRAME_FULL_STATE_CLONE_FORBIDDEN');
}
if (!/export const applyRuntimeOwnedEntityFrame[\s\S]*?frameTimestamp,\s*true,\s*\);/.test(frameApplication)) {
  throw new Error('SINGLE_SIGNER_ENTITY_CANDIDATE_BOUNDARY_MISSING');
}
if (!singleSigner.includes('? applyRuntimeOwnedEntityFrame')) {
  throw new Error('SINGLE_SIGNER_CROSS_J_RUNTIME_OWNED_FRAME_MISSING');
}
if (multiSigner.includes('applyRuntimeOwnedEntityFrame')) {
  throw new Error('MULTI_SIGNER_RUNTIME_OWNED_FRAME_FORBIDDEN');
}
if (runtimeProcess.includes('cloneRuntimeState(')) {
  throw new Error('RUNTIME_FRAME_FULL_STATE_CLONE_FORBIDDEN');
}
if (
  !/stageExternalEntityInput\([\s\S]*?options,\s*false,(\s*deferProposal,)?\s*\)/.test(
    entityInputStaging,
  ) ||
  !/commitEntityFrameCandidateState\(\s*staged\.result\.nextReplica\.state,/.test(entityInputStaging)
) {
  throw new Error('ORDINARY_ENTITY_INPUT_CANDIDATE_BOUNDARY_MISSING');
}
if (
  !/applyEntityInputToReplica\([\s\S]*?options\.isReplay,\s*true,\s*command\.kind === 'entity-txs' \? 'cross-j' : 'account-work',?\s*\)/.test(
    entityInputOutput,
  )
) {
  throw new Error('CROSS_J_RUNTIME_OWNED_FRAME_BOUNDARY_MISSING');
}

console.log(
  '✅ Every Entity frame uses a dirty-path candidate; no Runtime-owned mutation shortcut',
);

export {};
