import type { ClauseSchemas } from '../../runtime/custom-contracts/types';

export type CustomContractAllowance = { tokenId: number; leftAllowance: bigint; rightAllowance: bigint };
export type CustomContractEffect = { tokenId: number; amount: bigint };
export type CustomContractProgram = {
  transformerAddress: string;
  initcode: string;
  source: string;
  contractName: string;
  compilerVersion: string;
  schemas: ClauseSchemas;
  encodedBatch: string;
  allowances: CustomContractAllowance[];
};
export type CustomContractResolution = {
  proposerIsLeft: boolean;
  leftArguments: string;
  rightArguments: string;
  effects: CustomContractEffect[];
};
/** All fields are signed. Initcode is required after a crash to enforce the clause. */
export type AccountCustomContract = CustomContractProgram & {
  status: 'proposed' | 'active';
  proposerIsLeft: boolean;
  createdHeight: number;
  revision: number;
  resolution?: CustomContractResolution;
};
export type CustomContractTransition = { id: string } & (
  | { kind: 'propose'; program: CustomContractProgram }
  | { kind: 'approve' | 'reject' | 'confirm'; createdHeight: number; revision: number }
  | { kind: 'resolve'; createdHeight: number; revision: number;
      leftArguments: string; rightArguments: string; effects: CustomContractEffect[] }
);
