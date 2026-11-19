import type { PocUser } from '../user';

export const requireRunId = (value: string): string => {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error('USDC_POC_RUN_ID_INVALID');
  return value;
};

export const runOrderId = (entityId: string, runId: string): string => `usdc-poc-${entityId}-${requireRunId(runId)}`;

export const targetUser = (user: PocUser, apiBase: string): PocUser => {
  if (user.jurisdictions.length !== 2) throw new Error('USDC_POC_TWO_JURISDICTIONS_REQUIRED');
  const jurisdiction = user.jurisdictions[1]!;
  const identity = user.identities.find(value => value.chainId === jurisdiction.chainId);
  if (!identity) throw new Error('USDC_POC_TARGET_IDENTITY_MISSING');
  return {
    ...user,
    ...identity,
    jurisdiction: {
      ...jurisdiction,
      rpc: new URL(jurisdiction.rpc, apiBase).toString(),
    },
  };
};
