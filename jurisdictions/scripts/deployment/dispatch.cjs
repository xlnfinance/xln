/** Thin environment dispatcher for existing fixture/wrapped-token chain callers. */
const { executeStack } = require('../deploy-stack.cjs');
const { prepareExecution } = require('./preflight.cjs');
const { deploymentErrorCode, sanitizeDeploymentMessage } = require('./evidence.cjs');
const { acquireDeploymentLane } = require('./operator/attempt.ts');
const { join } = require('node:path');

async function runStack({ network, artifacts, config }) {
  const connection = await network.create();
  try {
    const [signer] = await connection.ethers.getSigners();
    const chainId = Number((await connection.ethers.provider.getNetwork()).chainId);
    const release = await acquireDeploymentLane(join(config.paths.root, '.xln-deployment-locks'), chainId, signer.address,
      String(process.env.XLN_DEPLOYMENT_ID || ''));
    try {
      const attempt = await prepareExecution({ ethers: connection.ethers, artifacts, config, networkConfig: connection.networkConfig });
      console.log(JSON.stringify(await executeStack({ connection, artifacts, config, attempt }), null, 2));
    } finally { await release(); }
  } finally { await connection.close(); }
}

const reportFailure = error => {
  console.error(`STACK_MANAGER_CHILD_FAILED:${deploymentErrorCode(error)}:${sanitizeDeploymentMessage(
    error?.shortMessage || error?.message || String(error), process.env.DEPLOYER_PRIVATE_KEY, process.env.XLN_STACK_MANAGER_RPC_URL,
  )}`);
  process.exitCode = 1;
};

module.exports = { runStack, reportFailure };
