// file: lob_fast.ts
/* Minimal TS LOB, без классов, заточен под ops/sec бенч. */
/* Запуск: bun lob_fast.ts  (или ts-node) */

const TICK = 1; // 1 цент = 1 тик
const PRICE_MIN = 0;
const PRICE_MAX = 1_000_000;
const MAX_ORDERS = 1_000_000; // слотов под resting-ордера
const BENCH_OPS = 500_000;
const ADD_PCT = 0.6;
const CANCEL_PCT = 0.3;
const EMIT_EVENTS = 0; // 0 = быстрее; 1 = складывать события в массив

const LEVELS = (((PRICE_MAX - PRICE_MIN) / TICK) | 0) + 1;
const EMPTY = -1;
const BITWORD = 32;

// ── Хранилище (SoA) ────────────────────────────────────────────────────────────
const orderPriceIdx = new Int32Array(MAX_ORDERS).fill(EMPTY);
const orderQtyLots = new Uint32Array(MAX_ORDERS); // 32-bit лоты — быстрее и достаточно
const orderOwner = new Uint32Array(MAX_ORDERS);
const orderNext = new Int32Array(MAX_ORDERS).fill(EMPTY);
const orderSide = new Uint8Array(MAX_ORDERS); // 0=BUY,1=SELL
const orderActive = new Uint8Array(MAX_ORDERS); // 1=active

const levelHead = new Int32Array(LEVELS).fill(EMPTY);
const levelTail = new Int32Array(LEVELS).fill(EMPTY);
const bitmap = new Uint32Array(Math.ceil(LEVELS / BITWORD));

let bestBidIdx = EMPTY;
let bestAskIdx = EMPTY;

// freelist (стек через orderNext)
let freeTop = 0;
for (let i = 0; i < MAX_ORDERS - 1; i++) orderNext[i] = i + 1;
orderNext[MAX_ORDERS - 1] = EMPTY;

// ── Быстрые бит-хелперы ───────────────────────────────────────────────────────
function setBit(i: number) {
  const w = (i / BITWORD) | 0,
    b = i & 31;
  bitmap[w] |= (1 << b) >>> 0;
}
function clearBit(i: number) {
  const w = (i / BITWORD) | 0,
    b = i & 31;
  bitmap[w] &= ~(1 << b) >>> 0;
}
function ctz32(x: number): number {
  return Math.clz32((x & -x) >>> 0) ^ 31;
}
function findNextNonEmptyFrom(i: number): number {
  // для ask
  if (i < 0) i = 0;
  for (; i < LEVELS; ) {
    const w = (i / BITWORD) | 0,
      base = w * BITWORD;
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
function findPrevNonEmptyFrom(i: number): number {
  // для bid
  if (i >= LEVELS) i = LEVELS - 1;
  for (; i >= 0; ) {
    const w = (i / BITWORD) | 0,
      base = w * BITWORD;
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

// ── Очереди уровня ────────────────────────────────────────────────────────────
function enqueueAtLevel(levelIdx: number, orderIdx: number) {
  if (levelHead[levelIdx] === EMPTY) {
    levelHead[levelIdx] = orderIdx;
    levelTail[levelIdx] = orderIdx;
    setBit(levelIdx);
    if (bestAskIdx === EMPTY || levelIdx < bestAskIdx) bestAskIdx = levelIdx;
    if (bestBidIdx === EMPTY || levelIdx > bestBidIdx) bestBidIdx = levelIdx;
  } else {
    const tail = levelTail[levelIdx];
    orderNext[tail] = orderIdx;
    levelTail[levelIdx] = orderIdx;
  }
  orderNext[orderIdx] = EMPTY;
}
function popHead(levelIdx: number): number {
  const head = levelHead[levelIdx];
  if (head === EMPTY) return EMPTY;
  const next = orderNext[head];
  levelHead[levelIdx] = next;
  if (next === EMPTY) {
    levelTail[levelIdx] = EMPTY;
    clearBit(levelIdx);
    if (bestAskIdx === levelIdx) bestAskIdx = findNextNonEmptyFrom(levelIdx + 1);
    if (bestBidIdx === levelIdx) bestBidIdx = findPrevNonEmptyFrom(levelIdx - 1);
  }
  orderNext[head] = EMPTY;
  return head;
}
function allocOrder(): number {
  const idx = freeTop;
  if (idx === EMPTY) throw new Error('Out of order slots');
  freeTop = orderNext[idx];
  return idx;
}
function freeOrder(idx: number) {
  orderActive[idx] = 0;
  orderNext[idx] = freeTop;
  freeTop = idx;
}

// ── События (минимум) ─────────────────────────────────────────────────────────
type Side = 0 | 1;
type LOBEvent =
  | { kind: 'ACK' }
  | { kind: 'TRADE'; price: number; qty: number }
  | { kind: 'FILLED' }
  | { kind: 'REDUCED' }
  | { kind: 'CANCELED' }
  | { kind: 'REJECT' };

const events: LOBEvent[] = [];
let evCount = 0;
function emit(e: LOBEvent) {
  evCount++;
  if (EMIT_EVENTS) events.push(e);
}

// ── Ядро: заявки ──────────────────────────────────────────────────────────────
function newOrder(
  owner: number,
  clientId: number,
  side: Side,
  priceTicks: number,
  qtyLots: number,
  tifGTCorIOC: 0 | 1 = 0,
  postOnly = false,
) {
  if (qtyLots <= 0) {
    emit({ kind: 'REJECT' });
    return;
  }
  const levelIdx = ((priceTicks - PRICE_MIN) / TICK) | 0;
  if (levelIdx < 0 || levelIdx >= LEVELS) {
    emit({ kind: 'REJECT' });
    return;
  }

  let remaining = qtyLots >>> 0;
  let filledLots = 0;
  let filledNotionalTicks = 0;

  if (side === 0) {
    // BUY
    if (postOnly && bestAskIdx !== EMPTY && bestAskIdx <= levelIdx) {
      emit({ kind: 'REJECT' });
      return;
    }
    while (remaining > 0 && bestAskIdx !== EMPTY && bestAskIdx <= levelIdx) {
      remaining = fillAgainstLevel(bestAskIdx, 0, remaining, (px, q) => {
        filledLots += q;
        filledNotionalTicks += px * q;
      });
      if (bestAskIdx !== EMPTY && levelHead[bestAskIdx] === EMPTY) bestAskIdx = findNextNonEmptyFrom(bestAskIdx + 1);
    }
  } else {
    // SELL
    if (postOnly && bestBidIdx !== EMPTY && bestBidIdx >= levelIdx) {
      emit({ kind: 'REJECT' });
      return;
    }
    while (remaining > 0 && bestBidIdx !== EMPTY && bestBidIdx >= levelIdx) {
      remaining = fillAgainstLevel(bestBidIdx, 1, remaining, (px, q) => {
        filledLots += q;
        filledNotionalTicks += px * q;
      });
      if (bestBidIdx !== EMPTY && levelHead[bestBidIdx] === EMPTY) bestBidIdx = findPrevNonEmptyFrom(bestBidIdx - 1);
    }
  }

  if (remaining > 0) {
    if (tifGTCorIOC === 1) {
      // IOC
      if (filledLots > 0) emit({ kind: 'FILLED' });
      else emit({ kind: 'REJECT' });
      return;
    }
    const idx = allocOrder();
    orderPriceIdx[idx] = levelIdx;
    orderQtyLots[idx] = remaining;
    orderOwner[idx] = owner;
    orderSide[idx] = side;
    orderActive[idx] = 1;
    enqueueAtLevel(levelIdx, idx);
    emit({ kind: 'ACK' });
  } else {
    // avg notional only if filledLots>0 (иначе деление на 0)
    emit({ kind: 'FILLED' });
  }
}

function fillAgainstLevel(
  levelIdx: number,
  takerSide: Side,
  remaining: number,
  acc: (priceTicks: number, qty: number) => void,
): number {
  while (remaining > 0) {
    const head = levelHead[levelIdx];
    if (head === EMPTY) return remaining;
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
    emit({ kind: 'TRADE', price: pxTicks, qty: tradeQty });

    if (newMakerQty === 0) {
      popHead(levelIdx);
      freeOrder(head);
      emit({ kind: 'FILLED' });
    } else {
      emit({ kind: 'REDUCED' });
      break;
    } // частично — остаётся в голове
  }
  return remaining;
}

function cancel(_owner: number, idx: number) {
  if (idx < 0 || idx >= MAX_ORDERS || orderActive[idx] === 0) {
    emit({ kind: 'REJECT' });
    return;
  }
  // lazy-cancel
  orderActive[idx] = 0;
  emit({ kind: 'CANCELED' });
}

// ── Бенч (без Math.random) ────────────────────────────────────────────────────
let RNG = 0x9e3779b9 | 0;
function rndU32() {
  // xorshift32
  let x = RNG | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  RNG = x | 0;
  return x >>> 0;
}
function rnd01() {
  return rndU32() / 0xffffffff;
}

function bench() {
  const ids: number[] = [];
  let nextId = 1;
  let adds = 0,
    cancels = 0;

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < BENCH_OPS; i++) {
    const r = rnd01();
    if (r < ADD_PCT || ids.length === 0) {
      const side: Side = (rndU32() & 1) as Side;
      const mid = bestBidIdx !== EMPTY && bestAskIdx !== EMPTY ? (bestBidIdx + bestAskIdx) >> 1 : LEVELS >> 1;
      const levelIdx = Math.max(0, Math.min(LEVELS - 1, mid + ((rndU32() % 21 | 0) - 10)));
      const px = PRICE_MIN + levelIdx * TICK;
      const qty = (rndU32() % 5 | 0) + 1;
      const id = nextId++;
      newOrder(id, id, side, px, qty, 0, false);
      ids.push(id);
      adds++;
    } else if (r < ADD_PCT + CANCEL_PCT) {
      const pos = rndU32() % ids.length | 0;
      cancel(0, pos); // демо: передаём индекс как "id" — в реале нужен map
      cancels++;
    } else {
      // reduce
      if (ids.length > 0) {
        const pos = rndU32() % ids.length | 0;
        // имитация reduce через cancel+add — в демо оставим пусто
      }
    }
  }
  const t1 = process.hrtime.bigint();
  const dtMs = Number(t1 - t0) / 1e6;
  const opsPerSec = (BENCH_OPS / dtMs) * 1000;

  console.log(`ops=${BENCH_OPS}, time=${dtMs.toFixed(2)} ms, ~${opsPerSec.toFixed(0)} ops/sec`);
  console.log(`adds=${adds}, cancels=${cancels}, events=${EMIT_EVENTS ? events.length : evCount}`);
}

if (require.main === module) bench();
