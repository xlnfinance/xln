import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REQUIRED_RPC_CONTRACT_KEYS = [
  'account',
  'depository',
  'entityProvider',
  'deltaTransformer',
] as const;

export type RpcContractAddresses = Partial<Record<(typeof REQUIRED_RPC_CONTRACT_KEYS)[number], string>>;

type RpcCodeResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: unknown };
};

type ContractArtifact = {
  contractName: string;
  deployedBytecode: string;
  deployedLinkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>;
  immutableReferences: Record<string, readonly { start: number; length: number }[]>;
  sourceName: string;
};

const ENTITY_PROVIDER_SELECTOR = '0x4318cdd0';
const CONTRACT_ARTIFACT_NAMES = {
  account: 'Account',
  depository: 'Depository',
  entityProvider: 'EntityProvider',
  deltaTransformer: 'DeltaTransformer',
  hankoVerifier: 'HankoVerifier',
} as const;
type CanonicalArtifactKey = keyof typeof CONTRACT_ARTIFACT_NAMES;

let canonicalArtifacts: Record<CanonicalArtifactKey, ContractArtifact> | null = null;

const validateCanonicalArtifact = (
  key: CanonicalArtifactKey,
  value: unknown,
): ContractArtifact => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`RPC_CANONICAL_ARTIFACT_INVALID:${key}`);
  }
  const artifact = value as Partial<ContractArtifact>;
  if (
    typeof artifact.contractName !== 'string' ||
    typeof artifact.sourceName !== 'string' ||
    typeof artifact.deployedBytecode !== 'string' ||
    !/^0x[0-9a-fA-F_$]+$/.test(artifact.deployedBytecode) ||
    !artifact.deployedLinkReferences ||
    typeof artifact.deployedLinkReferences !== 'object' ||
    !artifact.immutableReferences ||
    typeof artifact.immutableReferences !== 'object' ||
    Array.isArray(artifact.immutableReferences)
  ) {
    throw new Error(`RPC_CANONICAL_ARTIFACT_INVALID:${key}`);
  }
  const deployedBytes = (artifact.deployedBytecode.length - 2) / 2;
  const occupied = new Set<string>();
  for (const [groupId, references] of Object.entries(artifact.immutableReferences)) {
    if (!groupId || !Array.isArray(references) || references.length === 0) {
      throw new Error(`RPC_CANONICAL_IMMUTABLE_METADATA_INVALID:${key}:${groupId || 'missing'}`);
    }
    for (const reference of references) {
      if (
        !Number.isSafeInteger(reference.start) || reference.start < 0 ||
        reference.length !== 32 || reference.start + reference.length > deployedBytes
      ) {
        throw new Error(`RPC_CANONICAL_IMMUTABLE_METADATA_INVALID:${key}:${groupId}`);
      }
      const location = `${reference.start}:${reference.length}`;
      if (occupied.has(location)) {
        throw new Error(`RPC_CANONICAL_IMMUTABLE_METADATA_DUPLICATE:${key}:${location}`);
      }
      occupied.add(location);
    }
  }
  const groupCount = Object.keys(artifact.immutableReferences).length;
  if (key === 'account' && groupCount !== 1) {
    throw new Error(`RPC_CANONICAL_ACCOUNT_IMMUTABLE_GROUP_INVALID:${groupCount}`);
  }
  if (key === 'depository' && groupCount === 0) {
    throw new Error('RPC_CANONICAL_DEPOSITORY_IMMUTABLE_GROUPS_MISSING');
  }
  return artifact as ContractArtifact;
};

const fetchRpcBatch = async (
  rpcUrl: string,
  requests: Array<{ jsonrpc: '2.0'; id: number; method: string; params: unknown[] }>,
  timeoutMs: number,
): Promise<Map<number, RpcCodeResponse>> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requests),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RPC_CONTRACT_CODE_HTTP_${response.status}`);
    const payload = await response.json() as RpcCodeResponse[];
    if (!Array.isArray(payload)) throw new Error('RPC_CONTRACT_CODE_BATCH_INVALID');
    return new Map(payload.map((entry) => [Number(entry.id), entry]));
  } finally {
    clearTimeout(timeout);
  }
};

const readRpcContractCodes = async (
  rpcUrl: string,
  contracts: RpcContractAddresses,
  timeoutMs: number,
): Promise<Map<(typeof REQUIRED_RPC_CONTRACT_KEYS)[number], string>> => {
  const entries = REQUIRED_RPC_CONTRACT_KEYS
    .map((key) => [key, String(contracts[key] || '')] as const)
    .filter(([, address]) => /^0x[0-9a-fA-F]{40}$/.test(address));
  if (entries.length === 0) return new Map();
  const responses = await fetchRpcBatch(rpcUrl, entries.map(([, address], index) => ({
    jsonrpc: '2.0' as const,
    id: index + 1,
    method: 'eth_getCode',
    params: [address, 'latest'],
  })), timeoutMs);
  return new Map(entries.map(([key], index) => {
    const entry = responses.get(index + 1);
    if (!entry || entry.error || typeof entry.result !== 'string') {
      throw new Error(`RPC_CONTRACT_CODE_RESULT_INVALID:${key}:${String(entry?.error?.message || 'missing')}`);
    }
    return [key, entry.result] as const;
  }));
};

const loadCanonicalArtifacts = (): Record<CanonicalArtifactKey, ContractArtifact> => {
  if (canonicalArtifacts) return canonicalArtifacts;
  canonicalArtifacts = Object.fromEntries((Object.keys(CONTRACT_ARTIFACT_NAMES) as CanonicalArtifactKey[]).map((key) => {
    const name = CONTRACT_ARTIFACT_NAMES[key];
    const path = fileURLToPath(new URL(`../../frontend/static/contracts/${name}.json`, import.meta.url));
    const artifact = validateCanonicalArtifact(key, JSON.parse(readFileSync(path, 'utf8')));
    return [key, artifact];
  })) as Record<CanonicalArtifactKey, ContractArtifact>;
  return canonicalArtifacts;
};

const linkDeployedBytecode = (
  artifact: ContractArtifact,
  libraryAddresses: Readonly<Record<string, string>>,
): string => {
  let hex = artifact.deployedBytecode.slice(2);
  for (const libraries of Object.values(artifact.deployedLinkReferences)) {
    for (const [libraryName, references] of Object.entries(libraries)) {
      const libraryAddress = String(libraryAddresses[libraryName] || '');
      if (!/^0x[0-9a-fA-F]{40}$/.test(libraryAddress)) {
        throw new Error(`RPC_CANONICAL_LIBRARY_ADDRESS_MISSING:${libraryName}`);
      }
      const address = libraryAddress.slice(2).toLowerCase();
      for (const reference of references) {
        if (reference.length !== 20) throw new Error(`RPC_CANONICAL_LIBRARY_LENGTH_INVALID:${libraryName}`);
        const offset = reference.start * 2;
        hex = `${hex.slice(0, offset)}${address}${hex.slice(offset + reference.length * 2)}`;
      }
    }
  }
  return `0x${hex}`;
};

const readLinkedLibraryAddress = (
  artifact: ContractArtifact,
  actualCode: string,
  libraryName: string,
): string => {
  const references = Object.values(artifact.deployedLinkReferences)
    .flatMap(libraries => libraries[libraryName] ?? []);
  if (references.length === 0) throw new Error(`RPC_CANONICAL_LIBRARY_REFERENCE_MISSING:${libraryName}`);
  const actual = actualCode.slice(2);
  const addresses = new Set(references.map((reference) => {
    if (reference.length !== 20) throw new Error(`RPC_CANONICAL_LIBRARY_LENGTH_INVALID:${libraryName}`);
    const value = actual.slice(reference.start * 2, (reference.start + reference.length) * 2);
    if (!/^[0-9a-fA-F]{40}$/.test(value) || /^0{40}$/.test(value)) {
      throw new Error(`RPC_CANONICAL_LIBRARY_VALUE_INVALID:${libraryName}`);
    }
    return `0x${value.toLowerCase()}`;
  }));
  if (addresses.size !== 1) throw new Error(`RPC_CANONICAL_LIBRARY_BINDING_INCONSISTENT:${libraryName}`);
  return [...addresses][0]!;
};

const readRpcCodeAt = async (
  rpcUrl: string,
  address: string,
  context: string,
  timeoutMs: number,
): Promise<string> => {
  const responses = await fetchRpcBatch(rpcUrl, [{
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [address, 'latest'],
  }], timeoutMs);
  const entry = responses.get(1);
  if (!entry || entry.error || typeof entry.result !== 'string') {
    throw new Error(`${context}_CODE_RESULT_INVALID:${String(entry?.error?.message || 'missing')}`);
  }
  return entry.result;
};

const materializeImmutableReferences = (
  key: (typeof REQUIRED_RPC_CONTRACT_KEYS)[number],
  artifact: ContractArtifact,
  expectedCode: string,
  actualCode: string,
  contracts: RpcContractAddresses,
  context: string,
): string => {
  let expected = expectedCode.slice(2);
  const actual = actualCode.slice(2);
  const accountWord = String(contracts.account).slice(2).toLowerCase().padStart(64, '0');
  for (const [groupId, references] of Object.entries(artifact.immutableReferences)) {
    const first = references[0];
    if (!first || first.length !== 32) throw new Error(`RPC_CANONICAL_IMMUTABLE_INVALID:${key}`);
    const firstOffset = first.start * 2;
    const word = actual.slice(firstOffset, firstOffset + 64);
    if (!/^0{24}[0-9a-fA-F]{40}$/.test(word) || /^0{64}$/.test(word)) {
      throw new Error(`RPC_CANONICAL_IMMUTABLE_VALUE_INVALID:${key}`);
    }
    if (key === 'account' && word.toLowerCase() !== accountWord) {
      throw new Error(`${context}_IMMUTABLE_BINDING_MISMATCH:${key}:${groupId}`);
    }
    for (const reference of references) {
      const offset = reference.start * 2;
      if (reference.length !== 32 || actual.slice(offset, offset + 64).toLowerCase() !== word.toLowerCase()) {
        throw new Error(`RPC_CANONICAL_IMMUTABLE_INCONSISTENT:${key}`);
      }
      expected = `${expected.slice(0, offset)}${word}${expected.slice(offset + 64)}`;
    }
  }
  return `0x${expected}`;
};

const assertEntityProviderBinding = async (
  rpcUrl: string,
  contracts: RpcContractAddresses,
  context: string,
  timeoutMs: number,
): Promise<void> => {
  const responses = await fetchRpcBatch(rpcUrl, [{
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: contracts.depository, data: ENTITY_PROVIDER_SELECTOR }, 'latest'],
  }], timeoutMs);
  const entry = responses.get(1);
  const result = String(entry?.result || '');
  if (!entry || entry.error || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new Error(`${context}_ENTITY_PROVIDER_BINDING_READ_INVALID:${String(entry?.error?.message || result || 'missing')}`);
  }
  const linked = `0x${result.slice(-40)}`.toLowerCase();
  const configured = String(contracts.entityProvider).toLowerCase();
  if (linked !== configured) {
    throw new Error(`${context}_ENTITY_PROVIDER_BINDING_MISMATCH:expected=${configured}:actual=${linked}`);
  }
};

export const assertCanonicalRpcContractStack = async (
  rpcUrl: string,
  contracts: RpcContractAddresses,
  context: string,
  timeoutMs = 2_000,
): Promise<void> => {
  const invalid = REQUIRED_RPC_CONTRACT_KEYS.filter((key) =>
    !/^0x[0-9a-fA-F]{40}$/.test(String(contracts[key] || '')));
  if (invalid.length > 0) throw new Error(`${context}_CONTRACTS_INVALID:${invalid.join(',')}`);
  const artifacts = loadCanonicalArtifacts();
  const codes = await readRpcContractCodes(rpcUrl, contracts, timeoutMs);
  const entityProviderCode = String(codes.get('entityProvider'));
  const hankoVerifierAddress = readLinkedLibraryAddress(
    artifacts.entityProvider,
    entityProviderCode,
    'HankoVerifier',
  );
  const hankoVerifierCode = await readRpcCodeAt(
    rpcUrl,
    hankoVerifierAddress,
    `${context}_HANKO_VERIFIER`,
    timeoutMs,
  );
  if (hankoVerifierCode.toLowerCase() !== artifacts.hankoVerifier.deployedBytecode.toLowerCase()) {
    throw new Error(`${context}_CODE_MISMATCH:hankoVerifier`);
  }
  for (const key of REQUIRED_RPC_CONTRACT_KEYS) {
    const actual = String(codes.get(key)).toLowerCase();
    const linkedExpected = linkDeployedBytecode(artifacts[key], {
      Account: String(contracts.account),
      HankoVerifier: hankoVerifierAddress,
    });
    const expected = materializeImmutableReferences(key, artifacts[key], linkedExpected, actual, contracts, context);
    const normalizedExpected = expected.toLowerCase();
    if (actual !== normalizedExpected) {
      let firstDifferentNibble = 0;
      while (actual[firstDifferentNibble] === normalizedExpected[firstDifferentNibble]) {
        firstDifferentNibble += 1;
      }
      throw new Error(
        `${context}_CODE_MISMATCH:${key}` +
        `:actualBytes=${Math.max(0, (actual.length - 2) / 2)}` +
        `:expectedBytes=${Math.max(0, (expected.length - 2) / 2)}` +
        `:firstDifferentByte=${Math.max(0, Math.floor((firstDifferentNibble - 2) / 2))}`,
      );
    }
  }
  await assertEntityProviderBinding(rpcUrl, contracts, context, timeoutMs);
};

export const findMissingRpcContractCode = async (
  rpcUrl: string,
  contracts: RpcContractAddresses | null | undefined,
  timeoutMs = 2_000,
): Promise<string[]> => {
  const missing = REQUIRED_RPC_CONTRACT_KEYS
    .filter((key) => !/^0x[0-9a-fA-F]{40}$/.test(String(contracts?.[key] || '')))
    .map((key) => `${key}:missing`);
  const codeByKey = await readRpcContractCodes(rpcUrl, contracts ?? {}, timeoutMs);
  for (const [key, code] of codeByKey) {
    if (!code || code === '0x') missing.push(`${key}:${String(contracts?.[key])}`);
  }
  return missing;
};

const readRpcHexResult = async (
  rpcUrl: string,
  method: string,
  params: unknown[],
  context: string,
  timeoutMs: number,
): Promise<string> => {
  const responses = await fetchRpcBatch(rpcUrl, [{
    jsonrpc: '2.0', id: 1, method, params,
  }], timeoutMs);
  const entry = responses.get(1);
  if (!entry || entry.error || typeof entry.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(entry.result)) {
    throw new Error(`${context}_RESULT_INVALID:${String(entry?.error?.message || entry?.result || 'missing')}`);
  }
  return entry.result;
};

/**
 * Recovers metadata after a process dies after the on-chain deployment commits
 * but before jurisdictions.json is persisted. The adjacent-block checks are the
 * evidence: using "latest" (or guessing block 1) would silently widen or truncate
 * the authenticated EntityProvider event domain.
 */
export const findRpcContractDeploymentBlock = async (
  rpcUrl: string,
  address: string,
  context: string,
  timeoutMs = 2_000,
): Promise<number> => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`${context}_ADDRESS_INVALID:${address}`);
  }
  const latestHex = await readRpcHexResult(rpcUrl, 'eth_blockNumber', [], context, timeoutMs);
  const latest = Number.parseInt(latestHex.slice(2), 16);
  if (!Number.isSafeInteger(latest) || latest < 1) {
    throw new Error(`${context}_LATEST_BLOCK_INVALID:${latestHex}`);
  }
  const codeAt = async (block: number): Promise<string> => await readRpcHexResult(
    rpcUrl,
    'eth_getCode',
    [address, `0x${block.toString(16)}`],
    `${context}_BLOCK_${String(block)}`,
    timeoutMs,
  );
  if (await codeAt(latest) === '0x') {
    throw new Error(`${context}_LATEST_CODE_MISSING:${address}`);
  }

  let lower = 0;
  let upper = latest;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (await codeAt(middle) === '0x') lower = middle + 1;
    else upper = middle;
  }
  if (lower < 1 || await codeAt(lower) === '0x' || await codeAt(lower - 1) !== '0x') {
    throw new Error(`${context}_BOUNDARY_INVALID:${String(lower)}`);
  }
  return lower;
};
