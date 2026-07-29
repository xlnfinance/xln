const frameApplicationPath =
  'runtime/entity/consensus/frame-application.ts';
const singleSignerPath =
  'runtime/entity/consensus/single-signer-frame.ts';
const multiSignerPath =
  'runtime/entity/consensus/multi-signer-proposal.ts';
const runtimeProcessPath = 'runtime/runtime/frame/process.ts';

const frameApplication = await Bun.file(frameApplicationPath).text();
const singleSigner = await Bun.file(singleSignerPath).text();
const multiSigner = await Bun.file(multiSignerPath).text();
const runtimeProcess = await Bun.file(runtimeProcessPath).text();

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
if (!singleSigner.includes('? applyRuntimeOwnedEntityFrame')) {
  throw new Error('SINGLE_SIGNER_RUNTIME_OWNED_FRAME_MISSING');
}
if (multiSigner.includes('applyRuntimeOwnedEntityFrame')) {
  throw new Error('MULTI_SIGNER_RUNTIME_OWNED_FRAME_FORBIDDEN');
}
if (runtimeProcess.includes('cloneRuntimeState(')) {
  throw new Error('RUNTIME_FRAME_FULL_STATE_CLONE_FORBIDDEN');
}

console.log(
  '✅ Runtime/single-signer mutate owned State; multi-signer uses touched candidates',
);

export {};
