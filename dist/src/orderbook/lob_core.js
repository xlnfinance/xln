/**
 * Limit Order Book Core (TypeScript, “readable bible” edition)
 * ------------------------------------------------------------
 * Single-threaded, in-memory LOB with:
 *  - Separated bid/ask structures, per-price FIFO queues
 *  - O(1) removal from a price level (doubly-linked lists)
 *  - SoA (struct-of-arrays) layout via typed arrays (cache-friendly)
 *  - Best bid/ask tracking via bitmaps + fast next/prev scan
 *  - STP policies (0: off, 1: cancel taker, 2: reduce maker)
 *  - TIF: GTC, IOC, FOK (FOK uses dry-run liquidity check)
 *  - Real egress events recorded to a ring buffer (for bench & ASCII)
 *  - Deterministic event hash for snapshots (eHash)
 *
 * This file focuses on clarity and explicitness. All branches are guarded,
 * inputs are validated, and invariants can be asserted in dev mode.
 */
import { createHash } from "crypto";
/* ================================
   Constants & Limits
   ================================ */
const EMPTY = -1;
const BITWORD = 32;
/** Hard caps to avoid 32-bit overflow / insane inputs */
const MAX_QTY = 0x3fff_ffff; // ~1e9 lots (fits into uint32 safely)
const MAX_PRICE = 0x1fff_ffff; // protection for price grid
/** Event ring size for recording real events (for bench/hash/snapshots) */
const EVT_RING_CAP = 1 << 17; // 131,072 events kept (ring)
/** Trade checksum rolling prime (fits in 53-bit BigInt window we use) */
const PRIME = 0x1000001n;
/* ================================
   Module State (Typed Arrays)
   ================================ */
/** Grid parameters */
let TICK = 1;
let PMIN = 0;
let PMAX = 1_000_000;
let LEVELS = 0;
let MAX_ORDERS = 1_000_000;
let STP_POLICY = 0;
/** Optional dev assertions (set via enableDevAsserts) */
let DEV_ASSERTS = false;
/** Per-order fields (SoA). Index is “slot index”, not external orderId. */
let orderPriceIdx; // price level index
let orderQtyLots; // remaining quantity
let orderOwner; // account id
let orderSideArr; // 0=buy, 1=sell
let orderPrev; // prev order on the same level
let orderNext; // next order on the same level
let orderActive; // 1 if active
let orderId2Idx; // external orderId -> slot index
let orderExtId; // store external orderId for events
/** Per-level queues for bids and asks */
let levelHeadBid;
let levelTailBid;
let bitmapBid; // bitset: non-empty price levels
let levelHeadAsk;
let levelTailAsk;
let bitmapAsk;
/** Best levels */
let bestBidIdx = EMPTY;
let bestAskIdx = EMPTY;
/** Free list of slots for O(1) allocations */
let freeTop = 0;
/** Accounting & deterministic checksums */
let evAck = 0;
let evTrade = 0;
let evFilled = 0;
let evReduced = 0;
let evCanceled = 0;
let evReject = 0;
let tradeQtySum = 0n;
let tradeNotionalTicksSum = 0n;
let tradeChecksum = 0n;
/** Real events ring and a deterministic event hash (eHash) */
const evT = new Uint8Array(EVT_RING_CAP); // 1=ACK,2=REJ,3=TRD,4=RED,5=CAN
const evA = new Int32Array(EVT_RING_CAP);
const evB = new Int32Array(EVT_RING_CAP);
const evC = new Int32Array(EVT_RING_CAP);
const evD = new Int32Array(EVT_RING_CAP);
let evWr = 0;
let eHash = 0n;
/* ================================
   Public Helpers
   ================================ */
export function enableDevAsserts(on) {
    DEV_ASSERTS = on;
}
export function getBestBidPx() {
    return bestBidIdx === EMPTY ? -1 : PMIN + bestBidIdx * TICK;
}
export function getBestAskPx() {
    return bestAskIdx === EMPTY ? -1 : PMIN + bestAskIdx * TICK;
}
export function getCounters() {
    return {
        evAck,
        evTrade,
        evFilled,
        evReduced,
        evCanceled,
        evReject,
        tradeQtySum,
        tradeNotionalTicksSum,
        tradeChecksum,
        eHash,
    };
}
/**
 * Drain events from ring [from, current). Used by bench to
 *  a) prove real work was done, b) print step-by-step in ASCII mode.
 */
export function drainEvents(from) {
    const end = evWr;
    const items = [];
    for (let x = from; x < end; x++) {
        const i = x & (EVT_RING_CAP - 1);
        const t = evT[i], a = evA[i], b = evB[i], c = evC[i], d = evD[i];
        if (t === 1)
            items.push({ k: "ACK", id: a, owner: b });
        else if (t === 2)
            items.push({ k: "REJECT", id: a, owner: b, reason: String(c) });
        else if (t === 3)
            items.push({ k: "TRADE", px: a, qty: b, makerOwner: c, takerOwner: d });
        else if (t === 4)
            items.push({ k: "REDUCED", id: a, owner: b, delta: c, remain: d });
        else if (t === 5)
            items.push({ k: "CANCELED", id: a, owner: b });
    }
    return { next: end, items };
}
/* ================================
   Initialization / Reset
   ================================ */
export function resetBook(p) {
    // Validate basic params
    if (!Number.isFinite(p.tick) || p.tick <= 0)
        throw new Error("tick must be >0");
    if (!Number.isFinite(p.pmin) || !Number.isFinite(p.pmax) || p.pmax < p.pmin) {
        throw new Error("invalid pmin/pmax");
    }
    const levelsFloat = (p.pmax - p.pmin) / p.tick;
    if (!Number.isFinite(levelsFloat) || levelsFloat < 0 || levelsFloat > MAX_PRICE) {
        throw new Error("price grid too large");
    }
    // Apply
    TICK = p.tick | 0;
    PMIN = p.pmin | 0;
    PMAX = p.pmax | 0;
    MAX_ORDERS = p.maxOrders | 0;
    STP_POLICY = p.stpPolicy;
    LEVELS = ((PMAX - PMIN) / TICK | 0) + 1;
    // Allocate typed arrays
    orderPriceIdx = new Int32Array(MAX_ORDERS).fill(EMPTY);
    orderQtyLots = new Uint32Array(MAX_ORDERS);
    orderOwner = new Uint32Array(MAX_ORDERS);
    orderSideArr = new Uint8Array(MAX_ORDERS);
    orderPrev = new Int32Array(MAX_ORDERS).fill(EMPTY);
    orderNext = new Int32Array(MAX_ORDERS).fill(EMPTY);
    orderActive = new Uint8Array(MAX_ORDERS);
    orderId2Idx = new Int32Array(MAX_ORDERS).fill(EMPTY);
    orderExtId = new Uint32Array(MAX_ORDERS);
    levelHeadBid = new Int32Array(LEVELS).fill(EMPTY);
    levelTailBid = new Int32Array(LEVELS).fill(EMPTY);
    bitmapBid = new Uint32Array(Math.ceil(LEVELS / BITWORD));
    levelHeadAsk = new Int32Array(LEVELS).fill(EMPTY);
    levelTailAsk = new Int32Array(LEVELS).fill(EMPTY);
    bitmapAsk = new Uint32Array(Math.ceil(LEVELS / BITWORD));
    bestBidIdx = EMPTY;
    bestAskIdx = EMPTY;
    // Initialize free list
    freeTop = 0;
    for (let i = 0; i < MAX_ORDERS - 1; i++)
        orderNext[i] = i + 1;
    orderNext[MAX_ORDERS - 1] = EMPTY;
    // Reset counters and event ring
    evAck = evTrade = evFilled = evReduced = evCanceled = evReject = 0;
    tradeQtySum = 0n;
    tradeNotionalTicksSum = 0n;
    tradeChecksum = 0n;
    evWr = 0;
    eHash = 0n;
}
/* ================================
   Bitset Helpers
   ================================ */
const ctz32 = (x) => (Math.clz32((x & -x) >>> 0) ^ 31);
/** Mark level as non-empty in appropriate bitmap. */
function setBit(isBid, levelIdx) {
    const bm = isBid ? bitmapBid : bitmapAsk;
    const w = (levelIdx / BITWORD) | 0;
    const b = levelIdx & 31;
    bm[w] |= (1 << b) >>> 0;
}
/** Mark level as empty in appropriate bitmap (bit cleared). */
function clearBit(isBid, levelIdx) {
    const bm = isBid ? bitmapBid : bitmapAsk;
    const w = (levelIdx / BITWORD) | 0;
    const b = levelIdx & 31;
    bm[w] &= (~(1 << b)) >>> 0;
}
/** Scan forward to the next non-empty level (ask-ascending or bid-ascending). */
function findNextNonEmptyFrom(isAsk, start) {
    const bm = isAsk ? bitmapAsk : bitmapBid;
    let i = start < 0 ? 0 : start;
    for (; i < LEVELS;) {
        const w = (i / BITWORD) | 0;
        const base = w * BITWORD;
        let word = bm[w];
        if (word) {
            const shift = i - base;
            word >>>= shift;
            if (word)
                return base + shift + ctz32(word);
        }
        i = base + BITWORD;
    }
    return EMPTY;
}
/** Scan backward to the previous non-empty level (bid-descending or ask-descending). */
function findPrevNonEmptyFrom(isBid, start) {
    const bm = isBid ? bitmapBid : bitmapAsk;
    let i = start >= LEVELS ? LEVELS - 1 : start;
    for (; i >= 0;) {
        const w = (i / BITWORD) | 0;
        const base = w * BITWORD;
        let word = bm[w];
        if (word) {
            const upto = i - base;
            const mask = upto === 31 ? 0xffffffff : ((1 << (upto + 1)) - 1);
            word &= mask >>> 0;
            if (word)
                return base + (31 - Math.clz32(word));
        }
        i = base - 1;
    }
    return EMPTY;
}
/* ================================
   Level Queue Ops (O(1))
   ================================ */
function enqueueTail(side, levelIdx, idx) {
    const head = side === 0 ? levelHeadBid : levelHeadAsk;
    const tail = side === 0 ? levelTailBid : levelTailAsk;
    if (head[levelIdx] === EMPTY) {
        head[levelIdx] = tail[levelIdx] = idx;
        orderPrev[idx] = EMPTY;
        orderNext[idx] = EMPTY;
        setBit(side === 0, levelIdx);
        if (side === 0) {
            if (bestBidIdx === EMPTY || levelIdx > bestBidIdx)
                bestBidIdx = levelIdx;
        }
        else {
            if (bestAskIdx === EMPTY || levelIdx < bestAskIdx)
                bestAskIdx = levelIdx;
        }
    }
    else {
        const t = tail[levelIdx];
        orderNext[t] = idx;
        orderPrev[idx] = t;
        orderNext[idx] = EMPTY;
        tail[levelIdx] = idx;
    }
}
function removeFromLevel(side, levelIdx, idx) {
    const head = side === 0 ? levelHeadBid : levelHeadAsk;
    const tail = side === 0 ? levelTailBid : levelTailAsk;
    const p = orderPrev[idx];
    const n = orderNext[idx];
    if (p !== EMPTY)
        orderNext[p] = n;
    else
        head[levelIdx] = n;
    if (n !== EMPTY)
        orderPrev[n] = p;
    else
        tail[levelIdx] = p;
    orderPrev[idx] = orderNext[idx] = EMPTY;
    if (head[levelIdx] === EMPTY) {
        clearBit(side === 0, levelIdx);
        if (side === 0 && bestBidIdx === levelIdx) {
            bestBidIdx = findPrevNonEmptyFrom(true, levelIdx - 1);
        }
        if (side === 1 && bestAskIdx === levelIdx) {
            bestAskIdx = findNextNonEmptyFrom(true, levelIdx + 1);
        }
    }
}
/* ================================
   Slot Alloc / Free (O(1))
   ================================ */
function allocOrder() {
    const i = freeTop;
    if (i === EMPTY)
        throw new Error("Out of order slots");
    freeTop = orderNext[i];
    return i;
}
function freeOrder(i) {
    // Zero out to avoid stale data being read in dev/debug.
    orderActive[i] = 0;
    orderOwner[i] = 0;
    orderSideArr[i] = 0;
    orderQtyLots[i] = 0;
    orderPriceIdx[i] = EMPTY;
    // Push back to freelist
    orderPrev[i] = EMPTY;
    orderNext[i] = freeTop;
    freeTop = i;
}
/* ================================
   Events / Accounting
   ================================ */
function evRecord(type, a, b, c, d) {
    const i = evWr & (EVT_RING_CAP - 1);
    evT[i] = type;
    evA[i] = a | 0;
    evB[i] = b | 0;
    evC[i] = c | 0;
    evD[i] = d | 0;
    evWr++;
    // Deterministic rolling hash of event stream
    const mix = (BigInt(type) << 48n)
        ^ (BigInt(a & 0xffff) << 32n)
        ^ (BigInt(b & 0xffff) << 16n)
        ^ BigInt((c ^ d) & 0xffff);
    eHash = ((eHash * 0x1000003n) ^ mix) & 0x1fffffffffffffn;
}
function emitACK(owner, id) {
    evAck++;
    evRecord(1, id, owner, 0, 0);
}
function emitREJECT(owner, id, _reason) {
    evReject++;
    evRecord(2, id, owner, 0, 0);
}
function emitCANCELED(owner, id) {
    evCanceled++;
    evRecord(5, id, owner, 0, 0);
}
function emitREDUCED(owner, id, delta, remain) {
    evReduced++;
    evRecord(4, id, owner, delta, remain);
}
function emitTRADE(px, qty, makerOwner, takerOwner) {
    evTrade++;
    tradeQtySum += BigInt(qty);
    tradeNotionalTicksSum += BigInt(px) * BigInt(qty);
    const mix = (BigInt((px << 16) ^ qty) & 0x1fffffffffffffn);
    tradeChecksum = ((tradeChecksum * PRIME) + mix) & 0x1fffffffffffffn;
    evRecord(3, px, qty, makerOwner, takerOwner);
}
function emitFILLED() {
    evFilled++;
}
/* ================================
   Validation Helpers
   ================================ */
function priceToLevelIdx(priceTicks) {
    return ((priceTicks - PMIN) / TICK) | 0;
}
function isFiniteInt(x) {
    return Number.isFinite(x) && Math.trunc(x) === x;
}
function isQtyOk(q) {
    return isFiniteInt(q) && q > 0 && q <= MAX_QTY;
}
function isPriceOk(p) {
    return isFiniteInt(p) && p >= PMIN && p <= PMAX;
}
function stp(makerOwner, takerOwner) {
    if (makerOwner !== takerOwner)
        return 0;
    if (STP_POLICY === 1)
        return 1; // cancel taker
    if (STP_POLICY === 2)
        return 2; // reduce maker
    return 0;
}
/**
 * FOK dry run: compute how much is fillable for taker up to limitLevel.
 * No mutations; only scans queues.
 */
function availableLiquidity(side, limitLevel, need) {
    let remaining = need | 0;
    if (side === 0) {
        // BUY consumes asks from bestAsk upwards to limitLevel
        let li = bestAskIdx;
        while (remaining > 0 && li !== EMPTY && li <= limitLevel) {
            let cur = levelHeadAsk[li];
            while (remaining > 0 && cur !== EMPTY) {
                const q = orderQtyLots[cur] | 0;
                remaining -= q <= remaining ? q : remaining;
                cur = orderNext[cur];
            }
            li = findNextNonEmptyFrom(true, li + 1);
        }
    }
    else {
        // SELL consumes bids from bestBid down to limitLevel
        let li = bestBidIdx;
        while (remaining > 0 && li !== EMPTY && li >= limitLevel) {
            let cur = levelHeadBid[li];
            while (remaining > 0 && cur !== EMPTY) {
                const q = orderQtyLots[cur] | 0;
                remaining -= q <= remaining ? q : remaining;
                cur = orderNext[cur];
            }
            li = findPrevNonEmptyFrom(true, li - 1);
        }
    }
    return need - Math.max(0, remaining);
}
/* ================================
   Matching Helpers
   ================================ */
function stpReduce(makerIdx, dec) {
    const makerOwner = orderOwner[makerIdx] | 0;
    const id = orderExtId[makerIdx] | 0;
    const q = orderQtyLots[makerIdx] | 0;
    const d = Math.min(q, dec | 0);
    orderQtyLots[makerIdx] = (q - d) >>> 0;
    emitREDUCED(makerOwner, id, -d, orderQtyLots[makerIdx] | 0);
    if (orderQtyLots[makerIdx] === 0) {
        const lvl = orderPriceIdx[makerIdx] | 0;
        const side = orderSideArr[makerIdx];
        removeFromLevel(side, lvl, makerIdx);
        freeOrder(makerIdx);
        emitFILLED();
    }
}
function fillAgainstBid(levelIdx, remaining, takerOwner, takerId) {
    while (remaining > 0) {
        const head = levelHeadBid[levelIdx];
        if (head === EMPTY)
            return remaining;
        if (!orderActive[head]) {
            removeFromLevel(0, levelIdx, head);
            freeOrder(head);
            continue;
        }
        const makerOwner = orderOwner[head] | 0;
        const s = stp(makerOwner, takerOwner);
        if (s === 1) {
            emitREJECT(takerOwner, takerId, "STP cancel taker");
            return remaining;
        }
        const makerQty = orderQtyLots[head] | 0;
        const pxTicks = PMIN + levelIdx * TICK;
        const tradeQty = makerQty < remaining ? makerQty : remaining;
        if (s === 2) {
            stpReduce(head, remaining);
            continue;
        }
        const newMakerQty = makerQty - tradeQty;
        orderQtyLots[head] = newMakerQty >>> 0;
        remaining -= tradeQty;
        emitTRADE(pxTicks, tradeQty, makerOwner, takerOwner);
        if (newMakerQty === 0) {
            removeFromLevel(0, levelIdx, head);
            freeOrder(head);
            emitFILLED();
        }
        else {
            emitREDUCED(makerOwner, orderExtId[head] | 0, -tradeQty, newMakerQty);
            break; // only head participates in this step (FIFO)
        }
    }
    return remaining;
}
function fillAgainstAsk(levelIdx, remaining, takerOwner, takerId) {
    while (remaining > 0) {
        const head = levelHeadAsk[levelIdx];
        if (head === EMPTY)
            return remaining;
        if (!orderActive[head]) {
            removeFromLevel(1, levelIdx, head);
            freeOrder(head);
            continue;
        }
        const makerOwner = orderOwner[head] | 0;
        const s = stp(makerOwner, takerOwner);
        if (s === 1) {
            emitREJECT(takerOwner, takerId, "STP cancel taker");
            return remaining;
        }
        const makerQty = orderQtyLots[head] | 0;
        const pxTicks = PMIN + levelIdx * TICK;
        const tradeQty = makerQty < remaining ? makerQty : remaining;
        if (s === 2) {
            stpReduce(head, remaining);
            continue;
        }
        const newMakerQty = makerQty - tradeQty;
        orderQtyLots[head] = newMakerQty >>> 0;
        remaining -= tradeQty;
        emitTRADE(pxTicks, tradeQty, makerOwner, takerOwner);
        if (newMakerQty === 0) {
            removeFromLevel(1, levelIdx, head);
            freeOrder(head);
            emitFILLED();
        }
        else {
            emitREDUCED(makerOwner, orderExtId[head] | 0, -tradeQty, newMakerQty);
            break; // FIFO
        }
    }
    return remaining;
}
/* ================================
   Public Core API
   ================================ */
export function newOrder(owner, orderId, side, priceTicks, qtyLots, tif = 0, postOnly = false, _reduceOnly = false) {
    // Input validation
    if (!isFiniteInt(owner)) {
        emitREJECT(owner, orderId, "bad owner");
        return;
    }
    if (!isFiniteInt(orderId)) {
        emitREJECT(owner, orderId, "bad id");
        return;
    }
    if (!isQtyOk(qtyLots)) {
        emitREJECT(owner, orderId, "qty bad");
        return;
    }
    if (!isPriceOk(priceTicks)) {
        emitREJECT(owner, orderId, "price bad");
        return;
    }
    if (orderId >= MAX_ORDERS) {
        emitREJECT(owner, orderId, "id too large");
        return;
    }
    if (orderId2Idx[orderId] !== EMPTY && orderActive[orderId2Idx[orderId]]) {
        emitREJECT(owner, orderId, "dup id");
        return;
    }
    const levelIdx = priceToLevelIdx(priceTicks);
    let remaining = qtyLots | 0;
    // FOK check (dry-run)
    if (tif === 2) {
        const fillable = availableLiquidity(side, levelIdx, remaining);
        if (fillable < remaining) {
            emitREJECT(owner, orderId, "FOK no fill");
            return;
        }
    }
    // Crossing phase
    if (side === 0) {
        if (postOnly && bestAskIdx !== EMPTY && bestAskIdx <= levelIdx) {
            emitREJECT(owner, orderId, "postOnly would cross");
            return;
        }
        while (remaining > 0 && bestAskIdx !== EMPTY && bestAskIdx <= levelIdx) {
            remaining = fillAgainstAsk(bestAskIdx, remaining, owner, orderId);
            if (bestAskIdx !== EMPTY && levelHeadAsk[bestAskIdx] === EMPTY) {
                bestAskIdx = findNextNonEmptyFrom(true, bestAskIdx + 1);
            }
        }
    }
    else {
        if (postOnly && bestBidIdx !== EMPTY && bestBidIdx >= levelIdx) {
            emitREJECT(owner, orderId, "postOnly would cross");
            return;
        }
        while (remaining > 0 && bestBidIdx !== EMPTY && bestBidIdx >= levelIdx) {
            remaining = fillAgainstBid(bestBidIdx, remaining, owner, orderId);
            if (bestBidIdx !== EMPTY && levelHeadBid[bestBidIdx] === EMPTY) {
                bestBidIdx = findPrevNonEmptyFrom(true, bestBidIdx - 1);
            }
        }
    }
    // Posting phase
    if (remaining > 0) {
        if (tif === 1) { // IOC
            if (qtyLots !== remaining)
                emitFILLED();
            else
                emitREJECT(owner, orderId, "IOC no fill");
            return;
        }
        const idx = allocOrder();
        orderPriceIdx[idx] = levelIdx;
        orderQtyLots[idx] = remaining >>> 0;
        orderOwner[idx] = owner >>> 0;
        orderSideArr[idx] = side;
        orderActive[idx] = 1;
        orderExtId[idx] = orderId >>> 0;
        enqueueTail(side, levelIdx, idx);
        orderId2Idx[orderId] = idx;
        emitACK(owner, orderId);
    }
    else {
        emitFILLED(); // fully executed while crossing
    }
}
export function cancel(owner, orderId) {
    if (!isFiniteInt(orderId) || orderId >= MAX_ORDERS) {
        emitREJECT(owner, orderId, "bad id");
        return;
    }
    const idx = orderId2Idx[orderId];
    if (idx === EMPTY || !orderActive[idx]) {
        emitREJECT(owner, orderId, "not found");
        return;
    }
    const lvl = orderPriceIdx[idx] | 0;
    const side = orderSideArr[idx];
    const o = orderOwner[idx] | 0;
    const id = orderExtId[idx] | 0;
    removeFromLevel(side, lvl, idx);
    freeOrder(idx);
    orderId2Idx[orderId] = EMPTY;
    emitCANCELED(o, id);
}
export function replace(owner, orderId, newPriceTicks, qtyDeltaLots) {
    if (!isFiniteInt(orderId) || orderId >= MAX_ORDERS) {
        emitREJECT(owner, orderId, "bad id");
        return;
    }
    const idx = orderId2Idx[orderId];
    if (idx === EMPTY || !orderActive[idx]) {
        emitREJECT(owner, orderId, "not found");
        return;
    }
    if (!Number.isFinite(qtyDeltaLots) || Math.trunc(qtyDeltaLots) !== qtyDeltaLots) {
        emitREJECT(owner, orderId, "bad delta");
        return;
    }
    const curQty = orderQtyLots[idx] | 0;
    let wantQty = curQty + (qtyDeltaLots | 0);
    if (wantQty < 0 || wantQty > MAX_QTY) {
        emitREJECT(owner, orderId, "qty overflow");
        return;
    }
    let targetLevelIdx = orderPriceIdx[idx] | 0;
    let changed = false;
    if (newPriceTicks !== null) {
        if (!isPriceOk(newPriceTicks)) {
            emitREJECT(owner, orderId, "price bad");
            return;
        }
        const li = priceToLevelIdx(newPriceTicks);
        if (li !== targetLevelIdx) {
            targetLevelIdx = li;
            changed = true;
        }
    }
    if (qtyDeltaLots > 0)
        changed = true;
    const side = orderSideArr[idx];
    if (wantQty === 0) {
        // Equivalent to cancel
        const o = orderOwner[idx] | 0;
        const id = orderExtId[idx] | 0;
        removeFromLevel(side, orderPriceIdx[idx] | 0, idx);
        freeOrder(idx);
        orderId2Idx[orderId] = EMPTY;
        emitCANCELED(o, id);
        return;
    }
    if (!changed) {
        // Only size-down or no-op: keep priority
        orderQtyLots[idx] = wantQty >>> 0;
        emitREDUCED(orderOwner[idx] | 0, orderExtId[idx] | 0, qtyDeltaLots | 0, wantQty | 0);
        return;
    }
    // Price change and/or size-up: lose priority → re-enqueue at tail
    removeFromLevel(side, orderPriceIdx[idx] | 0, idx);
    orderPriceIdx[idx] = targetLevelIdx;
    orderQtyLots[idx] = wantQty >>> 0;
    enqueueTail(side, targetLevelIdx, idx);
    emitACK(orderOwner[idx] | 0, orderExtId[idx] | 0);
}
/** Generic command router (useful when driving from a queue). */
export function applyCommand(c) {
    if (c.kind === 0) {
        newOrder(c.owner, c.orderId, c.side, c.priceTicks, c.qtyLots, c.tif, c.postOnly, c.reduceOnly);
    }
    else if (c.kind === 1) {
        cancel(c.owner, c.orderId);
    }
    else {
        replace(c.owner, c.orderId, c.newPriceTicks, c.qtyDeltaLots);
    }
}
/* ================================
   Snapshots & ASCII Rendering
   ================================ */
export function computeStateHash() {
    // Hash the raw arrays + counters for a deterministic snapshot hash
    const h = createHash("sha256");
    h.update(new Uint8Array(orderActive.buffer));
    h.update(new Uint8Array(orderPriceIdx.buffer));
    h.update(new Uint8Array(orderQtyLots.buffer));
    h.update(new Uint8Array(levelHeadBid.buffer));
    h.update(new Uint8Array(levelTailBid.buffer));
    h.update(new Uint8Array(bitmapBid.buffer));
    h.update(new Uint8Array(levelHeadAsk.buffer));
    h.update(new Uint8Array(levelTailAsk.buffer));
    h.update(new Uint8Array(bitmapAsk.buffer));
    const c = getCounters();
    h.update(Buffer.from(JSON.stringify({
        evAck: c.evAck,
        evTrade: c.evTrade,
        evFilled: c.evFilled,
        evReduced: c.evReduced,
        evCanceled: c.evCanceled,
        evReject: c.evReject,
        tQty: c.tradeQtySum.toString(),
        tNotional: c.tradeNotionalTicksSum.toString(),
        tChk: c.tradeChecksum.toString(),
        eHash: c.eHash.toString(),
    })));
    return h.digest("hex");
}
export function snapshotLine(seed, ops) {
    const rs = restingSummary();
    const c = getCounters();
    return [
        `seed:${seed}`,
        `ops:${ops}`,
        `ack:${c.evAck}`,
        `trade:${c.evTrade}`,
        `filled:${c.evFilled}`,
        `reduced:${c.evReduced}`,
        `canceled:${c.evCanceled}`,
        `reject:${c.evReject}`,
        `tQty:${c.tradeQtySum.toString()}`,
        `tNotional:${c.tradeNotionalTicksSum.toString()}`,
        `tChk:${c.tradeChecksum.toString()}`,
        `eHash:${c.eHash.toString()}`,
        `restCnt:${rs.restingCount}`,
        `restLots:${rs.restingLots}`,
        `bb:${rs.bestBidPx}`,
        `ba:${rs.bestAskPx}`,
    ].join("|");
}
export function restingSummary() {
    let restingCount = 0;
    let restingLots = 0n;
    for (let lvl = 0; lvl < LEVELS; lvl++) {
        let curB = levelHeadBid[lvl];
        while (curB !== EMPTY) {
            if (orderActive[curB]) {
                restingCount++;
                restingLots += BigInt(orderQtyLots[curB]);
            }
            curB = orderNext[curB];
        }
        let curA = levelHeadAsk[lvl];
        while (curA !== EMPTY) {
            if (orderActive[curA]) {
                restingCount++;
                restingLots += BigInt(orderQtyLots[curA]);
            }
            curA = orderNext[curA];
        }
    }
    return {
        restingCount,
        restingLots: restingLots.toString(),
        bestBidPx: getBestBidPx(),
        bestAskPx: getBestAskPx(),
    };
}
/**
 * ASCII snapshot of the top-of-book (depth rows),
 * with per-level individual orders listed as "qty@owner,qty@owner,...".
 */
export function renderAscii(depth = 10, perLevelOrders = 10, lineWidth = 54) {
    const rows = [];
    const BOLD = "\x1b[1m", DIM = "\x1b[2m", RESET = "\x1b[0m";
    const GREEN = "\x1b[32m", RED = "\x1b[31m";
    const pad = (s, n) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
    const wrapList = (s, width) => {
        if (s.length <= width)
            return [s];
        const out = [];
        let i = 0;
        while (i < s.length) {
            out.push(s.slice(i, i + width));
            i += width;
        }
        return out;
    };
    // collect bids (desc)
    const bids = [];
    {
        let idx = bestBidIdx;
        while (idx !== EMPTY && bids.length < depth) {
            let cur = levelHeadBid[idx];
            const parts = [];
            let count = 0;
            while (cur !== EMPTY && count < perLevelOrders) {
                if (orderActive[cur]) {
                    parts.push(`${orderQtyLots[cur]}@${orderOwner[cur]}`);
                    count++;
                }
                cur = orderNext[cur];
            }
            if (parts.length)
                bids.push({ px: PMIN + idx * TICK, lines: wrapList(parts.join(","), lineWidth) });
            idx = findPrevNonEmptyFrom(true, idx - 1);
        }
    }
    // collect asks (asc)
    const asks = [];
    {
        let idx = bestAskIdx;
        while (idx !== EMPTY && asks.length < depth) {
            let cur = levelHeadAsk[idx];
            const parts = [];
            let count = 0;
            while (cur !== EMPTY && count < perLevelOrders) {
                if (orderActive[cur]) {
                    parts.push(`${orderQtyLots[cur]}@${orderOwner[cur]}`);
                    count++;
                }
                cur = orderNext[cur];
            }
            if (parts.length)
                asks.push({ px: PMIN + idx * TICK, lines: wrapList(parts.join(","), lineWidth) });
            idx = findNextNonEmptyFrom(true, idx + 1);
        }
    }
    const widthPx = 8;
    rows.push(`${BOLD}        BID (qty@owner)             |            ASK (qty@owner)      ${RESET}`);
    rows.push(`${DIM}     PX         ORDERS              |        PX         ORDERS        ${RESET}`);
    for (let i = 0; i < depth; i++) {
        const b = bids[i];
        const a = asks[i];
        const maxLines = Math.max(b?.lines.length ?? 0, a?.lines.length ?? 0) || 1;
        for (let k = 0; k < maxLines; k++) {
            const bPx = k === 0 && b ? pad(String(b.px), widthPx) : " ".repeat(widthPx);
            const aPx = k === 0 && a ? pad(String(a.px), widthPx) : " ".repeat(widthPx);
            const bTxt = b && b.lines[k] ? b.lines[k] : "";
            const aTxt = a && a.lines[k] ? a.lines[k] : "";
            const L = `${bPx} ${pad(bTxt, lineWidth)}`;
            const R = `${aPx} ${pad(aTxt, lineWidth)}`;
            rows.push(`${GREEN}${L}${RESET} | ${RED}${R}${RESET}`);
        }
    }
    return rows.join("\n");
}
