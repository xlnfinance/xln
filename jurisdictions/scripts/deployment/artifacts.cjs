/** The exact current Solidity sources and compiler output must own every deployable artifact. */
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const sha1 = value => createHash('sha1').update(value).digest('hex');

const assertCompilerConfig = (build, artifact, config) => {
  const profile = config.solidity.profiles.default;
  const override = profile.overrides[artifact.sourceName];
  if (!override && profile.compilers.length !== 1) throw new Error('STACK_MANAGER_COMPILER_SELECTION_AMBIGUOUS');
  const compiler = override || profile.compilers[0];
  if (compiler.version !== build.solcVersion || (compiler.type || 'solc') !== build.compilerType) {
    throw new Error(`STACK_MANAGER_COMPILER_IDENTITY_MISMATCH:${artifact.contractName}`);
  }
  for (const field of ['evmVersion', 'viaIR', 'optimizer', 'metadata']) {
    if (!isDeepStrictEqual(compiler.settings[field], build.input.settings[field])) {
      throw new Error(`STACK_MANAGER_COMPILER_SETTINGS_MISMATCH:${artifact.contractName}:${field}`);
    }
  }
  // Hardhat's hh3-sol-build-info-1 identity includes the original compiler path.
  // Rebind it to current resolved config: old valid bytecode must not attest a changed compiler.
  const smallerSolcInput = { ...build.input, sources: Object.fromEntries(Object.entries(build.input.sources)
    .map(([name, source]) => [name, { content: sha1(source.content) }])) };
  const identity = { format: build._format, solcLongVersion: build.solcLongVersion, smallerSolcInput,
    solcConfig: { ...compiler, type: undefined }, userSourceNameMap: build.userSourceNameMap,
    ...(compiler.type && compiler.type !== 'solc' ? { compilerType: compiler.type } : {}),
    ...(build.toolVersions ? { toolVersions: build.toolVersions } : {}) };
  const type = compiler.type && compiler.type !== 'solc' ? `${compiler.type}-` : '';
  if (build.id !== `solc-${compiler.version.replaceAll('.', '_')}-${type}${sha1(JSON.stringify(identity))}`) {
    throw new Error(`STACK_MANAGER_COMPILER_IDENTITY_MISMATCH:${artifact.contractName}`);
  }
};

const assertArtifactPipeline = (directory, artifact, config) => {
  const build = JSON.parse(readFileSync(join(directory, 'build-info', `${artifact.buildInfoId}.json`), 'utf8'));
  const result = JSON.parse(readFileSync(join(directory, 'build-info', `${artifact.buildInfoId}.output.json`), 'utf8'));
  if (build._format !== 'hh3-sol-build-info-1' || build.id !== artifact.buildInfoId
    || result.id !== build.id || build.solcVersion !== require('solc/package.json').version) {
    throw new Error('STACK_MANAGER_COMPILER_IDENTITY_MISMATCH');
  }
  assertCompilerConfig(build, artifact, config);
  const output = result.output.contracts[artifact.inputSourceName][artifact.contractName];
  if (artifact.bytecode !== `0x${output.evm.bytecode.object}` || artifact.deployedBytecode !== `0x${output.evm.deployedBytecode.object}`
    || JSON.stringify(artifact.abi) !== JSON.stringify(output.abi)
    || JSON.stringify(artifact.linkReferences) !== JSON.stringify(output.evm.bytecode.linkReferences)
    || JSON.stringify(artifact.deployedLinkReferences) !== JSON.stringify(output.evm.deployedBytecode.linkReferences)) {
    throw new Error(`STACK_MANAGER_ARTIFACT_BUILD_MISMATCH:${artifact.contractName}`);
  }
  for (const [source, mapped] of Object.entries(build.userSourceNameMap)) {
    if (readFileSync(join(__dirname, '../..', source), 'utf8') !== build.input.sources[mapped].content) {
      throw new Error(`STACK_MANAGER_SOURCE_BUILD_MISMATCH:${source}`);
    }
  }
};

module.exports = { assertArtifactPipeline };
