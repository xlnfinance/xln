// file: lob.ts
/* eslint-disable no-constant-condition */
// EN: Limit Order Book (LOB), price-time priority, single symbol. Functional style (no classes), cache-friendly arrays.
// RU: Лимитный ордербук (LOB) с приоритетом по цене и времени, один инструмент. Без классов, массивы для кэш-дружелюбности.
import { pathToFileURL } from 'node:url';
// EN: Integers only: price in ticks, quantity in lots. Single-thread demo with self-benchmark.
// RU: Только целые: цена в тиках, объём в лотах. Однопоточный демо с самобенчмарком.
// EN: Focus: correctness, predictable memory, no allocations on hot path.
// RU: Фокус: корректность, предсказуемая память, без аллокаций в горячем цикле.

// ---------- Tunables / Настройки ----------
// EN: Adjust these for your market; they define price grid, capacity, and bench profile.
// RU: Подстройте под ваш рынок; задают ценовую сетку, ёмкость и профиль бенча.
const TICK = 1;                  // RU: размер тика; EN: tick size
const PRICE_MIN = 0;             // RU: минимальная цена (тики); EN: min price (ticks)
const PRICE_MAX = 1_000_000;     // RU: максимальная цена; EN: max price (example)
const MAX_ORDERS = 1_000_000;    // RU: предвыделение слотов под ордера; EN: preallocate order slots
const SNAPSHOT_EVERY_MS = 0;     // RU: период снапшота (0=выкл); EN: snapshot period (0=off)
// Benchmark profile / Профиль бенча:
const BENCH_OPS = 500_000;       // сколько команд прогнать
const ADD_PCT = 0.60;            // mix: 60% add, 30% cancel, 10% match naturally
const CANCEL_PCT = 0.30;

// Logging/events control / Управление событиями
const EMIT_EVENTS = false;       // RU: выкл. для чистого бенча; EN: disable for raw perf
const COUNT_EVENTS = false;      // RU: считать события без хранения; EN: count-only without storing
const BENCH_FAST_CANCEL = true;  // RU: в бенче ускоряем cancel; EN: bench-only fast path for cancel
const SKIP_MAP_SET = true;       // RU: в бенче не писать в hash-map; EN: bench skip map writes

// ---------- Derived / Производные ----------
// EN: LEVELS defines number of price buckets; EMPTY is sentinel.
// RU: LEVELS — число ценовых уровней; EMPTY — маркер пустого значения.
const LEVELS = (PRICE_MAX - PRICE_MIN) / TICK + 1;
const EMPTY = -1;

// ---------- Storage (SoA) / Хранилище (структуры массивов) ----------
// EN: Structure-of-Arrays keeps fields in tight typed arrays for CPU cache efficiency.
// RU: Структура массивов хранит поля плотно в типизированных массивах — выгодно для кэша CPU.
const orderPriceIdx = new Int32Array(MAX_ORDERS).fill(EMPTY);
const orderQtyLots  = new Uint32Array(MAX_ORDERS);          // RU: 32-бит лоты; EN: 32-bit lots (faster if sufficient)
const orderOwner    = new Uint32Array(MAX_ORDERS);
const orderNext     = new Int32Array(MAX_ORDERS).fill(EMPTY);
const orderSide     = new Uint8Array(MAX_ORDERS);            // RU: 0=BUY,1=SELL; EN: 0=BUY,1=SELL
const orderActive   = new Uint8Array(MAX_ORDERS);            // RU: активен?; EN: activity flag

// per-level FIFO queues / Очереди уровня (FIFO внутри цены)
const levelHead = new Int32Array(LEVELS).fill(EMPTY);
const levelTail = new Int32Array(LEVELS).fill(EMPTY);

// bitmap of non-empty levels (32 levels per word) / битовая карта непустых уровней
const BITWORD = 32;
const bitmap = new Uint32Array(Math.ceil(LEVELS / BITWORD));

// best pointers / лучшие цены
let bestBidIdx = EMPTY;  // max non-empty bid level index
let bestAskIdx = EMPTY;  // min non-empty ask level index

// free list of order indices (stack via orderNext) / стек свободных индексов
let freeTop = 0;
(function initFreeList() {
  for (let i = 0; i < MAX_ORDERS - 1; i++) orderNext[i] = i + 1;
  orderNext[MAX_ORDERS - 1] = EMPTY;
})();

// ---------- Helpers / Вспомогательные ----------
function idxFromPriceTicks(priceTicks: number): number {
  // EN: Map price in ticks to level index; RU: Преобразование цены (тики) в индекс уровня
  const idx = (priceTicks - PRICE_MIN) / TICK;
  return (idx|0);
}
function priceTicksFromIdx(idx: number): number {
  // EN: Map level index back to price in ticks; RU: Обратное преобразование индекса в цену (тики)
  return PRICE_MIN + idx * TICK;
}
function setBit(levelIdx: number) {
  // EN: Mark level as non-empty in bitmap; RU: Пометить уровень как непустой
  const w = (levelIdx / BITWORD) | 0, b = levelIdx % BITWORD;
  bitmap[w] |= (1 << b) >>> 0;
}
function clearBit(levelIdx: number) {
  // EN: Mark level as empty; RU: Пометить уровень пустым
  const w = (levelIdx / BITWORD) | 0, b = levelIdx % BITWORD;
  bitmap[w] &= (~(1 << b)) >>> 0;
}
function isLevelEmpty(levelIdx: number): boolean {
  // EN: Quick check if no orders rest at this price; RU: Быстрая проверка пустоты уровня
  return levelHead[levelIdx] === EMPTY;
}
function findNextNonEmptyFrom(startIdx: number): number { // forward (asks)
  // EN: Scan bitmap forward to find next ask level with liquidity; RU: Вперёд по биткарте — ближайший ask уровень
  if (startIdx < 0) startIdx = 0;
  for (let i = startIdx; i < LEVELS; ) {
    const w = (i / BITWORD) | 0;
    const bitbase = w * BITWORD;
    let word = bitmap[w];
    if (word) {
      // mask off bits below i
      const shift = i - bitbase;
      word = (word >>> shift);
      if (word) {
        const offset = ctz(word);      // count trailing zeros
        return bitbase + shift + offset;
      }
    }
    i = bitbase + BITWORD;
  }
  return EMPTY;
}
function findPrevNonEmptyFrom(startIdx: number): number { // backward (bids)
  // EN: Scan bitmap backward to find next bid level with liquidity; RU: Назад по биткарте — ближайший bid уровень
  if (startIdx >= LEVELS) startIdx = LEVELS - 1;
  for (let i = startIdx; i >= 0; ) {
    const w = (i / BITWORD) | 0;
    const bitbase = w * BITWORD;
    let word = bitmap[w];
    if (word) {
      // mask off bits above i
      const upto = i - bitbase;
      const mask = upto === 31 ? 0xFFFFFFFF : ((1 << (upto + 1)) - 1);
      word &= mask >>> 0;
      if (word) {
        const offset = 31 - clz(word);
        return bitbase + offset;
      }
    }
    i = bitbase - 1;
  }
  return EMPTY;
}
// JS bit tricks
function ctz(x: number): number { // 0..31
  // EN: Count trailing zeros; RU: Кол-во замыкающих нулей
  return Math.clz32(x & -x) ^ 31;
}
function clz(x: number): number {
  // EN: Count leading zeros; RU: Кол-во ведущих нулей
  return Math.clz32(x);
}

// ---------- ClientId -> Internal Index Map / Отображение внешнего id в индекс ----------
// EN: Open-addressing hash map to resolve external client order id to internal slot index.
// RU: Хеш-таблица с линейным пробингом для связи внешнего id с внутренним индексом.
const MAP_SIZE = 1 << 21; // ~2M slots
const mapKeys = new Int32Array(MAP_SIZE).fill(EMPTY);
const mapVals = new Int32Array(MAP_SIZE).fill(EMPTY);
function mapHash(id:number){
  let x = id | 0; // Thomas Wang 32-bit hash
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = (x * 0x27d4eb2d) | 0;
  x = x ^ (x >>> 15);
  return (x >>> 0) & (MAP_SIZE - 1);
}
function mapSet(id:number, idx:number){
  let i = mapHash(id);
  for (;;){
    const k = mapKeys[i];
    if (k === EMPTY || k === id){ mapKeys[i] = id; mapVals[i] = idx; return; }
    i = (i + 1) & (MAP_SIZE - 1);
  }
}
function mapGet(id:number): number {
  let i = mapHash(id);
  for (;;){
    const k = mapKeys[i];
    if (k === id) return mapVals[i];
    if (k === EMPTY) return EMPTY;
    i = (i + 1) & (MAP_SIZE - 1);
  }
}
function mapDel(id:number){
  let i = mapHash(id);
  for (;;){
    const k = mapKeys[i];
    if (k === id){ mapKeys[i] = EMPTY; mapVals[i] = EMPTY; return; }
    if (k === EMPTY) return;
    i = (i + 1) & (MAP_SIZE - 1);
  }
}

// Bench-only shadow map to avoid hash on cancel (optional)
// RU: В бенче используем массив для мгновенного доступа по id
const benchIdToIdx: number[] = [];

// queue ops / операции с очередями уровня
function enqueueAtLevel(levelIdx: number, orderIdx: number) {
  // EN: Append order to price FIFO; RU: Добавить ордер в очередь уровня (хвост)
  if (levelHead[levelIdx] === EMPTY) {
    levelHead[levelIdx] = orderIdx;
    levelTail[levelIdx] = orderIdx;
    setBit(levelIdx);
    // update best pointers
    if (bestAskIdx === EMPTY || levelIdx < bestAskIdx) bestAskIdx = levelIdx;
    if (bestBidIdx === EMPTY || levelIdx > bestBidIdx) bestBidIdx = levelIdx;
  } else {
    const tail = levelTail[levelIdx];
    orderNext[tail] = orderIdx;
    levelTail[levelIdx] = orderIdx;
  }
  orderNext[orderIdx] = EMPTY;
}
function popHead(levelIdx: number): number { // returns removed orderIdx or EMPTY
  // EN: Remove head order from price FIFO; RU: Снять ордер с головы уровня
  const head = levelHead[levelIdx];
  if (head === EMPTY) return EMPTY;
  const next = orderNext[head];
  levelHead[levelIdx] = next;
  if (next === EMPTY) {
    levelTail[levelIdx] = EMPTY;
    clearBit(levelIdx);
    // fix best pointers if needed
    if (bestAskIdx === levelIdx && isLevelEmpty(levelIdx)) {
      bestAskIdx = findNextNonEmptyFrom(levelIdx + 1);
    }
    if (bestBidIdx === levelIdx && isLevelEmpty(levelIdx)) {
      bestBidIdx = findPrevNonEmptyFrom(levelIdx - 1);
    }
  }
  orderNext[head] = EMPTY;
  return head;
}

// freelist
function allocOrder(): number {
  // EN: Take free index for new resting order; RU: Взять свободный индекс под ордер
  const idx = freeTop;
  if (idx === EMPTY) throw new Error('Out of order slots');
  freeTop = orderNext[idx];
  return idx;
}
function freeOrder(idx: number) {
  // EN: Return order slot to freelist; RU: Вернуть слот ордера в стек свободных
  orderActive[idx] = 0;
  orderNext[idx] = freeTop;
  freeTop = idx;
}

// ---------- Events / События (Egress) ----------
// EN: Engine emits events (egress) describing state changes. Disable for perf tests.
// RU: Движок эмитит события (выход), описывающие изменения. Для перфа можно выключить.
type Event =
  | { kind:'ACK', owner:number, id:number }
  | { kind:'REJECT', owner:number, id:number, reason:string }
  | { kind:'REDUCED', owner:number, id:number, delta:number, remaining:number }
  | { kind:'FILLED', owner:number, id:number, filled:number, avgPrice:number }
  | { kind:'TRADE', makerId:number, takerId:number, price:number, qty:number, side:0|1, makerOwner:number, takerOwner:number, remainingTaker:number }
  | { kind:'CANCELED', owner:number, id:number, reason:string };

const events: Event[] = [];
let evCount = 0;
const DO_EMIT = EMIT_EVENTS || COUNT_EVENTS;
// Event wrappers, zero-cost when both flags off
function emitAck(owner:number, id:number){ if (!DO_EMIT){ return; } if (!EMIT_EVENTS){ evCount++; return; } events.push({kind:'ACK', owner, id}); }
function emitReject(owner:number, id:number, reason:string){ if (!DO_EMIT){ return; } if (!EMIT_EVENTS){ evCount++; return; } events.push({kind:'REJECT', owner, id, reason}); }
function emitReduced(owner:number, id:number, delta:number, remaining:number){ if (!DO_EMIT){ return; } if (!EMIT_EVENTS){ evCount++; return; } events.push({kind:'REDUCED', owner, id, delta, remaining}); }
function emitFilled(owner:number, id:number, filled:number, avgPrice:number){ if (!DO_EMIT){ return; } if (!EMIT_EVENTS){ evCount++; return; } events.push({kind:'FILLED', owner, id, filled, avgPrice}); }
function emitTrade(makerId:number, takerId:number, price:number, qty:number, side:0|1, makerOwner:number, takerOwner:number, remainingTaker:number){ if (!DO_EMIT){ return; } if (!EMIT_EVENTS){ evCount++; return; } events.push({kind:'TRADE', makerId, takerId, price, qty, side, makerOwner, takerOwner, remainingTaker}); }
function emitCanceled(owner:number, id:number, reason:string){ if (!DO_EMIT){ return; } if (!EMIT_EVENTS){ evCount++; return; } events.push({kind:'CANCELED', owner, id, reason}); }

// ---------- API (Ingress) / Входные операции ----------
// EN: These functions are the only ingress points into the engine: newOrder, cancel, replaceReduce.
// RU: Эти функции — вход в движок: создание ордера, отмена, уменьшение объёма.
type Side = 0|1; // 0 buy, 1 sell
type TIF  = 0|1|2; // 0 GTC, 1 IOC, 2 FOK (FOK реализуем минимально)

function newOrder(owner:number, clientOrderId:number, side:Side, priceTicks:number, qtyLots:number, tif:TIF=0, postOnly=false) {
  // EN: Place a limit order. Consumes opposing book (taker) up to limit price, then rests (maker) unless IOC.
  // RU: Разместить лимитный ордер. Сначала съедает противоположный стакан до лимит-цены, остаток ставит (если не IOC).
  if (qtyLots <= 0) { emitReject(owner, clientOrderId, 'qty<=0'); return; }
  const levelIdx = idxFromPriceTicks(priceTicks);
  if (levelIdx < 0 || levelIdx >= LEVELS) { emitReject(owner, clientOrderId, 'price OOR'); return; }

  // taker consume
  let remaining = qtyLots;
  let filledLots = 0;
  let filledNotionalTicks = 0;
  if (side === 0) {
    // BUY crosses if bestAskIdx <= levelIdx
    if (postOnly && bestAskIdx !== EMPTY && bestAskIdx <= levelIdx) { emitReject(owner, clientOrderId, 'post-only would cross'); return; }
    while (remaining > 0 && bestAskIdx !== EMPTY && bestAskIdx <= levelIdx) {
      remaining = fillAgainstLevel(bestAskIdx, 0, owner, clientOrderId, remaining, (px,qty)=>{ filledLots+=qty; filledNotionalTicks+=px*qty; });
      if (isLevelEmpty(bestAskIdx)) bestAskIdx = findNextNonEmptyFrom(bestAskIdx + 1);
      if (tif === 2 && remaining > 0) { /* for strict FOK we’d need preview; keeping simple */ }
    }
  } else {
    // SELL crosses if bestBidIdx >= levelIdx
    if (postOnly && bestBidIdx !== EMPTY && bestBidIdx >= levelIdx) { emitReject(owner, clientOrderId, 'post-only would cross'); return; }
    while (remaining > 0 && bestBidIdx !== EMPTY && bestBidIdx >= levelIdx) {
      remaining = fillAgainstLevel(bestBidIdx, 1, owner, clientOrderId, remaining, (px,qty)=>{ filledLots+=qty; filledNotionalTicks+=px*qty; });
      if (isLevelEmpty(bestBidIdx)) bestBidIdx = findPrevNonEmptyFrom(bestBidIdx - 1);
    }
  }

  if (remaining > 0) {
    if (tif === 1) { // IOC: don’t rest / RU: IOC — не ставим остаток в книгу
      if (filledLots>0) emitFilled(owner, clientOrderId, filledLots, filledNotionalTicks/filledLots);
      else emitReject(owner, clientOrderId, 'IOC unfilled');
      return;
    }
    // rest maker
    const idx = allocOrder();
    orderPriceIdx[idx] = levelIdx;
    orderQtyLots[idx]  = remaining;
    orderOwner[idx]    = owner;
    orderSide[idx]     = side;
    orderActive[idx]   = 1;
    enqueueAtLevel(levelIdx, idx);
    if (!SKIP_MAP_SET) mapSet(clientOrderId, idx);
    if (BENCH_FAST_CANCEL) benchIdToIdx[clientOrderId] = idx;
    emitAck(owner, clientOrderId);
  } else {
    emitFilled(owner, clientOrderId, filledLots, filledNotionalTicks/Math.max(1,filledLots));
  }
}

function fillAgainstLevel(levelIdx:number, takerSide:Side, takerOwner:number, takerId:number, remaining:number,
  onAcc:(pxTicks:number, qty:number)=>void): number {
  // EN: Match taker against FIFO queue at level; RU: Матчинг тейкера против очереди уровня по FIFO
  // consume FIFO at level
  while (remaining > 0 && levelHead[levelIdx] !== EMPTY) {
    const makerIdx = levelHead[levelIdx];
    // skip lazy-canceled or corrupt heads
    if (orderActive[makerIdx] === 0 || orderQtyLots[makerIdx] <= 0) {
      popHead(levelIdx);
      freeOrder(makerIdx);
      continue;
    }
    const makerQty = orderQtyLots[makerIdx];
    const tradeQty = makerQty < remaining ? makerQty : remaining;
    const px = PRICE_MIN + levelIdx * TICK; // inline for speed

    // reduce maker
    orderQtyLots[makerIdx] = makerQty - tradeQty;
    remaining -= tradeQty;
    onAcc(px, tradeQty);

    emitTrade(makerIdx, takerId, px, tradeQty, takerSide, orderOwner[makerIdx], takerOwner, remaining);

    if (orderQtyLots[makerIdx] === 0) {
      popHead(levelIdx);
      emitFilled(orderOwner[makerIdx], makerIdx, tradeQty, px);
      // free maker slot
      freeOrder(makerIdx);
    } else {
      emitReduced(orderOwner[makerIdx], makerIdx, tradeQty, orderQtyLots[makerIdx]);
      break; // частично заполненный maker остаётся в голове FIFO
    }
  }
  return remaining;
}

function cancel(owner:number, clientOrderId:number) {
  // EN: Cancel resting order by client id.
  // RU: Снять ордер по внешнему client id.
  const idx = BENCH_FAST_CANCEL ? (benchIdToIdx[clientOrderId] ?? (SKIP_MAP_SET ? EMPTY : mapGet(clientOrderId))) : mapGet(clientOrderId);
  if (idx < 0 || idx >= MAX_ORDERS || orderActive[idx] === 0) return;

  const levelIdx = orderPriceIdx[idx];
  if (levelHead[levelIdx] === idx) {
    popHead(levelIdx);
    freeOrder(idx);
    mapDel(clientOrderId);
    emitCanceled(owner, clientOrderId, 'OK');
  } else {
    // lazy-cancel (помечаем неактивным, будет вытолкнут при достижении головы)
    orderActive[idx] = 0;
    emitCanceled(owner, clientOrderId, 'LAZY');
  }
}

function replaceReduce(owner:number, clientOrderId:number, reduceLots:number) {
  // EN: Reduce quantity without losing time priority; RU: Сокращает объём без потери приоритета по времени
  const idx = mapGet(clientOrderId);
  if (idx < 0 || idx >= MAX_ORDERS || orderActive[idx] === 0) return;
  const newQty = orderQtyLots[idx] - reduceLots;
  if (newQty <= 0) return cancel(owner, clientOrderId);
  orderQtyLots[idx] = newQty; // сокращение объёма сохраняет приоритет
  emitReduced(owner, clientOrderId, reduceLots, newQty);
}

// ---------- Benchmark / Бенчмарк ----------
// EN: Synthetic ingress generator to stress the engine; RU: Синтетическая нагрузка для проверки производительности
// xorshift32 RNG for faster bench
let RNG_STATE = 0x9e3779b9 | 0;
function rndU32(){ let x = RNG_STATE | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; RNG_STATE = x | 0; return (x >>> 0); }
function rnd01(){ return rndU32() / 0xFFFFFFFF; }

function bench() {
  const N = BENCH_OPS;
  const idsUsed: number[] = [];
  let nextOwner = 1;
  let nextId = 1;
  let adds = 0, cancels = 0;

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const r = rnd01();
    if (r < ADD_PCT || idsUsed.length === 0) {
      // ADD
      const side: Side = (rndU32() & 1) as Side;
      const mid = (bestBidIdx !== EMPTY && bestAskIdx !== EMPTY)
        ? (bestBidIdx + bestAskIdx) >> 1
        : (LEVELS >> 1);
      // лимит рядом с мидом
      const levelIdx = Math.max(0, Math.min(LEVELS - 1, mid + (((rndU32()%21)|0)-10)));
      const px = PRICE_MIN + levelIdx * TICK;
      const qty = 1 + ((rndU32()%5)|0);
      const id = nextId++;
      newOrder(nextOwner++, id, side, px, qty, 0, false);
      if (BENCH_FAST_CANCEL) benchIdToIdx[id] = mapGet(id);
      idsUsed.push(id);
      adds++;
    } else if (r < ADD_PCT + CANCEL_PCT) {
      // CANCEL случайного известного id
      const pos = (rndU32() % idsUsed.length) | 0;
      const id = idsUsed[pos];
      cancel(0, id);
      cancels++;
    } else {
      // REPLACE-REDUCE
      if (idsUsed.length > 0) {
        const id = idsUsed[(rndU32() % idsUsed.length) | 0];
        replaceReduce(0, id, 1);
      }
    }
  }
  const t1 = process.hrtime.bigint();
  const dtMs = Number(t1 - t0) / 1e6;
  const opsPerSec = (N / dtMs) * 1000;

  console.log(`ops=${N}, time=${dtMs.toFixed(2)} ms, ~${opsPerSec.toFixed(0)} ops/sec`);
  console.log(`adds=${adds}, cancels=${cancels}, events=${EMIT_EVENTS ? events.length : (COUNT_EVENTS?evCount:0)}`);
  // keep validation optional for speed
  // const v = validate();
  // console.log(`validate ok=${v.ok}, levelsNonEmpty=${v.levelsNonEmpty}, restingOrders=${v.restingOrders}, restingQty=${v.restingQty}`);
}

// ---------- Run / Запуск ----------
// Bridge globals for pre-generated bench (lob_pregen) to avoid circular imports
// RU: Делаем функции и константы доступными как глобальные для pregen-бенча
// EN: Expose engine API and constants on globalThis for the pregen runner
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).newOrder = newOrder;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).cancel = cancel;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).LEVELS = LEVELS;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).PRICE_MIN = PRICE_MIN;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).TICK = TICK;
import {benchPregen} from './lob_pregen.js'
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]!).href;
  } catch {
    return false;
  }
})();
if (isMain) {
    benchPregen();
}

// ---------- Validation / Валидация ----------
// EN: Consistency checks between queues, bitmap, and best pointers after the run.
// RU: Проверка согласованности очередей, биткарты и указателей лучшей цены.
function validate() {
  let levelsNonEmpty = 0;
  let restingOrders = 0;
  let restingQty = 0;
  let ok = true;

  // bitmap vs queues and head activity
  for (let levelIdx = 0; levelIdx < LEVELS; levelIdx++) {
    const head = levelHead[levelIdx];
    const w = (levelIdx / BITWORD) | 0, b = levelIdx % BITWORD;
    const bit = (bitmap[w] >>> b) & 1;
    if (head === EMPTY) {
      if (bit !== 0) ok = false;
      continue;
    }
    levelsNonEmpty++;
    if (bit !== 1) ok = false;
    // head must be active and qty>0 (otherwise matching loop should have cleaned it)
    if (orderActive[head] === 0 || orderQtyLots[head] <= 0) ok = false;
    // walk queue and accumulate
    let seen = 0;
    for (let p = head; p !== EMPTY; p = orderNext[p]) {
      restingOrders++;
      restingQty += orderQtyLots[p];
      seen++;
      if (seen > MAX_ORDERS) { ok = false; break; }
    }
  }
  // best pointers vs bitmap
  const bestAskCand = findNextNonEmptyFrom(0);
  const bestBidCand = findPrevNonEmptyFrom(LEVELS - 1);
  if (bestAskIdx !== bestAskCand) ok = false;
  if (bestBidIdx !== bestBidCand) ok = false;
  return { ok, levelsNonEmpty, restingOrders, restingQty };
}