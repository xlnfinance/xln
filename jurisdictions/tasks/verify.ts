import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import { runReadonlyVerification, type VerificationArguments } from '../scripts/deployment/operator/readonly.ts';

export default async function verify(args: VerificationArguments, hre: HardhatRuntimeEnvironment): Promise<void> {
  await runReadonlyVerification(args, hre);
}
