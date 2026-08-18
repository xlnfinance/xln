import {
  deriveDelta,
  getTokenInfo,
  isLeftEntity,
} from '../../core/runtime.ts';
import type { AccountReplica, Delta, EntityReplica, RuntimeReplica } from './runtime-types';
import { renderCapacityBar, formatBarLegend } from './presentation/bars';
import { formatAmount, shortId } from './presentation/format';
import type { BarStyle } from './settings';
import { paint } from './presentation/theme';

export type AccountTokenRow = {
  counterpartyId: string;
  tokenId: number;
  symbol: string;
  bar: string;
  outCapacity: bigint;
  inCapacity: bigint;
  collateral: bigint;
  delta: bigint;
};

export type AccountView = {
  counterpartyId: string;
  height: number;
  tokens: AccountTokenRow[];
};

const entityReplicaFor = (env: RuntimeReplica, entityId: string): EntityReplica | null => {
  const needle = entityId.toLowerCase();
  for (const [key, replica] of env.state.eReplicas.entries()) {
    const [id] = String(key).split(':');
    if (String(id || '').toLowerCase() === needle) return replica;
  }
  return null;
};

const accountMap = (replica: EntityReplica): Map<string, AccountReplica> => {
  const accounts = replica.state?.accounts;
  if (!accounts) return new Map();
  if (accounts instanceof Map) return accounts;
  return new Map(Object.entries(accounts as Record<string, AccountReplica>));
};

export const listAccountViews = (
  env: RuntimeReplica,
  entityId: string,
  barStyle: BarStyle,
  color = true,
): AccountView[] => {
  const replica = entityReplicaFor(env, entityId);
  if (!replica) return [];
  const views: AccountView[] = [];
  for (const [counterpartyId, account] of accountMap(replica).entries()) {
    const frameDeltas = account.currentFrame?.deltas;
    const stateDeltas = account.state?.deltas;
    const deltas: Delta[] = Array.isArray(frameDeltas)
      ? frameDeltas
      : stateDeltas instanceof Map
        ? [...stateDeltas.values()]
        : [];
    const left = isLeftEntity(entityId, counterpartyId);
    const tokens: AccountTokenRow[] = [];
    for (const delta of deltas) {
      const derived = deriveDelta(delta, left);
      let symbol = `#${delta.tokenId}`;
      try {
        symbol = getTokenInfo(delta.tokenId).symbol;
      } catch {
        /* keep numeric */
      }
      tokens.push({
        counterpartyId,
        tokenId: delta.tokenId,
        symbol,
        bar: renderCapacityBar(derived, { style: barStyle, color }),
        outCapacity: derived.outCapacity,
        inCapacity: derived.inCapacity,
        collateral: derived.collateral,
        delta: derived.delta,
      });
    }
    views.push({
      counterpartyId,
      height: account.currentFrame?.height ?? 0,
      tokens,
    });
  }
  return views.sort((a, b) => a.counterpartyId.localeCompare(b.counterpartyId));
};

export const formatAccountsPanel = (
  env: RuntimeReplica,
  entityId: string,
  barStyle: BarStyle,
  color = true,
): string => {
  const views = listAccountViews(env, entityId, barStyle, color);
  const lines = [
    paint('bold', 'Accounts'),
    paint('muted', formatBarLegend(barStyle)),
    '',
  ];
  if (views.length === 0) {
    lines.push(paint('muted', 'No accounts yet. Open a hub from the Open tab / `xln open`.'));
    return lines.join('\n');
  }
  for (const view of views) {
    lines.push(paint('accent', `↔ ${shortId(view.counterpartyId, 10, 6)}  h=${view.height}`));
    if (view.tokens.length === 0) {
      lines.push(paint('muted', '  (no token deltas)'));
      continue;
    }
    for (const token of view.tokens) {
      lines.push(
        `  ${token.symbol.padEnd(6)} ${token.bar}  out=${formatAmount(token.outCapacity, token.tokenId)}  in=${formatAmount(token.inCapacity, token.tokenId)}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
};

export const findAccount = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
): AccountReplica | null => {
  const replica = entityReplicaFor(env, entityId);
  if (!replica) return null;
  const needle = counterpartyId.toLowerCase();
  for (const [id, account] of accountMap(replica).entries()) {
    if (id.toLowerCase() === needle) return account;
  }
  return null;
};
