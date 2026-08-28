import type { WalletPortfolioEntity, WalletPortfolioMath } from './wallet-portfolio-model';
import {
  decodeWalletSolvency,
  type WalletSolvencyAsset,
  type WalletSolvencyStatus,
} from './wallet-financial-health-solvency';
import {
  normalizeRequiredRuntimeEntityId,
  optionalRuntimeEntityId,
  optionalRuntimeInteger,
  optionalRuntimeMap,
  optionalRuntimeString,
  requireRuntimeBigInt,
  requireRuntimeEnum,
  requireRuntimeInteger,
  requireRuntimeMap,
  requireRuntimeRecord,
  requireRuntimeString,
} from './wallet-runtime-decode';

type DebtDirection = 'out' | 'in';
type DisputePhase = 'preparing' | 'disputed';

export type WalletDebtEntry = Readonly<{
  debtId: string;
  counterpartyId: string;
  counterpartyLabel: string;
  remainingLabel: string;
  originalLabel: string;
  paidLabel: string;
  lastUpdatedBlock: number;
}>;

export type WalletDebtGroup = Readonly<{
  key: string;
  direction: DebtDirection;
  tokenId: number;
  symbol: string;
  outstandingLabel: string;
  entries: readonly WalletDebtEntry[];
}>;

export type WalletDispute = Readonly<{
  counterpartyId: string;
  counterpartyLabel: string;
  phase: DisputePhase;
  accountHeight: number;
  frameHeight: number;
  responseWindowLabel: string;
  proofStatus: 'both-hankos' | 'local-hanko' | 'none';
}>;

export type WalletHistoryEvent = Readonly<{
  id: string;
  height: number;
  timestamp: number;
  kind: 'onchain' | 'offchain';
  direction: 'in' | 'out' | 'neutral';
  type: string;
  title: string;
  subtitle: string;
  status: string;
  counterpartyId?: string;
  amountLabel?: string;
}>;

export type WalletFinancialHealthProjection = Readonly<{
  height: number;
  entities: readonly WalletPortfolioEntity[];
  activeEntityId: string;
  activeEntityLabel: string;
  debtGroups: readonly WalletDebtGroup[];
  disputes: readonly WalletDispute[];
  accountsPage: number;
  accountsPageCount: number;
  accountsTotal: number;
  solvencyStatus: WalletSolvencyStatus;
  solvencyEntityCount: number;
  solvencyAccountViews: number;
  solvencyAssets: readonly WalletSolvencyAsset[];
  history: readonly WalletHistoryEvent[];
  historyPage: number;
  historyNextBeforeHeight: number | null;
}>;

export type WalletFinancialHealthPayload = Readonly<{
  frame: unknown;
  solvency: unknown;
  activity: unknown | null;
  historyPage: number;
}>;

const entityFromPayload = (value: unknown): WalletPortfolioEntity => {
  const root = requireRuntimeRecord(value, 'WALLET_HEALTH_ENTITY');
  return {
    entityId: normalizeRequiredRuntimeEntityId(root['entityId'], 'WALLET_HEALTH_ENTITY_ID'),
    label: requireRuntimeString(root['label'], 'WALLET_HEALTH_ENTITY_LABEL'),
    height: requireRuntimeInteger(root['height'], 'WALLET_HEALTH_ENTITY_HEIGHT'),
    isHub: root['isHub'] === true,
  };
};

export const readWalletFrameActiveEntityId = (value: unknown): string => {
  const activeEntityId = requireRuntimeRecord(value, 'WALLET_HEALTH_FRAME')['activeEntityId'];
  return activeEntityId === null
    ? ''
    : normalizeRequiredRuntimeEntityId(activeEntityId, 'WALLET_HEALTH_ACTIVE_ID');
};

const decodeDebtGroups = (
  core: Record<string, unknown>,
  activeEntityId: string,
  labels: ReadonlyMap<string, string>,
  math: WalletPortfolioMath,
): readonly WalletDebtGroup[] => {
  const groups: WalletDebtGroup[] = [];
  for (const direction of ['out', 'in'] as const) {
    const ledger = optionalRuntimeMap(core[direction === 'out' ? 'outDebtsByToken' : 'inDebtsByToken'], `WALLET_HEALTH_DEBT_${direction.toUpperCase()}`);
    for (const [tokenKey, bucketValue] of ledger) {
      const tokenId = requireRuntimeInteger(tokenKey, 'WALLET_HEALTH_DEBT_TOKEN', 1);
      const bucket = requireRuntimeMap(bucketValue, 'WALLET_HEALTH_DEBT_BUCKET');
      let outstanding = 0n;
      const entries = [...bucket.values()].map((value): WalletDebtEntry => {
        const debt = requireRuntimeRecord(value, 'WALLET_HEALTH_DEBT');
        if (requireRuntimeEnum(debt['direction'], ['out', 'in'], 'WALLET_HEALTH_DEBT_DIRECTION') !== direction) {
          throw new Error('WALLET_HEALTH_DEBT_LEDGER_MISMATCH');
        }
        if (requireRuntimeInteger(debt['tokenId'], 'WALLET_HEALTH_DEBT_ENTRY_TOKEN', 1) !== tokenId) {
          throw new Error('WALLET_HEALTH_DEBT_TOKEN_MISMATCH');
        }
        const debtor = normalizeRequiredRuntimeEntityId(debt['debtor'], 'WALLET_HEALTH_DEBT_DEBTOR');
        const creditor = normalizeRequiredRuntimeEntityId(debt['creditor'], 'WALLET_HEALTH_DEBT_CREDITOR');
        if ((direction === 'out' ? debtor : creditor) !== activeEntityId || debt['status'] !== 'open') {
          throw new Error('WALLET_HEALTH_DEBT_PERSPECTIVE_MISMATCH');
        }
        const counterpartyId = direction === 'out' ? creditor : debtor;
        const created = requireRuntimeBigInt(debt['createdAmount'], 'WALLET_HEALTH_DEBT_CREATED');
        const paid = requireRuntimeBigInt(debt['paidAmount'], 'WALLET_HEALTH_DEBT_PAID');
        const remaining = requireRuntimeBigInt(debt['remainingAmount'], 'WALLET_HEALTH_DEBT_REMAINING');
        if (created - paid !== remaining || remaining < 0n) throw new Error('WALLET_HEALTH_DEBT_AMOUNT_MISMATCH');
        outstanding += remaining;
        return {
          debtId: requireRuntimeString(debt['debtId'], 'WALLET_HEALTH_DEBT_ID'),
          counterpartyId,
          counterpartyLabel: labels.get(counterpartyId) ?? counterpartyId,
          remainingLabel: math.formatTokenAmount(tokenId, remaining),
          originalLabel: math.formatTokenAmount(tokenId, created),
          paidLabel: math.formatTokenAmount(tokenId, paid),
          lastUpdatedBlock: requireRuntimeInteger(debt['lastUpdatedBlock'], 'WALLET_HEALTH_DEBT_BLOCK'),
        };
      }).sort((left, right) => left.lastUpdatedBlock - right.lastUpdatedBlock || left.debtId.localeCompare(right.debtId));
      groups.push({
        key: `${direction}:${tokenId}`,
        direction,
        tokenId,
        symbol: math.getTokenInfo(tokenId).symbol,
        outstandingLabel: math.formatTokenAmount(tokenId, outstanding),
        entries,
      });
    }
  }
  return groups.sort((left, right) => left.direction === right.direction
    ? left.tokenId - right.tokenId
    : left.direction === 'out' ? -1 : 1);
};

const decodeDisputes = (
  accounts: unknown[],
  activeEntityId: string,
  labels: ReadonlyMap<string, string>,
): readonly WalletDispute[] => accounts.flatMap((value): WalletDispute[] => {
  const account = requireRuntimeRecord(value, 'WALLET_HEALTH_ACCOUNT');
  const status = requireRuntimeEnum(account['status'], ['active', 'dispute_preparing', 'disputed'], 'WALLET_HEALTH_ACCOUNT_STATUS');
  if (status === 'active') return [];
  const state = requireRuntimeRecord(account['state'], 'WALLET_HEALTH_ACCOUNT_STATE');
  const left = normalizeRequiredRuntimeEntityId(state['leftEntity'], 'WALLET_HEALTH_ACCOUNT_LEFT');
  const right = normalizeRequiredRuntimeEntityId(state['rightEntity'], 'WALLET_HEALTH_ACCOUNT_RIGHT');
  if (activeEntityId !== left && activeEntityId !== right) throw new Error('WALLET_HEALTH_ACCOUNT_PERSPECTIVE_MISMATCH');
  const config = requireRuntimeRecord(state['disputeConfig'], 'WALLET_HEALTH_DISPUTE_CONFIG');
  const leftSeconds = requireRuntimeInteger(config['leftResponseSeconds'], 'WALLET_HEALTH_DISPUTE_LEFT_SECONDS');
  const rightSeconds = requireRuntimeInteger(config['rightResponseSeconds'], 'WALLET_HEALTH_DISPUTE_RIGHT_SECONDS');
  const localProof = Boolean(optionalRuntimeString(account['currentDisputeProofHanko'], 'WALLET_HEALTH_LOCAL_PROOF'));
  const peerProof = Boolean(optionalRuntimeString(account['counterpartyDisputeProofHanko'], 'WALLET_HEALTH_PEER_PROOF'));
  const counterpartyId = activeEntityId === left ? right : left;
  return [{
    counterpartyId,
    counterpartyLabel: labels.get(counterpartyId) ?? counterpartyId,
    phase: status === 'disputed' ? 'disputed' : 'preparing',
    accountHeight: requireRuntimeInteger(account['currentHeight'], 'WALLET_HEALTH_ACCOUNT_HEIGHT'),
    frameHeight: requireRuntimeInteger(requireRuntimeRecord(account['currentFrame'], 'WALLET_HEALTH_ACCOUNT_FRAME')['height'], 'WALLET_HEALTH_ACCOUNT_FRAME_HEIGHT'),
    responseWindowLabel: `${leftSeconds}s left · ${rightSeconds}s right`,
    proofStatus: localProof && peerProof ? 'both-hankos' : localProof ? 'local-hanko' : 'none',
  }];
});

const decodeHistory = (value: unknown, math: WalletPortfolioMath) => {
  if (value === null) return { events: [] as WalletHistoryEvent[], nextBeforeHeight: null };
  const root = requireRuntimeRecord(value, 'WALLET_HEALTH_ACTIVITY');
  if (root['ok'] !== true || !Array.isArray(root['events'])) throw new Error('WALLET_HEALTH_ACTIVITY_INVALID');
  const events = root['events'].map((value): WalletHistoryEvent => {
    const event = requireRuntimeRecord(value, 'WALLET_HEALTH_ACTIVITY_EVENT');
    const tokenId = event['tokenId'] === undefined ? undefined : requireRuntimeInteger(event['tokenId'], 'WALLET_HEALTH_ACTIVITY_TOKEN', 1);
    const amount = optionalRuntimeString(event['amount'], 'WALLET_HEALTH_ACTIVITY_AMOUNT');
    if (amount && !/^-?\d+$/.test(amount)) throw new Error('WALLET_HEALTH_ACTIVITY_AMOUNT_INVALID');
    const counterpartyId = optionalRuntimeEntityId(event['counterpartyId'], 'WALLET_HEALTH_ACTIVITY_COUNTERPARTY');
    return {
      id: requireRuntimeString(event['id'], 'WALLET_HEALTH_ACTIVITY_ID'),
      height: requireRuntimeInteger(event['height'], 'WALLET_HEALTH_ACTIVITY_HEIGHT', 1),
      timestamp: requireRuntimeInteger(event['timestamp'], 'WALLET_HEALTH_ACTIVITY_TIMESTAMP'),
      kind: requireRuntimeEnum(event['kind'], ['onchain', 'offchain'], 'WALLET_HEALTH_ACTIVITY_KIND'),
      direction: requireRuntimeEnum(event['direction'], ['in', 'out', 'neutral'], 'WALLET_HEALTH_ACTIVITY_DIRECTION'),
      type: requireRuntimeString(event['type'], 'WALLET_HEALTH_ACTIVITY_TYPE'),
      title: requireRuntimeString(event['title'], 'WALLET_HEALTH_ACTIVITY_TITLE'),
      subtitle: requireRuntimeString(event['subtitle'], 'WALLET_HEALTH_ACTIVITY_SUBTITLE'),
      status: requireRuntimeString(event['status'], 'WALLET_HEALTH_ACTIVITY_STATUS'),
      ...(counterpartyId ? { counterpartyId } : {}),
      ...(amount ? { amountLabel: tokenId === undefined ? amount : math.formatTokenAmount(tokenId, BigInt(amount)) } : {}),
    };
  });
  const next = root['nextBeforeHeight'];
  return {
    events,
    nextBeforeHeight: next === null ? null : requireRuntimeInteger(next, 'WALLET_HEALTH_ACTIVITY_CURSOR', 1),
  };
};

export const decodeWalletFinancialHealthProjection = (
  payload: WalletFinancialHealthPayload,
  math: WalletPortfolioMath,
): WalletFinancialHealthProjection => {
  const solvency = decodeWalletSolvency(payload.solvency, math);
  const frame = requireRuntimeRecord(payload.frame, 'WALLET_HEALTH_FRAME');
  const height = requireRuntimeInteger(frame['height'], 'WALLET_HEALTH_HEIGHT');
  if (height !== solvency.height) throw new Error('WALLET_HEALTH_HEIGHT_MISMATCH');
  if (!Array.isArray(frame['entities'])) throw new Error('WALLET_HEALTH_ENTITIES_INVALID');
  const entities = frame['entities'].map(entityFromPayload);
  const activeEntityId = readWalletFrameActiveEntityId(frame);
  const history = decodeHistory(payload.activity, math);
  if (!activeEntityId && frame['activeEntity'] === null) return {
    height, entities, activeEntityId: '', activeEntityLabel: '', debtGroups: [], disputes: [],
    accountsPage: 0, accountsPageCount: 0, accountsTotal: 0,
    solvencyStatus: solvency.status, solvencyEntityCount: solvency.entityCount,
    solvencyAccountViews: solvency.accountViews, solvencyAssets: solvency.assets,
    history: history.events, historyPage: payload.historyPage, historyNextBeforeHeight: history.nextBeforeHeight,
  };
  const labels = new Map(entities.map((entity) => [entity.entityId, entity.label]));
  const active = requireRuntimeRecord(frame['activeEntity'], 'WALLET_HEALTH_ACTIVE_ENTITY');
  const core = requireRuntimeRecord(active['core'], 'WALLET_HEALTH_ACTIVE_CORE');
  if (normalizeRequiredRuntimeEntityId(core['entityId'], 'WALLET_HEALTH_CORE_ID') !== activeEntityId) {
    throw new Error('WALLET_HEALTH_ACTIVE_ID_MISMATCH');
  }
  const accounts = requireRuntimeRecord(active['accounts'], 'WALLET_HEALTH_ACCOUNTS');
  if (!Array.isArray(accounts['items'])) throw new Error('WALLET_HEALTH_ACCOUNT_ITEMS_INVALID');
  return {
    height,
    entities,
    activeEntityId,
    activeEntityLabel: labels.get(activeEntityId) ?? activeEntityId,
    debtGroups: decodeDebtGroups(core, activeEntityId, labels, math),
    disputes: decodeDisputes(accounts['items'], activeEntityId, labels),
    accountsPage: optionalRuntimeInteger(accounts['pageIndex'], 0, 'WALLET_HEALTH_ACCOUNT_PAGE'),
    accountsPageCount: optionalRuntimeInteger(accounts['pageCount'], accounts['items'].length > 0 ? 1 : 0, 'WALLET_HEALTH_ACCOUNT_PAGE_COUNT'),
    accountsTotal: optionalRuntimeInteger(accounts['totalItems'], accounts['items'].length, 'WALLET_HEALTH_ACCOUNT_TOTAL'),
    solvencyStatus: solvency.status,
    solvencyEntityCount: solvency.entityCount,
    solvencyAccountViews: solvency.accountViews,
    solvencyAssets: solvency.assets,
    history: history.events,
    historyPage: payload.historyPage,
    historyNextBeforeHeight: history.nextBeforeHeight,
  };
};
