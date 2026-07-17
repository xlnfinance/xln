#!/usr/bin/env bun

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

type AstNode = {
  nodeType?: string;
  name?: string;
  nodes?: unknown[];
  parameters?: AstNode;
  body?: unknown;
  expression?: AstNode;
  memberName?: string;
  typeName?: AstNode;
  arguments?: unknown[];
  kind?: string;
  visibility?: string;
  stateMutability?: string;
  members?: unknown[];
  [key: string]: unknown;
};
type BuildInfo = {
  input: { sources: Record<string, { content: string }> };
  output: { sources: Record<string, { ast: AstNode }> };
};
type SourceName = typeof SOURCE_NAMES[number];
type BuildMap = Record<SourceName, BuildInfo>;

const CONTRACT_ROOT = 'jurisdictions/contracts';
const EIP_170_MAX_DEPLOYED_BYTES = 24_576;
const SOURCE_NAMES = ['Account', 'Depository', 'EntityProvider', 'HankoCodec', 'HankoEncoding'] as const;

const fail = (message: string): never => {
  throw new Error(`ONCHAIN_HANKO_AST_VIOLATION: ${message}`);
};

const walk = (value: unknown, visit: (node: AstNode) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as AstNode;
  if (typeof node.nodeType === 'string') visit(node);
  for (const child of Object.values(node)) walk(child, visit);
};

const artifactPath = (name: string): string =>
  `jurisdictions/artifacts/contracts/${name}.sol/${name}.json`;

const dbgPath = (name: string): string =>
  `jurisdictions/artifacts/contracts/${name}.sol/${name}.dbg.json`;

const readBuildInfo = (name: SourceName): BuildInfo => {
  const debugPath = dbgPath(name);
  const dbg = JSON.parse(readFileSync(debugPath, 'utf8')) as { buildInfo: string };
  return JSON.parse(readFileSync(resolve(dirname(debugPath), dbg.buildInfo), 'utf8')) as BuildInfo;
};

const isFresh = (build: BuildInfo, name: SourceName): boolean => {
  const sourceName = `contracts/${name}.sol`;
  return build.input.sources[sourceName]?.content === readFileSync(`${CONTRACT_ROOT}/${name}.sol`, 'utf8');
};

const readBuildMap = (): BuildMap => Object.fromEntries(
  SOURCE_NAMES.map((name) => [name, readBuildInfo(name)]),
) as BuildMap;

const loadFreshBuildInfo = (): BuildMap => {
  try {
    const builds = readBuildMap();
    if (SOURCE_NAMES.every((name) => isFresh(builds[name], name))) return builds;
  } catch {
    // Missing or unreadable build-info is repaired by the canonical compiler below.
  }
  const compiled = spawnSync('bun', ['run', 'compile'], {
    cwd: 'jurisdictions',
    encoding: 'utf8',
  });
  if (compiled.stdout) process.stdout.write(compiled.stdout);
  if (compiled.stderr) process.stderr.write(compiled.stderr);
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) fail(`Hardhat compile failed with exit ${String(compiled.status)}`);
  const builds = readBuildMap();
  if (!SOURCE_NAMES.every((name) => isFresh(builds[name], name))) {
    fail('Hardhat build-info does not match current Hanko sources');
  }
  return builds;
};

const findContract = (build: BuildInfo, name: string): AstNode => {
  const source = build.output.sources[`contracts/${name}.sol`]?.ast;
  if (!source) fail(`missing AST for ${name}`);
  let result: AstNode | undefined;
  walk(source, (node) => {
    if (node.nodeType === 'ContractDefinition' && node.name === name) result = node;
  });
  if (!result) fail(`missing ContractDefinition ${name}`);
  return result as AstNode;
};

const functions = (contract: AstNode): AstNode[] => {
  const nodes = contract.nodes;
  if (!Array.isArray(nodes)) fail(`malformed contract AST ${String(contract.name)}`);
  return (nodes as unknown[]).filter((node): node is AstNode =>
    Boolean(node && typeof node === 'object' && (node as AstNode).nodeType === 'FunctionDefinition'));
};

const namedFunction = (contract: AstNode, name: string): AstNode => {
  const matches = functions(contract).filter((fn) => fn.name === name);
  if (matches.length !== 1) fail(`${String(contract.name)}.${name} count=${matches.length}`);
  return matches[0]!;
};

const parameterNames = (fn: AstNode): string[] => {
  const parameters = (fn.parameters as AstNode | undefined)?.parameters;
  if (!Array.isArray(parameters)) return [];
  return parameters.map((parameter) => String((parameter as AstNode).name ?? ''));
};

const calledNames = (fn: AstNode): string[] => {
  const names: string[] = [];
  walk(fn.body, (node) => {
    if (node.nodeType !== 'FunctionCall') return;
    const expression = node.expression as AstNode | undefined;
    if (expression?.nodeType === 'Identifier') names.push(String(expression.name));
    if (expression?.nodeType === 'MemberAccess') names.push(String(expression.memberName));
  });
  return names;
};

const hankoEncodingCalls = (fn: AstNode): string[] => {
  const names: string[] = [];
  walk(fn.body, (node) => {
    if (node.nodeType !== 'MemberAccess') return;
    const expression = node.expression as AstNode | undefined;
    if (expression?.nodeType === 'Identifier' && expression.name === 'HankoEncoding') {
      names.push(String(node.memberName));
    }
  });
  return names;
};

const hasChainId = (fn: AstNode): boolean => {
  let found = false;
  walk(fn.body, (node) => {
    const expression = node.expression as AstNode | undefined;
    if (node.nodeType === 'MemberAccess' && node.memberName === 'chainid' && expression?.name === 'block') {
      found = true;
    }
  });
  return found;
};

const hasAddressThis = (fn: AstNode): boolean => {
  let found = false;
  walk(fn.body, (node) => {
    if (node.nodeType !== 'FunctionCall') return;
    const expression = node.expression as AstNode | undefined;
    const typeName = expression?.typeName as AstNode | undefined;
    const args = node.arguments;
    if (
      expression?.nodeType === 'ElementaryTypeNameExpression' &&
      typeName?.name === 'address' &&
      Array.isArray(args) &&
      (args[0] as AstNode | undefined)?.name === 'this'
    ) found = true;
  });
  return found;
};

const assertExact = (actual: string[], expected: string[], label: string): void => {
  const normalizedActual = [...actual].sort();
  const normalizedExpected = [...expected].sort();
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    fail(`${label}: actual=${normalizedActual.join(',') || '-'} expected=${normalizedExpected.join(',') || '-'}`);
  }
};

const recursiveTsFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? recursiveTsFiles(join(directory, entry.name))
    : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);

const recursiveFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? recursiveFiles(join(directory, entry.name))
    : [join(directory, entry.name)]);

export const checkOnchainHankoAst = (): void => {
  const builds = loadFreshBuildInfo();
  const contracts = Object.fromEntries(
    SOURCE_NAMES.map((name) => [name, findContract(builds[name], name)]),
  ) as Record<SourceName, AstNode>;

  const sizes: string[] = [];
  for (const name of ['Account', 'Depository', 'EntityProvider']) {
    const artifact = JSON.parse(readFileSync(artifactPath(name), 'utf8')) as { deployedBytecode: string };
    const bytes = (artifact.deployedBytecode.length - 2) / 2;
    if (bytes > EIP_170_MAX_DEPLOYED_BYTES) fail(`${name} deployed bytecode=${bytes}`);
    sizes.push(`${name}=${bytes}`);
  }

  const codecFunctions = functions(contracts.HankoCodec).filter((fn) => fn.kind === 'function');
  const codecNames = [
    'encodeBatchHankoPayloadForDomain', 'computeBatchHankoHashForDomain',
    'encodeCooperativeUpdateHankoPayloadForDomain', 'computeCooperativeUpdateHankoHashForDomain',
    'encodeDisputeProofHankoPayloadForDomain', 'computeDisputeProofHankoHashForDomain',
    'encodeFinalDisputeProofHankoPayloadForDomain', 'computeFinalDisputeProofHankoHashForDomain',
    'encodeCooperativeDisputeProofHankoPayloadForDomain', 'computeCooperativeDisputeProofHankoHashForDomain',
    'encodeWatchtowerCounterDisputeHankoPayloadForDomain', 'computeWatchtowerCounterDisputeHankoHashForDomain',
    'encodeEntityTransferHankoPayloadForDomain', 'computeEntityTransferHankoHashForDomain',
    'encodeReleaseControlSharesHankoPayloadForDomain', 'computeReleaseControlSharesHankoHashForDomain',
    'encodeCancelEntityProviderActionHankoPayloadForDomain', 'computeCancelEntityProviderActionHankoHashForDomain',
    'encodeBoardProposalHankoPayloadForDomain', 'computeBoardProposalHankoHashForDomain',
    'encodeBoardProposalCancelHankoPayloadForDomain', 'computeBoardProposalCancelHankoHashForDomain',
  ];
  assertExact(codecFunctions.map((fn) => String(fn.name)), codecNames, 'HankoCodec surface');
  for (const fn of codecFunctions) {
    if (fn.visibility !== 'external' || fn.stateMutability !== 'pure') {
      fail(`HankoCodec.${String(fn.name)} must remain external pure`);
    }
    if (hankoEncodingCalls(fn).length !== 1) fail(`HankoCodec.${String(fn.name)} must call HankoEncoding exactly once`);
  }

  const localEncoders: Record<string, string> = {
    _encodeBatchHankoPayload: 'encodeBatch',
    _encodeCooperativeUpdateHankoPayload: 'encodeCooperativeUpdate',
    _encodeDisputeProofHankoPayload: 'encodeDisputeProof',
    _encodeCooperativeDisputeProofHankoPayload: 'encodeCooperativeDisputeProof',
  };
  for (const [name, encodingCall] of Object.entries(localEncoders)) {
    const fn = namedFunction(contracts.Account, name);
    if (fn.visibility !== 'private' || fn.stateMutability !== 'view') fail(`Account.${name} must remain private view`);
    if (!hasChainId(fn) || !hasAddressThis(fn)) fail(`Account.${name} must derive block.chainid + address(this)`);
    assertExact(hankoEncodingCalls(fn), [encodingCall], `Account.${name} encoding calls`);
  }

  for (const [contractName, functionName, encodingName] of [
    ['Depository', '_encodeWatchtowerCounterDisputeHankoPayload', 'encodeWatchtowerCounterDispute'],
    ['EntityProvider', 'encodeBoardProposalHankoPayload', 'encodeBoardProposal'],
    ['EntityProvider', 'encodeBoardProposalCancelHankoPayload', 'encodeBoardProposalCancel'],
    ['EntityProvider', 'encodeEntityTransferHankoPayload', 'encodeEntityTransfer'],
    ['EntityProvider', 'encodeReleaseControlSharesHankoPayload', 'encodeReleaseControlShares'],
    ['EntityProvider', 'encodeCancelEntityProviderActionHankoPayload', 'encodeCancelEntityProviderAction'],
  ] as const) {
    const fn = namedFunction(contracts[contractName], functionName);
    if (!hasChainId(fn) || !hasAddressThis(fn)) fail(`${contractName}.${functionName} must derive local domain`);
    assertExact(hankoEncodingCalls(fn), [encodingName], `${contractName}.${functionName} encoding calls`);
  }

  const productionInventory = (['Account', 'Depository', 'EntityProvider'] as const).flatMap((contractName) =>
    functions(contracts[contractName]!).flatMap((fn) => hankoEncodingCalls(fn).map((call) =>
      `${contractName}.${String(fn.name)}:${call}`)));
  assertExact(productionInventory, [
    'Account._encodeBatchHankoPayload:encodeBatch',
    'Account._encodeCooperativeUpdateHankoPayload:encodeCooperativeUpdate',
    'Account._encodeDisputeProofHankoPayload:encodeDisputeProof',
    'Account._encodeCooperativeDisputeProofHankoPayload:encodeCooperativeDisputeProof',
    'Depository._encodeWatchtowerCounterDisputeHankoPayload:encodeWatchtowerCounterDispute',
    'EntityProvider.encodeBoardProposalHankoPayload:encodeBoardProposal',
    'EntityProvider.encodeBoardProposalCancelHankoPayload:encodeBoardProposalCancel',
    'EntityProvider.encodeEntityTransferHankoPayload:encodeEntityTransfer',
    'EntityProvider.encodeReleaseControlSharesHankoPayload:encodeReleaseControlShares',
    'EntityProvider.encodeCancelEntityProviderActionHankoPayload:encodeCancelEntityProviderAction',
  ], 'production HankoEncoding inventory');

  for (const [contractName, functionNames] of [
    ['Account', Object.keys(localEncoders)],
    ['Depository', ['processBatch', 'computeWatchtowerCounterDisputeHash', 'watchtowerCounterDispute']],
    ['EntityProvider', ['entityTransferTokens', 'releaseControlShares', 'cancelEntityProviderAction']],
  ] as const) {
    for (const functionName of functionNames) {
      const names = parameterNames(namedFunction(contracts[contractName], functionName));
      const forbidden = names
        .filter((name) => name === 'chainId' || name === 'contractAddress');
      if (forbidden.length) fail(`${contractName}.${functionName} accepts caller-controlled domain`);
      if (contractName === 'EntityProvider') {
        if (!names.includes('hankoData') || names.includes('encodedBoard') || names.includes('encodedSignature')) {
          fail(`EntityProvider.${functionName} must accept one canonical Hanko envelope`);
        }
      }
    }
  }

  if (functions(contracts.EntityProvider).some((fn) => fn.name === 'recoverEntity')) {
    fail('legacy EntityProvider.recoverEntity surface was reintroduced');
  }
  for (const [consumer, hashCall] of [
    ['entityTransferTokens', 'computeEntityTransferHankoHash'],
    ['releaseControlShares', 'computeReleaseControlSharesHankoHash'],
    ['cancelEntityProviderAction', 'computeCancelEntityProviderActionHankoHash'],
  ]) {
    const calls = calledNames(namedFunction(contracts.EntityProvider, consumer!));
    if (!calls.includes(hashCall!) || !calls.includes('_verifyCurrentHankoSignature')) {
      fail(`${consumer} hash/canonical-Hanko wiring drift`);
    }
  }
  for (const [consumer, hashCall] of [
    ['proposeBoard', 'computeBoardProposalHash'],
    ['cancelBoardProposal', 'computeBoardProposalCancelHash'],
  ]) {
    const fn = namedFunction(contracts.EntityProvider, consumer!);
    const calls = calledNames(fn);
    if (!calls.includes(hashCall!) || !calls.includes('_requireBoardAuthority')) {
      fail(`${consumer} hash/authority wiring drift`);
    }
    const forbidden = parameterNames(fn)
      .filter((name) => name === 'chainId' || name === 'contractAddress');
    if (forbidden.length) fail(`EntityProvider.${consumer} accepts caller-controlled domain`);
  }
  for (const [hashFunction, encoder] of [
    ['computeBoardProposalHash', 'encodeBoardProposalHankoPayload'],
    ['computeBoardProposalCancelHash', 'encodeBoardProposalCancelHankoPayload'],
  ]) {
    if (!calledNames(namedFunction(contracts.EntityProvider, hashFunction!)).includes(encoder!)) {
      fail(`${hashFunction} local-domain encoder wiring drift`);
    }
  }

  const internalVerifyConsumers = functions(contracts.EntityProvider)
    .filter((fn) => calledNames(fn).includes('_verifyHankoSignature'))
    .map((fn) => String(fn.name));
  assertExact(internalVerifyConsumers, [
    'verifyHankoSignature', 'batchVerifyHankoSignatures',
  ], 'EntityProvider canonical Hanko verifier consumers');

  const currentVerifyConsumers = functions(contracts.EntityProvider)
    .filter((fn) => calledNames(fn).includes('_verifyCurrentHankoSignature'))
    .map((fn) => String(fn.name));
  assertExact(currentVerifyConsumers, [
    '_requireBoardAuthority',
    'entityTransferTokens', 'cancelEntityProviderAction', 'releaseControlShares',
  ], 'EntityProvider current-only Hanko verifier consumers');

  const verifyConsumers = (['Account', 'Depository', 'EntityProvider'] as const).flatMap((contractName) =>
    functions(contracts[contractName]!).filter((fn) => calledNames(fn).includes('verifyHankoSignature'))
      .map((fn) => `${contractName}.${String(fn.name)}`));
  assertExact(verifyConsumers, [
    'Account.verifyDisputeProofHanko',
    'Account.verifyCooperativeProofHanko', 'Account.processC2R', 'Account._settleDiffs', 'Account._disputeStart',
    'Depository.processBatch', 'Depository.watchtowerCounterDispute',
  ], 'verifyHankoSignature consumers');

  const finalProofConsumers = (['Account', 'Depository', 'EntityProvider'] as const).flatMap((contractName) =>
    functions(contracts[contractName]!).filter((fn) => calledNames(fn).includes('verifyFinalDisputeProofHanko'))
      .map((fn) => `${contractName}.${String(fn.name)}`));
  assertExact(finalProofConsumers, [], 'protocol-dead FinalDisputeProof callers');
  if (functions(contracts.Account).some((fn) => fn.name === 'verifyFinalDisputeProofHanko')) {
    fail('protocol-dead Account.verifyFinalDisputeProofHanko surface was reintroduced');
  }
  const typesAst = builds.HankoEncoding.output.sources['contracts/Types.sol']?.ast;
  if (!typesAst) fail('missing Types.sol AST');
  let messageTypeMembers: string[] | undefined;
  walk(typesAst, (node) => {
    if (node.nodeType !== 'EnumDefinition' || node.name !== 'MessageType') return;
    const members = node.members;
    if (!Array.isArray(members)) fail('malformed MessageType enum AST');
    messageTypeMembers = (members as unknown[]).map((member) => String((member as AstNode).name));
  });
  if (messageTypeMembers?.[2] !== 'FinalDisputeProof') {
    fail(`MessageType slot 2 must remain reserved for FinalDisputeProof: ${messageTypeMembers?.join(',') ?? 'missing'}`);
  }

  for (const contractName of ['Account', 'Depository', 'EntityProvider', 'HankoEncoding'] as const) {
    let referencesCodec = false;
    walk(contracts[contractName]!, (node) => {
      if (node.name === 'HankoCodec') referencesCodec = true;
    });
    if (referencesCodec) fail(`${contractName} production AST references HankoCodec`);
  }
  const deploymentReferences = [
    'jurisdictions/ignition',
    'jurisdictions/scripts',
    'runtime/jadapter',
    'runtime/orchestrator',
    'scripts',
    'frontend/src',
  ].flatMap(recursiveFiles).filter((path) => readFileSync(path, 'utf8').includes('HankoCodec'));
  assertExact(deploymentReferences, [], 'production stack HankoCodec references');

  const labels = [
    ['ENTITY', 'TRANSFER'].join('_'),
    ['RELEASE', 'CONTROL', 'SHARES'].join('_'),
  ];
  const tsFiles = recursiveTsFiles('runtime');
  for (const label of labels) {
    const producers = tsFiles.filter((path) => readFileSync(path, 'utf8').includes(`'${label}'`));
    assertExact(producers, ['runtime/hanko/onchain-domain.ts'], `runtime ${label} literal producers`);
  }

  console.log(`on-chain Hanko AST check passed (${sizes.join(', ')}, FinalDisputeProof callers=0)`);
};

if (import.meta.main) checkOnchainHankoAst();
