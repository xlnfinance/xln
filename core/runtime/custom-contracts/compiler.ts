import { safeStringify } from '../../protocol/serialization';
import solc from 'solc';
import { readFileSync } from 'node:fs';
import { Interface, keccak256 } from 'ethers';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';
import { CUSTOM_TRANSFORMER_ABI } from '../../protocol/dispute/custom-contract-abi';
import { readClauseSchemas } from './simulation';
import type { CompiledClause } from './types';
import { validateClauseAst } from './constraints';

const WIDE_MATH = readFileSync(new URL('../../../jurisdictions/contracts/math/WideMath.sol', import.meta.url), 'utf8');
const CUSTOM_COMPILER_VERSION = '0.8.36+commit.8a079791.Emscripten.clang';
const CUSTOM_MAX_CODE_BYTES = 12_288;

const compileSource = (source: string, emitBytecode: boolean): Record<string, unknown> => {
  if (new TextEncoder().encode(source).length > 65_536) throw new Error('CLAUSE_SOURCE_TOO_LARGE');
  if (solc.version() !== CUSTOM_COMPILER_VERSION) throw new Error('CLAUSE_COMPILER_VERSION_MISMATCH');
  const settings = {
    optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'cancun', metadata: { bytecodeHash: 'none', appendCBOR: false },
    outputSelection: emitBytecode
      ? { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
      : { 'Clause.sol': { '': ['ast'] } },
  };
  const output: unknown = JSON.parse(solc.compile(safeStringify({ language: 'Solidity',
    sources: { 'Clause.sol': { content: source } }, settings,
  }), { import: path => path === 'WideMath.sol' ? { contents: WIDE_MATH } : { error: `IMPORT_NOT_ALLOWED:${path}` } }));
  return requireBoundaryRecord(output, 'CLAUSE_COMPILER_OUTPUT');
};

const requireBytecode = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]+$/.test(value) || value.length / 2 > CUSTOM_MAX_CODE_BYTES) {
    throw new Error('CLAUSE_BYTECODE_INVALID_OR_TOO_LARGE');
  }
  return `0x${value}`;
};

const rejectCompilerErrors = (output: Record<string, unknown>): void => {
  const errors = output['errors'];
  if (!Array.isArray(errors)) return;
  for (const raw of errors) {
    const error = requireBoundaryRecord(raw, 'CLAUSE_DIAGNOSTIC');
    if (error['severity'] === 'error') throw new Error(`CLAUSE_COMPILE_FAILED:${String(error['formattedMessage'])}`);
  }
};

const readArtifact = (output: Record<string, unknown>, name: string) => {
  const contracts = requireBoundaryRecord(output['contracts'], 'CLAUSE_CONTRACTS');
  const compiled = requireBoundaryRecord(requireBoundaryRecord(contracts['Clause.sol'], 'CLAUSE_SOURCE_CONTRACTS')[name], 'CLAUSE_CONTRACT_NAME');
  if (!Array.isArray(compiled['abi'])) throw new Error('CLAUSE_ABI_INVALID');
  const abi = new Interface(safeStringify(compiled['abi']));
  const actual = abi.getFunction('applyBatch');
  const expected = new Interface(CUSTOM_TRANSFORMER_ABI).getFunction('applyBatch');
  if (!actual || !expected || actual.format('sighash') !== expected.format('sighash') ||
    actual.outputs.map(value => value.format()).join() !== expected.outputs.map(value => value.format()).join() ||
    !['view', 'pure'].includes(actual.stateMutability)) {
    throw new Error('CLAUSE_APPLY_BATCH_ABI_MISMATCH');
  }
  const evm = requireBoundaryRecord(compiled['evm'], 'CLAUSE_EVM');
  return {
    initcode: requireBytecode(requireBoundaryRecord(evm['bytecode'], 'CLAUSE_INITCODE')['object']),
    runtimeBytecode: requireBytecode(requireBoundaryRecord(evm['deployedBytecode'], 'CLAUSE_RUNTIME_CODE')['object']),
  };
};

/** Pure artifact production plus isolated EVM introspection; no RJEA mutation. */
export async function compileCustomContract(source: string, contractName: string): Promise<CompiledClause> {
  // Validate source restrictions before invoking bytecode generation.
  const syntax = compileSource(source, false);
  rejectCompilerErrors(syntax);
  validateClauseAst(syntax);
  const output = compileSource(source, true);
  rejectCompilerErrors(output);
  const code = readArtifact(output, contractName);
  const schemas = await readClauseSchemas(code.runtimeBytecode);
  return { source, contractName, compilerVersion: CUSTOM_COMPILER_VERSION, ...code,
    codeHash: keccak256(code.runtimeBytecode), schemas };
}
