/**
 * Limit Order Book Engine for XLN
 *
 * Refactored from .archive/orderbook/lob_core.ts
 * Key changes:
 * - Class-based (not global singleton) for multiple books
 * - BigInt for prices/quantities
 * - String entityIds (mapped to uint32 internally)
 * - Browser-compatible (no Node crypto)
 *
 * Performance characteristics preserved:
 * - O(1) order removal via doubly-linked lists
 * - Bitmap-based best price tracking
 * - SoA layout for cache efficiency
 */

import { ethers } from 'ethers';
import {
  Side, TIF, OrderCmd, OrderbookParams, OrderbookEvent, StoredOrder,
  MAX_FILL_RATIO
} from './types';

const EMPTY = -1;
const BITWORD = 32;
const MAX_QTY = 0x7FFFFFFFFFFFFFFFn;  // BigInt max safe

export class OrderbookEngine {
  readonly pairId: string;
  readonly tick: bigint;
  readonly pmin: bigint;
  readonly pmax: bigint;
  readonly levels: number;
  readonly maxOrders: number;
  readonly stpPolicy: 0 | 1 | 2;

  // Entity ID mapping (string -> uint32)
  private entityToIdx: Map<string, number> = new Map();
  private idxToEntity: string[] = [];

  // Order ID mapping (string -> slot index)
  private orderIdToSlot: Map<string, number> = new Map();

  // Per-order fields (SoA layout)
  private orderPriceIdx: Int32Array;
  private orderQtyLots: BigInt64Array;
  private orderOwnerIdx: Uint32Array;
  private orderSide: Uint8Array;
  private orderPrev: Int32Array;
  private orderNext: Int32Array;
  private orderActive: Uint8Array;
  private orderTimestamp: Float64Array;
  private orderIds: string[];

  // Per-level queues
  private levelHeadBid: Int32Array;
  private levelTailBid: Int32Array;
  private bitmapBid: Uint32Array;
  private levelHeadAsk: Int32Array;
  private levelTailAsk: Int32Array;
  private bitmapAsk: Uint32Array;

  // Best levels
  private bestBidIdx = EMPTY;
  private bestAskIdx = EMPTY;

  // Free list
  private freeTop = 0;

  // Event buffer
  private events: OrderbookEvent[] = [];

  // Counters for determinism verification
  private tradeCount = 0;
  private tradeQtySum = 0n;
  private tradeNotionalSum = 0n;

  constructor(params: OrderbookParams) {
    this.pairId = params.pairId;
    this.tick = params.tick;
    this.pmin = params.pmin;
    this.pmax = params.pmax;
    this.maxOrders = params.maxOrders;
    this.stpPolicy = params.stpPolicy;

    this.levels = Number((this.pmax - this.pmin) / this.tick) + 1;

    // Allocate arrays
    this.orderPriceIdx = new Int32Array(this.maxOrders).fill(EMPTY);
    this.orderQtyLots = new BigInt64Array(this.maxOrders);
    this.orderOwnerIdx = new Uint32Array(this.maxOrders);
    this.orderSide = new Uint8Array(this.maxOrders);
    this.orderPrev = new Int32Array(this.maxOrders).fill(EMPTY);
    this.orderNext = new Int32Array(this.maxOrders).fill(EMPTY);
    this.orderActive = new Uint8Array(this.maxOrders);
    this.orderTimestamp = new Float64Array(this.maxOrders);
    this.orderIds = new Array(this.maxOrders).fill('');

    this.levelHeadBid = new Int32Array(this.levels).fill(EMPTY);
    this.levelTailBid = new Int32Array(this.levels).fill(EMPTY);
    this.bitmapBid = new Uint32Array(Math.ceil(this.levels / BITWORD));

    this.levelHeadAsk = new Int32Array(this.levels).fill(EMPTY);
    this.levelTailAsk = new Int32Array(this.levels).fill(EMPTY);
    this.bitmapAsk = new Uint32Array(Math.ceil(this.levels / BITWORD));

    // Initialize free list
    for (let i = 0; i < this.maxOrders - 1; i++) {
      this.orderNext[i] = i + 1;
    }
    this.orderNext[this.maxOrders - 1] = EMPTY;
  }

  // === Public API ===

  getBestBid(): bigint | null {
    return this.bestBidIdx === EMPTY ? null : this.pmin + BigInt(this.bestBidIdx) * this.tick;
  }

  getBestAsk(): bigint | null {
    return this.bestAskIdx === EMPTY ? null : this.pmin + BigInt(this.bestAskIdx) * this.tick;
  }

  getSpread(): bigint | null {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    if (bid === null || ask === null) return null;
    return ask - bid;
  }

  drainEvents(): OrderbookEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  getCounters() {
    return {
      tradeCount: this.tradeCount,
      tradeQtySum: this.tradeQtySum,
      tradeNotionalSum: this.tradeNotionalSum,
    };
  }

  /** Compute deterministic state hash */
  computeStateHash(): string {
    const data = JSON.stringify({
      pairId: this.pairId,
      bestBid: this.getBestBid()?.toString() ?? 'null',
      bestAsk: this.getBestAsk()?.toString() ?? 'null',
      tradeCount: this.tradeCount,
      tradeQtySum: this.tradeQtySum.toString(),
      tradeNotionalSum: this.tradeNotionalSum.toString(),
      // Include active order count for state verification
      activeOrders: Array.from(this.orderActive).filter(x => x === 1).length,
    });
    return ethers.keccak256(ethers.toUtf8Bytes(data));
  }

  // === Order Operations ===

  applyCommand(cmd: OrderCmd): void {
    if (cmd.kind === 0) {
      this.newOrder(cmd);
    } else if (cmd.kind === 1) {
      this.cancelOrder(cmd.ownerId, cmd.orderId);
    } else {
      this.replaceOrder(cmd.ownerId, cmd.orderId, cmd.newPriceTicks, cmd.qtyDeltaLots);
    }
  }

  newOrder(cmd: Extract<OrderCmd, { kind: 0 }>): void {
    const { ownerId, orderId, side, priceTicks, qtyLots, tif, postOnly } = cmd;

    // Validate
    if (qtyLots <= 0n || qtyLots > MAX_QTY) {
      this.emitReject(orderId, ownerId, 'invalid qty');
      return;
    }
    if (priceTicks < this.pmin || priceTicks > this.pmax) {
      this.emitReject(orderId, ownerId, 'price out of range');
      return;
    }
    if (this.orderIdToSlot.has(orderId)) {
      this.emitReject(orderId, ownerId, 'duplicate orderId');
      return;
    }

    const levelIdx = this.priceToLevel(priceTicks);
    let remaining = qtyLots;
    const ownerIdx = this.getOrCreateOwnerIdx(ownerId);

    // FOK dry-run check
    if (tif === 2) {
      const fillable = this.availableLiquidity(side, levelIdx, remaining);
      if (fillable < remaining) {
        this.emitReject(orderId, ownerId, 'FOK cannot fill');
        return;
      }
    }

    // Crossing phase
    if (side === 0) { // BUY - cross against asks
      if (postOnly && this.bestAskIdx !== EMPTY && this.bestAskIdx <= levelIdx) {
        this.emitReject(orderId, ownerId, 'postOnly would cross');
        return;
      }
      while (remaining > 0n && this.bestAskIdx !== EMPTY && this.bestAskIdx <= levelIdx) {
        remaining = this.fillAgainstAsk(this.bestAskIdx, remaining, ownerIdx, ownerId, orderId);
        this.updateBestAsk();
      }
    } else { // SELL - cross against bids
      if (postOnly && this.bestBidIdx !== EMPTY && this.bestBidIdx >= levelIdx) {
        this.emitReject(orderId, ownerId, 'postOnly would cross');
        return;
      }
      while (remaining > 0n && this.bestBidIdx !== EMPTY && this.bestBidIdx >= levelIdx) {
        remaining = this.fillAgainstBid(this.bestBidIdx, remaining, ownerIdx, ownerId, orderId);
        this.updateBestBid();
      }
    }

    // Post remaining
    if (remaining > 0n) {
      if (tif === 1) { // IOC - cancel unfilled
        if (remaining < qtyLots) {
          // Partial fill happened
        }
        return;
      }

      // GTC - post to book
      const slot = this.allocSlot();
      if (slot === EMPTY) {
        this.emitReject(orderId, ownerId, 'book full');
        return;
      }

      this.orderPriceIdx[slot] = levelIdx;
      this.orderQtyLots[slot] = remaining;
      this.orderOwnerIdx[slot] = ownerIdx;
      this.orderSide[slot] = side;
      this.orderActive[slot] = 1;
      this.orderTimestamp[slot] = Date.now();
      this.orderIds[slot] = orderId;

      this.orderIdToSlot.set(orderId, slot);
      this.enqueueTail(side, levelIdx, slot);

      this.emitAck(orderId, ownerId);
    }
  }

  cancelOrder(ownerId: string, orderId: string): void {
    const slot = this.orderIdToSlot.get(orderId);
    if (slot === undefined || !this.orderActive[slot]) {
      this.emitReject(orderId, ownerId, 'order not found');
      return;
    }

    const levelIdx = this.orderPriceIdx[slot];
    const side = this.orderSide[slot] as Side;

    this.removeFromLevel(side, levelIdx, slot);
    this.freeSlot(slot);
    this.orderIdToSlot.delete(orderId);

    this.emitCanceled(orderId, ownerId);
  }

  replaceOrder(ownerId: string, orderId: string, newPrice: bigint | null, qtyDelta: bigint): void {
    const slot = this.orderIdToSlot.get(orderId);
    if (slot === undefined || !this.orderActive[slot]) {
      this.emitReject(orderId, ownerId, 'order not found');
      return;
    }

    const curQty = this.orderQtyLots[slot];
    const newQty = curQty + qtyDelta;

    if (newQty <= 0n) {
      this.cancelOrder(ownerId, orderId);
      return;
    }

    const side = this.orderSide[slot] as Side;
    const curLevel = this.orderPriceIdx[slot];
    let targetLevel = curLevel;

    if (newPrice !== null) {
      if (newPrice < this.pmin || newPrice > this.pmax) {
        this.emitReject(orderId, ownerId, 'price out of range');
        return;
      }
      targetLevel = this.priceToLevel(newPrice);
    }

    const priceChanged = targetLevel !== curLevel;
    const sizeUp = qtyDelta > 0n;

    if (priceChanged || sizeUp) {
      // Lose priority - requeue at tail
      this.removeFromLevel(side, curLevel, slot);
      this.orderPriceIdx[slot] = targetLevel;
      this.orderQtyLots[slot] = newQty;
      this.enqueueTail(side, targetLevel, slot);
      this.emitAck(orderId, ownerId);
    } else {
      // Size down - keep priority
      this.orderQtyLots[slot] = newQty;
      this.emitReduced(orderId, ownerId, qtyDelta, newQty);
    }
  }

  // === Internal Helpers ===

  private priceToLevel(price: bigint): number {
    return Number((price - this.pmin) / this.tick);
  }

  private getOrCreateOwnerIdx(entityId: string): number {
    let idx = this.entityToIdx.get(entityId);
    if (idx === undefined) {
      idx = this.idxToEntity.length;
      this.entityToIdx.set(entityId, idx);
      this.idxToEntity.push(entityId);
    }
    return idx;
  }

  private getOwnerEntity(idx: number): string {
    return this.idxToEntity[idx] ?? '';
  }

  private allocSlot(): number {
    if (this.freeTop === EMPTY) return EMPTY;
    const slot = this.freeTop;
    this.freeTop = this.orderNext[slot];
    return slot;
  }

  private freeSlot(slot: number): void {
    this.orderActive[slot] = 0;
    this.orderQtyLots[slot] = 0n;
    this.orderIds[slot] = '';
    this.orderNext[slot] = this.freeTop;
    this.freeTop = slot;
  }

  // === Level Queue Operations ===

  private enqueueTail(side: Side, levelIdx: number, slot: number): void {
    const head = side === 0 ? this.levelHeadBid : this.levelHeadAsk;
    const tail = side === 0 ? this.levelTailBid : this.levelTailAsk;

    if (head[levelIdx] === EMPTY) {
      head[levelIdx] = tail[levelIdx] = slot;
      this.orderPrev[slot] = EMPTY;
      this.orderNext[slot] = EMPTY;
      this.setBit(side === 0, levelIdx);

      if (side === 0) {
        if (this.bestBidIdx === EMPTY || levelIdx > this.bestBidIdx) {
          this.bestBidIdx = levelIdx;
        }
      } else {
        if (this.bestAskIdx === EMPTY || levelIdx < this.bestAskIdx) {
          this.bestAskIdx = levelIdx;
        }
      }
    } else {
      const t = tail[levelIdx];
      this.orderNext[t] = slot;
      this.orderPrev[slot] = t;
      this.orderNext[slot] = EMPTY;
      tail[levelIdx] = slot;
    }
  }

  private removeFromLevel(side: Side, levelIdx: number, slot: number): void {
    const head = side === 0 ? this.levelHeadBid : this.levelHeadAsk;
    const tail = side === 0 ? this.levelTailBid : this.levelTailAsk;

    const p = this.orderPrev[slot];
    const n = this.orderNext[slot];

    if (p !== EMPTY) this.orderNext[p] = n; else head[levelIdx] = n;
    if (n !== EMPTY) this.orderPrev[n] = p; else tail[levelIdx] = p;

    this.orderPrev[slot] = this.orderNext[slot] = EMPTY;

    if (head[levelIdx] === EMPTY) {
      this.clearBit(side === 0, levelIdx);
    }
  }

  // === Bitmap Operations ===

  private setBit(isBid: boolean, levelIdx: number): void {
    const bm = isBid ? this.bitmapBid : this.bitmapAsk;
    const w = Math.floor(levelIdx / BITWORD);
    const b = levelIdx & 31;
    bm[w] |= (1 << b) >>> 0;
  }

  private clearBit(isBid: boolean, levelIdx: number): void {
    const bm = isBid ? this.bitmapBid : this.bitmapAsk;
    const w = Math.floor(levelIdx / BITWORD);
    const b = levelIdx & 31;
    bm[w] &= (~(1 << b)) >>> 0;
  }

  private findNextNonEmpty(isAsk: boolean, start: number): number {
    const bm = isAsk ? this.bitmapAsk : this.bitmapBid;
    for (let i = Math.max(0, start); i < this.levels; ) {
      const w = Math.floor(i / BITWORD);
      const base = w * BITWORD;
      let word = bm[w];
      if (word) {
        const shift = i - base;
        word >>>= shift;
        if (word) return base + shift + this.ctz32(word);
      }
      i = base + BITWORD;
    }
    return EMPTY;
  }

  private findPrevNonEmpty(isBid: boolean, start: number): number {
    const bm = isBid ? this.bitmapBid : this.bitmapAsk;
    for (let i = Math.min(this.levels - 1, start); i >= 0; ) {
      const w = Math.floor(i / BITWORD);
      const base = w * BITWORD;
      let word = bm[w];
      if (word) {
        const upto = i - base;
        const mask = upto === 31 ? 0xffffffff : ((1 << (upto + 1)) - 1);
        word &= mask >>> 0;
        if (word) return base + (31 - Math.clz32(word));
      }
      i = base - 1;
    }
    return EMPTY;
  }

  private ctz32(x: number): number {
    return Math.clz32((x & -x) >>> 0) ^ 31;
  }

  private updateBestBid(): void {
    if (this.bestBidIdx !== EMPTY && this.levelHeadBid[this.bestBidIdx] === EMPTY) {
      this.bestBidIdx = this.findPrevNonEmpty(true, this.bestBidIdx - 1);
    }
  }

  private updateBestAsk(): void {
    if (this.bestAskIdx !== EMPTY && this.levelHeadAsk[this.bestAskIdx] === EMPTY) {
      this.bestAskIdx = this.findNextNonEmpty(true, this.bestAskIdx + 1);
    }
  }

  // === Matching ===

  private availableLiquidity(side: Side, limitLevel: number, need: bigint): bigint {
    let remaining = need;

    if (side === 0) { // BUY needs asks
      let li = this.bestAskIdx;
      while (remaining > 0n && li !== EMPTY && li <= limitLevel) {
        let cur = this.levelHeadAsk[li];
        while (remaining > 0n && cur !== EMPTY) {
          const q = this.orderQtyLots[cur];
          remaining -= q <= remaining ? q : remaining;
          cur = this.orderNext[cur];
        }
        li = this.findNextNonEmpty(true, li + 1);
      }
    } else { // SELL needs bids
      let li = this.bestBidIdx;
      while (remaining > 0n && li !== EMPTY && li >= limitLevel) {
        let cur = this.levelHeadBid[li];
        while (remaining > 0n && cur !== EMPTY) {
          const q = this.orderQtyLots[cur];
          remaining -= q <= remaining ? q : remaining;
          cur = this.orderNext[cur];
        }
        li = this.findPrevNonEmpty(true, li - 1);
      }
    }

    return need - (remaining > 0n ? remaining : 0n);
  }

  private fillAgainstBid(levelIdx: number, remaining: bigint, takerOwnerIdx: number, takerOwnerId: string, takerOrderId: string): bigint {
    while (remaining > 0n) {
      const head = this.levelHeadBid[levelIdx];
      if (head === EMPTY) return remaining;
      if (!this.orderActive[head]) {
        this.removeFromLevel(0, levelIdx, head);
        this.freeSlot(head);
        continue;
      }

      const makerOwnerIdx = this.orderOwnerIdx[head];
      const makerOwnerId = this.getOwnerEntity(makerOwnerIdx);
      const makerOrderId = this.orderIds[head];

      // STP check
      if (makerOwnerIdx === takerOwnerIdx && this.stpPolicy === 1) {
        this.emitReject(takerOrderId, takerOwnerId, 'STP cancel taker');
        return remaining;
      }

      const makerQty = this.orderQtyLots[head];
      const price = this.pmin + BigInt(levelIdx) * this.tick;
      const tradeQty = makerQty < remaining ? makerQty : remaining;

      const newMakerQty = makerQty - tradeQty;
      this.orderQtyLots[head] = newMakerQty;
      remaining -= tradeQty;

      this.emitTrade(price, tradeQty, makerOwnerId, takerOwnerId, makerOrderId, takerOrderId);

      if (newMakerQty === 0n) {
        this.removeFromLevel(0, levelIdx, head);
        this.orderIdToSlot.delete(makerOrderId);
        this.freeSlot(head);
      } else {
        this.emitReduced(makerOrderId, makerOwnerId, -tradeQty, newMakerQty);
        break; // FIFO - only head participates
      }
    }
    return remaining;
  }

  private fillAgainstAsk(levelIdx: number, remaining: bigint, takerOwnerIdx: number, takerOwnerId: string, takerOrderId: string): bigint {
    while (remaining > 0n) {
      const head = this.levelHeadAsk[levelIdx];
      if (head === EMPTY) return remaining;
      if (!this.orderActive[head]) {
        this.removeFromLevel(1, levelIdx, head);
        this.freeSlot(head);
        continue;
      }

      const makerOwnerIdx = this.orderOwnerIdx[head];
      const makerOwnerId = this.getOwnerEntity(makerOwnerIdx);
      const makerOrderId = this.orderIds[head];

      // STP check
      if (makerOwnerIdx === takerOwnerIdx && this.stpPolicy === 1) {
        this.emitReject(takerOrderId, takerOwnerId, 'STP cancel taker');
        return remaining;
      }

      const makerQty = this.orderQtyLots[head];
      const price = this.pmin + BigInt(levelIdx) * this.tick;
      const tradeQty = makerQty < remaining ? makerQty : remaining;

      const newMakerQty = makerQty - tradeQty;
      this.orderQtyLots[head] = newMakerQty;
      remaining -= tradeQty;

      this.emitTrade(price, tradeQty, makerOwnerId, takerOwnerId, makerOrderId, takerOrderId);

      if (newMakerQty === 0n) {
        this.removeFromLevel(1, levelIdx, head);
        this.orderIdToSlot.delete(makerOrderId);
        this.freeSlot(head);
      } else {
        this.emitReduced(makerOrderId, makerOwnerId, -tradeQty, newMakerQty);
        break; // FIFO
      }
    }
    return remaining;
  }

  // === Event Emission ===

  private emitAck(orderId: string, ownerId: string): void {
    this.events.push({ type: 'ACK', orderId, ownerId });
  }

  private emitReject(orderId: string, ownerId: string, reason: string): void {
    this.events.push({ type: 'REJECT', orderId, ownerId, reason });
  }

  private emitCanceled(orderId: string, ownerId: string): void {
    this.events.push({ type: 'CANCELED', orderId, ownerId });
  }

  private emitReduced(orderId: string, ownerId: string, delta: bigint, remain: bigint): void {
    this.events.push({ type: 'REDUCED', orderId, ownerId, delta, remain });
  }

  private emitTrade(price: bigint, qty: bigint, makerOwnerId: string, takerOwnerId: string, makerOrderId: string, takerOrderId: string): void {
    this.tradeCount++;
    this.tradeQtySum += qty;
    this.tradeNotionalSum += price * qty;

    this.events.push({
      type: 'TRADE',
      price,
      qty,
      makerOwnerId,
      takerOwnerId,
      makerOrderId,
      takerOrderId,
    });
  }
}
