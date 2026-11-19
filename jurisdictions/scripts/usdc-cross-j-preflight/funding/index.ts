#!/usr/bin/env bun
import { readFundingConfig } from './config';
import { sanitizeDeploymentMessage } from '../../deployment/evidence.cjs';

const config = readFundingConfig(process.argv.slice(2));
try {
  if (config.action === 'prepare') {
    const { prepareFunding } = await import('./prepare');
    await prepareFunding(config);
  } else {
    const { runFunding } = await import('./run');
    await runFunding(config);
  }
} catch (error) {
  let message = error instanceof Error ? error.message : 'USDC_FUNDING_FAILED';
  message = sanitizeDeploymentMessage(message, config.action === 'run' ? process.env[config.keyEnv] : '', '');
  for (const key of ['ETH_SEPOLIA_RPC', 'ARB_SEPOLIA_RPC', 'POC_RUNTIME_11155111_RPC', 'POC_RUNTIME_421614_RPC'])
    message = sanitizeDeploymentMessage(message, '', process.env[key]);
  console.error(message);
  process.exitCode = 1;
}
