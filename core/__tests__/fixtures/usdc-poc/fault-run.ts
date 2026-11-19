import {
  configureExecutionHost,
  readExecutionConfig,
} from '../../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/config';

const [point, ...args] = process.argv.slice(2);
if (point !== 'deposit' && point !== 'withdrawal') throw new Error('USDC_FIXTURE_FAULT_POINT_INVALID');
const config = readExecutionConfig(args);
configureExecutionHost(config);
const { executeRun } = await import('../../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/flow/run');
const { installInterruption } = await import('../../../scenarios/usdc-poc/recovery/interrupt');
await executeRun(config, user => installInterruption(user, point));
