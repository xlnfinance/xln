/** Compiler and wallet data. Compilation never runs inside an RJEA transition. */
export type ClauseField = Readonly<{ name: string; type: string; label: string }>;
export type ClauseSchemas = Readonly<{
  params: readonly ClauseField[];
  leftArguments: readonly ClauseField[];
  rightArguments: readonly ClauseField[];
}>;
export type CompiledClause = Readonly<{
  source: string;
  contractName: string;
  compilerVersion: string;
  initcode: string;
  runtimeBytecode: string;
  codeHash: string;
  schemas: ClauseSchemas;
}>;
export type ClauseSimulationInput = Readonly<{
  artifact: CompiledClause;
  tokenIds: readonly number[];
  deltas: readonly bigint[];
  encodedBatch: string;
  leftArguments: string;
  rightArguments: string;
  timestamp: number;
  leftEntity: string;
  rightEntity: string;
  depositoryAddress: string;
  transformerAddress: string;
  chainId: number;
  rpcUrl?: string;
}>;
