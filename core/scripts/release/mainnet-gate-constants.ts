export const MAINNET_GATE = {
  expectedHubs: 3,
  expectedTowers: 1,
  recoverySlaSeconds: 60,
  soakMinutes: 60,
  regressionThresholdPct: 20,
} as const;

export const MAINNET_GATE_LABELS = {
  cappedPolicySchema: 'xln:capped-testnet-policy:v1',
  cappedPolicyName: 'capped-public-testnet',
} as const;
