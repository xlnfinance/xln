import { safeStringify } from '../../protocol/serialization';
// Process fixture for the deployment seam, terminated at observable effects.
import { getBytes } from 'ethers';
import { deployJurisdictionStack } from '../../jurisdiction/adapter/stack-manager/deploy';
import { decodeDeployJurisdictionStackRequest } from '../../jurisdiction/adapter/stack-manager/validation';
import { executionPid } from '../orchestrator/stack-manager-recovery/stack-manager-resume-support';

const input = JSON.parse(await Bun.stdin.text());
const request = decodeDeployJurisdictionStackRequest(input.request);
try {
  const result = await deployJurisdictionStack(request, {
    deploymentId: 'resume-usdc',
    mode: input.mode,
    evidenceDirectory: input.directory,
    signerPrivateKey: getBytes(process.env['DEPLOYER_PRIVATE_KEY']!),
    onPhase: phase => {
      console.error(`STACK_MANAGER_PHASE:${phase}`);
      if (phase === input.cut) {
        // This cut interrupts execution as well as its application caller.
        // A lost caller alone must leave the native owner active.
        if (phase === 'verifying') process.kill(executionPid(process.pid), 'SIGKILL');
        process.kill(process.pid, 'SIGKILL');
      }
    },
    publishJurisdiction: () => {
      console.error('STACK_MANAGER_PUBLISH_CALLBACK');
      if (input.cut === 'catalog-published') process.kill(process.pid, 'SIGKILL');
      return false;
    },
  });
  console.log(safeStringify(result));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
