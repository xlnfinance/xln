/**
 * Pure Orderbook Core
 *
 * Limit order book using SoA (Struct of Arrays) for performance.
 * All functions are pure - state is passed in, new state returned.
 * Designed for integration into RJEA flow.
 *
 * TODO(snapshot-perf): TypedArray serialization degrades after JSON round-trip
 * Current: Int32Array/Uint32Array serialize to number[] via JSON.stringify
 * Impact: After snapshot restore, arrays become regular JS arrays (slower iteration)
 * Fix: Update snapshot-coder.ts to detect and restore TypedArray types:
 *   - Serialize: { _type: 'Int32Array', data: [...] }
 *   - Deserialize: new Int32Array(obj.data)
 * Priority: Medium (functional correctness preserved, only perf affected)
 */

// ============================================================================
// Types
// ============================================================================

export type Side = 0 | 1;        // 0 = BUY (bids), 1 = SELL (asks)
export type TIF = 0 | 1 | 2;     // 0 = GTC, 1 = IOC, 2 = FOK

// minFillRatio uses uint16 scale (0-65535) matching swap protocol
export const MAX_FILL_RATIO = 65535;

export type OrderCmd =
  | { kind: 0; ownerId: string; orderId: string; side: Side; tif: TIF; postOnly: boolean; priceTicks: number; qtyLots: number; minFillRatio?: number }
  | { kind: 1; ownerId: string; orderId: string }  // CANCEL
  | { kind: 2; ownerId: string; orderId: string; newPriceTicks: number | null; qtyDeltaLots: number };  // REPLACE

export type BookEvent =
  | { type: 'ACK'; orderId: string; ownerId: string }
  | { type: 'REJECT'; orderId: string; ownerId: string; reason: string }
  | { type: 'TRADE'; price: number; qty: number; makerOwnerId: string; takerOwnerId: string; makerOrderId: string; takerOrderId: string; makerQtyBefore: number; takerQtyTotal: number }
  | { type: 'REDUCED'; orderId: string; ownerId: string; delta: number; remain: number }
  | { type: 'CANCELED'; orderId: string; ownerId: string };

export interface BookParams {
  tick: number;
  pmin: number;
  pmax: number;
  maxOrders: number;
  stpPolicy: 0 | 1 | 2;  // 0=off, 1=cancel taker, 2=reduce maker
}

/** Orderbook state - immutable, create new on each mutation */
export interface BookState {
  readonly params: BookParams;
  readonly levels: number;

  // Order storage (SoA for cache efficiency)
  readonly orderPriceIdx: Int32Array;
  readonly orderQtyLots: Uint32Array;
  readonly orderOwnerIdx: Uint32Array;  // index into owners array
  readonly orderSide: Uint8Array;
  readonly orderPrev: Int32Array;
  readonly orderNext: Int32Array;
  readonly orderActive: Uint8Array;

  // Owner/OrderId mapping (strings stored separately)
  readonly owners: string[];           // ownerId strings
  readonly orderIds: string[];         // orderId strings
  readonly orderIdToIdx: Map<string, number>;

  // Level queues
  readonly levelHeadBid: Int32Array;
  readonly levelTailBid: Int32Array;
  readonly levelHeadAsk: Int32Array;
  readonly levelTailAsk: Int32Array;

  // Bitmap for fast best-price lookup
  readonly bitmapBid: Uint32Array;
  readonly bitmapAsk: Uint32Array;

  // Best prices (-1 = empty)
  readonly bestBidIdx: number;
  readonly bestAskIdx: number;

  // Free list
  readonly freeHead: number;

  // Counters for state hash
  readonly tradeCount: number;
  readonly tradeQtySum: bigint;
  readonly eventHash: bigint;
}

const EMPTY = -1;
const BITWORD = 32;
// Uint32 max = 4,294,967,295 (~4.3 billion)
// With LOT_SCALE = 10^12, this allows ~4294 ETH per order
const MAX_QTY = 0xFFFFFFFF;  // Uint32 max - matches storage type
const PRIME = 0x1_0000_01n;

// ============================================================================
// Initialization
// ============================================================================

export function createBook(params: BookParams): BookState {
  const { tick, pmin, pmax, maxOrders } = params;

  if (tick <= 0) throw new Error('tick must be positive');
  if (pmax <= pmin) throw new Error('pmax must be > pmin');

  const levels = Math.floor((pmax - pmin) / tick) + 1;
  if (levels <= 0) throw new Error('invalid price grid');

  const bitmapSize = Math.ceil(levels / BITWORD);

  // Initialize order arrays
  const orderNext = new Int32Array(maxOrders);
  for (let i = 0; i < maxOrders - 1; i++) orderNext[i] = i + 1;
  orderNext[maxOrders - 1] = EMPTY;

  return {
    params,
    levels,
    orderPriceIdx: new Int32Array(maxOrders).fill(EMPTY),
    orderQtyLots: new Uint32Array(maxOrders),
    orderOwnerIdx: new Uint32Array(maxOrders),
    orderSide: new Uint8Array(maxOrders),
    orderPrev: new Int32Array(maxOrders).fill(EMPTY),
    orderNext,
    orderActive: new Uint8Array(maxOrders),
    owners: [],
    orderIds: [],
    orderIdToIdx: new Map(),
    levelHeadBid: new Int32Array(levels).fill(EMPTY),
    levelTailBid: new Int32Array(levels).fill(EMPTY),
    levelHeadAsk: new Int32Array(levels).fill(EMPTY),
    levelTailAsk: new Int32Array(levels).fill(EMPTY),
    bitmapBid: new Uint32Array(bitmapSize),
    bitmapAsk: new Uint32Array(bitmapSize),
    bestBidIdx: EMPTY,
    bestAskIdx: EMPTY,
    freeHead: 0,
    tradeCount: 0,
    tradeQtySum: 0n,
    eventHash: 0n,
  };
}

// ============================================================================
// Helpers (internal, operate on mutable copies)
// ============================================================================

function cloneMutableState(s: BookState): {
  orderPriceIdx: Int32Array;
  orderQtyLots: Uint32Array;
  orderOwnerIdx: Uint32Array;
  orderSide: Uint8Array;
  orderPrev: Int32Array;
  orderNext: Int32Array;
  orderActive: Uint8Array;
  owners: string[];
  orderIds: string[];
  orderIdToIdx: Map<string, number>;
  levelHeadBid: Int32Array;
  levelTailBid: Int32Array;
  levelHeadAsk: Int32Array;
  levelTailAsk: Int32Array;
  bitmapBid: Uint32Array;
  bitmapAsk: Uint32Array;
  bestBidIdx: number;
  bestAskIdx: number;
  freeHead: number;
  tradeCount: number;
  tradeQtySum: bigint;
  eventHash: bigint;
} {
  return {
    orderPriceIdx: s.orderPriceIdx.slice(),
    orderQtyLots: s.orderQtyLots.slice(),
    orderOwnerIdx: s.orderOwnerIdx.slice(),
    orderSide: s.orderSide.slice(),
    orderPrev: s.orderPrev.slice(),
    orderNext: s.orderNext.slice(),
    orderActive: s.orderActive.slice(),
    owners: [...s.owners],
    orderIds: [...s.orderIds],
    orderIdToIdx: new Map(s.orderIdToIdx),
    levelHeadBid: s.levelHeadBid.slice(),
    levelTailBid: s.levelTailBid.slice(),
    levelHeadAsk: s.levelHeadAsk.slice(),
    levelTailAsk: s.levelTailAsk.slice(),
    bitmapBid: s.bitmapBid.slice(),
    bitmapAsk: s.bitmapAsk.slice(),
    bestBidIdx: s.bestBidIdx,
    bestAskIdx: s.bestAskIdx,
    freeHead: s.freeHead,
    tradeCount: s.tradeCount,
    tradeQtySum: s.tradeQtySum,
    eventHash: s.eventHash,
  };
}

const ctz32 = (x: number) => Math.clz32((x & -x) >>> 0) ^ 31;

function findNextNonEmpty(bitmap: Uint32Array, levels: number, start: number): number {
  if (start < 0) start = 0;
  for (let i = start; i < levels;) {
    const w = (i / BITWORD) | 0;
    const base = w * BITWORD;
    let word = bitmap[w];
    if (word) {
      const shift = i - base;
      word >>>= shift;
      if (word) return base + shift + ctz32(word);
    }
    i = base + BITWORD;
  }
  return EMPTY;
}

function findPrevNonEmpty(bitmap: Uint32Array, start: number): number {
  for (let i = start; i >= 0;) {
    const w = (i / BITWORD) | 0;
    const base = w * BITWORD;
    let word = bitmap[w];
    if (word) {
      const upto = i - base;
      const mask = upto === 31 ? 0xffffffff : (1 << (upto + 1)) - 1;
      word &= mask >>> 0;
      if (word) return base + (31 - Math.clz32(word));
    }
    i = base - 1;
  }
  return EMPTY;
}

// ============================================================================
// Core Operations
// ============================================================================

export function applyCommand(
  state: BookState,
  cmd: OrderCmd
): { state: BookState; events: BookEvent[] } {
  const events: BookEvent[] = [];
  const m = cloneMutableState(state);
  const { params, levels } = state;
  const { tick, pmin, pmax, stpPolicy } = params;

  // Get or create owner index
  function getOwnerIdx(ownerId: string): number {
    let idx = m.owners.indexOf(ownerId);
    if (idx === -1) {
      idx = m.owners.length;
      m.owners.push(ownerId);
    }
    return idx;
  }

  // Allocate order slot
  function allocOrder(): number {
    const i = m.freeHead;
    if (i === EMPTY) throw new Error('Out of order slots');
    m.freeHead = m.orderNext[i];
    return i;
  }

  // Free order slot
  function freeOrder(i: number): void {
    m.orderActive[i] = 0;
    m.orderPriceIdx[i] = EMPTY;
    m.orderQtyLots[i] = 0;
    m.orderNext[i] = m.freeHead;
    m.freeHead = i;
  }

  // Bitmap operations
  function setBit(side: Side, levelIdx: number): void {
    const bm = side === 0 ? m.bitmapBid : m.bitmapAsk;
    const w = (levelIdx / BITWORD) | 0;
    const b = levelIdx & 31;
    bm[w] |= (1 << b) >>> 0;
  }

  function clearBit(side: Side, levelIdx: number): void {
    const bm = side === 0 ? m.bitmapBid : m.bitmapAsk;
    const w = (levelIdx / BITWORD) | 0;
    const b = levelIdx & 31;
    bm[w] &= ~(1 << b) >>> 0;
  }

  // Level queue operations
  function enqueueTail(side: Side, levelIdx: number, idx: number): void {
    const head = side === 0 ? m.levelHeadBid : m.levelHeadAsk;
    const tail = side === 0 ? m.levelTailBid : m.levelTailAsk;

    if (head[levelIdx] === EMPTY) {
      head[levelIdx] = idx;
      tail[levelIdx] = idx;
      m.orderPrev[idx] = EMPTY;
      m.orderNext[idx] = EMPTY;
      setBit(side, levelIdx);

      if (side === 0) {
        if (m.bestBidIdx === EMPTY || levelIdx > m.bestBidIdx) m.bestBidIdx = levelIdx;
      } else {
        if (m.bestAskIdx === EMPTY || levelIdx < m.bestAskIdx) m.bestAskIdx = levelIdx;
      }
    } else {
      const t = tail[levelIdx];
      m.orderNext[t] = idx;
      m.orderPrev[idx] = t;
      m.orderNext[idx] = EMPTY;
      tail[levelIdx] = idx;
    }
  }

  function removeFromLevel(side: Side, levelIdx: number, idx: number): void {
    const head = side === 0 ? m.levelHeadBid : m.levelHeadAsk;
    const tail = side === 0 ? m.levelTailBid : m.levelTailAsk;

    const p = m.orderPrev[idx];
    const n = m.orderNext[idx];

    if (p !== EMPTY) m.orderNext[p] = n;
    else head[levelIdx] = n;

    if (n !== EMPTY) m.orderPrev[n] = p;
    else tail[levelIdx] = p;

    m.orderPrev[idx] = EMPTY;
    m.orderNext[idx] = EMPTY;

    if (head[levelIdx] === EMPTY) {
      clearBit(side, levelIdx);
      if (side === 0 && m.bestBidIdx === levelIdx) {
        m.bestBidIdx = findPrevNonEmpty(m.bitmapBid, levelIdx - 1);
      }
      if (side === 1 && m.bestAskIdx === levelIdx) {
        m.bestAskIdx = findNextNonEmpty(m.bitmapAsk, levels, levelIdx + 1);
      }
    }
  }

  // Hash update
  function bumpHash(tag: number, a: number, b: number): void {
    m.eventHash = (m.eventHash * PRIME + BigInt((tag * 2654435761 >>> 0) ^ a ^ (b << 7))) & 0x1fffffffffffffn;
  }

  // Fill against resting orders
  function fillAgainst(
    side: Side,
    levelIdx: number,
    remaining: number,
    takerOwnerIdx: number,
    takerOrderId: string,
    takerQtyTotal: number  // Taker's original order qty for fill ratio calculation
  ): number {
    const head = side === 0 ? m.levelHeadAsk : m.levelHeadBid;
    const oppSide: Side = side === 0 ? 1 : 0;

    while (remaining > 0) {
      const headIdx = head[levelIdx];
      if (headIdx === EMPTY) return remaining;

      if (!m.orderActive[headIdx]) {
        removeFromLevel(oppSide, levelIdx, headIdx);
        freeOrder(headIdx);
        continue;
      }

      const makerOwnerIdx = m.orderOwnerIdx[headIdx];
      const makerOwnerId = m.owners[makerOwnerIdx];
      const takerOwnerId = m.owners[takerOwnerIdx];
      const makerOrderId = m.orderIds[headIdx];

      // Self-trade prevention
      if (makerOwnerIdx === takerOwnerIdx) {
        if (stpPolicy === 1) {
          // Cancel taker: return 0 to break outer matching loop
          // (returning remaining would cause infinite loop since maker isn't modified)
          events.push({ type: 'REJECT', orderId: takerOrderId, ownerId: takerOwnerId, reason: 'STP cancel taker' });
          return 0;
        }
        if (stpPolicy === 2) {
          // Reduce maker and skip the self-cross qty
          const dec = Math.min(m.orderQtyLots[headIdx], remaining);
          m.orderQtyLots[headIdx] -= dec;
          remaining -= dec; // Also skip the qty that would have self-traded
          events.push({ type: 'REDUCED', orderId: makerOrderId, ownerId: makerOwnerId, delta: -dec, remain: m.orderQtyLots[headIdx] });
          if (m.orderQtyLots[headIdx] === 0) {
            removeFromLevel(oppSide, levelIdx, headIdx);
            freeOrder(headIdx);
          }
          continue;
        }
      }

      const makerQty = m.orderQtyLots[headIdx];
      const tradeQty = Math.min(makerQty, remaining);
      const pxTicks = pmin + levelIdx * tick;

      m.orderQtyLots[headIdx] -= tradeQty;
      remaining -= tradeQty;

      m.tradeCount++;
      m.tradeQtySum += BigInt(tradeQty);
      bumpHash(3, pxTicks, tradeQty);

      events.push({
        type: 'TRADE',
        price: pxTicks,
        qty: tradeQty,
        makerOwnerId,
        takerOwnerId,
        makerOrderId,
        takerOrderId,
        makerQtyBefore: makerQty,     // Maker's qty before this trade
        takerQtyTotal,                 // Taker's total order qty
      });

      if (m.orderQtyLots[headIdx] === 0) {
        removeFromLevel(oppSide, levelIdx, headIdx);
        freeOrder(headIdx);
        m.orderIdToIdx.delete(makerOrderId);
      } else {
        events.push({ type: 'REDUCED', orderId: makerOrderId, ownerId: makerOwnerId, delta: -tradeQty, remain: m.orderQtyLots[headIdx] });
      }
    }
    return remaining;
  }

  // Handle commands
  if (cmd.kind === 0) {
    // NEW ORDER
    const { ownerId, orderId, side, tif, postOnly, priceTicks, qtyLots, minFillRatio = 0 } = cmd;

    // Validation
    if (qtyLots <= 0 || qtyLots > MAX_QTY) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: 'qty out of range' });
      return { state, events };
    }

    if (minFillRatio < 0 || minFillRatio > MAX_FILL_RATIO) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: `minFillRatio must be 0-${MAX_FILL_RATIO}` });
      return { state, events };
    }

    const levelIdx = Math.floor((priceTicks - pmin) / tick);
    if (levelIdx < 0 || levelIdx >= levels) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: 'price out of range' });
      return { state, events };
    }

    if (m.orderIdToIdx.has(orderId)) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: 'duplicate orderId' });
      return { state, events };
    }

    const ownerIdx = getOwnerIdx(ownerId);
    let remaining = qtyLots;

    // Check postOnly
    if (postOnly) {
      if (side === 0 && m.bestAskIdx !== EMPTY && m.bestAskIdx <= levelIdx) {
        events.push({ type: 'REJECT', orderId, ownerId, reason: 'postOnly would cross' });
        return { state, events };
      }
      if (side === 1 && m.bestBidIdx !== EMPTY && m.bestBidIdx >= levelIdx) {
        events.push({ type: 'REJECT', orderId, ownerId, reason: 'postOnly would cross' });
        return { state, events };
      }
    }

    // Dry-run simulation to check FOK and minFillRatio BEFORE mutating state
    // This prevents partial fills that would need rollback
    let simRemaining = qtyLots;
    if (side === 0) {
      let simBestAsk = m.bestAskIdx;
      while (simRemaining > 0 && simBestAsk !== EMPTY && simBestAsk <= levelIdx) {
        let headIdx = m.levelHeadAsk[simBestAsk];
        while (headIdx !== EMPTY && simRemaining > 0) {
          // Skip self-trades in simulation (STP would prevent them)
          if (stpPolicy > 0 && m.orderOwnerIdx[headIdx] === ownerIdx) {
            headIdx = m.orderNext[headIdx];
            continue;
          }
          const makerQty = m.orderQtyLots[headIdx];
          simRemaining -= Math.min(makerQty, simRemaining);
          headIdx = m.orderNext[headIdx];
        }
        if (simRemaining > 0) {
          simBestAsk = findNextNonEmpty(m.bitmapAsk, levels, simBestAsk + 1);
        }
      }
    } else {
      let simBestBid = m.bestBidIdx;
      while (simRemaining > 0 && simBestBid !== EMPTY && simBestBid >= levelIdx) {
        let headIdx = m.levelHeadBid[simBestBid];
        while (headIdx !== EMPTY && simRemaining > 0) {
          // Skip self-trades in simulation (STP would prevent them)
          if (stpPolicy > 0 && m.orderOwnerIdx[headIdx] === ownerIdx) {
            headIdx = m.orderNext[headIdx];
            continue;
          }
          const makerQty = m.orderQtyLots[headIdx];
          simRemaining -= Math.min(makerQty, simRemaining);
          headIdx = m.orderNext[headIdx];
        }
        if (simRemaining > 0) {
          simBestBid = findPrevNonEmpty(m.bitmapBid, simBestBid - 1);
        }
      }
    }

    // Check FOK constraint
    if (tif === 2 && simRemaining > 0) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: 'FOK cannot fill entirely' });
      return { state, events };
    }

    // Check minFillRatio constraint BEFORE mutating state
    // For IOC/FOK orders, reject if can't fill immediately
    // For GTC orders, minFillRatio is enforced at swap_resolve time (allows resting on book)
    if (minFillRatio > 0 && (tif === 1 || tif === 2)) {
      const simFilledQty = qtyLots - simRemaining;
      const simFillRatio = Math.floor((simFilledQty / qtyLots) * MAX_FILL_RATIO);
      if (simFillRatio < minFillRatio) {
        events.push({ type: 'REJECT', orderId, ownerId, reason: `minFillRatio not met: ${simFillRatio} < ${minFillRatio} (pre-check)` });
        return { state, events };
      }
    }

    // Match against opposite side
    if (side === 0) {
      // BUY - match against asks
      while (remaining > 0 && m.bestAskIdx !== EMPTY && m.bestAskIdx <= levelIdx) {
        remaining = fillAgainst(0, m.bestAskIdx, remaining, ownerIdx, orderId, qtyLots);
        if (m.bestAskIdx !== EMPTY && m.levelHeadAsk[m.bestAskIdx] === EMPTY) {
          m.bestAskIdx = findNextNonEmpty(m.bitmapAsk, levels, m.bestAskIdx + 1);
        }
      }
    } else {
      // SELL - match against bids
      while (remaining > 0 && m.bestBidIdx !== EMPTY && m.bestBidIdx >= levelIdx) {
        remaining = fillAgainst(1, m.bestBidIdx, remaining, ownerIdx, orderId, qtyLots);
        if (m.bestBidIdx !== EMPTY && m.levelHeadBid[m.bestBidIdx] === EMPTY) {
          m.bestBidIdx = findPrevNonEmpty(m.bitmapBid, m.bestBidIdx - 1);
        }
      }
    }

    // minFillRatio already checked in pre-flight simulation above
    // No post-check needed - state only mutated if pre-check passed
    const filledQty = qtyLots - remaining;

    // Handle remaining qty based on TIF
    if (remaining > 0) {
      if (tif === 1 || tif === 2) {
        // IOC or FOK - don't add to book
        // (FOK shouldn't reach here with remaining > 0 due to pre-check above)
        if (filledQty === 0) {
          events.push({ type: 'REJECT', orderId, ownerId, reason: 'no fill' });
        }
        // Partial fill for IOC is fine, just don't post remainder
      } else {
        // GTC (tif === 0) - add remaining to book
        const idx = allocOrder();
        m.orderPriceIdx[idx] = levelIdx;
        m.orderQtyLots[idx] = remaining;
        m.orderOwnerIdx[idx] = ownerIdx;
        m.orderSide[idx] = side;
        m.orderActive[idx] = 1;
        m.orderIds[idx] = orderId;
        m.orderIdToIdx.set(orderId, idx);
        enqueueTail(side, levelIdx, idx);
        events.push({ type: 'ACK', orderId, ownerId });
        bumpHash(1, ownerIdx, remaining);
      }
    }

  } else if (cmd.kind === 1) {
    // CANCEL
    const { ownerId, orderId } = cmd;
    const idx = m.orderIdToIdx.get(orderId);

    if (idx === undefined || !m.orderActive[idx]) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: 'not found' });
      return { state, events };
    }

    // Check ownership
    if (m.owners[m.orderOwnerIdx[idx]] !== ownerId) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: 'not owner' });
      return { state, events };
    }

    const levelIdx = m.orderPriceIdx[idx];
    const side = m.orderSide[idx] as Side;
    removeFromLevel(side, levelIdx, idx);
    freeOrder(idx);
    m.orderIdToIdx.delete(orderId);
    events.push({ type: 'CANCELED', orderId, ownerId });
    bumpHash(5, m.orderOwnerIdx[idx], 0);

  } else if (cmd.kind === 2) {
    // REPLACE (cancel + new)
    const { ownerId, orderId, newPriceTicks, qtyDeltaLots } = cmd;
    const idx = m.orderIdToIdx.get(orderId);

    if (idx === undefined || !m.orderActive[idx]) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: 'not found' });
      return { state, events };
    }

    if (m.owners[m.orderOwnerIdx[idx]] !== ownerId) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: 'not owner' });
      return { state, events };
    }

    const side = m.orderSide[idx] as Side;
    const oldLevelIdx = m.orderPriceIdx[idx];
    const oldQty = m.orderQtyLots[idx];
    const newQty = oldQty + qtyDeltaLots;

    if (newQty <= 0) {
      // Cancel
      removeFromLevel(side, oldLevelIdx, idx);
      freeOrder(idx);
      m.orderIdToIdx.delete(orderId);
      events.push({ type: 'CANCELED', orderId, ownerId });
    } else if (newPriceTicks !== null) {
      // Price change - CANCEL old, then match+post new order (proper replace semantics)
      const newLevelIdx = Math.floor((newPriceTicks - pmin) / tick);
      if (newLevelIdx < 0 || newLevelIdx >= levels) {
        events.push({ type: 'REJECT', orderId, ownerId, reason: 'new price out of range' });
        return { state, events };
      }

      // Cancel existing order
      removeFromLevel(side, oldLevelIdx, idx);
      freeOrder(idx);
      m.orderIdToIdx.delete(orderId);
      events.push({ type: 'CANCELED', orderId, ownerId });

      // Now attempt to match and post new order with crossing
      const ownerIdx = m.orderOwnerIdx[idx];
      let remaining = newQty;

      // Match against opposite side
      if (side === 0) {
        // BUY - match against asks
        while (remaining > 0 && m.bestAskIdx !== EMPTY && m.bestAskIdx <= newLevelIdx) {
          remaining = fillAgainst(0, m.bestAskIdx, remaining, ownerIdx, orderId, newQty);
          if (m.bestAskIdx !== EMPTY && m.levelHeadAsk[m.bestAskIdx] === EMPTY) {
            m.bestAskIdx = findNextNonEmpty(m.bitmapAsk, levels, m.bestAskIdx + 1);
          }
        }
      } else {
        // SELL - match against bids
        while (remaining > 0 && m.bestBidIdx !== EMPTY && m.bestBidIdx >= newLevelIdx) {
          remaining = fillAgainst(1, m.bestBidIdx, remaining, ownerIdx, orderId, newQty);
          if (m.bestBidIdx !== EMPTY && m.levelHeadBid[m.bestBidIdx] === EMPTY) {
            m.bestBidIdx = findPrevNonEmpty(m.bitmapBid, m.bestBidIdx - 1);
          }
        }
      }

      // Post any remaining to book (GTC behavior)
      if (remaining > 0) {
        const newIdx = allocOrder();
        m.orderPriceIdx[newIdx] = newLevelIdx;
        m.orderQtyLots[newIdx] = remaining;
        m.orderOwnerIdx[newIdx] = ownerIdx;
        m.orderSide[newIdx] = side;
        m.orderActive[newIdx] = 1;
        m.orderIds[newIdx] = orderId;
        m.orderIdToIdx.set(orderId, newIdx);
        enqueueTail(side, newLevelIdx, newIdx);
        events.push({ type: 'ACK', orderId, ownerId });
        bumpHash(1, ownerIdx, remaining);
      }
    } else {
      // Qty change only (no price change, no crossing needed)
      m.orderQtyLots[idx] = newQty;
      events.push({ type: 'REDUCED', orderId, ownerId, delta: qtyDeltaLots, remain: newQty });
    }
  }

  // Build new immutable state
  const newState: BookState = {
    params: state.params,
    levels: state.levels,
    orderPriceIdx: m.orderPriceIdx,
    orderQtyLots: m.orderQtyLots,
    orderOwnerIdx: m.orderOwnerIdx,
    orderSide: m.orderSide,
    orderPrev: m.orderPrev,
    orderNext: m.orderNext,
    orderActive: m.orderActive,
    owners: m.owners,
    orderIds: m.orderIds,
    orderIdToIdx: m.orderIdToIdx,
    levelHeadBid: m.levelHeadBid,
    levelTailBid: m.levelTailBid,
    levelHeadAsk: m.levelHeadAsk,
    levelTailAsk: m.levelTailAsk,
    bitmapBid: m.bitmapBid,
    bitmapAsk: m.bitmapAsk,
    bestBidIdx: m.bestBidIdx,
    bestAskIdx: m.bestAskIdx,
    freeHead: m.freeHead,
    tradeCount: m.tradeCount,
    tradeQtySum: m.tradeQtySum,
    eventHash: m.eventHash,
  };

  return { state: newState, events };
}

// ============================================================================
// Getters
// ============================================================================

export function getBestBid(state: BookState): number | null {
  if (state.bestBidIdx === EMPTY) return null;
  return state.params.pmin + state.bestBidIdx * state.params.tick;
}

export function getBestAsk(state: BookState): number | null {
  if (state.bestAskIdx === EMPTY) return null;
  return state.params.pmin + state.bestAskIdx * state.params.tick;
}

export function getSpread(state: BookState): number | null {
  const bid = getBestBid(state);
  const ask = getBestAsk(state);
  if (bid === null || ask === null) return null;
  return ask - bid;
}

/** Compute deterministic state hash for consensus */
export function computeBookHash(state: BookState): string {
  // Include: eventHash + tradeCount + tradeQtySum + bestBid + bestAsk
  const bid = state.bestBidIdx;
  const ask = state.bestAskIdx;
  const combined = `${state.eventHash.toString(16)}|${state.tradeCount}|${state.tradeQtySum}|${bid}|${ask}`;

  // Simple hash (for real use, replace with keccak256)
  let hash = 0n;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash * 31n + BigInt(combined.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * ASCII snapshot of the top-of-book (depth rows),
 * with per-level individual orders listed as "qty@owner,qty@owner,...".
 */
export function renderAscii(state: BookState, depth = 10, perLevelOrders = 10, lineWidth = 40): string {
  const { params: { pmin, tick }, levelHeadBid, levelHeadAsk, orderQtyLots, orderOwnerIdx, orderNext, orderActive, owners, bestBidIdx, bestAskIdx } = state;
  const rows: string[] = [];
  const BOLD = '\x1b[1m', DIM = '\x1b[2m', RESET = '\x1b[0m';
  const GREEN = '\x1b[32m', RED = '\x1b[31m';

  const pad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

  // Find previous non-empty bid level
  const findPrevBid = (from: number): number => {
    for (let i = from; i >= 0; i--) {
      if (levelHeadBid[i] !== EMPTY) return i;
    }
    return EMPTY;
  };

  // Find next non-empty ask level
  const findNextAsk = (from: number): number => {
    for (let i = from; i < state.levels; i++) {
      if (levelHeadAsk[i] !== EMPTY) return i;
    }
    return EMPTY;
  };

  // Collect bids (descending price)
  const bids: { px: number; orders: string }[] = [];
  let bidIdx = bestBidIdx;
  while (bidIdx !== EMPTY && bids.length < depth) {
    let cur = levelHeadBid[bidIdx];
    const parts: string[] = [];
    let count = 0;
    while (cur !== EMPTY && count < perLevelOrders) {
      if (orderActive[cur]) {
        const owner = owners[orderOwnerIdx[cur]]?.slice(-4) || '?';
        parts.push(`${orderQtyLots[cur]}@${owner}`);
        count++;
      }
      cur = orderNext[cur];
    }
    if (parts.length) bids.push({ px: pmin + bidIdx * tick, orders: parts.join(',') });
    bidIdx = findPrevBid(bidIdx - 1);
  }

  // Collect asks (ascending price)
  const asks: { px: number; orders: string }[] = [];
  let askIdx = bestAskIdx;
  while (askIdx !== EMPTY && asks.length < depth) {
    let cur = levelHeadAsk[askIdx];
    const parts: string[] = [];
    let count = 0;
    while (cur !== EMPTY && count < perLevelOrders) {
      if (orderActive[cur]) {
        const owner = owners[orderOwnerIdx[cur]]?.slice(-4) || '?';
        parts.push(`${orderQtyLots[cur]}@${owner}`);
        count++;
      }
      cur = orderNext[cur];
    }
    if (parts.length) asks.push({ px: pmin + askIdx * tick, orders: parts.join(',') });
    askIdx = findNextAsk(askIdx + 1);
  }

  rows.push(`${BOLD}     BID (qty@owner)      |      ASK (qty@owner)     ${RESET}`);
  rows.push(`${DIM}  PX      ORDERS          |   PX      ORDERS         ${RESET}`);

  for (let i = 0; i < depth; i++) {
    const b = bids[i];
    const a = asks[i];
    const bPx = b ? pad(String(b.px), 6) : '      ';
    const aPx = a ? pad(String(a.px), 6) : '      ';
    const bOrd = b ? pad(b.orders.slice(0, lineWidth), lineWidth) : ' '.repeat(lineWidth);
    const aOrd = a ? pad(a.orders.slice(0, lineWidth), lineWidth) : ' '.repeat(lineWidth);
    rows.push(`${GREEN}${bPx} ${bOrd}${RESET} | ${RED}${aPx} ${aOrd}${RESET}`);
  }

  return rows.join('\n');
}
