#!/usr/bin/env bun

import {
  activateDeploymentCandidate,
  resolveDeploymentRoot,
  rollbackDeploymentCandidate,
  verifyDeploymentCandidateState,
} from './deployment-candidate';

const main = async (): Promise<void> => {
  const [command, rootArg, releaseArg, ...extra] = Bun.argv.slice(2);
  if (!command || !rootArg || extra.length > 0) throw new Error('DEPLOYMENT_CANDIDATE_ARGUMENTS_INVALID');
  const deploymentRoot = resolveDeploymentRoot(rootArg);
  if (command === 'activate') {
    if (!releaseArg) throw new Error('DEPLOYMENT_CANDIDATE_RELEASE_REQUIRED');
    const selection = await activateDeploymentCandidate(resolveDeploymentRoot(releaseArg), deploymentRoot);
    console.info(
      `DEPLOYMENT_CANDIDATE_ACTIVE release=${selection.state.activeReleaseId} ` +
      `rollback=${selection.state.rollbackReleaseId ?? 'none'} path=${selection.activeDirectory}`,
    );
    return;
  }
  if (releaseArg !== undefined) throw new Error('DEPLOYMENT_CANDIDATE_ARGUMENTS_INVALID');
  const selection = command === 'rollback'
    ? await rollbackDeploymentCandidate(deploymentRoot)
    : command === 'verify'
      ? await verifyDeploymentCandidateState(deploymentRoot)
      : null;
  if (selection === null) throw new Error(`DEPLOYMENT_CANDIDATE_COMMAND_INVALID:${command}`);
  console.info(
    `DEPLOYMENT_CANDIDATE_${command.toUpperCase()} release=${selection.state.activeReleaseId} ` +
    `rollback=${selection.state.rollbackReleaseId ?? 'none'} path=${selection.activeDirectory}`,
  );
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
