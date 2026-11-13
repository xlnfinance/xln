/** Existing fixture/wrapped-token callers dispatch explicitly to the same executor. */
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import { runStack, reportFailure } from '../scripts/deployment/dispatch.cjs';

export default async function chainStack(_args: unknown, hre: HardhatRuntimeEnvironment): Promise<void> {
  try { await runStack(hre); } catch (error) { reportFailure(error); }
}
