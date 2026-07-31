import type { AccountFrame, AccountState, AccountTx } from '@xln/runtime/api/public/runtime-module';
import type { FrontendXlnFunctions } from '$lib/stores/xlnStore';
import type { EntityReplica } from '$lib/types/ui';
import { entityAvatar as resolveEntityAvatar } from '$lib/utils/avatar';
import { formatEntityId } from '$lib/utils/format';
import { getEntityDisplayName, resolveEntityName } from '$lib/utils/entityNaming';
import { requireTokenDecimals } from './token-metadata';

type GossipSource = Parameters<typeof resolveEntityName>[1];

type TokenInfo = {
  symbol?: string;
  decimals?: number;
};

export type EntityActivityChip = {
  label: string;
  tone?: 'neutral' | 'good' | 'warn' | 'danger';
};

export type EntityActivityRow = {
  id: string;
  height: number;
  timestamp: number;
  source: 'frame';
  accountId: string;
  accountLabel: string;
  kind: 'pending' | 'mempool' | 'confirmed';
  actor: 'you' | 'peer' | 'system';
  actorSide: 'L' | 'R' | '';
  actorLabel: string;
  actorEntityId: string;
  actorName: string;
  actorAvatar: string;
  actorInitials: string;
  headline: string;
  bodyLines: string[];
  chips: EntityActivityChip[];
  footerLeft: string;
  footerRight: string;
};

export type EntityActivityAccountOption = {
  accountId: string;
  accountLabel: string;
};

type BuildEntityActivityRowsOptions = {
  replica: EntityReplica | null;
  tabEntityId: string;
  activeEnv: GossipSource;
  activeXlnFunctions: FrontendXlnFunctions | null;
  getTokenInfo: (tokenId: number) => TokenInfo;
  formatAmount: (amount: bigint, decimals: number) => string;
};

function compareText(left: string, right: string): number {
  return String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base' });
}

export function formatEntityActivityTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
}

function entityTxTypeLabel(type: string): string {
  const known: Record<string, string> = {
    htlcPayment: 'HTLC Payment',
    directPayment: 'Direct Payment',
    openAccount: 'Open Account',
    extendCredit: 'Extend Credit',
    requestCollateral: 'Request Collateral',
    r2c: 'Deposit Collateral',
    settle_approve: 'Settle Approve',
    settle_finalize: 'Settle Finalize',
    disputeStart: 'Dispute Start',
    disputeFinalize: 'Dispute Finalize',
    reopenDisputedAccount: 'Reopen Disputed',
    placeSwapOffer: 'Swap Offer',
    requestSwapCancel: 'Swap Cancel Request',
    j_broadcast: 'J Broadcast',
    j_rebroadcast: 'J Rebroadcast',
    j_clear_batch: 'J Clear Batch',
    j_abort_sent_batch: 'J Abort Sent Batch',
    'profile-update': 'Profile Update',
    setHubConfig: 'Hub Config',
  };
  if (known[type]) return known[type];
  return String(type || 'unknown')
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function activityAccountLabel(counterpartyId: string, activeEnv: GossipSource): string {
  const raw = String(counterpartyId || '');
  if (!raw) return 'Unknown account';
  return resolveEntityName(raw, activeEnv) || formatEntityId(raw);
}

function initialsFor(name: string, fallback: string): string {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || fallback;
}

function activityEntityName(
  entityIdRaw: unknown,
  fallback: string,
  options: BuildEntityActivityRowsOptions,
): string {
  const entityId = String(entityIdRaw || '').trim();
  if (!entityId) return fallback;
  return getEntityDisplayName(entityId, {
    source: options.activeEnv,
    selfEntityId: options.replica?.state?.entityId || options.tabEntityId,
    fallback,
  });
}

function frameActorMeta(
  account: AccountState,
  byLeft: boolean | undefined,
  options: BuildEntityActivityRowsOptions,
): Pick<EntityActivityRow, 'actor' | 'actorSide' | 'actorLabel' | 'actorEntityId' | 'actorName' | 'actorAvatar' | 'actorInitials'> {
  const localEntityId = String(options.replica?.state?.entityId || options.tabEntityId || '').trim();
  const localEntity = localEntityId.toLowerCase();
  const leftEntityId = String(account?.leftEntity || '').trim();
  const rightEntityId = String(account?.rightEntity || '').trim();
  const leftEntity = leftEntityId.toLowerCase();
  const localIsLeft = Boolean(localEntity && leftEntity && localEntity === leftEntity);
  const actorEntityId = typeof byLeft === 'boolean' ? (byLeft ? leftEntityId : rightEntityId) : '';
  const actorName = actorEntityId
    ? getEntityDisplayName(actorEntityId, {
        source: options.activeEnv,
        selfEntityId: localEntityId,
        fallback: actorEntityId,
      })
    : 'System';
  const actorAvatar = actorEntityId ? resolveEntityAvatar(options.activeXlnFunctions, actorEntityId) : '';
  const actorInitials = initialsFor(actorName, 'SY');
  if (typeof byLeft !== 'boolean') {
    return {
      actor: 'system',
      actorSide: '',
      actorLabel: 'System',
      actorEntityId: '',
      actorName,
      actorAvatar,
      actorInitials,
    };
  }
  const actorSide = byLeft ? 'L' : 'R';
  const actor = byLeft === localIsLeft ? 'you' : 'peer';
  return {
    actor,
    actorSide,
    actorLabel: `${actor === 'you' ? 'You' : 'Counterparty'} · ${actorSide}`,
    actorEntityId,
    actorName,
    actorAvatar,
    actorInitials,
  };
}

function activityTokenAmount(
  tokenIdRaw: unknown,
  amountRaw: unknown,
  options: BuildEntityActivityRowsOptions,
): string {
  const tokenId = Number(tokenIdRaw || 0);
  const amount = (() => {
    if (typeof amountRaw === 'bigint') return amountRaw;
    try {
      return BigInt(String(amountRaw ?? 0));
    } catch {
      return 0n;
    }
  })();
  if (tokenId > 0 && options.activeXlnFunctions?.formatTokenAmount) {
    return options.activeXlnFunctions.formatTokenAmount(tokenId, amount);
  }
  if (tokenId <= 0) return options.formatAmount(amount, 0);
  const token = options.getTokenInfo(tokenId);
  return `${options.formatAmount(
    amount,
    requireTokenDecimals(token.decimals, `token:${tokenId}`),
  )} ${token.symbol || `#${tokenId}`}`;
}

function describeClaimedEvents(eventsRaw: unknown): string {
  if (!Array.isArray(eventsRaw) || eventsRaw.length === 0) return 'no events';
  const grouped = new Map<string, number>();
  for (const event of eventsRaw) {
    const type = String((event as { type?: unknown })?.type || 'event');
    grouped.set(type, (grouped.get(type) || 0) + 1);
  }
  return Array.from(grouped.entries())
    .map(([type, count]) => `${entityTxTypeLabel(type)}${count > 1 ? ` ×${count}` : ''}`)
    .join(' · ');
}

function summarizeAccountTx(
  tx: AccountTx,
  accountId: string,
  accountLabel: string,
  actor: 'you' | 'peer' | 'system',
  options: BuildEntityActivityRowsOptions,
): string {
  const data = tx?.data && typeof tx.data === 'object' ? tx.data as Record<string, unknown> : {};
  switch (tx.type) {
    case 'direct_payment': {
      const amount = activityTokenAmount(data['tokenId'], data['amount'], options);
      const description = String(data['description'] || '').trim();
      const route = Array.isArray(data['route'])
        ? data['route'].map((hop) => activityEntityName(hop, formatEntityId(String(hop || '')), options)).join(' → ')
        : '';
      let line = `${actor === 'peer' ? 'Received payment' : 'Sent payment'} ${amount}`;
      line += actor === 'peer' ? ` from ${accountLabel}` : ` to ${accountLabel}`;
      if (route) line += ` via ${route}`;
      if (description) line += ` · ${description}`;
      return line;
    }
    case 'swap_offer':
      return `Created order · sell ${activityTokenAmount(data['giveTokenId'], data['giveAmount'], options)} for ${activityTokenAmount(data['wantTokenId'], data['wantAmount'], options)}`;
    case 'swap_cancel_request':
      return `Cancelled order · ${String(data['offerId'] || 'unknown')}`;
    case 'swap_resolve': {
      const offerId = String(data['offerId'] || 'unknown');
      const cancelRemainder = Boolean(data['cancelRemainder']);
      const executionGive = data['executionGiveAmount'];
      const executionWant = data['executionWantAmount'];
      const giveToken = data['restingGiveTokenId'] ?? data['giveTokenId'];
      const wantToken = data['restingWantTokenId'] ?? data['wantTokenId'];
      const filled = executionGive !== undefined && executionWant !== undefined
        ? `${activityTokenAmount(giveToken, executionGive, options)} ↔ ${activityTokenAmount(wantToken, executionWant, options)}`
        : offerId;
      if (cancelRemainder && executionGive !== undefined && executionWant !== undefined) return `Resolved order · ${filled} and closed remainder`;
      if (cancelRemainder) return `Closed order · ${offerId}`;
      return `Resolved order · ${filled}`;
    }
    case 'request_collateral': {
      const amount = activityTokenAmount(data['tokenId'], data['amount'], options);
      const fee = typeof data['feeAmount'] !== 'undefined'
        ? activityTokenAmount(data['feeTokenId'] ?? data['tokenId'], data['feeAmount'], options)
        : '';
      return fee ? `Requested collateral · ${amount} (+ fee ${fee})` : `Requested collateral · ${amount}`;
    }
    case 'set_credit_limit':
      return `Set credit limit · ${activityTokenAmount(data['tokenId'], data['amount'], options)}`;
    case 'add_delta':
      return `Opened token lane · ${activityEntityName(accountId, accountLabel, options)} / ${options.getTokenInfo(Number(data['tokenId'] || 0)).symbol}`;
    case 'reserve_to_collateral':
      return `Claimed reserve → collateral move · ${options.getTokenInfo(Number(data['tokenId'] || 0)).symbol}`;
    case 'htlc_lock':
      return `Opened HTLC · ${activityTokenAmount(data['tokenId'], data['amount'], options)}`;
    case 'htlc_resolve':
      return `Resolved HTLC · ${String(data['outcome'] || 'unknown')}`;
    case 'settle_transition':
      return `Settlement workspace · ${String(data['kind'] || 'updated')} v${Number(data['version'] || 0)}`;
    case 'reopen_disputed':
      return 'Reopened disputed account';
    case 'j_event_claim':
      return `Claimed J#${Number(data['jHeight'] || 0)} · ${describeClaimedEvents(data['events'])}`;
    default:
      return entityTxTypeLabel(String(tx.type || 'unknown'));
  }
}

export function buildEntityActivityRows(options: BuildEntityActivityRowsOptions): EntityActivityRow[] {
  const rows: EntityActivityRow[] = [];
  const accounts = options.replica?.state?.accounts;
  if (accounts instanceof Map && accounts.size > 0) {
    for (const [counterpartyId, account] of accounts.entries()) {
      const accountId = String(counterpartyId || '');
      const accountLabel = activityAccountLabel(accountId, options.activeEnv);
      const pushFrameRow = (
        kind: 'pending' | 'mempool' | 'confirmed',
        frameLabel: string,
        statusLabel: string,
        height: number,
        timestamp: number,
        txs: AccountTx[],
        byLeft?: boolean,
      ) => {
        if (!Array.isArray(txs) || txs.length === 0) return;
        const actorMeta = frameActorMeta(account, byLeft, options);
        const allLines = txs.map((tx) => summarizeAccountTx(tx, accountId, accountLabel, actorMeta.actor, options));
        const headline = allLines.length === 1 ? allLines[0] ?? 'Account frame action' : `${txs.length} actions in account frame`;
        const bodyLines = allLines.length <= 1
          ? []
          : (allLines.length > 4 ? [...allLines.slice(0, 4), `+${allLines.length - 4} more actions`] : allLines);
        rows.push({
          id: `entity-activity-frame-${accountId}-${kind}-${height}-${timestamp}`,
          height,
          timestamp,
          source: 'frame',
          accountId,
          accountLabel,
          kind,
          actor: actorMeta.actor,
          actorSide: actorMeta.actorSide,
          actorLabel: actorMeta.actorLabel,
          actorEntityId: actorMeta.actorEntityId,
          actorName: actorMeta.actorName,
          actorAvatar: actorMeta.actorAvatar,
          actorInitials: actorMeta.actorInitials || '',
          headline,
          bodyLines,
          chips: [
            { label: frameLabel },
            {
              label: `${actorMeta.actor === 'peer' ? accountLabel : activityEntityName(options.tabEntityId, 'You', options)} → ${actorMeta.actor === 'peer' ? activityEntityName(options.tabEntityId, 'You', options) : accountLabel}`,
            },
            { label: statusLabel, tone: kind === 'confirmed' ? 'good' : (kind === 'mempool' ? 'warn' : 'neutral') },
            { label: `${txs.length} tx` },
          ],
          footerLeft: formatEntityId(accountId),
          footerRight: height > 0 ? `E#${height}` : statusLabel,
        });
      };

      if (account.pendingFrame) {
        pushFrameRow(
          'pending',
          'Pending frame',
          'Awaiting consensus',
          Number(account.pendingFrame.height || 0),
          Number(account.pendingFrame.timestamp || 0),
          Array.isArray(account.pendingFrame.accountTxs) ? account.pendingFrame.accountTxs : [],
          account.pendingFrame.byLeft,
        );
      }

      if (Array.isArray(account.mempool) && account.mempool.length > 0) {
        pushFrameRow(
          'mempool',
          'Queued broadcast',
          `${account.mempool.length} queued`,
          Number(account.pendingFrame?.height || account.currentHeight || 0),
          Number(account.pendingFrame?.timestamp || account.currentFrame?.timestamp || 0),
          account.mempool,
          account.leftEntity === (options.replica?.state?.entityId || options.tabEntityId),
        );
      }

      const frameHistory = (account as { frameHistory?: AccountFrame[] }).frameHistory;
      const frames = Array.isArray(frameHistory) ? frameHistory.slice(-12) : [];
      for (const frame of frames) {
        pushFrameRow(
          'confirmed',
          'Confirmed frame',
          'Confirmed',
          Number(frame.height || 0),
          Number(frame.timestamp || 0),
          Array.isArray(frame.accountTxs) ? frame.accountTxs : [],
          frame.byLeft,
        );
      }
    }
  }

  return rows.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    if (a.height !== b.height) return b.height - a.height;
    return compareText(a.accountLabel, b.accountLabel);
  });
}

export function buildEntityActivityAccounts(rows: EntityActivityRow[]): EntityActivityAccountOption[] {
  const labels = new Map<string, string>();
  for (const row of rows) {
    if (!row.accountId) continue;
    labels.set(row.accountId, row.accountLabel);
  }
  return Array.from(labels.entries())
    .map(([accountId, accountLabel]) => ({ accountId, accountLabel }))
    .sort((a, b) => compareText(a.accountLabel, b.accountLabel));
}

export function filterEntityActivityRows(rows: EntityActivityRow[], accountFilter: string): EntityActivityRow[] {
  return accountFilter === 'all' ? rows : rows.filter((row) => row.accountId === accountFilter);
}
