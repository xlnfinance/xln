import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import { runStandaloneDeployment } from '../scripts/deployment/operator/standalone.ts';
import type { DeploymentArguments } from '../scripts/deployment/operator/inputs.ts';

export default async function deploy(args: DeploymentArguments, hre: HardhatRuntimeEnvironment): Promise<void> {
  await runStandaloneDeployment(args, hre);
}
