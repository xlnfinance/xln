// file: lob_pregen.ts
// Использует API из твоего lob.ts: newOrder(), cancel(), LEVELS, PRICE_MIN, TICK
// И экспортирует benchPregen() как новый бенчмарк без аллокаций в хот-лупе.

declare function newOrder(owner:number, clientId:number, side:0|1, priceTicks:number, qtyLots:number, tif:0|1, postOnly:boolean): void;
declare function cancel(owner:number, idx:number): void;
declare const LEVELS: number;
declare const PRICE_MIN: number;
declare const TICK: number;

// --- параметры ---
const N = 500_000;            // столько операций прогоняем
const ADD_PCT = 0.60;         // 60% add
const CANCEL_PCT = 0.30;      // 30% cancel
const UNROLL = 8;             // микробатч: разворачиваем цикл

// простейший быстрый RNG без аллокаций
let RNG = 0x9e3779b9 | 0;
function rndU32(){ let x = RNG|0; x^=x<<13; x^=x>>>17; x^=x<<5; return (RNG=x)|0; }
function rnd01(){ return (rndU32()>>>0) / 0xFFFFFFFF; }

// предгенерируем командный поток
// cmdType: 0=ADD, 1=CANCEL
const cmdType = new Uint8Array(N);
const sideArr = new Uint8Array(N);
const levelArr = new Int32Array(N);
const qtyArr = new Uint16Array(N);
const cancelIdx = new Int32Array(N);

function pregen() {
  // стек активных id без push/pop (для выбора кандидата на cancel)
  const ids = new Int32Array(N);
  let idsTop = 0;
  let nextId = 1;

  for (let i=0;i<N;i++){
    const r = (rnd01());
    if (r < ADD_PCT || idsTop===0) {
      cmdType[i] = 0;
      sideArr[i] = (rndU32() & 1) as 0|1;

      const mid = (LEVELS>>1);
      const li = Math.max(0, Math.min(LEVELS-1, mid + ((rndU32()%21|0)-10)));
      levelArr[i] = li;
      qtyArr[i] = ((rndU32()%5|0)+1) as number;

      // запомним id в стек
      ids[idsTop++] = nextId++;
      cancelIdx[i] = idsTop-1; // позиция в стеке для потенциального cancel
    } else if (r < ADD_PCT + CANCEL_PCT) {
      cmdType[i] = 1;
      // если стек пуст — превратим в ADD
      if (idsTop===0) { cmdType[i]=0; sideArr[i]=(rndU32()&1) as 0|1; levelArr[i]=(LEVELS>>1); qtyArr[i]=1; cancelIdx[i]=0; continue; }
      // возьмём случайный индекс из стека (не вынимая из него)
      const pos = (rndU32() % idsTop) | 0;
      cancelIdx[i] = pos;
    } else {
      // для простоты: тоже ADD
      cmdType[i] = 0;
      sideArr[i] = (rndU32() & 1) as 0|1;
      const mid = (LEVELS>>1);
      const li = Math.max(0, Math.min(LEVELS-1, mid + ((rndU32()%21|0)-10)));
      levelArr[i] = li;
      qtyArr[i] = ((rndU32()%5|0)+1) as number;
      ids[idsTop++] = nextId++;
      cancelIdx[i] = idsTop-1;
    }
  }

  return { ids, idsTopRef: {v: idsTop}, nextIdRef: {v: nextId} };
}

export function benchPregen() {
  const { ids, idsTopRef, nextIdRef } = pregen();

  const t0 = process.hrtime.bigint();
  let adds=0, cancels=0;

  // горячий цикл: только вызовы newOrder/cancel, без аллокаций и RNG
  let i = 0;
  const limit = (N/UNROLL | 0) * UNROLL;
  for (; i < limit; i += UNROLL) {
    for (let k=0;k<UNROLL;k++){
      const ii = i+k;
      if (cmdType[ii]===0){
        const li = levelArr[ii];
        const px = PRICE_MIN + li*TICK;
        const id = nextIdRef.v++; // монотонный id
        newOrder(id, id, sideArr[ii] as 0|1, px, qtyArr[ii], 0, false);
        // сдвиг стека не нужен, мы не используем его во время замера
        adds++;
      } else {
        const pos = cancelIdx[ii];
        const idx = ids[pos] | 0; // в демо считаем, что id==internalIdx; в проде нужен map
        cancel(0, idx);
        cancels++;
      }
    }
  }
  // хвост
  for (; i < N; i++){
    if (cmdType[i]===0){
      const li = levelArr[i];
      const px = PRICE_MIN + li*TICK;
      const id = nextIdRef.v++;
      newOrder(id, id, sideArr[i] as 0|1, px, qtyArr[i], 0, false);
      adds++;
    } else {
      const pos = cancelIdx[i];
      const idx = ids[pos] | 0;
      cancel(0, idx);
      cancels++;
    }
  }

  const t1 = process.hrtime.bigint();
  const dtMs = Number(t1 - t0) / 1e6;
  const opsPerSec = (N / dtMs) * 1000;
  console.log(`ops=${N}, time=${dtMs.toFixed(2)} ms, ~${opsPerSec.toFixed(0)} ops/sec`);
  console.log(`adds=${adds}, cancels=${cancels}`);
}

// если запускаешь отдельно
import { pathToFileURL } from 'node:url';
const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1]!).href; } catch { return false; } })();
if (isMain) benchPregen();