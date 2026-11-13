/** Native Future IDs carry the sealed attempt identity; directory names alone do not. */
const deploymentModuleIds = deploymentId => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(deploymentId)) throw new Error('STACK_MANAGER_DEPLOYMENT_ID_INVALID');
  const suffix = Buffer.from(deploymentId, 'utf8').toString('hex');
  return { stack: `XlnStack_${suffix}`, listing: `XlnListing_${suffix}` };
};

const assertNativeDeploymentIdentity = (prior, deploymentId) => {
  const modules = deploymentModuleIds(deploymentId);
  const ids = [...Object.keys(prior.contracts), ...prior.started, ...prior.successful,
    ...[...prior.failed, ...prior.held, ...prior.timedOut].map(entry => entry.futureId)];
  // Same signer/chain/bytecode is insufficient: a copied attempt B would otherwise
  // certify its contracts as A. Reject foreign native Futures before any send.
  if (ids.some(id => !id.startsWith(`${modules.stack}#`) && !id.startsWith(`${modules.listing}#`))) {
    throw new Error('STACK_MANAGER_IGNITION_ATTEMPT_MISMATCH');
  }
};

module.exports = { deploymentModuleIds, assertNativeDeploymentIdentity };
