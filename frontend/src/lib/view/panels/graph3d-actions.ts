import type { GraphPaymentJob, GraphXLNRuntime } from './graph3d-types';
import { graphReserveValue } from './graph3d-helpers';
import { parseTokenAmountInput } from '../../components/Entity/token-amount-input';

export function parseGraphPaymentAmount(amount: string, decimals: number): bigint {
  return parseTokenAmountInput(amount, decimals);
}

export function buildGraphPaymentInput(
  job: GraphPaymentJob,
  signerId: string,
  route: string[],
  decimals: number,
  maxSenderDebit: bigint,
) {
  if (route.length < 2) throw new Error(`Invalid route: expected at least 2 entities, got ${route.length}`);
  if (route[0] !== job.from || route[route.length - 1] !== job.to) {
    throw new Error(`Route mismatch: expected ${job.from} → ${job.to}, got ${route[0]} → ${route[route.length - 1]}`);
  }
  return {
    entityId: job.from,
    signerId,
    entityTxs: [
      {
        type: 'htlcPayment' as const,
        data: {
          targetEntityId: job.to,
          tokenId: job.tokenId,
          amount: parseGraphPaymentAmount(job.amount, decimals),
          maxSenderDebit,
          route,
          deliveryMode: 'instant' as const,
          description: `Bird view payment: ${job.amount}`,
        },
      },
    ],
  };
}

export async function loadGraphScenarioSteps<T>(filename: string, parse: (source: string) => T): Promise<T | null> {
  const response = await fetch(`/worlds/${filename}`);
  if (!response.ok) return null;
  return parse(await response.text());
}

export async function executeGraphScenario(options: { filename: string; runtime: GraphXLNRuntime; env: any }) {
  const response = await fetch(`/worlds/${options.filename}`);
  if (!response.ok) throw new Error(`Failed to load scenario: ${response.statusText}`);
  const parsed = options.runtime.parseScenario(await response.text());
  if (parsed.errors.length > 0) return { parsed, result: null };
  const result = await options.runtime.executeScenario(options.env, parsed.scenario);
  return { parsed, result };
}

export function collectGraphTokenIds(replicas: Map<string, any>): number[] {
  const tokenIds = new Set<number>([1]);
  for (const replica of replicas.values()) {
    if (!replica?.state?.reserves) continue;
    for (const tokenIdValue of replica.state.reserves.keys()) {
      const tokenId = Number(tokenIdValue);
      if (Number.isFinite(tokenId)) tokenIds.add(tokenId);
    }
  }
  return [...tokenIds].sort((left, right) => left - right);
}

export function calculateGraphEntityRadius(reserveValueUsd: number): number {
  if (reserveValueUsd <= 0) return 0.4;
  const ratio = Math.max(1, reserveValueUsd / 500_000);
  return Math.max(0.5, Math.min(0.5 * Math.pow(ratio, 0.6), 2.7));
}

export function getGraphEntitySizeForToken(options: {
  replicas: Map<string, any>;
  entityId: string;
  tokenId: number;
  tokenDecimals: number;
  sizeMultiplier: number;
}): number {
  const displayScale = 1.6 * options.sizeMultiplier;
  for (const [key, replica] of options.replicas) {
    if ((key.split(':')[0] || key) !== options.entityId) continue;
    if (!replica?.state?.reserves) return 0.4 * displayScale;
    const reserve = graphReserveValue(replica.state.reserves, String(options.tokenId));
    const reserveValueUsd = Number(reserve) / 10 ** options.tokenDecimals;
    return calculateGraphEntityRadius(reserveValueUsd) * displayScale;
  }
  return 0.4 * displayScale;
}
