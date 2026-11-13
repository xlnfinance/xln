/** The public native Ignition engine is the sole transaction/recovery authority. */
const { deploy, DeploymentResultType } = require('@nomicfoundation/ignition-core');
const { HardhatArtifactResolver, errorDeploymentResultToExceptionMessage } = require('@nomicfoundation/hardhat-ignition/helpers');

const executionPolicy = (global = {}, network = {}) => ({
  ...Object.fromEntries(Object.entries(global).filter(([, value]) => value !== undefined)),
  maxRetries: global.maxRetries ?? network.maxRetries,
  retryInterval: global.retryInterval ?? network.retryInterval,
  disableFeeBumping: global.disableFeeBumping ?? network.disableFeeBumping,
  requiredConfirmations: 1,
  blockPollingInterval: global.blockPollingInterval ?? 25,
});

const createModuleDeployer = ({ connection, artifacts, config, attempt }) => async ignitionModule => {
  const network = connection.networkConfig.ignition;
  const policy = executionPolicy(config.ignition, network);
  const result = await deploy({
    artifactResolver: new HardhatArtifactResolver(artifacts),
    provider: connection.provider,
    deploymentDir: attempt.journalDirectory,
    ignitionModule,
    deploymentParameters: {},
    accounts: await connection.provider.request({ method: 'eth_accounts' }),
    defaultSender: attempt.deployer,
    config: Object.fromEntries(Object.entries(policy)
      .filter(([, value]) => value !== undefined)),
    ...Object.fromEntries(['maxFeePerGasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasPrice']
      .filter(key => network[key] !== undefined).map(key => [key, network[key]])),
    disableFeeBumping: policy.disableFeeBumping,
  });
  if (result.type !== DeploymentResultType.SUCCESSFUL_DEPLOYMENT) {
    throw new Error(errorDeploymentResultToExceptionMessage(result));
  }
  return Object.fromEntries(Object.entries(ignitionModule.results).map(([name, future]) => [name, result.contracts[future.id].address]));
};

module.exports = { createModuleDeployer, executionPolicy };
