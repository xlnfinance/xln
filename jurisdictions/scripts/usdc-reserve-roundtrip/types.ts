import type { JsonRpcProvider, Wallet } from 'ethers';
import type { Depository } from '../../typechain-types';
import type { readVerificationInputs } from '../deployment/operator/readonly-identity';
import type { CanonicalChainPoint } from '../../../core/jurisdiction/adapter/stack-manager/receipts';

export type RoundtripOptions = Readonly<{
  network: 'local' | 'ethereum-sepolia' | 'arbitrum-sepolia';
  chainId: number;
  token: string;
  deploymentDir: string;
  confirmations?: number;
}>;
export type Snapshot = Readonly<{
  point: CanonicalChainPoint;
  token: bigint;
  reserve: bigint;
  nativeWei: bigint;
  debt: bigint;
  entityNonce: bigint;
  allowance: bigint;
}>;
export type FinancialStage = 'approval' | 'deposit' | 'withdrawal';
export type TransactionEvidence = {
  stage: FinancialStage;
  hash: string;
  status: 'broadcast-attempt' | 'broadcast' | 'confirmed';
  receipt?: unknown;
  expense?: unknown;
  confirmedAt?: CanonicalChainPoint;
};
export type RoundtripEvidence = {
  operation: 'one-usdc-reserve-roundtrip';
  status: 'incomplete' | 'complete';
  stage: string;
  network: string;
  chainId: number;
  amount: bigint;
  confirmations: number;
  signer?: string;
  entityId?: string;
  probe?: unknown;
  deployment?: Readonly<{
    deploymentId: string;
    manifest: Context['input']['manifest'];
    executionCandidate: Context['input']['executionCandidate'];
    inputDigests: Context['input']['inputDigests'];
    verifiedAt: CanonicalChainPoint;
  }>;
  transactions: TransactionEvidence[];
  snapshots: Partial<Record<'initial' | 'deposited' | 'restored' | 'failure', Snapshot>>;
  native?: { feesWei: bigint; deltaWei: bigint; unaccountedDeltaWei: bigint };
  failure?: string;
  balanceReadFailure?: string;
};
export type Context = Readonly<{
  options: RoundtripOptions;
  provider: JsonRpcProvider;
  wallet: Wallet;
  input: Awaited<ReturnType<typeof readVerificationInputs>>;
  depository: Depository;
  entityId: string;
  evidence: RoundtripEvidence;
  signal: AbortSignal;
}>;
export const ONE_USDC = 1_000_000n;
