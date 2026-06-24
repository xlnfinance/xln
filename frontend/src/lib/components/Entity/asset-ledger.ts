export type AssetLedgerRow = {
  symbol: string;
  address: string;
  decimals: number;
  tokenId: number | undefined;
  isNative: boolean;
  externalBalance: bigint;
  reserveBalance: bigint;
  accountBalance: bigint;
  externalUsd: number;
  reserveUsd: number;
  accountUsd: number;
  totalUsd: number;
  externalError?: string;
};

export type AssetLedgerTotals = {
  externalUsd: number;
  reserveUsd: number;
  accountUsd: number;
};

export type ExternalWalletSnapshotSource = {
  sourceHeight: number;
  sourceHash?: string;
  finalityDepth?: number;
  headBlockNumber?: number;
};
