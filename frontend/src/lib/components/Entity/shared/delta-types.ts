export type DeltaParts = {
  outCapacity: bigint;
  inCapacity: bigint;
  outOwnCredit: bigint;
  outCollateral: bigint;
  outPeerCredit: bigint;
  inOwnCredit: bigint;
  inCollateral: bigint;
  inPeerCredit: bigint;
  outTotalHold?: bigint;
  inTotalHold?: bigint;
};

export type DeltaVisualScale = {
  outCapacityUsd: number;
  inCapacityUsd: number;
  outOwnCreditUsd: number;
  outCollateralUsd: number;
  outPeerCreditUsd: number;
  inOwnCreditUsd: number;
  inCollateralUsd: number;
  inPeerCreditUsd: number;
  outTotalUsd: number;
  inTotalUsd: number;
};
