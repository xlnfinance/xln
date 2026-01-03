/**
 * Runtime ASCII Visualization System
 * Terminal-friendly state dumps for debugging and frontend display
 *
 * Usage:
 *   console.log(formatRuntime(env));
 *   console.log(formatEntity(entityState));
 *   console.log(formatAccount(accountMachine, myEntityId));
 */

import type { Env, EntityState, AccountMachine, Delta } from './types';

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
    const delta = Date.now() - ts;
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

function drawProgressBar(current: bigint, max: bigint, width: number = 10): string {
  if (max === 0n) return '░'.repeat(width);
  const filled = Math.min(width, Math.floor(Number(current * BigInt(width) / max)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * Format full runtime state (Env)
 */
export function formatRuntime(env: Env, options?: FormatOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const output: string[] = [];

  // Runtime header
  const runtimeInfo = [
    `Height: ${env.height || 0} | Timestamp: ${formatTimestamp(env.timestamp, false)}`,
    `Entities: ${env.eReplicas.size} | J-Replicas: ${env.jReplicas?.size || 0}`
  ];

  output.push(drawBox('RUNTIME STATE', runtimeInfo, 0, true));
  output.push('');

  // Entities
  let entityCount = 0;
  for (const [replicaKey, replica] of env.eReplicas) {
    if (opts.maxAccounts && entityCount >= opts.maxAccounts) {
      output.push(`  ... and ${env.eReplicas.size - entityCount} more entities`);
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

  const summary = [
    `Height: ${entity.height || 0} | J-Height: ${entity.lastFinalizedJHeight || 0}`,
    `Timestamp: ${formatTimestamp(entity.timestamp)}`,
    `Reserves: ${formatReserves(entity.reserves)} | Accounts: ${entity.accounts.size}`
  ];

  // HTLC stats
  const lockCount = entity.lockBook?.size || 0;
  const routeCount = entity.htlcRoutes?.size || 0;
  const feesEarned = entity.htlcFeesEarned || 0n;

  if (lockCount > 0 || feesEarned > 0n) {
    summary.push(`HTLC: ${lockCount} locks | Fees: ${formatBigInt(feesEarned)} | Routes: ${routeCount}`);
  }

  // Swap stats
  const swapCount = entity.swapBook?.size || 0;
  if (swapCount > 0) {
    summary.push(`Swaps: ${swapCount} offers`);
  }

  output.push(drawBox(title, summary, indent));

  // HTLC detail (if locks exist)
  if (!opts.showReservesOnly && lockCount > 0 && entity.lockBook) {
    output.push('');
    output.push(' '.repeat(indent) + '  HTLC Locks:');

    const locks = Array.from(entity.lockBook.values())
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      .slice(0, opts.maxLocks);

    for (const lock of locks) {
      const status = getLockStatus(lock, entity);
      const dir = lock.direction === 'outgoing' ? '→' : '←';
      output.push(' '.repeat(indent) + `    ${dir} ${formatBigInt(lock.amount)} | ${lock.hashlock.slice(0, 12)}... | ${status}`);
    }

    if (entity.lockBook.size > (opts.maxLocks || 10)) {
      output.push(' '.repeat(indent) + `    ... and ${entity.lockBook.size - (opts.maxLocks || 10)} more`);
    }
  }

  // Accounts (if not reserves-only)
  if (!opts.showReservesOnly) {
    output.push('');
    let accountCount = 0;

    for (const [counterpartyId, account] of entity.accounts) {
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
export function formatAccount(account: AccountMachine, myEntityId: string, options?: FormatOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const indent = opts.indentSize || 0;
  const output: string[] = [];

  // Account header
  const isLeft = myEntityId === account.leftEntity;
  const counterparty = isLeft ? account.rightEntity : account.leftEntity;
  const title = `Account: ${formatAddress(myEntityId)} ↔ ${formatAddress(counterparty)}`;

  const summary = [
    `Frame: ${account.currentHeight} | Mempool: ${account.mempool.length} | Pending: ${account.pendingFrame ? `h${account.pendingFrame.height}` : 'none'}`,
    `Perspective: ${isLeft ? 'LEFT' : 'RIGHT'} (canonical)`
  ];

  output.push(drawBox(title, summary, indent));

  // Deltas per token
  if (account.deltas.size > 0) {
    output.push('');
    for (const [tokenId, delta] of account.deltas) {
      if (opts.tokenFilter && !opts.tokenFilter.includes(tokenId)) continue;

      const symbol = tokenId === 1 ? 'USDC' : 'ETH';
      output.push(' '.repeat(indent) + `  Token ${tokenId} (${symbol}):`);
      output.push(' '.repeat(indent) + `    offdelta: ${formatBigInt(delta.offdelta, 18, symbol)} | ondelta: ${formatBigInt(delta.ondelta, 18, symbol)}`);
      output.push(' '.repeat(indent) + `    collateral: ${formatBigInt(delta.collateral, 18, symbol)}`);

      const htlcHold = (isLeft ? delta.leftHtlcHold : delta.rightHtlcHold) || 0n;
      const swapHold = (isLeft ? delta.leftSwapHold : delta.rightSwapHold) || 0n;

      if (htlcHold > 0n || swapHold > 0n) {
        output.push(' '.repeat(indent) + `    Holds: HTLC=${formatBigInt(htlcHold, 18, symbol)} | Swap=${formatBigInt(swapHold, 18, symbol)}`);
      }
    }
  }

  // Active locks
  if (account.locks && account.locks.size > 0) {
    output.push('');
    output.push(' '.repeat(indent) + `  Locks (${account.locks.size}):`);

    const locks = Array.from(account.locks.values()).slice(0, opts.maxLocks);
    for (const lock of locks) {
      const timeLeft = formatDuration(Number(lock.timelock) - Date.now());
      output.push(' '.repeat(indent) + `    [${lock.lockId.slice(0, 12)}...] ${formatBigInt(lock.amount)} | ${lock.senderIsLeft ? 'L→R' : 'R→L'} | ${timeLeft}`);
    }
  }

  // Active swaps
  if (account.swapOffers && account.swapOffers.size > 0) {
    output.push('');
    output.push(' '.repeat(indent) + `  Swap Offers (${account.swapOffers.size}):`);

    const swaps = Array.from(account.swapOffers.values()).slice(0, opts.maxSwaps);
    for (const swap of swaps) {
      const giveSymbol = swap.giveTokenId === 1 ? 'USDC' : 'ETH';
      const wantSymbol = swap.wantTokenId === 1 ? 'USDC' : 'ETH';
      output.push(' '.repeat(indent) + `    ${formatBigInt(swap.giveAmount)} ${giveSymbol} → ${formatBigInt(swap.wantAmount)} ${wantSymbol}`);
    }
  }

  return output.join('\n');
}

/**
 * Format orderbook state (for hubs)
 */
export function formatOrderbook(bookState: any, pairId: string, depth: number = 10): string {
  const output: string[] = [];
  const width = 60;

  // Parse pair ID (e.g., "1/2" -> token1=ETH, token2=USDC)
  const [baseId, quoteId] = pairId.split('/').map(Number);
  const baseSymbol = baseId === 1 ? 'ETH' : baseId === 2 ? 'USDC' : `T${baseId}`;
  const quoteSymbol = quoteId === 1 ? 'ETH' : quoteId === 2 ? 'USDC' : `T${quoteId}`;

  const title = `ORDERBOOK: ${baseSymbol}/${quoteSymbol} (Pair ${pairId})`;

  // Extract bids and asks from bookState
  const bids: Array<{ price: bigint; amount: bigint }> = [];
  const asks: Array<{ price: bigint; amount: bigint }> = [];

  if (bookState?.bids && typeof bookState.bids[Symbol.iterator] === 'function') {
    for (const [price, amount] of bookState.bids) {
      bids.push({ price: BigInt(price), amount: BigInt(amount) });
    }
  }

  if (bookState?.asks && typeof bookState.asks[Symbol.iterator] === 'function') {
    for (const [price, amount] of bookState.asks) {
      asks.push({ price: BigInt(price), amount: BigInt(amount) });
    }
  }

  // Sort: bids descending (highest first), asks ascending (lowest first)
  bids.sort((a, b) => Number(b.price - a.price));
  asks.sort((a, b) => Number(a.price - b.price));

  // Find max volume for bar scaling
  const allVolumes = [...bids, ...asks].map(o => o.amount);
  const maxVolume = allVolumes.length > 0 ? allVolumes.reduce((a, b) => a > b ? a : b) : 1n;

  // Build content
  const content: string[] = [];

  // ASKS (sellers) - show in reverse order (highest at top)
  content.push('ASKS (Sellers):');
  const asksToShow = asks.slice(0, depth).reverse();
  for (let i = 0; i < asksToShow.length; i++) {
    const ask = asksToShow[i];
    const priceStr = formatBigInt(ask.price, 18);
    const amountStr = formatBigInt(ask.amount, 18, baseSymbol);
    const bar = drawProgressBar(ask.amount, maxVolume, 8);
    const marker = i === asksToShow.length - 1 ? ' <- Best Ask' : '';
    content.push(`  ${priceStr.padStart(8)} | ${bar} ${amountStr}${marker}`);
  }

  // Spread
  if (bids.length > 0 && asks.length > 0) {
    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const spread = bestAsk - bestBid;
    const spreadPct = bestBid > 0n ? Number(spread * 10000n / bestBid) / 100 : 0;
    content.push(`${'─'.repeat(width - 2)}`);
    content.push(`Spread: ${formatBigInt(spread, 18)} (${spreadPct.toFixed(2)}%)`);
    content.push(`${'─'.repeat(width - 2)}`);
  }

  // BIDS (buyers)
  const bidsToShow = bids.slice(0, depth);
  for (let i = 0; i < bidsToShow.length; i++) {
    const bid = bidsToShow[i];
    const priceStr = formatBigInt(bid.price, 18);
    const amountStr = formatBigInt(bid.amount, 18, baseSymbol);
    const bar = drawProgressBar(bid.amount, maxVolume, 8);
    const marker = i === 0 ? ' <- Best Bid' : '';
    content.push(`  ${priceStr.padStart(8)} | ${bar} ${amountStr}${marker}`);
  }
  content.push('BIDS (Buyers):');

  // Summary
  const totalBidVol = bids.slice(0, depth).reduce((sum, b) => sum + b.amount, 0n);
  const totalAskVol = asks.slice(0, depth).reduce((sum, a) => sum + a.amount, 0n);
  content.push(`${'─'.repeat(width - 2)}`);
  content.push(`Depth: ${depth} levels | Bids: ${formatBigInt(totalBidVol, 18)} | Asks: ${formatBigInt(totalAskVol, 18)}`);

  output.push(drawBox(title, content, 0));

  return output.join('\n');
}

/**
 * Format a summary line for quick status
 */
export function formatSummary(env: Env): string {
  const entityCount = env.eReplicas.size;
  const jCount = env.jReplicas?.size || 0;

  let totalReserves = 0n;
  let totalCollateral = 0n;
  let totalLocks = 0;

  for (const [, replica] of env.eReplicas) {
    for (const [, amount] of replica.state.reserves) {
      totalReserves += amount;
    }
    for (const [, account] of replica.state.accounts) {
      for (const [, delta] of account.deltas) {
        totalCollateral += delta.collateral;
      }
      totalLocks += account.locks?.size || 0;
    }
  }

  return `H=${env.height || 0} | E=${entityCount} J=${jCount} | R=${formatBigInt(totalReserves)} C=${formatBigInt(totalCollateral)} L=${totalLocks}`;
}

// Helper: Get lock status
function getLockStatus(lock: any, entity: EntityState): string {
  const now = Date.now();
  const jHeight = entity.lastFinalizedJHeight || 0;

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
function formatReserves(reserves: Map<string, bigint>): string {
  if (!reserves || reserves.size === 0) return '$0';

  const parts: string[] = [];
  for (const [tokenId, amount] of reserves) {
    const symbol = Number(tokenId) === 1 ? 'USDC' : 'ETH';
    parts.push(formatBigInt(amount, 18, symbol));
  }

  return parts.join(', ');
}
