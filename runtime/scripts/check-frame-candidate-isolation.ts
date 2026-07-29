const frameApplicationPath =
  'runtime/entity/consensus/frame-application.ts';
const runtimeProcessPath = 'runtime/runtime/frame/process.ts';

const frameApplication = await Bun.file(frameApplicationPath).text();
const runtimeProcess = await Bun.file(runtimeProcessPath).text();

if (!frameApplication.includes('createEntityFrameCandidateState(normalized)')) {
  throw new Error('ENTITY_FRAME_TOUCHED_CANDIDATE_MISSING');
}
if (frameApplication.includes('cloneEntityState(normalized)')) {
  throw new Error('ENTITY_FRAME_FULL_STATE_CLONE_FORBIDDEN');
}
if (runtimeProcess.includes('cloneRuntimeState(')) {
  throw new Error('RUNTIME_FRAME_FULL_STATE_CLONE_FORBIDDEN');
}

console.log(
  '✅ Runtime mutates owned State; Entity frames use touched Account candidates',
);

export {};
