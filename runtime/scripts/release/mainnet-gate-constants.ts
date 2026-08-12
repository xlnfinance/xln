export const MAINNET_GATE = {
  expectedHubs: 3,
  expectedTowers: 1,
  recoverySlaSeconds: 60,
  soakMinutes: 60,
  regressionThresholdPct: 20,
} as const;

export const MAINNET_RELEASE_BLOCKERS = [
  {
    id: 'CAPPED_FINANCIAL_RISK_ENFORCEMENT_MISSING',
    requirement: 'A machine-enforced aggregate financial risk ceiling with executable boundary evidence',
  },
  {
    id: 'LENDING_BILATERAL_COVENANT_MISSING',
    requirement: 'A bilaterally committed lending covenant covering principal, maturity, repayment, and default',
  },
  {
    id: 'LENDING_ONCHAIN_MATURITY_DEFAULT_ENFORCEMENT_MISSING',
    requirement: 'On-chain maturity and default enforcement for every mainnet lending position',
  },
] as const;

export const MAINNET_GATE_LABELS = {
  cappedPolicySchema: 'xln:capped-testnet-policy:v1',
  cappedPolicyName: 'capped-public-testnet',
} as const;
