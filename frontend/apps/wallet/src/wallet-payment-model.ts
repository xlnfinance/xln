import type {
  RuntimePaymentDeliveryMode,
  RuntimePaymentEntityTx,
  RuntimePaymentInput,
} from '../../../packages/runtime-client/src/payment-command-types';

import { buildPaymentRuntimeInput } from '../../../packages/runtime-client/src/payment-command';
import {
  decodeWalletPortfolioProjection,
  type WalletPortfolioAccount,
  type WalletPortfolioMath,
} from './wallet-portfolio-model';
import {
  normalizeRequiredRuntimeEntityId,
  requireRuntimeInteger,
  requireRuntimeRecord,
  requireRuntimeString,
} from './wallet-runtime-decode';

export type WalletPaymentMath = WalletPortfolioMath & Readonly<{
  parseTokenAmount: (tokenId: number, amount: string) => bigint;
}>;

export type WalletPaymentToken = Readonly<{
  tokenId: number;
  symbol: string;
  reserve: bigint;
  spendable: bigint;
  spendableLabel: string;
}>;

export type WalletPaymentProjection = Readonly<{
  height: number;
  activeEntityId: string;
  activeEntityLabel: string;
  signerId: string;
  entities: readonly Readonly<{ entityId: string; label: string }>[];
  recipients: readonly Readonly<{ entityId: string; label: string; blocked: boolean }>[];
  tokens: readonly WalletPaymentToken[];
  accounts: readonly WalletPortfolioAccount[];
}>;

export type WalletPaymentRoute = Readonly<{
  path: readonly string[];
  hops: readonly Readonly<{ from: string; to: string; fee: bigint; feePPM: number }>[];
  totalFee: bigint;
  senderAmount: bigint;
  recipientAmount: bigint;
  probability: number;
}>;

export type WalletPaymentQuoteRequest = Readonly<{
  sourceEntityId: string;
  targetEntityId: string;
  tokenId: number;
  recipientAmount: bigint;
  deliveryMode: RuntimePaymentDeliveryMode;
}>;

const blockedCounterparties = (frame: Record<string, unknown>, activeEntityId: string): ReadonlySet<string> => {
  const active = requireRuntimeRecord(frame['activeEntity'], 'WALLET_PAYMENT_ACTIVE_ENTITY');
  const accounts = requireRuntimeRecord(active['accounts'], 'WALLET_PAYMENT_ACCOUNTS');
  if (!Array.isArray(accounts['items'])) throw new Error('WALLET_PAYMENT_ACCOUNTS_INVALID');
  return new Set(accounts['items'].flatMap((value): string[] => {
    const account = requireRuntimeRecord(value, 'WALLET_PAYMENT_ACCOUNT');
    const status = requireRuntimeString(account['status'], 'WALLET_PAYMENT_ACCOUNT_STATUS');
    if (status === 'active') return [];
    if (status !== 'dispute_preparing' && status !== 'disputed') {
      throw new Error('WALLET_PAYMENT_ACCOUNT_STATUS_INVALID');
    }
    const state = requireRuntimeRecord(account['state'], 'WALLET_PAYMENT_ACCOUNT_STATE');
    const left = normalizeRequiredRuntimeEntityId(state['leftEntity'], 'WALLET_PAYMENT_ACCOUNT_LEFT');
    const right = normalizeRequiredRuntimeEntityId(state['rightEntity'], 'WALLET_PAYMENT_ACCOUNT_RIGHT');
    if (left !== activeEntityId && right !== activeEntityId) {
      throw new Error('WALLET_PAYMENT_ACCOUNT_PERSPECTIVE_MISMATCH');
    }
    return [left === activeEntityId ? right : left];
  }));
};

export const decodeWalletPaymentProjection = (
  value: unknown,
  math: WalletPaymentMath,
): WalletPaymentProjection => {
  const frame = requireRuntimeRecord(value, 'WALLET_PAYMENT_FRAME');
  const portfolio = decodeWalletPortfolioProjection(frame, math);
  if (!portfolio.activeEntityId) return {
    height: portfolio.height,
    activeEntityId: '',
    activeEntityLabel: '',
    signerId: '',
    entities: portfolio.entities,
    recipients: [],
    tokens: [],
    accounts: [],
  };
  const active = requireRuntimeRecord(frame['activeEntity'], 'WALLET_PAYMENT_ACTIVE_ENTITY');
  const core = requireRuntimeRecord(active['core'], 'WALLET_PAYMENT_ACTIVE_CORE');
  const signerId = requireRuntimeString(core['signerId'], 'WALLET_PAYMENT_SIGNER');
  const blocked = blockedCounterparties(frame, portfolio.activeEntityId);
  return {
    height: portfolio.height,
    activeEntityId: portfolio.activeEntityId,
    activeEntityLabel: portfolio.activeEntityLabel,
    signerId,
    entities: portfolio.entities,
    recipients: portfolio.entities
      .filter(({ entityId }) => entityId !== portfolio.activeEntityId)
      .map(({ entityId, label }) => ({ entityId, label, blocked: blocked.has(entityId) })),
    tokens: portfolio.assets.map((asset) => ({
      tokenId: asset.tokenId,
      symbol: asset.symbol,
      reserve: asset.reserve,
      spendable: asset.reserve + asset.accountSpendable,
      spendableLabel: math.formatTokenAmount(asset.tokenId, asset.reserve + asset.accountSpendable),
    })),
    accounts: portfolio.accounts,
  };
};

const routeAmount = (value: unknown, label: string): bigint => {
  const raw = requireRuntimeString(value, label);
  if (!/^\d+$/.test(raw)) throw new Error(`${label}_INVALID`);
  return BigInt(raw);
};

const modeAllowsRoute = (mode: RuntimePaymentDeliveryMode, route: WalletPaymentRoute): boolean => {
  if (mode === 'direct') return route.path.length === 2;
  if (mode === 'trusted') return route.path.length === 3 && route.totalFee === 0n;
  return true;
};

export const decodeWalletPaymentRoutes = (
  value: unknown,
  request: WalletPaymentQuoteRequest,
): readonly WalletPaymentRoute[] => {
  const root = requireRuntimeRecord(value, 'WALLET_PAYMENT_ROUTES');
  if (!Array.isArray(root['routes'])) throw new Error('WALLET_PAYMENT_ROUTES_INVALID');
  const routes = root['routes'].map((value): WalletPaymentRoute => {
    const route = requireRuntimeRecord(value, 'WALLET_PAYMENT_ROUTE');
    if (!Array.isArray(route['path']) || route['path'].length < 2 || route['path'].length > 12) {
      throw new Error('WALLET_PAYMENT_ROUTE_PATH_INVALID');
    }
    const path = route['path'].map((id) => normalizeRequiredRuntimeEntityId(id, 'WALLET_PAYMENT_ROUTE_ENTITY'));
    if (path[0] !== request.sourceEntityId || path[path.length - 1] !== request.targetEntityId) {
      throw new Error('WALLET_PAYMENT_ROUTE_ENDPOINT_MISMATCH');
    }
    if (new Set(path).size !== path.length) throw new Error('WALLET_PAYMENT_ROUTE_CYCLE');
    if (!Array.isArray(route['hops']) || route['hops'].length !== path.length - 1) {
      throw new Error('WALLET_PAYMENT_ROUTE_HOPS_INVALID');
    }
    const hops = route['hops'].map((value, index) => {
      const hop = requireRuntimeRecord(value, 'WALLET_PAYMENT_ROUTE_HOP');
      const from = normalizeRequiredRuntimeEntityId(hop['from'], 'WALLET_PAYMENT_ROUTE_HOP_FROM');
      const to = normalizeRequiredRuntimeEntityId(hop['to'], 'WALLET_PAYMENT_ROUTE_HOP_TO');
      if (from !== path[index] || to !== path[index + 1]) throw new Error('WALLET_PAYMENT_ROUTE_HOP_MISMATCH');
      return {
        from,
        to,
        fee: routeAmount(hop['fee'], 'WALLET_PAYMENT_ROUTE_HOP_FEE'),
        feePPM: requireRuntimeInteger(hop['feePPM'], 'WALLET_PAYMENT_ROUTE_HOP_PPM'),
      };
    });
    const totalFee = routeAmount(route['totalFee'], 'WALLET_PAYMENT_ROUTE_FEE');
    const senderAmount = routeAmount(route['senderAmount'], 'WALLET_PAYMENT_ROUTE_SENDER');
    const recipientAmount = routeAmount(route['recipientAmount'], 'WALLET_PAYMENT_ROUTE_RECIPIENT');
    const probability = Number(route['probability']);
    if (recipientAmount !== request.recipientAmount || senderAmount !== recipientAmount + totalFee) {
      throw new Error('WALLET_PAYMENT_ROUTE_AMOUNT_MISMATCH');
    }
    if (hops.reduce((sum, hop) => sum + hop.fee, 0n) !== totalFee) {
      throw new Error('WALLET_PAYMENT_ROUTE_FEE_MISMATCH');
    }
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error('WALLET_PAYMENT_ROUTE_PROBABILITY_INVALID');
    }
    return { path, hops, totalFee, senderAmount, recipientAmount, probability };
  }).filter((route) => modeAllowsRoute(request.deliveryMode, route));
  return routes.sort((left, right) => left.senderAmount === right.senderAmount
    ? left.path.length - right.path.length || left.path.join(':').localeCompare(right.path.join(':'))
    : left.senderAmount < right.senderAmount ? -1 : 1);
};

export const buildWalletPaymentInput = (input: Readonly<{
  projection: WalletPaymentProjection;
  targetEntityId: string;
  tokenId: number;
  deliveryMode: RuntimePaymentDeliveryMode;
  description: string;
  route: WalletPaymentRoute;
}>): RuntimePaymentInput => buildPaymentRuntimeInput({
  entityId: input.projection.activeEntityId,
  signerId: input.projection.signerId,
  targetEntityId: input.targetEntityId,
  tokenId: input.tokenId,
  deliveryMode: input.deliveryMode,
  description: input.description,
  route: { ...input.route, path: [...input.route.path] },
});

export const buildWalletEntityTxInput = (
  projection: WalletPaymentProjection,
  entityTx: RuntimePaymentEntityTx,
): RuntimePaymentInput => ({
  runtimeTxs: [],
  entityInputs: [{
    entityId: projection.activeEntityId,
    signerId: projection.signerId,
    entityTxs: [entityTx],
  }],
  jInputs: [],
});
