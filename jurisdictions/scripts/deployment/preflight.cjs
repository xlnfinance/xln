/** Admission and exact artifact binding run before Ignition can submit its first Future. */
const { mkdirSync, openSync, readFileSync, fsyncSync, closeSync, existsSync, cpSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { captureArtifactDigests, captureCandidateSources, candidateRevision } = require('./evidence.cjs');
const { save } = require('./manifest.cjs');
const { assertArtifactPipeline } = require('./artifacts.cjs');
const { STACK_ARTIFACTS } = require('../../../core/jurisdiction/adapter/stack-manager/verification.ts');
const { readCompilerBytecodeEvidence } = require('../../../core/jurisdiction/adapter/stack-manager/compiler-bytecode.ts');
const { nativeDeploymentOptions } = require('./engine.cjs');
const { captureOrigin, verifyOrigin } = require('./origin.cjs');

const readToken = async (ethers, address, decimals) => {
  if (await ethers.provider.getCode(address) === '0x') throw new Error('DEPLOYMENT_TOKEN_CODE_MISSING');
  const token = new ethers.Contract(address, ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], ethers.provider);
  const symbol = await token.symbol();
  if (!symbol.trim() || symbol !== symbol.trim() || Buffer.byteLength(symbol) > 32) throw new Error('STABLECOIN_SYMBOL_INVALID');
  if (Number(await token.decimals()) !== decimals) throw new Error(`DEPLOYMENT_TOKEN_DECIMALS_MISMATCH:expected=${decimals}`);
  return { address, symbol, decimals };
};

const prepareExecution = async ({ ethers, artifacts, config, networkConfig, input = process.env }) => {
  const deploymentId = input.XLN_DEPLOYMENT_ID;
  if (!deploymentId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(deploymentId)) throw new Error('STACK_MANAGER_DEPLOYMENT_ID_INVALID');
  const mode = input.XLN_DEPLOYMENT_MODE;
  if (mode !== 'new' && mode !== 'resume') throw new Error('STACK_MANAGER_DEPLOYMENT_MODE_INVALID');
  const output = input.XLN_DEPLOY_OUTPUT;
  if (!output) throw new Error('XLN_DEPLOY_OUTPUT_REQUIRED');
  const directory = dirname(output);
  const journalDirectory = input.nativeDirectory || join(config.paths.ignition, 'deployments', deploymentId);
  const [deployer] = await ethers.getSigners();
  const privateKey = String(input.DEPLOYER_PRIVATE_KEY || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey) || new ethers.Wallet(privateKey).address !== deployer.address) {
    throw new Error('FOUNDATION_SIGNER_KEY_UNAVAILABLE');
  }
  const foundationRecipient = ethers.getAddress(input.XLN_FOUNDATION_ADDRESS || deployer.address);
  if (foundationRecipient !== deployer.address) throw new Error('FOUNDATION_LISTING_SIGNER_MISMATCH');
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const expectedChainId = Number(input.XLN_STACK_MANAGER_CHAIN_ID || chainId);
  if (expectedChainId !== chainId) throw new Error('STACK_MANAGER_CHAIN_ID_MISMATCH');
  let stablecoin = String(input.XLN_STABLECOIN_ADDRESS || '').trim();
  const fixtureToken = !stablecoin && input.XLN_DEPLOY_TEST_STABLECOIN === '1';
  if (!stablecoin && !fixtureToken) throw new Error('XLN_STABLECOIN_ADDRESS_REQUIRED');
  stablecoin = stablecoin ? await readToken(ethers, ethers.getAddress(stablecoin), 6) : null;
  const wrappedAddress = String(input.XLN_WRAPPED_NATIVE_ADDRESS || '').trim();
  const wrapped = wrappedAddress ? await readToken(ethers, ethers.getAddress(wrappedAddress), 18) : null;
  if (wrapped && (wrapped.address === stablecoin?.address || stablecoin?.symbol === 'WETH')) throw new Error('WRAPPED_NATIVE_DUPLICATES_STABLECOIN');
  for (const { sourceName, contractName } of Object.values(STACK_ARTIFACTS)) {
    assertArtifactPipeline(config.paths.artifacts, await artifacts.readArtifact(`${sourceName}:${contractName}`), config);
    await readCompilerBytecodeEvidence(pathToFileURL(`${join(config.paths.artifacts, 'build-info')}/`), sourceName, contractName);
  }
  if (fixtureToken) assertArtifactPipeline(config.paths.artifacts, await artifacts.readArtifact('ERC20Mock'), config);
  const digests = captureArtifactDigests(config.paths.artifacts);
  const saved = mode === 'resume' ? JSON.parse(readFileSync(`${output}.execution.json`, 'utf8')) : undefined;
  const origin = mode === 'new' ? await captureOrigin(ethers.provider, deployer.address)
    : await verifyOrigin(saved.origin, ethers.provider, deployer.address);
  const identity = { schemaVersion: 1, deploymentId, graphVersion: 'xln-stack-ignition-1', chainId, deployer: deployer.address,
    foundationRecipient, stablecoin, fixtureToken, wrapped, origin, artifacts: digests, sources: captureCandidateSources(), candidateSha: candidateRevision().sha,
    policy: { executionConfirmations: 1, admissionConfirmations: Number(input.XLN_DEPLOY_CONFIRMATIONS || 12),
      native: JSON.parse(JSON.stringify(nativeDeploymentOptions(config, networkConfig), (_, value) => typeof value === 'bigint' ? String(value) : value)) } };
  if (mode === 'new') {
    if (existsSync(journalDirectory)) throw new Error('STACK_MANAGER_DEPLOYMENT_ATTEMPT_EXISTS');
    mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { recursive: !input.nativeDirectory, mode: 0o700 });
    const handle = openSync(output, 'wx', 0o600);
    fsyncSync(handle); closeSync(handle);
  } else if (!existsSync(join(journalDirectory, 'journal.jsonl'))) throw new Error('STACK_MANAGER_IGNITION_JOURNAL_MISSING');
  if (mode === 'resume') {
    if (JSON.stringify(saved) !== JSON.stringify(identity)) throw new Error('STACK_MANAGER_EXECUTION_IDENTITY_MISMATCH');
  } else save(`${output}.execution.json`, identity);
  if (mode === 'new') cpSync(config.paths.artifacts, `${output}.artifacts`, { recursive: true });
  return { deploymentId, mode, output, directory, journalDirectory, privateKey, deployer: deployer.address,
    foundationRecipient, chainId, stablecoin, fixtureToken, wrapped, identity };
};

const publishManifest = save;

module.exports = { prepareExecution, readToken, publishManifest };
