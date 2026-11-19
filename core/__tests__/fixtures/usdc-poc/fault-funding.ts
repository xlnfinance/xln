import { readFundingConfig } from '../../../../jurisdictions/scripts/usdc-cross-j-preflight/funding/config';
import { runFunding } from '../../../../jurisdictions/scripts/usdc-cross-j-preflight/funding/run';

const [point, ...args] = process.argv.slice(2);
if (!point) throw new Error('FUNDING_INTERRUPTION_POINT_REQUIRED');
await runFunding(readFundingConfig(args), (chainId, stage, hash) => {
  if (`${chainId}:${stage}` === point) {
    console.log(`USDC_FUNDING_INTERRUPTED:${point}:${hash}`);
    process.kill(process.pid, 'SIGKILL');
  }
});
