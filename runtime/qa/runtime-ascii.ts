/**
 * Runtime ASCII Visualization System
 * Terminal-friendly state dumps for debugging and frontend display
 *
 * Usage:
 *   console.log(formatRuntime(env));
 *   console.log(formatEntity(entityState));
 *   console.log(formatAccount(account, myEntityId));
 */

import type { RuntimeReplica } from '../runtime/types';
import { readRuntimeFrameEvents } from '../runtime/observability/env-events';
import type { EntityState } from '../entity/types';
import type { AccountReplica } from '../types/account';
import { getWallClockMs } from '../infra/time';
import { listOpenSwapOffers } from '../orderbook/open-swap-offers';

export interface FormatOptions {
  maxAccounts?: number;
  maxLocks?: number;
  maxSwaps?: number;
  showReservesOnly?: boolean;
  showMempool?: boolean;
  showHistory?: boolean;
  useColor?: boolean;
  compactMode?: boolean;
  indentSize?: number;
  tokenFilter?: number[];
  accountFilter?: string[];
}

const DEFAULT_OPTIONS: FormatOptions = {
  maxAccounts: 10,
  maxLocks: 10,
  maxSwaps: 10,
  showMempool: true,
  showHistory: false,
  useColor: false,
  compactMode: false,
  indentSize: 2
};

const formatStateRootPreview = (value: unknown): string => {
  if (typeof value === 'string') return value.slice(0, 16);
  if (value instanceof Uint8Array) {
    const hex = Array.from(value.slice(0, 8))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
    return hex ? `0x${hex}` : 'N/A';
  }
  return 'N/A';
};

// Box drawing characters
const BOX = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  verticalRight: '├',
  verticalLeft: '┤'
};

const DOUBLE_BOX = {
  topLeft: '╔',
  topRight: '╗',
  bottomLeft: '╚',
  bottomRight: '╝',
  horizontal: '═',
  vertical: '║',
  verticalRight: '╠',
  verticalLeft: '╣'
};

// Helper functions
function formatBigInt(amount: bigint, decimals: number = 18, symbol: string = ''): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const absWhole = whole < 0n ? -whole : whole;

  if (absWhole >= 1000n) {
    const thousands = Number(absWhole) / 1000;
    return `${whole < 0n ? '-' : ''}$${thousands.toFixed(0)}k${symbol ? ' ' + symbol : ''}`;
  }

  return `${whole < 0n ? '-' : ''}$${absWhole}${symbol ? ' ' + symbol : ''}`;
}

function formatAddress(addr: string): string {
  return addr.slice(-8);
}

function formatMaybeAddress(value: unknown): string {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'string') {
    return value.length >= 8 ? value.slice(-8) : value;
  }
  if (typeof value === 'bigint') {
    const hex = value.toString(16);
    return hex.length >= 8 ? hex.slice(-8) : hex;
  }
  if (value instanceof Uint8Array) {
    const hex = Array.from(value).map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex.length >= 8 ? hex.slice(-8) : hex;
  }
  try {
    const str = String(value);
    return str.length >= 8 ? str.slice(-8) : str;
  } catch {
    return 'N/A';
  }
}

function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const seconds = Math.floor(abs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatTimestamp(ts: number, relative: boolean = true): string {
  if (relative) {
    const delta = getWallClockMs() - ts;
    if (Math.abs(delta) < 1000) return 'now';
    return delta > 0 ? `${formatDuration(delta)} ago` : `in ${formatDuration(-delta)}`;
  }
  return new Date(ts).toISOString().slice(11, 19); // HH:MM:SS
}

function drawBox(title: string, content: string[], indent: number = 0, doubleBox: boolean = false): string {
  const width = 62;
  const pad = ' '.repeat(indent);
  const box = doubleBox ? DOUBLE_BOX : BOX;

  const lines = [
    `${pad}${box.topLeft}${box.horizontal.repeat(width)}${box.topRight}`,
    `${pad}${box.vertical} ${title.padEnd(width - 1)}${box.vertical}`
  ];

  if (content.length > 0) {
    lines.push(`${pad}${box.verticalRight}${box.horizontal.repeat(width)}${box.verticalLeft}`);
    for (const line of content) {
      lines.push(`${pad}${box.vertical} ${line.padEnd(width - 1)}${box.vertical}`);
    }
  }

  lines.push(`${pad}${box.bottomLeft}${box.horizontal.repeat(width)}${box.bottomRight}`);

  return lines.join('\n');
}

/**
 * Format full runtime state (RuntimeReplica)
 */
export function formatRuntime(env: RuntimeReplica, options?: FormatOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const output: string[] = [];

  // Runtime header
  const runtimeInfo = [
    `Height: ${env.state.height || 0} | Timestamp: ${formatTimestamp(env.state.timestamp, false)}`,
    `Entities: ${env.state.eReplicas.size} | J-Replicas: ${env.state.jReplicas?.size || 0}`
  ];

  output.push(drawBox('RUNTIME STATE', runtimeInfo, 0, true));
  output.push('');

  // Events Stack (hierarchical RJEA log)
  const frameEvents = readRuntimeFrameEvents(env);
  if (frameEvents.length > 0) {
    output.push('  EVENTS (Hierarchical Stack):');
    output.push('  ' + '─'.repeat(60));

    const recentEvents = frameEvents.slice(-50); // Last 50 events

    for (const event of recentEvents) {
      // Build context tag: entity:account:frame
      let indent = 2;
      let tag = 'R'; // Runtime

      if (event.category === 'jurisdiction') {
        indent = 4;
        const jName = event.data?.['jurisdictionName'] || env.activeJurisdiction || 'J';
        const block = event.data?.['blockNumber'] || '?';
        tag = `  J:${jName}:${block}`;
      } else if (event.entityId) {
        // Entity-level
        const entityShort = formatAddress(event.entityId);
        const entityHeight = event.data?.['height'] || '?';

        // Check if account-level event
        if (event.message.includes('bilateral') || event.message.includes('Account') || event.data?.['accountId']) {
          indent = 8;
          const accountIdValue = event.data?.['accountId'] || event.data?.['toEntity'] || event.data?.['fromEntity'];
          const accountShort = typeof accountIdValue === 'string' ? formatAddress(accountIdValue) : '?';
          const frameHeight = event.data?.['frameHeight'] || event.data?.['height'] || '?';
          tag = `      A:${entityShort}:${accountShort}:${frameHeight}`;
        } else {
          indent = 6;
          tag = `    E:${entityShort}:${entityHeight}`;
        }
      }

      const timestamp = formatTimestamp(event.timestamp, true);
      const level = event.level === 'error' ? '❌' : event.level === 'warn' ? '⚠️ ' : '  ';

      output.push(' '.repeat(indent) + `${level}[${timestamp}] ${tag} ${event.message}`);

      // Show critical data fields (compact, inline)
      if (event.data) {
        const criticalFields = ['amount', 'tokenId', 'height', 'txCount'];
        const shown = criticalFields
          .filter(f => event.data![f] !== undefined)
          .map(f => `${f}=${event.data![f]}`)
          .join(' ');

        if (shown) {
          output.push(' '.repeat(indent + 2) + `↳ ${shown}`);
        }
      }
    }

    output.push('  ' + '─'.repeat(60));
    output.push('');
  }

  // J-Replicas (Jurisdictions)
  if (env.state.jReplicas && env.state.jReplicas.size > 0) {
    output.push('  J-REPLICAS (Jurisdictions):');
    for (const [jName, jReplica] of env.state.jReplicas) {
      const jDepository = jReplica.contracts?.depository;
      const jInfo = [
        `Name: ${jName}`,
        `Block: ${jReplica.blockNumber} | State Root: ${formatStateRootPreview(jReplica.stateRoot)}`,
        `Mempool: ${jReplica.mempool?.length || 0} txs | Delay: ${jReplica.blockDelayMs}ms`,
        `Contracts: Depository=${formatMaybeAddress(jDepository)}`
      ];
      output.push(drawBox(`J-Replica: ${jName}`, jInfo, 2));
    }
    output.push('');
  }

  // Entities
  let entityCount = 0;
  for (const replica of env.state.eReplicas.values()) {
    if (opts.maxAccounts && entityCount >= opts.maxAccounts) {
      output.push(`  ... and ${env.state.eReplicas.size - entityCount} more entities`);
      break;
    }

    output.push(formatEntity(replica.state, { ...opts, indentSize: 2 }));
    output.push('');
    entityCount++;
  }

  return output.join('\n');
}

/**
 * Format entity state (E-Machine)
 */
export function formatEntity(entity: EntityState, options?: FormatOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const indent = opts.indentSize || 0;
  const output: string[] = [];

  // Entity header
  const entityId = entity.entityId || 'Unknown';
  const title = `Entity: ${formatAddress(entityId)}`;

  // Sort by importance: amounts first, then counts, then technical
  const summary = [
    `Reserves: ${formatReserves(entity.reserves)} | Accounts: ${entity.accounts.size}`,
  ];

  // HTLC stats (amounts first)
  const lockCount = entity.lockBook?.size || 0;
  const routeCount = entity.htlcRoutes?.size || 0;
  const feesEarned = entity.htlcFeesEarned || 0n;

  if (lockCount > 0 || feesEarned > 0n) {
    summary.push(`HTLC: Fees=${formatBigInt(feesEarned)} | Locks=${lockCount} | Routes=${routeCount}`);
  }

  // Swap stats
  const openSwapOffers = listOpenSwapOffers(entity);
  const swapCount = openSwapOffers.length;
  if (swapCount > 0) {
    summary.push(`Swaps: ${swapCount} offers`);
  }

  // Technical details last
  summary.push(`Height: ${entity.height || 0} | J-Height: ${entity.lastFinalizedJHeight || 0} | Time: ${formatTimestamp(entity.timestamp)}`);

  output.push(drawBox(title, summary, indent));

  // HTLC detail (comprehensive: locks + routes + fees)
  if (!opts.showReservesOnly && (lockCount > 0 || routeCount > 0 || feesEarned > 0n)) {
    output.push('');
    output.push(' '.repeat(indent) + '  HTLC Detail:');

    // Active locks from lockBook
    if (lockCount > 0 && entity.lockBook) {
      output.push(' '.repeat(indent) + `    Locks (${lockCount}):`);

      const locks = Array.from(entity.lockBook.values())
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
        .slice(0, opts.maxLocks);

      for (const lock of locks) {
        const status = getLockStatus(lock, entity);
        const dir = lock.direction === 'outgoing' ? '→' : '←';
        const timeLeft = formatDuration(Number(lock.timelock) - getWallClockMs());
        output.push(' '.repeat(indent) + `      ${dir} ${formatBigInt(lock.amount)} | hash=${lock.hashlock.slice(0, 12)}... | ${status} | ${timeLeft}`);
      }

      if (entity.lockBook.size > (opts.maxLocks || 10)) {
        output.push(' '.repeat(indent) + `      ... and ${entity.lockBook.size - (opts.maxLocks || 10)} more`);
      }
    }

    // Active routes (multi-hop tracking)
    if (routeCount > 0 && entity.htlcRoutes) {
      output.push(' '.repeat(indent) + `    Routes (${routeCount}):`);

      const routes = Array.from(entity.htlcRoutes.entries()).slice(0, 5);
      for (const [hashlock, route] of routes) {
        const inbound = route.inboundEntity ? formatAddress(route.inboundEntity) : 'origin';
        const outbound = route.outboundEntity ? formatAddress(route.outboundEntity) : 'final';
        const status = route.secret ? '✓revealed' : 'pending';
        output.push(' '.repeat(indent) + `      ${inbound} → ${outbound} | hash=${hashlock.slice(0, 12)}... | ${status}`);
      }
    }

    // Total fees earned
    if (feesEarned > 0n) {
      output.push(' '.repeat(indent) + `    Fees Earned: ${formatBigInt(feesEarned)} ✓`);
    }
  }

  // Swap detail (offers + orderbook if hub)
  if (!opts.showReservesOnly && swapCount > 0) {
    output.push('');
    output.push(' '.repeat(indent) + `  Swap Offers (${swapCount}):`);

    const swaps = openSwapOffers.slice(0, opts.maxSwaps);

    for (const swap of swaps) {
      const giveSymbol = swap.giveTokenId === 1 ? 'USDC' : 'ETH';
      const wantSymbol = swap.wantTokenId === 1 ? 'USDC' : 'ETH';
      output.push(' '.repeat(indent) + `    ${formatBigInt(swap.giveAmount)} ${giveSymbol} → ${formatBigInt(swap.wantAmount)} ${wantSymbol}`);
    }

    if (swapCount > (opts.maxSwaps || 10)) {
      output.push(' '.repeat(indent) + `    ... and ${swapCount - (opts.maxSwaps || 10)} more`);
    }
  }

  // Orderbook (hub only)
  if (!opts.showReservesOnly && entity.orderbookExt) {
    output.push('');
    output.push(' '.repeat(indent) + '  Orderbook Extension: Active (hub)');
    // Could expand to show book depth if needed
  }

  // Accounts (if not reserves-only)
  if (!opts.showReservesOnly) {
    output.push('');
    let accountCount = 0;

    for (const account of entity.accounts.values()) {
      if (opts.maxAccounts && accountCount >= opts.maxAccounts) {
        output.push(' '.repeat(indent) + `  ... and ${entity.accounts.size - accountCount} more accounts`);
        break;
      }

      output.push(formatAccount(account, entity.entityId, { ...opts, indentSize: indent + 4 }));
      accountCount++;
    }
  }

  return output.join('\n');
}

/**
 * Format account machine state (A-Machine)
 */
export function formatAccount(account: AccountReplica, myEntityId: string, options?: FormatOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const indent = opts.indentSize || 0;
  const output: string[] = [];

  // Account header
  const isLeft = myEntityId === account.state.leftEntity;
  const counterparty = isLeft ? account.state.rightEntity : account.state.leftEntity;
  const title = `Account: ${formatAddress(myEntityId)} ↔ ${formatAddress(counterparty)}`;

  // Sort by importance: state first, then technical
  const summary = [
    `Perspective: ${isLeft ? 'LEFT' : 'RIGHT'} (canonical)`,
    `Frame: ${account.currentHeight} | Mempool: ${account.mempool.length} | Pending: ${account.pendingFrame ? `h${account.pendingFrame.height}` : 'none'}`
  ];

  output.push(drawBox(title, summary, indent));

  // Deltas per token
  if (account.state.deltas.size > 0) {
    output.push('');
    for (const [tokenId, delta] of account.state.deltas) {
      if (opts.tokenFilter && !opts.tokenFilter.includes(tokenId)) continue;

      const symbol = tokenId === 1 ? 'USDC' : 'ETH';
      const totalHold = (isLeft ? delta.leftHold : delta.rightHold) || 0n;

      output.push(' '.repeat(indent) + `  Token ${tokenId} (${symbol}):`);

      // Most important: amounts (offdelta, collateral, holds)
      output.push(' '.repeat(indent) + `    offdelta: ${formatBigInt(delta.offdelta, 18, symbol)} | collateral: ${formatBigInt(delta.collateral, 18, symbol)}`);

      if (totalHold > 0n) {
        output.push(' '.repeat(indent) + `    Hold: ${formatBigInt(totalHold, 18, symbol)}`);
      }

      // Secondary: ondelta (less important for most debugging)
      if (delta.ondelta !== 0n) {
        output.push(' '.repeat(indent) + `    ondelta: ${formatBigInt(delta.ondelta, 18, symbol)}`);
      }
    }
  }

  // Active locks (show ALL details: lockId, hashlock, sender, expiry)
  if (account.state.locks && account.state.locks.size > 0) {
    output.push('');
    output.push(' '.repeat(indent) + `  Locks (${account.state.locks.size}):`);

    const locks = Array.from(account.state.locks.values()).slice(0, opts.maxLocks);
    for (const lock of locks) {
      const timeLeft = formatDuration(Number(lock.timelock) - getWallClockMs());
      const direction = lock.senderIsLeft ? 'L→R' : 'R→L';
      output.push(' '.repeat(indent) + `    Lock: ${lock.lockId.slice(0, 12)}... | ${formatBigInt(lock.amount)}`);
      output.push(' '.repeat(indent) + `      Hash: ${lock.hashlock.slice(0, 16)}... | ${direction} | Expires: ${timeLeft}`);
    }

    if (account.state.locks.size > (opts.maxLocks || 10)) {
      output.push(' '.repeat(indent) + `    ... and ${account.state.locks.size - (opts.maxLocks || 10)} more locks`);
    }
  }

  // Active swaps (show ALL details: offerId, amounts, fill ratio)
  if (account.state.swapOffers && account.state.swapOffers.size > 0) {
    output.push('');
    output.push(' '.repeat(indent) + `  Swap Offers (${account.state.swapOffers.size}):`);

    const swaps = Array.from(account.state.swapOffers.values()).slice(0, opts.maxSwaps);
    for (const swap of swaps) {
      const giveSymbol = swap.giveTokenId === 1 ? 'USDC' : 'ETH';
      const wantSymbol = swap.wantTokenId === 1 ? 'USDC' : 'ETH';
      const side = swap.makerIsLeft ? '(maker=LEFT)' : '(maker=RIGHT)';
      output.push(' '.repeat(indent) + `    Offer: ${swap.offerId.slice(0, 12)}...`);
      output.push(' '.repeat(indent) + `      Give: ${formatBigInt(swap.giveAmount)} ${giveSymbol} | Want: ${formatBigInt(swap.wantAmount)} ${wantSymbol}`);
      output.push(' '.repeat(indent) + `      ${side}`);
    }

    if (account.state.swapOffers.size > (opts.maxSwaps || 10)) {
      output.push(' '.repeat(indent) + `    ... and ${account.state.swapOffers.size - (opts.maxSwaps || 10)} more swaps`);
    }
  }

  return output.join('\n');
}

// Helper: Get lock status
function getLockStatus(lock: { timelock: bigint | number | string; hashlock: string }, entity: EntityState): string {
  const now = getWallClockMs();
  if (now > Number(lock.timelock)) {
    return '🔴 Expired';
  }

  const route = entity.htlcRoutes?.get(lock.hashlock);
  if (route?.secret) {
    return '🟢 Revealed';
  }

  return '🟡 Pending';
}

// Helper: Format reserves map
function formatReserves(reserves: Map<string | number, bigint>): string {
  if (!reserves || reserves.size === 0) return '$0';

  const parts: string[] = [];
  for (const [tokenId, amount] of reserves) {
    const symbol = Number(tokenId) === 1 ? 'USDC' : 'ETH';
    parts.push(formatBigInt(amount, 18, symbol));
  }

  return parts.join(', ');
}
