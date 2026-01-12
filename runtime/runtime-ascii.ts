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
import { getWallClockMs } from './time';

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

  // Events Stack (hierarchical RJEA log)
  if (env.frameLogs && env.frameLogs.length > 0) {
    output.push('  EVENTS (Hierarchical Stack):');
    output.push('  ' + '─'.repeat(60));

    const recentEvents = env.frameLogs.slice(-50); // Last 50 events

    for (const event of recentEvents) {
      // Build context tag: entity:account:frame
      let indent = 2;
      let tag = 'R'; // Runtime

      if (event.category === 'jurisdiction') {
        indent = 4;
        const jName = event.data?.jurisdictionName || env.activeJurisdiction || 'J';
        const block = event.data?.blockNumber || '?';
        tag = `  J:${jName}:${block}`;
      } else if (event.entityId) {
        // Entity-level
        const entityShort = formatAddress(event.entityId);
        const entityHeight = event.data?.height || '?';

        // Check if account-level event
        if (event.message.includes('bilateral') || event.message.includes('Account') || event.data?.accountId) {
          indent = 8;
          const accountId = event.data?.accountId || event.data?.toEntity || event.data?.fromEntity;
          const accountShort = accountId ? formatAddress(accountId) : '?';
          const frameHeight = event.data?.frameHeight || event.data?.height || '?';
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
  if (env.jReplicas && env.jReplicas.size > 0) {
    output.push('  J-REPLICAS (Jurisdictions):');
    for (const [jName, jReplica] of env.jReplicas) {
      const jInfo = [
        `Name: ${jName}`,
        `Block: ${jReplica.blockNumber} | State Root: ${(jReplica.stateRoot as any).slice?.(0, 16) || 'N/A'}`,
        `Mempool: ${jReplica.mempool?.length || 0} txs | Delay: ${jReplica.blockDelayMs}ms`,
        `Contracts: Depository=${jReplica.contracts?.depository?.slice(-8) || 'N/A'}`
      ];
      output.push(drawBox(`J-Replica: ${jName}`, jInfo, 2));
    }
    output.push('');
  }

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
  const swapCount = entity.swapBook?.size || 0;
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
  if (!opts.showReservesOnly && swapCount > 0 && entity.swapBook) {
    output.push('');
    output.push(' '.repeat(indent) + `  Swap Offers (${swapCount}):`);

    const swaps = Array.from(entity.swapBook.values())
      .slice(0, opts.maxSwaps);

    for (const swap of swaps) {
      const giveSymbol = swap.giveTokenId === 1 ? 'USDC' : 'ETH';
      const wantSymbol = swap.wantTokenId === 1 ? 'USDC' : 'ETH';
      output.push(' '.repeat(indent) + `    ${formatBigInt(swap.giveAmount)} ${giveSymbol} → ${formatBigInt(swap.wantAmount)} ${wantSymbol} | min=${swap.minFillRatio}/65535`);
    }

    if (entity.swapBook.size > (opts.maxSwaps || 10)) {
      output.push(' '.repeat(indent) + `    ... and ${entity.swapBook.size - (opts.maxSwaps || 10)} more`);
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

  // Sort by importance: state first, then technical
  const summary = [
    `Perspective: ${isLeft ? 'LEFT' : 'RIGHT'} (canonical)`,
    `Frame: ${account.currentHeight} | Mempool: ${account.mempool.length} | Pending: ${account.pendingFrame ? `h${account.pendingFrame.height}` : 'none'}`
  ];

  output.push(drawBox(title, summary, indent));

  // Deltas per token
  if (account.deltas.size > 0) {
    output.push('');
    for (const [tokenId, delta] of account.deltas) {
      if (opts.tokenFilter && !opts.tokenFilter.includes(tokenId)) continue;

      const symbol = tokenId === 1 ? 'USDC' : 'ETH';
      const htlcHold = (isLeft ? delta.leftHtlcHold : delta.rightHtlcHold) || 0n;
      const swapHold = (isLeft ? delta.leftSwapHold : delta.rightSwapHold) || 0n;

      output.push(' '.repeat(indent) + `  Token ${tokenId} (${symbol}):`);

      // Most important: amounts (offdelta, collateral, holds)
      output.push(' '.repeat(indent) + `    offdelta: ${formatBigInt(delta.offdelta, 18, symbol)} | collateral: ${formatBigInt(delta.collateral, 18, symbol)}`);

      if (htlcHold > 0n || swapHold > 0n) {
        output.push(' '.repeat(indent) + `    Holds: HTLC=${formatBigInt(htlcHold, 18, symbol)} | Swap=${formatBigInt(swapHold, 18, symbol)}`);
      }

      // Secondary: ondelta (less important for most debugging)
      if (delta.ondelta !== 0n) {
        output.push(' '.repeat(indent) + `    ondelta: ${formatBigInt(delta.ondelta, 18, symbol)}`);
      }
    }
  }

  // Active locks (show ALL details: lockId, hashlock, sender, expiry)
  if (account.locks && account.locks.size > 0) {
    output.push('');
    output.push(' '.repeat(indent) + `  Locks (${account.locks.size}):`);

    const locks = Array.from(account.locks.values()).slice(0, opts.maxLocks);
    for (const lock of locks) {
      const timeLeft = formatDuration(Number(lock.timelock) - getWallClockMs());
      const direction = lock.senderIsLeft ? 'L→R' : 'R→L';
      output.push(' '.repeat(indent) + `    Lock: ${lock.lockId.slice(0, 12)}... | ${formatBigInt(lock.amount)}`);
      output.push(' '.repeat(indent) + `      Hash: ${lock.hashlock.slice(0, 16)}... | ${direction} | Expires: ${timeLeft}`);
      if (lock.envelope) {
        const envInfo = lock.envelope.finalRecipient ? 'Final recipient' :
                       lock.envelope.nextHop ? `→ ${formatAddress(lock.envelope.nextHop)}` : 'Unknown';
        output.push(' '.repeat(indent) + `      Envelope: ${envInfo}`);
      }
    }

    if (account.locks.size > (opts.maxLocks || 10)) {
      output.push(' '.repeat(indent) + `    ... and ${account.locks.size - (opts.maxLocks || 10)} more locks`);
    }
  }

  // Active swaps (show ALL details: offerId, amounts, fill ratio)
  if (account.swapOffers && account.swapOffers.size > 0) {
    output.push('');
    output.push(' '.repeat(indent) + `  Swap Offers (${account.swapOffers.size}):`);

    const swaps = Array.from(account.swapOffers.values()).slice(0, opts.maxSwaps);
    for (const swap of swaps) {
      const giveSymbol = swap.giveTokenId === 1 ? 'USDC' : 'ETH';
      const wantSymbol = swap.wantTokenId === 1 ? 'USDC' : 'ETH';
      const side = swap.makerIsLeft ? '(maker=LEFT)' : '(maker=RIGHT)';
      output.push(' '.repeat(indent) + `    Offer: ${swap.offerId.slice(0, 12)}...`);
      output.push(' '.repeat(indent) + `      Give: ${formatBigInt(swap.giveAmount)} ${giveSymbol} | Want: ${formatBigInt(swap.wantAmount)} ${wantSymbol}`);
      output.push(' '.repeat(indent) + `      MinFill: ${swap.minFillRatio}/65535 | ${side}`);
    }

    if (account.swapOffers.size > (opts.maxSwaps || 10)) {
      output.push(' '.repeat(indent) + `    ... and ${account.swapOffers.size - (opts.maxSwaps || 10)} more swaps`);
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
  const now = getWallClockMs();
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
