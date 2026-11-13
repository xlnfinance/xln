/** The public native Ignition engine is the sole transaction/recovery authority. */
const { deploy, DeploymentResultType } = require('@nomicfoundation/ignition-core');
const { HardhatArtifactResolver, errorDeploymentResultToExceptionMessage } = require('@nomicfoundation/hardhat-ignition/helpers');
const { assertBroadcastNonce } = require('./nonces.cjs');
const { assertNativeReceipts } = require('./receipts.cjs');

const executionPolicy = (global = {}, network = {}) => ({
  ...Object.fromEntries(Object.entries(global).filter(([, value]) => value !== undefined)),
  maxRetries: global.maxRetries ?? network.maxRetries,
  retryInterval: global.retryInterval ?? network.retryInterval,
  disableFeeBumping: global.disableFeeBumping ?? network.disableFeeBumping,
  requiredConfirmations: 1,
  blockPollingInterval: global.blockPollingInterval ?? 25,
});

const nativeDeploymentOptions = (config, networkConfig) => {
  const network = networkConfig.ignition;
  const policy = executionPolicy(config.ignition, network);
  return { config: Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined)),
    ...Object.fromEntries(['maxFeePerGasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasPrice']
      .filter(key => network[key] !== undefined).map(key => [key, network[key]])),
    ...(policy.disableFeeBumping === undefined ? {} : { disableFeeBumping: policy.disableFeeBumping }) };
};

const createModuleDeployer = ({ connection, artifacts, config, attempt }) => async ignitionModule => {
  const provider = { request: async request => {
    if (request.method === 'eth_sendTransaction') {
      await assertBroadcastNonce(attempt, request.params[0]);
      await assertNativeReceipts(attempt.journalDirectory, connection.ethers.provider);
    }
    return connection.provider.request(request);
  } };
  const result = await deploy({
    artifactResolver: new HardhatArtifactResolver(artifacts),
    provider,
    deploymentDir: attempt.journalDirectory,
    ignitionModule,
    deploymentParameters: {},
    accounts: await connection.provider.request({ method: 'eth_accounts' }),
    defaultSender: attempt.deployer,
    ...nativeDeploymentOptions(config, connection.networkConfig),
  });
  if (result.type !== DeploymentResultType.SUCCESSFUL_DEPLOYMENT) {
    throw new Error(errorDeploymentResultToExceptionMessage(result));
  }
  return Object.fromEntries(Object.entries(ignitionModule.results).map(([name, future]) => [name, result.contracts[future.id].address]));
};

module.exports = { createModuleDeployer, executionPolicy, nativeDeploymentOptions };
