export interface JurisdictionConfig {
  address: string;
  name: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  chainId?: number;
  blockTimeMs?: number;
  /** First J block relevant to this registered entity's history. */
  registrationBlock?: number;
  /** Authenticated history scan starts at this EntityProvider deployment block. */
  entityProviderDeploymentBlock?: number;
  rebalancePolicyUsd?: {
    r2cRequestSoftLimit: number;
    hardLimit: number;
    maxFee: number;
  };
}
