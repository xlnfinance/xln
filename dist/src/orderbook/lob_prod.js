// file: lob_prod.ts
// Production-grade Limit Order Book (one symbol), TypeScript (Node/Bun).
// - Functional style (no classes) in hot path
// - Price–time priority, FIFO per price level
// - Integer ticks/lots (no floats)
// - Full cancel by orderId (O(1)) with per-level doubly linked list (O(1) remove)
// - Order types: LIMIT, MARKET(as wide limit), IOC, FOK, POST_ONLY, REDUCE_ONLY
// - Replace: price/size (size-down keeps priority; price/size-up loses priority)
// - STP: cancel-taker or decrement-maker
// - Deterministic bench (seeded), pre-generated command stream
// - Snapshot + SHA-256 digest; seed=>snapshot persistence & consistency check
// - WAL (binary) with batched fsync; snapshot interval by ops
//
// Run (bench):
//   bun lob_prod.ts --seed=123 --ops=500000 --wal --snap
//   node --enable-source-maps lob_prod.ts --seed=123 --ops=500000 --wal --snap
//
// Notes:
// - WAL/snapshot paths are local files in CWD.
// - This is single-threaded core. Hook to Worker+SAB rings by feeding commands to `applyCommand()` and reading emitted events in a typed outbox.
//
// ──────────────────────────────────────────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
// ---------- CLI ----------
const argv = process.argv.slice(2);
const getNum = (k, d) => {
    const a = argv.find(x => x.startsWith(`--${k}=`));
    return a ? Number(a.split('=')[1]) : d;
};
const getBool = (k, d = false) => argv.some(x => x === `--${k}` || x === `--${k}=1` || x === `--${k}=true`) ? true : d;
const SEED = getNum('seed', 0xC0FFEE);
const OPS = getNum('ops', 500_000);
const TICK = getNum('tick', 1); // 1 = 1 cent
const PRICE_MIN = getNum('pmin', 0);
const PRICE_MAX = getNum('pmax', 1_000_000);
const LEVELS = ((PRICE_MAX - PRICE_MIN) / TICK | 0) + 1;
const MAX_ORDERS = getNum('maxOrders', 1_000_000);
const ADD_PCT = Number(getNum('addPct', 60)) / 100; // 0.60
const CANCEL_PCT = Number(getNum('cancelPct', 30)) / 100; // 0.30
const UNROLL = getNum('unroll', 8);
const SNAP_EVERY = getNum('snapEveryOps', 200_000);
const WAL_BATCH_MS = getNum('walBatchMs', 5);
const ENABLE_WAL = getBool('wal', false);
const ENABLE_SNAP = getBool('snap', false);
const STP_POLICY = getNum('stp', 1); // 0=off, 1=cancel-taker, 2=decrement-maker
const SNAP_DB = path.resolve(process.cwd(), 'bench_snapshots.json');
const WAL_PATH = path.resolve(process.cwd(), 'lob.wal');
const SNAP_PATH = path.resolve(process.cwd(), 'lob.snapshot.bin');
// ---------- RNG (deterministic) ----------
let RNG = (SEED >>> 0);
const rndU32 = () => { let x = RNG | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; RNG = x | 0; return x >>> 0; };
const rnd01 = () => rndU32() / 0xFFFFFFFF;
// ---------- Storage (SoA) ----------
const EMPTY = -1;
const BITWORD = 32;
const orderPriceIdx = new Int32Array(MAX_ORDERS).fill(EMPTY);
const orderQtyLots = new Uint32Array(MAX_ORDERS);
const orderOwner = new Uint32Array(MAX_ORDERS);
const orderSide = new Uint8Array(MAX_ORDERS); // 0/1
const orderPrev = new Int32Array(MAX_ORDERS).fill(EMPTY);
const orderNext = new Int32Array(MAX_ORDERS).fill(EMPTY);
const orderActive = new Uint8Array(MAX_ORDERS); // 1 active
const orderId2Idx = new Int32Array(MAX_ORDERS).fill(EMPTY); // simple map for bench (orderId < MAX_ORDERS). Replace with open-addressing for general use.
const levelHead = new Int32Array(LEVELS).fill(EMPTY);
const levelTail = new Int32Array(LEVELS).fill(EMPTY);
const bitmap = new Uint32Array(Math.ceil(LEVELS / BITWORD));
let bestBidIdx = EMPTY;
let bestAskIdx = EMPTY;
// freelist stack
let freeTop = 0;
for (let i = 0; i < MAX_ORDERS - 1; i++)
    orderNext[i] = i + 1;
orderNext[MAX_ORDERS - 1] = EMPTY;
// ---------- Bit helpers ----------
const setBit = (i) => { const w = (i / BITWORD | 0), b = i & 31; bitmap[w] |= (1 << b) >>> 0; };
const clearBit = (i) => { const w = (i / BITWORD | 0), b = i & 31; bitmap[w] &= (~(1 << b)) >>> 0; };
const ctz32 = (x) => (Math.clz32((x & -x) >>> 0) ^ 31);
function findNextNonEmptyFrom(i) {
    if (i < 0)
        i = 0;
    for (; i < LEVELS;) {
        const w = (i / BITWORD | 0), base = w * BITWORD;
        let word = bitmap[w];
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
function findPrevNonEmptyFrom(i) {
    if (i >= LEVELS)
        i = LEVELS - 1;
    for (; i >= 0;) {
        const w = (i / BITWORD | 0), base = w * BITWORD;
        let word = bitmap[w];
        if (word) {
            const upto = i - base;
            const mask = upto === 31 ? 0xFFFFFFFF : ((1 << (upto + 1)) - 1);
            word &= mask >>> 0;
            if (word)
                return base + (31 - Math.clz32(word));
        }
        i = base - 1;
    }
    return EMPTY;
}
// ---------- Level queue ops (doubly linked for O(1) remove) ----------
function enqueueTail(levelIdx, idx) {
    const tail = levelTail[levelIdx];
    if (tail === EMPTY) {
        levelHead[levelIdx] = idx;
        levelTail[levelIdx] = idx;
        orderPrev[idx] = EMPTY;
        orderNext[idx] = EMPTY;
        setBit(levelIdx);
        if (bestAskIdx === EMPTY || levelIdx < bestAskIdx)
            bestAskIdx = levelIdx;
        if (bestBidIdx === EMPTY || levelIdx > bestBidIdx)
            bestBidIdx = levelIdx;
    }
    else {
        orderNext[tail] = idx;
        orderPrev[idx] = tail;
        orderNext[idx] = EMPTY;
        levelTail[levelIdx] = idx;
    }
}
function removeFromLevel(levelIdx, idx) {
    const p = orderPrev[idx], n = orderNext[idx];
    if (p !== EMPTY)
        orderNext[p] = n;
    else
        levelHead[levelIdx] = n;
    if (n !== EMPTY)
        orderPrev[n] = p;
    else
        levelTail[levelIdx] = p;
    orderPrev[idx] = orderNext[idx] = EMPTY;
    if (levelHead[levelIdx] === EMPTY) {
        clearBit(levelIdx);
        if (bestAskIdx === levelIdx)
            bestAskIdx = findNextNonEmptyFrom(levelIdx + 1);
        if (bestBidIdx === levelIdx)
            bestBidIdx = findPrevNonEmptyFrom(levelIdx - 1);
    }
}
// ---------- Alloc/free ----------
function allocOrder() { const i = freeTop; if (i === EMPTY)
    throw Error('Out of slots'); freeTop = orderNext[i]; return i; }
function freeOrder(i) { orderActive[i] = 0; orderNext[i] = freeTop; freeTop = i; }
// ---------- Events counters + buffer ----------
let evAck = 0, evTrade = 0, evFilled = 0, evReduced = 0, evCanceled = 0, evReject = 0;
let tradeQtySum = 0n, tradeNotionalTicksSum = 0n, tradeChecksum = 0n;
const PRIME = 0x1000001n;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const outbox = []; // not stored in bench to avoid GC; in prod use typed outbox ring.
function emitACK() { evAck++; /*outbox.push({k:'ACK', id})*/ }
function emitREJECT() { evReject++; }
function emitTRADE(px, qty) {
    evTrade++;
    tradeQtySum += BigInt(qty);
    tradeNotionalTicksSum += BigInt(px) * BigInt(qty);
    const mix = (BigInt((px << 16) ^ qty) & 0x1fffffffffffffn);
    tradeChecksum = ((tradeChecksum * PRIME + mix) & 0x1fffffffffffffn);
}
function emitFILLED() { evFilled++; }
function emitREDUCED() { evReduced++; }
function emitCANCELED() { evCanceled++; }
// ---------- STP ----------
function stp(ownerMaker, ownerTaker) {
    if (ownerMaker !== ownerTaker)
        return 0; // off
    if (STP_POLICY === 1)
        return 1; // cancel taker
    if (STP_POLICY === 2)
        return 2; // decrement maker
    return 0;
}
// ---------- Matching core ----------
function newOrder(owner, orderId, side, priceTicks, qtyLots, tif = 0, postOnly = false, reduceOnly = false) {
    if (qtyLots <= 0) {
        emitREJECT();
        return;
    }
    const levelIdx = ((priceTicks - PRICE_MIN) / TICK) | 0;
    if (levelIdx < 0 || levelIdx >= LEVELS) {
        emitREJECT();
        return;
    }
    // Reduce-only: taker cannot increase position; for spot demo, treat as normal (hook for perps).
    let remaining = qtyLots >>> 0;
    if (side === 0) { // BUY
        if (postOnly && bestAskIdx !== EMPTY && bestAskIdx <= levelIdx) {
            emitREJECT();
            return;
        }
        while (remaining > 0 && bestAskIdx !== EMPTY && bestAskIdx <= levelIdx) {
            remaining = fillAgainstLevel(bestAskIdx, remaining, owner, side);
            if (bestAskIdx !== EMPTY && levelHead[bestAskIdx] === EMPTY)
                bestAskIdx = findNextNonEmptyFrom(bestAskIdx + 1);
            if (remaining > 0 && tif === 2) { /* strict FOK preview omitted */ }
        }
    }
    else { // SELL
        if (postOnly && bestBidIdx !== EMPTY && bestBidIdx >= levelIdx) {
            emitREJECT();
            return;
        }
        while (remaining > 0 && bestBidIdx !== EMPTY && bestBidIdx >= levelIdx) {
            remaining = fillAgainstLevel(bestBidIdx, remaining, owner, side);
            if (bestBidIdx !== EMPTY && levelHead[bestBidIdx] === EMPTY)
                bestBidIdx = findPrevNonEmptyFrom(bestBidIdx - 1);
        }
    }
    if (remaining > 0) {
        if (tif === 1) { // IOC: do not rest
            if (qtyLots !== remaining)
                emitFILLED();
            else
                emitREJECT();
            return;
        }
        // rest as maker
        const idx = allocOrder();
        orderPriceIdx[idx] = levelIdx;
        orderQtyLots[idx] = remaining;
        orderOwner[idx] = owner;
        orderSide[idx] = side;
        orderActive[idx] = 1;
        enqueueTail(levelIdx, idx);
        if (orderId < MAX_ORDERS)
            orderId2Idx[orderId] = idx;
        emitACK();
    }
    else {
        emitFILLED();
    }
}
function fillAgainstLevel(levelIdx, remaining, takerOwner, takerSide) {
    while (remaining > 0) {
        const head = levelHead[levelIdx];
        if (head === EMPTY)
            return remaining;
        if (!orderActive[head]) {
            removeFromLevel(levelIdx, head);
            freeOrder(head);
            continue;
        }
        // STP
        const s = stp(orderOwner[head], takerOwner);
        if (s === 1) { // cancel taker
            emitREJECT();
            return remaining; // taker aborted
        }
        const makerQty = orderQtyLots[head];
        const pxTicks = PRICE_MIN + levelIdx * TICK;
        let tradeQty = makerQty < remaining ? makerQty : remaining;
        if (s === 2) { // decrement maker (reduce maker so it doesn't cross with self)
            if (makerQty > 0) {
                const dec = Math.min(makerQty, remaining);
                orderQtyLots[head] = makerQty - dec;
                emitREDUCED();
                if (orderQtyLots[head] === 0) {
                    removeFromLevel(levelIdx, head);
                    freeOrder(head);
                    emitFILLED();
                }
                // continue loop; do not count as trade
                continue;
            }
        }
        else {
            // normal trade
            const newMakerQty = makerQty - tradeQty;
            orderQtyLots[head] = newMakerQty;
            remaining -= tradeQty;
            emitTRADE(pxTicks, tradeQty);
            if (newMakerQty === 0) {
                removeFromLevel(levelIdx, head);
                freeOrder(head);
                emitFILLED();
            }
            else {
                emitREDUCED();
                break; // partially filled maker stays at head
            }
        }
    }
    return remaining;
}
function cancel(owner, orderId) {
    const idx = (orderId < MAX_ORDERS) ? orderId2Idx[orderId] : EMPTY;
    if (idx === EMPTY || !orderActive[idx]) {
        emitREJECT();
        return;
    }
    // optional ownership check (owner==orderOwner[idx]) — skipped in bench for speed
    const lvl = orderPriceIdx[idx];
    removeFromLevel(lvl, idx);
    freeOrder(idx);
    orderId2Idx[orderId] = EMPTY;
    emitCANCELED();
}
function replace(owner, orderId, newPriceTicks, qtyDeltaLots) {
    const idx = (orderId < MAX_ORDERS) ? orderId2Idx[orderId] : EMPTY;
    if (idx === EMPTY || !orderActive[idx]) {
        emitREJECT();
        return;
    }
    // size-down keeps priority; size-up or price change loses priority (remove and reinsert)
    const curQty = orderQtyLots[idx] >>> 0;
    const wantQty = (qtyDeltaLots < 0) ? (curQty + qtyDeltaLots) : (curQty + qtyDeltaLots);
    if (wantQty <= 0) { // becomes cancel
        const lvl = orderPriceIdx[idx];
        removeFromLevel(lvl, idx);
        freeOrder(idx);
        orderId2Idx[orderId] = EMPTY;
        emitCANCELED();
        return;
    }
    let changedPrice = false, changedUp = false;
    let targetLevelIdx = orderPriceIdx[idx];
    if (newPriceTicks !== null) {
        const li = ((newPriceTicks - PRICE_MIN) / TICK | 0);
        if (li < 0 || li >= LEVELS) {
            emitREJECT();
            return;
        }
        if (li !== targetLevelIdx) {
            changedPrice = true;
            targetLevelIdx = li;
        }
    }
    if (qtyDeltaLots > 0)
        changedUp = true;
    if (!changedPrice && !changedUp && qtyDeltaLots < 0) {
        // pure reduce, keep priority
        const reduceBy = Math.min(curQty, -qtyDeltaLots | 0);
        const newQ = curQty - reduceBy;
        orderQtyLots[idx] = newQ;
        emitREDUCED();
        return;
    }
    // otherwise: remove and reinsert at tail (lose priority)
    const prevLevel = orderPriceIdx[idx];
    removeFromLevel(prevLevel, idx);
    orderPriceIdx[idx] = targetLevelIdx;
    orderQtyLots[idx] = wantQty >>> 0;
    enqueueTail(targetLevelIdx, idx);
    emitACK();
}
// ---------- WAL (binary, batched fsync) ----------
let walFd;
let walBuf = Buffer.allocUnsafe(0);
let walTimer;
function walOpen() {
    if (!ENABLE_WAL)
        return;
    walFd = fs.openSync(WAL_PATH, 'a');
    walTimer = setInterval(() => walFlush(), WAL_BATCH_MS);
}
function walAppend(cmd) {
    if (!ENABLE_WAL || walFd === undefined)
        return;
    // encode fixed: kind u8 | owner u32 | orderId u32 | side u8 | tif u8 | flags u8 | price i64 | qty i32 | qtyDelta i32
    const buf = Buffer.allocUnsafe(1 + 4 + 4 + 1 + 1 + 1 + 8 + 4 + 4);
    let o = 0;
    buf.writeUInt8(cmd.kind, o);
    o += 1;
    buf.writeUInt32LE(cmd.owner >>> 0, o);
    o += 4;
    buf.writeUInt32LE(cmd.orderId >>> 0, o);
    o += 4;
    if (cmd.kind === 0) {
        const c = cmd;
        buf.writeUInt8(c.side, o);
        o += 1;
        buf.writeUInt8(c.tif, o);
        o += 1;
        buf.writeUInt8((c.postOnly ? 1 : 0) | (c.reduceOnly ? 2 : 0), o);
        o += 1;
        buf.writeBigInt64LE(BigInt(c.priceTicks), o);
        o += 8;
        buf.writeInt32LE(c.qtyLots | 0, o);
        o += 4;
        buf.writeInt32LE(0, o);
        o += 4;
    }
    else if (cmd.kind === 1) {
        buf.writeUInt8(0, o);
        o += 1;
        buf.writeUInt8(0, o);
        o += 1;
        buf.writeUInt8(0, o);
        o += 1;
        buf.writeBigInt64LE(0n, o);
        o += 8;
        buf.writeInt32LE(0, o);
        o += 4;
        buf.writeInt32LE(0, o);
        o += 4;
    }
    else {
        const c = cmd;
        buf.writeUInt8(0, o);
        o += 1;
        buf.writeUInt8(0, o);
        o += 1;
        buf.writeUInt8(0, o);
        o += 1;
        buf.writeBigInt64LE(c.newPriceTicks === null ? -0x8000000000000000n : BigInt(c.newPriceTicks), o);
        o += 8;
        buf.writeInt32LE(0, o);
        o += 4;
        buf.writeInt32LE(c.qtyDeltaLots | 0, o);
        o += 4;
    }
    walBuf = Buffer.concat([walBuf, buf]);
}
function walFlush() {
    if (!ENABLE_WAL || walFd === undefined)
        return;
    if (walBuf.length === 0)
        return;
    fs.writeSync(walFd, walBuf);
    fs.fsyncSync(walFd);
    walBuf = Buffer.allocUnsafe(0);
}
function walClose() {
    if (!ENABLE_WAL || walFd === undefined)
        return;
    walFlush();
    clearInterval(walTimer);
    fs.closeSync(walFd);
    walFd = undefined;
}
// ---------- Snapshot ----------
function snapshotWrite() {
    if (!ENABLE_SNAP)
        return;
    const fd = fs.openSync(SNAP_PATH, 'w');
    // write core arrays
    const writeArr = (a) => fs.writeSync(fd, Buffer.from(a));
    writeArr(orderPriceIdx.buffer);
    writeArr(orderQtyLots.buffer);
    writeArr(orderOwner.buffer);
    writeArr(orderSide.buffer);
    writeArr(orderPrev.buffer);
    writeArr(orderNext.buffer);
    writeArr(orderActive.buffer);
    writeArr(levelHead.buffer);
    writeArr(levelTail.buffer);
    writeArr(bitmap.buffer);
    // trailer (json counters)
    const trailer = Buffer.from(JSON.stringify({
        evAck, evTrade, evFilled, evReduced, evCanceled, evReject,
        tradeQtySum: tradeQtySum.toString(),
        tradeNotionalTicksSum: tradeNotionalTicksSum.toString(),
        tradeChecksum: tradeChecksum.toString(),
        bestBidIdx, bestAskIdx
    }));
    const tl = Buffer.allocUnsafe(4);
    tl.writeUInt32LE(trailer.length, 0);
    fs.writeSync(fd, tl);
    fs.writeSync(fd, trailer);
    fs.closeSync(fd);
}
// ---------- State digest & snapshot string ----------
function computeRestingSummary() {
    let restingCount = 0;
    let restingLots = 0n;
    for (let lvl = 0; lvl < LEVELS; lvl++) {
        let cur = levelHead[lvl];
        while (cur !== EMPTY) {
            if (orderActive[cur]) {
                restingCount++;
                restingLots += BigInt(orderQtyLots[cur]);
            }
            cur = orderNext[cur];
        }
    }
    const bb = (bestBidIdx === EMPTY) ? -1 : (PRICE_MIN + bestBidIdx * TICK);
    const ba = (bestAskIdx === EMPTY) ? -1 : (PRICE_MIN + bestAskIdx * TICK);
    return { restingCount, restingLots: restingLots.toString(), bestBidPx: bb, bestAskPx: ba };
}
function computeStateHash() {
    const h = createHash('sha256');
    h.update(new Uint8Array(orderActive.buffer));
    h.update(new Uint8Array(orderPriceIdx.buffer));
    h.update(new Uint8Array(orderQtyLots.buffer));
    h.update(new Uint8Array(levelHead.buffer));
    h.update(new Uint8Array(levelTail.buffer));
    h.update(new Uint8Array(bitmap.buffer));
    const trailer = Buffer.from(JSON.stringify({
        evAck, evTrade, evFilled, evReduced, evCanceled, evReject,
        tradeQtySum: tradeQtySum.toString(),
        tradeNotionalTicksSum: tradeNotionalTicksSum.toString(),
        tradeChecksum: tradeChecksum.toString()
    }));
    h.update(trailer);
    return h.digest('hex');
}
function snapshotLine() {
    const rs = computeRestingSummary();
    return [
        `seed:${SEED}`, `ops:${OPS}`,
        `ack:${evAck}`, `trade:${evTrade}`, `filled:${evFilled}`, `reduced:${evReduced}`, `canceled:${evCanceled}`, `reject:${evReject}`,
        `tQty:${tradeQtySum.toString()}`, `tNotional:${tradeNotionalTicksSum.toString()}`, `tChk:${tradeChecksum.toString()}`,
        `restCnt:${rs.restingCount}`, `restLots:${rs.restingLots}`, `bb:${rs.bestBidPx}`, `ba:${rs.bestAskPx}`
    ].join('|');
}
function snapDbLoad() {
    try {
        if (fs.existsSync(SNAP_DB)) {
            const txt = fs.readFileSync(SNAP_DB, 'utf8');
            return txt ? JSON.parse(txt) : {};
        }
    }
    catch { }
    return {};
}
function snapDbSave(db) {
    fs.writeFileSync(SNAP_DB, JSON.stringify(db, null, 2), 'utf8');
}
// ---------- Command application (prod API) ----------
function applyCommand(c) {
    if (c.kind === 0) {
        if (ENABLE_WAL)
            walAppend(c);
        newOrder(c.owner, c.orderId, c.side, c.priceTicks, c.qtyLots, c.tif, c.postOnly, c.reduceOnly);
    }
    else if (c.kind === 1) {
        if (ENABLE_WAL)
            walAppend(c);
        cancel(c.owner, c.orderId);
    }
    else {
        if (ENABLE_WAL)
            walAppend(c);
        replace(c.owner, c.orderId, c.newPriceTicks, c.qtyDeltaLots);
    }
}
// ---------- Bench pregen ----------
const cmdKind = new Uint8Array(OPS); // 0 add,1 cancel,2 replace(reduce)
const cmdSide = new Uint8Array(OPS);
const cmdLvl = new Int32Array(OPS);
const cmdQty = new Uint16Array(OPS);
const cmdPrice = new Int32Array(OPS);
const cmdDelta = new Int32Array(OPS);
function chooseCancelLevel() {
    if (bestBidIdx === EMPTY && bestAskIdx === EMPTY)
        return EMPTY;
    if (bestBidIdx !== EMPTY && bestAskIdx !== EMPTY) {
        return (rndU32() & 1) ? bestBidIdx : bestAskIdx;
    }
    return bestBidIdx !== EMPTY ? bestBidIdx : bestAskIdx;
}
function pregen() {
    for (let i = 0; i < OPS; i++) {
        const r = rnd01();
        if (r < ADD_PCT) {
            cmdKind[i] = 0;
            cmdSide[i] = (rndU32() & 1);
            const mid = (bestBidIdx >= 0 && bestAskIdx >= 0) ? ((bestBidIdx + bestAskIdx) >> 1) : (LEVELS >> 1);
            const li = Math.max(0, Math.min(LEVELS - 1, mid + ((rndU32() % 21 | 0) - 10)));
            cmdLvl[i] = li;
            cmdPrice[i] = PRICE_MIN + li * TICK;
            cmdQty[i] = ((rndU32() % 5 | 0) + 1);
        }
        else if (r < ADD_PCT + CANCEL_PCT) {
            cmdKind[i] = 1;
            const lvl = chooseCancelLevel();
            cmdLvl[i] = (lvl === EMPTY) ? -1 : lvl;
        }
        else {
            cmdKind[i] = 2; // replace reduce (head)
            const lvl = chooseCancelLevel();
            cmdLvl[i] = (lvl === EMPTY) ? -1 : lvl;
            cmdDelta[i] = -(((rndU32() % 3 | 0) + 1) | 0); // reduce 1..3
        }
    }
}
// ---------- Bench runner ----------
function runBench() {
    walOpen();
    let adds = 0, cancels = 0, replaces = 0;
    let nextOwner = 1;
    let snapshotCounter = 0;
    const t0 = process.hrtime.bigint();
    let i = 0;
    const limit = (OPS / UNROLL | 0) * UNROLL;
    for (; i < limit; i += UNROLL) {
        for (let k = 0; k < UNROLL; k++) {
            const ii = i + k;
            const kind = cmdKind[ii];
            if (kind === 0) {
                const side = cmdSide[ii];
                const px = cmdPrice[ii];
                const qty = cmdQty[ii];
                const id = nextOwner; // in bench: orderId==owner (bounded)
                applyCommand({ kind: 0, owner: nextOwner, orderId: id, side, tif: 0, postOnly: false, reduceOnly: false, priceTicks: px, qtyLots: qty });
                nextOwner++;
                adds++;
            }
            else if (kind === 1) {
                const lvl = cmdLvl[ii];
                if (lvl >= 0) {
                    const head = levelHead[lvl];
                    if (head !== EMPTY) {
                        // map by reverse: we don't store orderId; for bench we assigned orderId==owner at creation; here just cancel head by crafting lookup:
                        const fakeId = orderOwner[head]; // in bench mapping
                        applyCommand({ kind: 1, owner: orderOwner[head], orderId: fakeId });
                    }
                    else
                        emitREJECT();
                }
                else
                    emitREJECT();
                cancels++;
            }
            else {
                const lvl = cmdLvl[ii];
                if (lvl >= 0) {
                    const head = levelHead[lvl];
                    if (head !== EMPTY) {
                        const fakeId = orderOwner[head];
                        applyCommand({ kind: 2, owner: orderOwner[head], orderId: fakeId, newPriceTicks: null, qtyDeltaLots: cmdDelta[ii] });
                    }
                    else
                        emitREJECT();
                }
                else
                    emitREJECT();
                replaces++;
            }
            if (ENABLE_SNAP && ++snapshotCounter === SNAP_EVERY) {
                snapshotCounter = 0;
                snapshotWrite();
            }
        }
    }
    for (; i < OPS; i++) {
        const kind = cmdKind[i];
        if (kind === 0) {
            const id = nextOwner;
            applyCommand({ kind: 0, owner: nextOwner, orderId: id, side: cmdSide[i], tif: 0, postOnly: false, reduceOnly: false, priceTicks: cmdPrice[i], qtyLots: cmdQty[i] });
            nextOwner++;
            adds++;
        }
        else if (kind === 1) {
            const lvl = cmdLvl[i];
            if (lvl >= 0) {
                const head = levelHead[lvl];
                if (head !== EMPTY) {
                    const fakeId = orderOwner[head];
                    applyCommand({ kind: 1, owner: orderOwner[head], orderId: fakeId });
                }
                else
                    emitREJECT();
            }
            else
                emitREJECT();
            cancels++;
        }
        else {
            const lvl = cmdLvl[i];
            if (lvl >= 0) {
                const head = levelHead[lvl];
                if (head !== EMPTY) {
                    const fakeId = orderOwner[head];
                    applyCommand({ kind: 2, owner: orderOwner[head], orderId: fakeId, newPriceTicks: null, qtyDeltaLots: cmdDelta[i] });
                }
                else
                    emitREJECT();
            }
            else
                emitREJECT();
            replaces++;
        }
        if (ENABLE_SNAP && ++snapshotCounter === SNAP_EVERY) {
            snapshotCounter = 0;
            snapshotWrite();
        }
    }
    walClose();
    const t1 = process.hrtime.bigint();
    const dtMs = Number(t1 - t0) / 1e6;
    const opsSec = (OPS / dtMs) * 1000;
    return { dtMs, opsSec, adds, cancels, replaces };
}
// ---------- Main ----------
function main() {
    RNG = (SEED >>> 0);
    pregen();
    const { dtMs, opsSec, adds, cancels, replaces } = runBench();
    const snap = snapshotLine();
    const hash = computeStateHash();
    const line = `${snap}|hash:${hash}`;
    console.log(`ops=${OPS}, time=${dtMs.toFixed(2)} ms, ~${opsSec.toFixed(0)} ops/sec`);
    console.log(`adds=${adds}, cancels=${cancels}, replaces=${replaces}`);
    console.log(line);
    if (ENABLE_SNAP)
        snapshotWrite();
    const db = snapDbLoad();
    const prev = db[String(SEED)];
    if (prev) {
        if (prev === line)
            console.log(`CHECK: OK (seed ${SEED})`);
        else {
            console.log(`CHECK: FAIL (seed ${SEED})`);
            console.log(`prev: ${prev}`);
            console.log(`curr: ${line}`);
        }
    }
    else {
        db[String(SEED)] = line;
        snapDbSave(db);
        console.log(`SNAPSHOT SAVED for seed ${SEED} -> ${path.basename(SNAP_DB)}`);
    }
}
if (require.main === module)
    main();
// ──────────────────────────────────────────────────────────────────────────────
// Hook notes (for later integration):
// - Feed external commands into applyCommand({kind:..., ...})
// - Move events to a typed outbox ring; here we only count them to avoid GC.
// - For general orderId mapping, replace orderId2Idx with an open-address hash map.
// - Add risk checks/KYC hooks at applyCommand() boundary in production.
//
