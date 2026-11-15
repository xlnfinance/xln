/** Native Future IDs carry the sealed attempt identity; directory names alone do not. */
const deploymentModuleIds = deploymentId => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(deploymentId)) throw new Error('STACK_MANAGER_DEPLOYMENT_ID_INVALID');
  const suffix = Buffer.from(deploymentId, 'utf8').toString('hex');
  return { stack: `XlnStack_${suffix}`, listing: `XlnListing_${suffix}` };
};

const assertFutureIds = (ids, deploymentId) => {
  const modules = deploymentModuleIds(deploymentId);
  if (!ids.length) throw new Error('STACK_MANAGER_IGNITION_JOURNAL_INCOMPLETE');
  // Same signer/chain/bytecode is insufficient: a copied attempt B would otherwise
  // certify its contracts as A. Reject foreign native Futures before any send.
  if (ids.some(id => !id.startsWith(`${modules.stack}#`) && !id.startsWith(`${modules.listing}#`))) {
    throw new Error('STACK_MANAGER_IGNITION_ATTEMPT_MISMATCH');
  }
};

const assertNativeDeploymentIdentity = (prior, deploymentId) => assertFutureIds([
  ...Object.keys(prior.contracts), ...prior.started, ...prior.successful,
  ...[...prior.failed, ...prior.held, ...prior.timedOut].map(entry => entry.futureId),
], deploymentId);
const assertNativeJournalIdentity = (messages, deploymentId) => assertFutureIds(
  messages.filter(message => message.futureId !== undefined).map(message => message.futureId), deploymentId,
);

module.exports = { deploymentModuleIds, assertNativeDeploymentIdentity, assertNativeJournalIdentity };
