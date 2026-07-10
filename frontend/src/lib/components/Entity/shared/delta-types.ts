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

export type DeltaCapacityBarPresentation = Readonly<{
  colors?: Readonly<{
    credit?: string;
    collateral?: string;
    debt?: string;
    track?: string;
    delta?: string;
  }>;
  animations?: Readonly<{
    transition?: boolean;
    sweep?: boolean;
    glow?: boolean;
    ripple?: boolean;
  }>;
  durationsMs?: Readonly<{
    transition?: number;
    sweep?: number;
    glow?: number;
    ripple?: number;
    stripe?: number;
    settling?: number;
  }>;
  creditGradient?: boolean;
}>;
