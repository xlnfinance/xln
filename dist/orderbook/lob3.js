// file: lob_final.ts
/* Limit Order Book (один символ), без классов, с детерминированным бенчем.
 * - Целые тики/лоты (никаких float).
 * - FIFO в пределах ценового уровня.
 * - Частичные/полные сделки (taker против maker-очереди).
 * - Отмены (lazy-cancel: снимаем head уровня мгновенно, "лениво" из середины).
 * - Детерминированный PRNG с seed.
 * - Предгенерация команд (ADD/CANCEL/REDUCE) — никаких аллокаций в горячем цикле.
 * - Снапшот результата + SHA-256 хэш состояния; сравнение с прошлым результатом по тому же seed.
 *
 * Запуск: bun lob_final.ts --seed=123 --ops=500000
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
// -------------------- Параметры (можно менять флагами CLI) --------------------
const argv = process.argv.slice(2);
function argNum(name, def) {
    const a = argv.find(x => x.startsWith(`--${name}=`));
    return a ? Number(a.split('=')[1]) : def;
}
function argBool(name, def) {
    const a = argv.find(x => x === `--${name}` || x === `--${name}=1` || x === `--${name}=true`);
    return a ? true : def;
}
const SEED = argNum('seed', 0xC0FFEE);
const OPS = argNum('ops', 500_000);
const EMIT_EVENTS = argBool('emitEvents', false); // для прод egress заменим на SPSC ring
const COUNT_EVENTS_ONLY = argBool('countEventsOnly', false); // только считать, без BigInt-агрегаций
// Тик и ценовая сетка
const TICK = 1; // 1 цент = 1 тик
const PRICE_MIN = 0;
const PRICE_MAX = 1_000_000;
const LEVELS = ((PRICE_MAX - PRICE_MIN) / TICK | 0) + 1;
// Лимиты
const MAX_ORDERS = 1_000_000; // максимальное число "висящих" заявок
const EMPTY = -1;
const BITWORD = 32;
// Микс команд
const ADD_PCT = 0.60;
const CANCEL_PCT = 0.30; // ~10% останется под REDUCE
const UNROLL = 8; // микро-батч цикла
// -------------------- Хранилище LOB (SoA) ------------------------------------
const orderPriceIdx = new Int32Array(MAX_ORDERS).fill(EMPTY);
const orderQtyLots = new Uint32Array(MAX_ORDERS);
const orderOwner = new Uint32Array(MAX_ORDERS);
const orderNext = new Int32Array(MAX_ORDERS).fill(EMPTY);
const orderSide = new Uint8Array(MAX_ORDERS); // 0=BUY,1=SELL
const orderActive = new Uint8Array(MAX_ORDERS); // 1=active
const levelHead = new Int32Array(LEVELS).fill(EMPTY);
const levelTail = new Int32Array(LEVELS).fill(EMPTY);
const bitmap = new Uint32Array(Math.ceil(LEVELS / BITWORD));
let bestBidIdx = EMPTY;
let bestAskIdx = EMPTY;
// freelist: стек через orderNext
let freeTop = 0;
for (let i = 0; i < MAX_ORDERS - 1; i++)
    orderNext[i] = i + 1;
orderNext[MAX_ORDERS - 1] = EMPTY;
// -------------------- Быстрые бит-хелперы ------------------------------------
function setBit(i) {
    const w = (i / BITWORD) | 0, b = i & 31;
    bitmap[w] |= (1 << b) >>> 0;
}
function clearBit(i) {
    const w = (i / BITWORD) | 0, b = i & 31;
    bitmap[w] &= (~(1 << b)) >>> 0;
}
function ctz32(x) { return (Math.clz32((x & -x) >>> 0) ^ 31); }
function findNextNonEmptyFrom(i) {
    if (i < 0)
        i = 0;
    for (; i < LEVELS;) {
        const w = (i / BITWORD) | 0, base = w * BITWORD;
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
        const w = (i / BITWORD) | 0, base = w * BITWORD;
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
// -------------------- Очереди уровней ----------------------------------------
function enqueueAtLevel(levelIdx, orderIdx) {
    if (levelHead[levelIdx] === EMPTY) {
        levelHead[levelIdx] = orderIdx;
        levelTail[levelIdx] = orderIdx;
        setBit(levelIdx);
        if (bestAskIdx === EMPTY || levelIdx < bestAskIdx)
            bestAskIdx = levelIdx;
        if (bestBidIdx === EMPTY || levelIdx > bestBidIdx)
            bestBidIdx = levelIdx;
    }
    else {
        const tail = levelTail[levelIdx];
        orderNext[tail] = orderIdx;
        levelTail[levelIdx] = orderIdx;
    }
    orderNext[orderIdx] = EMPTY;
}
function popHead(levelIdx) {
    const head = levelHead[levelIdx];
    if (head === EMPTY)
        return EMPTY;
    const next = orderNext[head];
    levelHead[levelIdx] = next;
    if (next === EMPTY) {
        levelTail[levelIdx] = EMPTY;
        clearBit(levelIdx);
        if (bestAskIdx === levelIdx)
            bestAskIdx = findNextNonEmptyFrom(levelIdx + 1);
        if (bestBidIdx === levelIdx)
            bestBidIdx = findPrevNonEmptyFrom(levelIdx - 1);
    }
    orderNext[head] = EMPTY;
    return head;
}
function allocOrder() {
    const idx = freeTop;
    if (idx === EMPTY)
        throw new Error('Out of order slots');
    freeTop = orderNext[idx];
    return idx;
}
function freeOrder(idx) {
    orderActive[idx] = 0;
    orderNext[idx] = freeTop;
    freeTop = idx;
}
let evAck = 0, evTrade = 0, evFilled = 0, evReduced = 0, evCanceled = 0, evReject = 0;
let tradeQtySum = 0n; // суммарный объём сделок
let tradeNotionalTicksSum = 0n; // сумма (priceTicks*qty)
let tradeChecksum = 0n; // простой чек-сум (mix)
const P = 0x1000001n; // небольшой прост. модуль для mix
function emitACK() { if (!EMIT_EVENTS)
    return; evAck++; }
function emitREJECT() { if (!EMIT_EVENTS)
    return; evReject++; }
function emitTRADE(pxTicks, qty) {
    if (!EMIT_EVENTS)
        return;
    evTrade++;
    if (COUNT_EVENTS_ONLY)
        return; // ускорение: без BigInt
    tradeQtySum += BigInt(qty);
    tradeNotionalTicksSum += BigInt(pxTicks) * BigInt(qty);
    // mix: (checksum * prime + (px<<16 ^ qty)) mod 2^53
    const mix = (BigInt((pxTicks << 16) ^ qty) & 0x1fffffffffffffn);
    tradeChecksum = ((tradeChecksum * P + mix) & 0x1fffffffffffffn);
}
function emitFILLED() { if (!EMIT_EVENTS)
    return; evFilled++; }
function emitREDUCED() { if (!EMIT_EVENTS)
    return; evReduced++; }
function emitCANCELED() { if (!EMIT_EVENTS)
    return; evCanceled++; }
// -------------------- Ядро (NEW / CANCEL / REDUCE) ---------------------------
function newOrder(owner, _clientId, side, priceTicks, qtyLots, tif = 0, postOnly = false) {
    if (qtyLots <= 0) {
        emitREJECT();
        return;
    }
    const levelIdx = ((priceTicks - PRICE_MIN) / TICK) | 0;
    if (levelIdx < 0 || levelIdx >= LEVELS) {
        emitREJECT();
        return;
    }
    let remaining = qtyLots >>> 0;
    if (side === 0) { // BUY
        if (postOnly && bestAskIdx !== EMPTY && bestAskIdx <= levelIdx) {
            emitREJECT();
            return;
        }
        while (remaining > 0 && bestAskIdx !== EMPTY && bestAskIdx <= levelIdx) {
            remaining = fillAgainstLevel(bestAskIdx, remaining, (px, q) => emitTRADE(px, q));
            if (bestAskIdx !== EMPTY && levelHead[bestAskIdx] === EMPTY)
                bestAskIdx = findNextNonEmptyFrom(bestAskIdx + 1);
        }
    }
    else { // SELL
        if (postOnly && bestBidIdx !== EMPTY && bestBidIdx >= levelIdx) {
            emitREJECT();
            return;
        }
        while (remaining > 0 && bestBidIdx !== EMPTY && bestBidIdx >= levelIdx) {
            remaining = fillAgainstLevel(bestBidIdx, remaining, (px, q) => emitTRADE(px, q));
            if (bestBidIdx !== EMPTY && levelHead[bestBidIdx] === EMPTY)
                bestBidIdx = findPrevNonEmptyFrom(bestBidIdx - 1);
        }
    }
    if (remaining > 0) {
        if (tif === 1) { // IOC: остаток не ставим
            if (qtyLots !== remaining)
                emitFILLED();
            else
                emitREJECT();
            return;
        }
        const idx = allocOrder();
        orderPriceIdx[idx] = levelIdx;
        orderQtyLots[idx] = remaining;
        orderOwner[idx] = owner;
        orderSide[idx] = side;
        orderActive[idx] = 1;
        enqueueAtLevel(levelIdx, idx);
        emitACK();
    }
    else {
        emitFILLED();
    }
}
function fillAgainstLevel(levelIdx, remaining, acc) {
    while (remaining > 0) {
        const head = levelHead[levelIdx];
        if (head === EMPTY)
            return remaining;
        if (orderActive[head] === 0) {
            popHead(levelIdx);
            freeOrder(head);
            continue;
        }
        const makerQty = orderQtyLots[head];
        const tradeQty = makerQty < remaining ? makerQty : remaining;
        const pxTicks = PRICE_MIN + levelIdx * TICK;
        const newMakerQty = makerQty - tradeQty;
        orderQtyLots[head] = newMakerQty;
        remaining -= tradeQty;
        acc(pxTicks, tradeQty);
        if (newMakerQty === 0) {
            popHead(levelIdx);
            freeOrder(head);
            emitFILLED();
        }
        else {
            emitREDUCED();
            break;
        } // частично — остаётся в голове
    }
    return remaining;
}
// Отмена head уровня (детерминированно выбираем уровень)
function cancelHeadAtLevel(levelIdx) {
    const head = levelHead[levelIdx];
    if (head === EMPTY) {
        emitREJECT();
        return;
    }
    // мгновенно снимаем head
    popHead(levelIdx);
    freeOrder(head);
    emitCANCELED();
}
// Уменьшение head (reduce) — эмулируем REPLACE-reduce головы уровня
function reduceHeadAtLevel(levelIdx, lots) {
    const head = levelHead[levelIdx];
    if (head === EMPTY) {
        emitREJECT();
        return;
    }
    const q = orderQtyLots[head];
    if (lots >= q) {
        // эквивалент cancel
        popHead(levelIdx);
        freeOrder(head);
        emitCANCELED();
        return;
    }
    orderQtyLots[head] = q - lots; // приоритет сохраняем
    emitREDUCED();
}
// -------------------- Детерминированный PRNG ---------------------------------
let RNG = (SEED >>> 0);
function rndU32() {
    let x = RNG | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    RNG = x | 0;
    return (x >>> 0);
}
function rnd01() { return (rndU32() / 0xFFFFFFFF); }
const cmdKind = new Uint8Array(OPS);
const cmdSide = new Uint8Array(OPS); // для ADD: 0/1
const cmdLvl = new Int32Array(OPS); // для ADD/CANCEL/REDUCE: индекс уровня
const cmdQty = new Uint16Array(OPS); // для ADD/REDUCE: лоты
function chooseNonEmptyLevelForCancelOrReduce(preferBid) {
    // если есть обе стороны — 50/50, иначе берём что есть; если пусто — возврат EMPTY
    if (bestBidIdx === EMPTY && bestAskIdx === EMPTY)
        return EMPTY;
    if (bestBidIdx !== EMPTY && bestAskIdx !== EMPTY) {
        const coin = (rndU32() & 1) !== 0 ? preferBid : !preferBid;
        return coin ? bestBidIdx : bestAskIdx;
    }
    return bestBidIdx !== EMPTY ? bestBidIdx : bestAskIdx;
}
function pregen() {
    for (let i = 0; i < OPS; i++) {
        const r = rnd01();
        if (r < ADD_PCT) {
            cmdKind[i] = 0; // ADD
            cmdSide[i] = (rndU32() & 1);
            // ставим около текущего mid (или центр сетки, если пусто)
            const mid = (bestBidIdx >= 0 && bestAskIdx >= 0) ? ((bestBidIdx + bestAskIdx) >> 1) : (LEVELS >> 1);
            const li = Math.max(0, Math.min(LEVELS - 1, mid + ((rndU32() % 21 | 0) - 10)));
            cmdLvl[i] = li;
            cmdQty[i] = ((rndU32() % 5 | 0) + 1);
        }
        else if (r < ADD_PCT + CANCEL_PCT) {
            cmdKind[i] = 1; // CANCEL
            // детерминированный выбор целевого уровня для cancel: head на ближайшем к mid непустом уровне
            const preferBid = (rndU32() & 1) === 0;
            const lvl = chooseNonEmptyLevelForCancelOrReduce(preferBid);
            cmdLvl[i] = (lvl === EMPTY) ? -1 : lvl;
            cmdQty[i] = 0;
        }
        else {
            cmdKind[i] = 2; // REDUCE
            const preferBid = (rndU32() & 1) === 0;
            const lvl = chooseNonEmptyLevelForCancelOrReduce(preferBid);
            cmdLvl[i] = (lvl === EMPTY) ? -1 : lvl;
            cmdQty[i] = ((rndU32() % 3 | 0) + 1); // уменьшить на 1..3 лота
        }
    }
}
// -------------------- Бенч (горячий цикл без аллокаций) ----------------------
function runBench() {
    const t0 = process.hrtime.bigint();
    let adds = 0, cancels = 0, reduces = 0;
    let i = 0;
    const limit = (OPS / UNROLL | 0) * UNROLL;
    let nextOwner = 1;
    for (; i < limit; i += UNROLL) {
        for (let k = 0; k < UNROLL; k++) {
            const ii = i + k;
            const kind = cmdKind[ii];
            if (kind === 0) {
                const li = cmdLvl[ii];
                const px = PRICE_MIN + li * TICK;
                const side = cmdSide[ii];
                const qty = cmdQty[ii];
                newOrder(nextOwner, nextOwner, side, px, qty, 0, false);
                nextOwner++;
                adds++;
            }
            else if (kind === 1) {
                const li = cmdLvl[ii];
                if (li >= 0)
                    cancelHeadAtLevel(li);
                else
                    emitREJECT();
                cancels++;
            }
            else {
                const li = cmdLvl[ii];
                if (li >= 0)
                    reduceHeadAtLevel(li, cmdQty[ii] || 1);
                else
                    emitREJECT();
                reduces++;
            }
        }
    }
    for (; i < OPS; i++) {
        const kind = cmdKind[i];
        if (kind === 0) {
            const li = cmdLvl[i];
            const px = PRICE_MIN + li * TICK;
            newOrder(nextOwner, nextOwner, cmdSide[i], px, cmdQty[i], 0, false);
            nextOwner++;
            adds++;
        }
        else if (kind === 1) {
            const li = cmdLvl[i];
            if (li >= 0)
                cancelHeadAtLevel(li);
            else
                emitREJECT();
            cancels++;
        }
        else {
            const li = cmdLvl[i];
            if (li >= 0)
                reduceHeadAtLevel(li, cmdQty[i] || 1);
            else
                emitREJECT();
            reduces++;
        }
    }
    const t1 = process.hrtime.bigint();
    const dtMs = Number(t1 - t0) / 1e6;
    const opsPerSec = (OPS / dtMs) * 1000;
    return { dtMs, opsPerSec, adds, cancels, reduces };
}
// -------------------- Снапшот и проверка -------------------------------------
function computeRestingSummary() {
    let restingCount = 0;
    let restingLots = 0n;
    // Пройдём только по head цепочкам: этого достаточно для хэша (состояние детерминир.)
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
    const bestBidPx = (bestBidIdx === EMPTY) ? -1 : (PRICE_MIN + bestBidIdx * TICK);
    const bestAskPx = (bestAskIdx === EMPTY) ? -1 : (PRICE_MIN + bestAskIdx * TICK);
    return { restingCount, restingLots: restingLots.toString(), bestBidPx, bestAskPx };
}
function computeStateHash() {
    const h = createHash('sha256');
    // Важно: та же последовательность update для стабильности
    h.update(new Uint8Array(orderActive.buffer));
    h.update(new Uint8Array(orderPriceIdx.buffer));
    h.update(new Uint8Array(orderQtyLots.buffer));
    h.update(new Uint8Array(levelHead.buffer));
    h.update(new Uint8Array(levelTail.buffer));
    h.update(new Uint8Array(bitmap.buffer));
    // добавим ключевые счётчики сделок
    const trailer = Buffer.from(JSON.stringify({
        evAck, evTrade, evFilled, evReduced, evCanceled, evReject,
        tradeQtySum: tradeQtySum.toString(),
        tradeNotionalTicksSum: tradeNotionalTicksSum.toString(),
        tradeChecksum: tradeChecksum.toString()
    }));
    h.update(trailer);
    return h.digest('hex');
}
function snapshotString() {
    const rs = computeRestingSummary();
    return [
        `seed:${SEED}`,
        `ops:${OPS}`,
        `ack:${evAck}`,
        `trade:${evTrade}`,
        `filled:${evFilled}`,
        `reduced:${evReduced}`,
        `canceled:${evCanceled}`,
        `reject:${evReject}`,
        `tQty:${tradeQtySum.toString()}`,
        `tNotional:${tradeNotionalTicksSum.toString()}`,
        `tChk:${tradeChecksum.toString()}`,
        `restCnt:${rs.restingCount}`,
        `restLots:${rs.restingLots}`,
        `bb:${rs.bestBidPx}`,
        `ba:${rs.bestAskPx}`
    ].join('|');
}
const SNAP_DB = path.resolve(process.cwd(), 'bench_snapshots.json');
function loadSnapshots() {
    try {
        if (fs.existsSync(SNAP_DB)) {
            const txt = fs.readFileSync(SNAP_DB, 'utf8');
            return txt ? JSON.parse(txt) : {};
        }
    }
    catch { }
    return {};
}
function saveSnapshots(db) {
    fs.writeFileSync(SNAP_DB, JSON.stringify(db, null, 2), 'utf8');
}
// -------------------- Main ----------------------------------------------------
function main() {
    // Предгенерация команд с фиксированным seed
    RNG = (SEED >>> 0);
    pregen();
    // Прогон
    const t0 = process.hrtime.bigint();
    const { dtMs, opsPerSec, adds, cancels, reduces } = runBench();
    const t1 = process.hrtime.bigint();
    // Снапшот и хэш
    const snapLine = snapshotString();
    const stateHash = computeStateHash();
    const longLine = `${snapLine}|hash:${stateHash}`;
    // Печать метрик
    console.log(`ops=${OPS}, time=${dtMs.toFixed(2)} ms, ~${opsPerSec.toFixed(0)} ops/sec`);
    console.log(`adds=${adds}, cancels=${cancels}, reduces=${reduces}`);
    console.log(longLine);
    // Проверка и сохранение
    const db = loadSnapshots();
    const prev = db[String(SEED)];
    if (prev) {
        if (prev === longLine) {
            console.log(`CHECK: OK (seed ${SEED})`);
        }
        else {
            console.log(`CHECK: FAIL (seed ${SEED})`);
            console.log(`prev: ${prev}`);
            console.log(`curr: ${longLine}`);
        }
    }
    else {
        db[String(SEED)] = longLine;
        saveSnapshots(db);
        console.log(`SNAPSHOT SAVED for seed ${SEED} -> bench_snapshots.json`);
    }
}
if (require.main === module)
    main();
