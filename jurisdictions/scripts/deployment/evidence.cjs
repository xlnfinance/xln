/** Sanitized diagnostics and actual artifact hashes; Ignition owns the sole transaction journal. */
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const candidatePaths = ['jurisdictions/tasks', 'jurisdictions/scripts/deployment/dispatch.cjs', 'jurisdictions/scripts/deploy-stack.cjs', 'jurisdictions/scripts/foundation-hanko.cjs',
  'jurisdictions/scripts/compiler/local-solc.ts', 'jurisdictions/hardhat.config.ts', 'jurisdictions/package.json',
  'package.json', 'bun.lock', 'core/hanko', 'core/account/crypto.ts', 'core/entity/factory.ts', 'core/entity/id.ts',
  'core/protocol/crypto', 'core/protocol/serialization', 'core/support/bytes', 'core/scripts/deployment/stack-manager.ts',
  'core/jurisdiction/adapter/stack-manager', 'jurisdictions/contracts', 'jurisdictions/scripts/deployment'];

const sourceFiles = (root, path) => {
  const { statSync } = require('node:fs');
  return statSync(join(root, path)).isDirectory()
    ? readdirSync(join(root, path)).flatMap(name => sourceFiles(root, `${path}/${name}`)) : [path];
};

const captureCandidateSources = () => {
  const root = join(__dirname, '../../..');
  return Object.fromEntries(candidatePaths.flatMap(path => sourceFiles(root, path)).sort().map(path =>
    [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
};

const candidateRevision = () => {
  const cwd = join(__dirname, '../../..');
  return { sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().length > 0 };
};

const captureArtifactDigests = (artifactDirectory, relativeDirectory = '') => {
  const artifacts = {};
  for (const entry of readdirSync(join(artifactDirectory, relativeDirectory), { withFileTypes: true })) {
    const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(artifacts, captureArtifactDigests(artifactDirectory, path));
    else if (entry.isFile()) {
      artifacts[`jurisdictions/artifacts/${path}`] = createHash('sha256').update(readFileSync(join(artifactDirectory, path))).digest('hex');
    }
  }
  return artifacts;
};

const deploymentErrorCode = error => {
  const code = typeof error?.code === 'string' ? error.code : String(error?.message || '').split(':')[0];
  return /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'HARDHAT_DEPLOYMENT_ERROR';
};

const sanitizeDeploymentMessage = (value, privateKeyHex, rpcUrl) => {
  let message = String(value);
  if (privateKeyHex) {
    const key = privateKeyHex.replace(/^0x/i, '');
    message = message.replace(new RegExp(`(?:0x)?${key}`, 'gi'), '[REDACTED_PRIVATE_KEY]');
  }
  if (rpcUrl) message = message.replaceAll(rpcUrl, '[REDACTED_RPC_URL]');
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_RPC_URL]')
    .replaceAll('\n', ' ').replaceAll('\r', ' ').slice(-4_096).trim();
};

module.exports = { captureArtifactDigests, captureCandidateSources, candidateRevision, deploymentErrorCode, sanitizeDeploymentMessage };
