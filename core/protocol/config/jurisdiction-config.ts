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
  /**
   * Committed minimum own-side Account response window this Entity accepts
   * when a peer proposes Account genesis. Absent means the role default
   * (hub 1 h, user 24 h). Tests and dev stacks set a lower one explicitly.
   */
  accountDisputeFloorSeconds?: number;
  rebalancePolicyUsd?: {
    r2cRequestSoftLimit: number;
    hardLimit: number;
    maxFee: number;
  };
}
