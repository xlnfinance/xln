/**
 * Verifies receipts and exact linked runtime bytecode before local discovery.
 * Artifact link references are resolved from the manifest; a mismatched byte
 * outside those compiler-declared slots rejects the deployment. [99/100]
 */

import { JsonRpcProvider } from 'ethers';
import { readFile } from 'node:fs/promises';
import type { JurisdictionStackManifest, StackContractName } from './types';
import { bindCompilerImmutables, readCompilerBytecodeEvidence } from './compiler-bytecode';

type LinkReference = Readonly<{ start: number; length: number }>;
type Artifact = Readonly<{
  deployedBytecode: string;
  deployedLinkReferences: Readonly<Record<string, Readonly<Record<string, readonly LinkReference[]>>>>;
}>;

type ArtifactDescriptor = Readonly<{ path: string; sourceName: string; contractName: string }>;

const ARTIFACTS: Readonly<Record<StackContractName, ArtifactDescriptor>> = {
  account: { path: 'contracts/Account.sol/Account.json', sourceName: 'contracts/Account.sol', contractName: 'Account' },
  depositoryBounds: { path: 'contracts/DepositoryBounds.sol/DepositoryBounds.json', sourceName: 'contracts/DepositoryBounds.sol', contractName: 'DepositoryBounds' },
  hashLadderRegistry: { path: 'contracts/HashLadderRegistry.sol/HashLadderRegistry.json', sourceName: 'contracts/HashLadderRegistry.sol', contractName: 'HashLadderRegistry' },
  nftCustody: { path: 'contracts/custody/NftCustody.sol/NftCustody.json', sourceName: 'contracts/custody/NftCustody.sol', contractName: 'NftCustody' },
  hankoVerifier: { path: 'contracts/HankoVerifier.sol/HankoVerifier.json', sourceName: 'contracts/HankoVerifier.sol', contractName: 'HankoVerifier' },
  entityProvider: { path: 'contracts/EntityProvider.sol/EntityProvider.json', sourceName: 'contracts/EntityProvider.sol', contractName: 'EntityProvider' },
  depository: { path: 'contracts/Depository.sol/Depository.json', sourceName: 'contracts/Depository.sol', contractName: 'Depository' },
  deltaTransformer: { path: 'contracts/DeltaTransformer.sol/DeltaTransformer.json', sourceName: 'contracts/DeltaTransformer.sol', contractName: 'DeltaTransformer' },
};

const LIBRARY_ADDRESSES: Readonly<Record<string, StackContractName>> = {
  Account: 'account',
  DepositoryBounds: 'depositoryBounds',
  HashLadderRegistry: 'hashLadderRegistry',
  NftCustody: 'nftCustody',
  HankoVerifier: 'hankoVerifier',
};

const SOLIDITY_LIBRARY_NAMES = new Set<StackContractName>([
  'account', 'depositoryBounds', 'hashLadderRegistry', 'nftCustody', 'hankoVerifier',
]);

const artifactUrl = (path: string): URL =>
  new URL(`../../../../jurisdictions/artifacts/${path}`, import.meta.url);
const buildInfoUrl = new URL('../../../../jurisdictions/artifacts/build-info/', import.meta.url);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const decodeArtifact = (value: unknown, name: string): Artifact => {
  if (!isRecord(value) || typeof value['deployedBytecode'] !== 'string' || !isRecord(value['deployedLinkReferences'])) {
    throw new Error(`STACK_MANAGER_ARTIFACT_INVALID:${name}`);
  }
  const deployedLinkReferences: Record<string, Record<string, readonly LinkReference[]>> = {};
  for (const [sourceName, rawLibraries] of Object.entries(value['deployedLinkReferences'])) {
    if (!isRecord(rawLibraries)) throw new Error(`STACK_MANAGER_ARTIFACT_LINKS_INVALID:${name}:${sourceName}`);
    const libraries: Record<string, readonly LinkReference[]> = {};
    for (const [libraryName, rawReferences] of Object.entries(rawLibraries)) {
      if (!Array.isArray(rawReferences)) throw new Error(`STACK_MANAGER_ARTIFACT_LINKS_INVALID:${name}:${libraryName}`);
      libraries[libraryName] = rawReferences.map((rawReference, index) => {
        if (!isRecord(rawReference)) throw new Error(`STACK_MANAGER_ARTIFACT_LINK_INVALID:${name}:${libraryName}:${index}`);
        const start = rawReference['start'];
        const length = rawReference['length'];
        if (!Number.isSafeInteger(start) || Number(start) < 0 || !Number.isSafeInteger(length) || Number(length) <= 0) {
          throw new Error(`STACK_MANAGER_ARTIFACT_LINK_INVALID:${name}:${libraryName}:${index}`);
        }
        return { start: Number(start), length: Number(length) };
      });
    }
    deployedLinkReferences[sourceName] = libraries;
  }
  return { deployedBytecode: value['deployedBytecode'], deployedLinkReferences };
};

const readArtifact = async (name: StackContractName): Promise<Artifact> => {
  const value: unknown = JSON.parse(await readFile(artifactUrl(ARTIFACTS[name].path), 'utf8'));
  return decodeArtifact(value, name);
};

const linkExpectedBytecode = (
  artifact: Artifact,
  manifest: JurisdictionStackManifest,
  name: StackContractName,
): string => {
  let linked = artifact.deployedBytecode.toLowerCase();
  for (const libraries of Object.values(artifact.deployedLinkReferences)) {
    for (const [libraryName, references] of Object.entries(libraries)) {
      const contractName = LIBRARY_ADDRESSES[libraryName];
      if (!contractName) throw new Error(`STACK_MANAGER_LINK_LIBRARY_UNKNOWN:${name}:${libraryName}`);
      const address = manifest.contracts[contractName].slice(2).toLowerCase();
      for (const reference of references) {
        if (reference.length !== 20) throw new Error(`STACK_MANAGER_LINK_LENGTH_INVALID:${name}:${libraryName}`);
        const start = 2 + reference.start * 2;
        linked = `${linked.slice(0, start)}${address}${linked.slice(start + reference.length * 2)}`;
      }
    }
  }
  return linked;
};

const describeBytecodeMismatch = (actual: string, expected: string): string => {
  const limit = Math.min(actual.length, expected.length);
  let offset = 0;
  while (offset < limit && actual[offset] === expected[offset]) offset += 1;
  return `nibble=${offset}:actualLength=${actual.length}:expectedLength=${expected.length}`;
};

export const verifyJurisdictionStack = async (
  provider: JsonRpcProvider,
  manifest: JurisdictionStackManifest,
  confirmations: number,
): Promise<void> => {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== manifest.chainId) throw new Error('STACK_MANAGER_MANIFEST_CHAIN_ID_MISMATCH');
  const names = Object.keys(ARTIFACTS) as StackContractName[];
  for (const name of names) {
    const deployment = manifest.evmContracts[name];
    if (!deployment) throw new Error(`STACK_MANAGER_DEPLOYMENT_MISSING:${name}`);
    const receipt = await provider.getTransactionReceipt(deployment.transactionHash);
    if (!receipt || receipt.status !== 1 || receipt.blockNumber !== deployment.deploymentBlock) {
      throw new Error(`STACK_MANAGER_RECEIPT_INVALID:${name}`);
    }
    const depth = await receipt.confirmations();
    if (depth < confirmations) throw new Error(`STACK_MANAGER_RECEIPT_NOT_FINAL:${name}:${depth}:${confirmations}`);
    if ((receipt.contractAddress || '').toLowerCase() !== deployment.address.toLowerCase()) {
      throw new Error(`STACK_MANAGER_RECEIPT_ADDRESS_MISMATCH:${name}`);
    }
    const code = (await provider.getCode(deployment.address, receipt.blockNumber)).toLowerCase();
    const linked = linkExpectedBytecode(await readArtifact(name), manifest, name);
    const descriptor = ARTIFACTS[name];
    const compilerEvidence = await readCompilerBytecodeEvidence(
      buildInfoUrl,
      descriptor.sourceName,
      descriptor.contractName,
    );
    const immutableValues = {
      ...(SOLIDITY_LIBRARY_NAMES.has(name) && compilerEvidence.immutableReferences['library_deploy_address']
        ? { library_deploy_address: deployment.address }
        : {}),
      ...(name === 'entityProvider' ? { foundationDeployer: manifest.foundationRecipient } : {}),
      ...(name === 'depository'
        ? {
            entityProvider: manifest.contracts.entityProvider,
            deltaTransformer: manifest.contracts.deltaTransformer,
            admin: manifest.deployer,
          }
        : {}),
    };
    const expected = bindCompilerImmutables(
      linked,
      compilerEvidence,
      immutableValues,
      name,
    );
    if (code !== expected) {
      throw new Error(`STACK_MANAGER_BYTECODE_MISMATCH:${name}:${describeBytecodeMismatch(code, expected)}`);
    }
  }
  const registration = manifest.evmContracts.stablecoinRegistration;
  const registrationReceipt = await provider.getTransactionReceipt(registration.transactionHash);
  if (
    !registrationReceipt ||
    registrationReceipt.status !== 1 ||
    registrationReceipt.blockNumber !== registration.blockNumber ||
    (registrationReceipt.to || '').toLowerCase() !== manifest.contracts.depository.toLowerCase()
  ) throw new Error('STACK_MANAGER_STABLECOIN_REGISTRATION_RECEIPT_INVALID');
  if (await registrationReceipt.confirmations() < confirmations) {
    throw new Error('STACK_MANAGER_STABLECOIN_REGISTRATION_NOT_FINAL');
  }
  const stablecoinDeployment = manifest.evmContracts.stablecoin;
  if (stablecoinDeployment) {
    const receipt = await provider.getTransactionReceipt(stablecoinDeployment.transactionHash);
    if (
      !receipt || receipt.status !== 1 || receipt.blockNumber !== stablecoinDeployment.deploymentBlock ||
      (receipt.contractAddress || '').toLowerCase() !== stablecoinDeployment.address.toLowerCase()
    ) throw new Error('STACK_MANAGER_TEST_STABLECOIN_RECEIPT_INVALID');
    if (await receipt.confirmations() < confirmations) throw new Error('STACK_MANAGER_TEST_STABLECOIN_NOT_FINAL');
    const artifactValue: unknown = JSON.parse(await readFile(
      artifactUrl('contracts/ERC20Mock.sol/ERC20Mock.json'),
      'utf8',
    ));
    const artifact = decodeArtifact(artifactValue, 'stablecoin');
    const code = (await provider.getCode(stablecoinDeployment.address, receipt.blockNumber)).toLowerCase();
    const stablecoinExpected = bindCompilerImmutables(
      artifact.deployedBytecode.toLowerCase(),
      await readCompilerBytecodeEvidence(
        buildInfoUrl,
        'contracts/ERC20Mock.sol',
        'ERC20Mock',
      ),
      { tokenDecimals: '0x06' },
      'stablecoin',
    );
    if (code !== stablecoinExpected) {
      throw new Error('STACK_MANAGER_TEST_STABLECOIN_BYTECODE_MISMATCH');
    }
  }
};
