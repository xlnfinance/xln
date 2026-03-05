export type DeltaParts = {
  outOwnCredit: bigint;
  outCollateral: bigint;
  outPeerCredit: bigint;
  inOwnCredit: bigint;
  inCollateral: bigint;
  inPeerCredit: bigint;
  outTotalHold?: bigint;
  inTotalHold?: bigint;
};
