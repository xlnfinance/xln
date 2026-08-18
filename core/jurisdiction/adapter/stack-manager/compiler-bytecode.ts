/**
 * Reads solc build evidence for constructor-bound immutable slots. This keeps
 * Stack Manager bytecode verification independent from the deployment output:
 * every patched byte is located by compiler metadata and supplied locally. [98/100]
 */

import { readdir, readFile } from 'node:fs/promises';

type ImmutableReference = Readonly<{ start: number; length: number }>;

export type CompilerBytecodeEvidence = Readonly<{
  immutableReferences: Readonly<Record<string, readonly ImmutableReference[]>>;
}>;

const requireRecord = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const readFieldRecord = (
  parent: Record<string, unknown>,
  field: string,
  code: string,
): Record<string, unknown> => requireRecord(parent[field], code);

const collectImmutableNames = (
  value: unknown,
  names: Map<number, string>,
): void => {
  if (Array.isArray(value)) {
    for (const child of value) collectImmutableNames(child, names);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  if (
    node['mutability'] === 'immutable' &&
    Number.isSafeInteger(node['id']) &&
    typeof node['name'] === 'string' &&
    node['name'].length > 0
  ) names.set(Number(node['id']), node['name']);
  for (const child of Object.values(node)) collectImmutableNames(child, names);
};

const decodeReferences = (
  value: unknown,
  code: string,
): readonly ImmutableReference[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  return value.map((raw, index) => {
    const reference = requireRecord(raw, `${code}:${index}`);
    const start = reference['start'];
    const length = reference['length'];
    if (!Number.isSafeInteger(start) || Number(start) < 0 || !Number.isSafeInteger(length) || Number(length) <= 0) {
      throw new Error(`${code}:${index}`);
    }
    return { start: Number(start), length: Number(length) };
  });
};

const decodeEvidence = (
  value: unknown,
  sourceName: string,
  contractName: string,
): CompilerBytecodeEvidence | null => {
  const root = requireRecord(value, 'STACK_MANAGER_BUILD_INFO_INVALID');
  const output = readFieldRecord(root, 'output', 'STACK_MANAGER_BUILD_OUTPUT_INVALID');
  const contracts = readFieldRecord(output, 'contracts', 'STACK_MANAGER_BUILD_CONTRACTS_INVALID');
  const sourceContracts = contracts[sourceName];
  if (sourceContracts === undefined) return null;
  const contract = readFieldRecord(
    requireRecord(sourceContracts, 'STACK_MANAGER_BUILD_SOURCE_CONTRACTS_INVALID'),
    contractName,
    'STACK_MANAGER_BUILD_CONTRACT_INVALID',
  );
  const evm = readFieldRecord(contract, 'evm', 'STACK_MANAGER_BUILD_EVM_INVALID');
  const deployed = readFieldRecord(evm, 'deployedBytecode', 'STACK_MANAGER_BUILD_BYTECODE_INVALID');
  const rawReferences = requireRecord(
    deployed['immutableReferences'] ?? {},
    'STACK_MANAGER_BUILD_IMMUTABLES_INVALID',
  );
  if (Object.keys(rawReferences).length === 0) return { immutableReferences: {} };

  const sources = readFieldRecord(output, 'sources', 'STACK_MANAGER_BUILD_SOURCES_INVALID');
  const source = readFieldRecord(sources, sourceName, 'STACK_MANAGER_BUILD_SOURCE_INVALID');
  const names = new Map<number, string>();
  collectImmutableNames(source['ast'], names);
  const immutableReferences: Record<string, readonly ImmutableReference[]> = {};
  for (const [rawId, rawSlots] of Object.entries(rawReferences)) {
    const id = Number(rawId);
    const name = rawId === 'library_deploy_address' ? rawId : names.get(id);
    if (!name || Object.hasOwn(immutableReferences, name)) {
      throw new Error(`STACK_MANAGER_BUILD_IMMUTABLE_NAME_INVALID:${sourceName}:${contractName}:${rawId}`);
    }
    immutableReferences[name] = decodeReferences(
      rawSlots,
      `STACK_MANAGER_BUILD_IMMUTABLE_REFERENCE_INVALID:${sourceName}:${contractName}:${name}`,
    );
  }
  return { immutableReferences };
};

export const readCompilerBytecodeEvidence = async (
  buildInfoDirectory: URL,
  sourceName: string,
  contractName: string,
): Promise<CompilerBytecodeEvidence> => {
  const files = (await readdir(buildInfoDirectory)).filter(file => file.endsWith('.json')).sort();
  let match: CompilerBytecodeEvidence | null = null;
  for (const file of files) {
    const raw: unknown = JSON.parse(await readFile(new URL(file, buildInfoDirectory), 'utf8'));
    const candidate = decodeEvidence(raw, sourceName, contractName);
    if (!candidate) continue;
    if (match) throw new Error(`STACK_MANAGER_BUILD_INFO_AMBIGUOUS:${sourceName}:${contractName}`);
    match = candidate;
  }
  if (!match) throw new Error(`STACK_MANAGER_BUILD_INFO_MISSING:${sourceName}:${contractName}`);
  return match;
};

export const bindCompilerImmutables = (
  bytecode: string,
  evidence: CompilerBytecodeEvidence,
  values: Readonly<Record<string, string>>,
  contractName: string,
): string => {
  let bound = bytecode;
  const names = Object.keys(evidence.immutableReferences).sort();
  const supplied = Object.keys(values).sort();
  if (names.join('\0') !== supplied.join('\0')) {
    throw new Error(`STACK_MANAGER_IMMUTABLE_SET_MISMATCH:${contractName}:expected=${names}:actual=${supplied}`);
  }
  for (const name of names) {
    const value = values[name];
    if (!value || !/^0x(?:[0-9a-fA-F]{2}){1,32}$/.test(value)) {
      throw new Error(`STACK_MANAGER_IMMUTABLE_VALUE_INVALID:${contractName}:${name}`);
    }
    for (const reference of evidence.immutableReferences[name] ?? []) {
      if (reference.length !== 32) throw new Error(`STACK_MANAGER_IMMUTABLE_LENGTH_INVALID:${contractName}:${name}`);
      const start = 2 + reference.start * 2;
      const encoded = value.slice(2).toLowerCase().padStart(64, '0');
      bound = `${bound.slice(0, start)}${encoded}${bound.slice(start + reference.length * 2)}`;
    }
  }
  return bound;
};
