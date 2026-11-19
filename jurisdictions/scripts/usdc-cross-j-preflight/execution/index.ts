import { configureExecutionHost, readExecutionConfig } from './config';

const config = readExecutionConfig(process.argv.slice(2));
configureExecutionHost(config);
if (config.action === 'prepare') {
  const { prepareExecution } = await import('./prepare');
  await prepareExecution(config);
} else {
  const { executeRun } = await import('./flow/run');
  await executeRun(config);
}
