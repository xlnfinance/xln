import { configureExecutionHost, readExecutionConfig, readExecutionStatusConfig } from './config';

const args = process.argv.slice(2);
if (args[0] === 'status') {
  const { runStatus } = await import('./status');
  await runStatus(readExecutionStatusConfig(args.slice(1)));
} else {
  const config = readExecutionConfig(args);
  if (config.session) {
    const { runSupervised } = await import('./flow/supervised');
    await runSupervised(config, config.session);
  } else if (config.action === 'prepare') {
    configureExecutionHost(config);
    const { prepareExecution } = await import('./prepare');
    await prepareExecution(config);
  } else {
    configureExecutionHost(config);
    const { executeRun } = await import('./flow/run');
    await executeRun(config);
  }
}
