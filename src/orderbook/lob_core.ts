// src/orderbook/lob_core.ts
import { createHash } from "crypto";

export type Side = 0 | 1;            // 0 BUY, 1 SELL
export type TIF  = 0 | 1 | 2;        // 0 GTC, 1 IOC, 2 FOK
export type Cmd =
  | { kind: 0; owner: number; orderId: number; side: Side; tif: TIF; postOnly: boolean; reduceOnly: boolean; priceTicks: number; qtyLots: number; }
  | { kind: 1; owner: number; orderId: number; }
  | { kind: 2; owner: number; orderId: number; newPriceTicks: number | null; qtyDeltaLots: number; };

export type CoreParams = {
  tick: number; pmin: number; pmax: number; maxOrders: number; stpPolicy: 0|1|2;
  devAsserts?: boolean;
};

// ── egress события (реальные) ────────────────────────────────────────────────
export type EgressEvent =
  | { k:'ACK', id:number, owner:number }
  | { k:'REJECT', id:number, owner:number, reason:string }
  | { k:'TRADE', px:number, qty:number, makerOwner:number, takerOwner:number }
  | { k:'REDUCED', id:number, owner:number, delta:number, remain:number }
  | { k:'CANCELED', id:number, owner:number };
type Sink = (e:EgressEvent)=>void;
let eventSink: Sink | null = null;
export function setEventSink(sink: Sink | null){ eventSink = sink; }

// ── состояние ────────────────────────────────────────────────────────────────
const EMPTY = -1;
const BITWORD = 32;
const MAX_QTY = 1_000_000_000; // 1e9 лотов (настраиваемый лимит)

let DEV_ASSERTS=false;

let TICK = 1, PMIN = 0, PMAX = 1_000_000, LEVELS = 0, MAX_ORDERS = 1_000_000;
let STP_POLICY: 0|1|2 = 0;

let orderPriceIdx!: Int32Array;
let orderQtyLots!: Uint32Array;
let orderOwner!: Uint32Array;
let orderSideArr!: Uint8Array;
let orderPrev!: Int32Array;
let orderNext!: Int32Array;
let orderActive!: Uint8Array;
let orderId2Idx!: Int32Array;
let orderExtId!: Uint32Array;

let levelHeadBid!: Int32Array;
let levelTailBid!: Int32Array;
let bitmapBid!: Uint32Array;

let levelHeadAsk!: Int32Array;
let levelTailAsk!: Int32Array;
let bitmapAsk!: Uint32Array;

let bestBidIdx = EMPTY;
let bestAskIdx = EMPTY;

let freeTop = 0;

// counters + egress hash
let evAck=0, evTrade=0, evFilled=0, evReduced=0, evCanceled=0, evReject=0;
let tradeQtySum=0n, tradeNotionalTicksSum=0n, tradeChecksum=0n, eventHash=0n;
const PRIME=0x1_0000_01n;

const isFiniteInt = (x:number)=> Number.isFinite(x) && Math.floor(x)===x;

// ── геттеры/инициализация ───────────────────────────────────────────────────
export function getBestBidPx(){ return bestBidIdx===EMPTY ? -1 : (PMIN + bestBidIdx*TICK); }
export function getBestAskPx(){ return bestAskIdx===EMPTY ? -1 : (PMIN + bestAskIdx*TICK); }
export function getCounters(){ return { evAck, evTrade, evFilled, evReduced, evCanceled, evReject, tradeQtySum, tradeNotionalTicksSum, tradeChecksum, eventHash }; }
export function getDims(){ return { TICK, PMIN, PMAX, LEVELS, MAX_ORDERS }; }

export function resetBook(p: CoreParams){
  if (!isFiniteInt(p.tick) || p.tick<=0) throw Error("tick must be positive int");
  if (!isFiniteInt(p.pmin) || !isFiniteInt(p.pmax) || p.pmax<=p.pmin) throw Error("pmin<pmax required");
  TICK = p.tick|0; PMIN = p.pmin|0; PMAX = p.pmax|0; MAX_ORDERS = p.maxOrders|0;
  LEVELS = (((PMAX - PMIN)/TICK)|0) + 1;
  if (LEVELS<=0) throw Error("invalid price grid");
  STP_POLICY = p.stpPolicy;
  DEV_ASSERTS = !!p.devAsserts;

  orderPriceIdx = new Int32Array(MAX_ORDERS).fill(EMPTY);
  orderQtyLots  = new Uint32Array(MAX_ORDERS);
  orderOwner    = new Uint32Array(MAX_ORDERS);
  orderSideArr  = new Uint8Array(MAX_ORDERS);
  orderPrev     = new Int32Array(MAX_ORDERS).fill(EMPTY);
  orderNext     = new Int32Array(MAX_ORDERS).fill(EMPTY);
  orderActive   = new Uint8Array(MAX_ORDERS);
  orderId2Idx   = new Int32Array(MAX_ORDERS).fill(EMPTY);
  orderExtId    = new Uint32Array(MAX_ORDERS);

  levelHeadBid = new Int32Array(LEVELS).fill(EMPTY);
  levelTailBid = new Int32Array(LEVELS).fill(EMPTY);
  bitmapBid    = new Uint32Array(Math.ceil(LEVELS / BITWORD));

  levelHeadAsk = new Int32Array(LEVELS).fill(EMPTY);
  levelTailAsk = new Int32Array(LEVELS).fill(EMPTY);
  bitmapAsk    = new Uint32Array(Math.ceil(LEVELS / BITWORD));

  bestBidIdx = EMPTY; bestAskIdx = EMPTY;

  freeTop = 0;
  for (let i=0;i<MAX_ORDERS-1;i++) orderNext[i]=i+1;
  orderNext[MAX_ORDERS-1] = EMPTY;

  evAck=evTrade=evFilled=evReduced=evCanceled=evReject=0;
  tradeQtySum=0n; tradeNotionalTicksSum=0n; tradeChecksum=0n; eventHash=0n;
}

// ── бит-утилиты ──────────────────────────────────────────────────────────────
const ctz32=(x:number)=> (Math.clz32((x & -x)>>>0)^31);
function setBit(side: Side, i:number){
  const bm = side===0 ? bitmapBid : bitmapAsk;
  const w=(i/BITWORD|0), b=i&31;
  bm[w] |= (1<<b)>>>0;
}
function clearBit(side: Side, i:number){
  const bm = side===0 ? bitmapBid : bitmapAsk;
  const w=(i/BITWORD|0), b=i&31;
  bm[w] &= (~(1<<b))>>>0;
}
function findNextNonEmptyFrom(side: Side, i:number): number {
  const bm = side===1 ? bitmapAsk : bitmapBid;
  if (i<0) i=0;
  for (; i<LEVELS; ){
    const w=(i/BITWORD|0), base=w*BITWORD;
    let word=bm[w];
    if (word){
      const shift=i-base; word>>>=shift;
      if (word) return base+shift+ctz32(word);
    }
    i=base+BITWORD;
  }
  return EMPTY;
}
function findPrevNonEmptyFrom(side: Side, i:number): number {
  const bm = side===0 ? bitmapBid : bitmapAsk;
  if (i>=LEVELS) i=LEVELS-1;
  for (; i>=0; ){
    const w=(i/BITWORD|0), base=w*BITWORD;
    let word=bm[w];
    if (word){
      const upto=i-base;
      const mask = upto===31 ? 0xFFFFFFFF : ((1<<(upto+1))-1);
      word&=mask>>>0;
      if (word) return base+(31-Math.clz32(word));
    }
    i=base-1;
  }
  return EMPTY;
}

// ── очереди уровня ───────────────────────────────────────────────────────────
function enqueueTail(side: Side, levelIdx:number, idx:number){
  const head = side===0 ? levelHeadBid : levelHeadAsk;
  const tail = side===0 ? levelTailBid : levelTailAsk;

  if (head[levelIdx]===EMPTY){
    head[levelIdx]=idx; tail[levelIdx]=idx;
    orderPrev[idx]=EMPTY; orderNext[idx]=EMPTY;
    setBit(side, levelIdx);
    if (side===0){ if (bestBidIdx===EMPTY || levelIdx>bestBidIdx) bestBidIdx=levelIdx; }
    else { if (bestAskIdx===EMPTY || levelIdx<bestAskIdx) bestAskIdx=levelIdx; }
  } else {
    const t = tail[levelIdx];
    orderNext[t]=idx; orderPrev[idx]=t; orderNext[idx]=EMPTY; tail[levelIdx]=idx;
  }
}
function removeFromLevel(side: Side, levelIdx:number, idx:number){
  const head = side===0 ? levelHeadBid : levelHeadAsk;
  const tail = side===0 ? levelTailBid : levelTailAsk;

  const p=orderPrev[idx], n=orderNext[idx];
  if (p!==EMPTY) orderNext[p]=n; else head[levelIdx]=n;
  if (n!==EMPTY) orderPrev[n]=p; else tail[levelIdx]=p;
  orderPrev[idx]=orderNext[idx]=EMPTY;

  if (head[levelIdx]===EMPTY){
    clearBit(side, levelIdx);
    if (side===0 && bestBidIdx===levelIdx) bestBidIdx = findPrevNonEmptyFrom(0, levelIdx-1);
    if (side===1 && bestAskIdx===levelIdx) bestAskIdx = findNextNonEmptyFrom(1, levelIdx+1);
  }
}

function assertLevelPointers(side:Side, lvl:number){
  if (!DEV_ASSERTS) return;
  const head = side===0 ? levelHeadBid : levelHeadAsk;
  const tail = side===0 ? levelTailBid : levelTailAsk;
  if (head[lvl]===EMPTY) return;
  let cur=head[lvl], prev=EMPTY;
  while (cur!==EMPTY){
    if (orderPrev[cur]!==prev) throw Error("broken prev");
    prev=cur; cur=orderNext[cur];
  }
  if (prev!==tail[lvl]) throw Error("broken tail");
}

// ── аллок/фри ────────────────────────────────────────────────────────────────
function allocOrder():number{ const i=freeTop; if(i===EMPTY) throw Error('Out of slots'); freeTop=orderNext[i]; return i; }
function freeOrder(i:number){
  orderActive[i]=0;
  orderPriceIdx[i]=EMPTY; orderQtyLots[i]=0;
  orderOwner[i]=0; orderSideArr[i]=0;
  orderPrev[i]=EMPTY; orderNext[i]=EMPTY;
  orderExtId[i]=0;
  orderNext[i]=freeTop; freeTop=i;
}

// ── egress helpers ───────────────────────────────────────────────────────────
function bumpEventHash(tag:number, a:number, b:number, c:number){
  // очень дешёвый rolling-хэш по событиям
  eventHash = ( (eventHash*PRIME + BigInt((tag*2654435761>>>0) ^ a ^ (b<<7) ^ (c<<13))) & 0x1fffffffffffffn );
}
function emitACK(owner:number, id:number){ evAck++; if (eventSink) eventSink({k:'ACK', owner, id}); bumpEventHash(1, owner, id, 0); }
function emitREJECT(owner:number, id:number, reason:string){ evReject++; if (eventSink) eventSink({k:'REJECT', owner, id, reason}); bumpEventHash(2, owner, id, reason.length); }
function emitTRADE(px:number, qty:number, makerOwner:number, takerOwner:number){
  evTrade++;
  tradeQtySum+=BigInt(qty);
  tradeNotionalTicksSum+=BigInt(px)*BigInt(qty);
  const mix=(BigInt((px<<16) ^ qty) & 0x1fffffffffffffn);
  tradeChecksum=( (tradeChecksum*PRIME + mix) & 0x1fffffffffffffn );
  if (eventSink) eventSink({k:'TRADE', px, qty, makerOwner, takerOwner});
  bumpEventHash(3, px|0, qty|0, (makerOwner^takerOwner)|0);
}
function emitFILLED(){ evFilled++; }
function emitREDUCED(owner:number, id:number, delta:number, remain:number){ evReduced++; if (eventSink) eventSink({k:'REDUCED', owner, id, delta, remain}); bumpEventHash(4, owner, id, remain); }
function emitCANCELED(owner:number, id:number){ evCanceled++; if (eventSink) eventSink({k:'CANCELED', owner, id}); bumpEventHash(5, owner, id, 0); }

// ── STP ──────────────────────────────────────────────────────────────────────
function stp(ownerMaker:number, ownerTaker:number): 0|1|2 {
  if (ownerMaker!==ownerTaker) return 0;
  if (STP_POLICY===1) return 1;
  if (STP_POLICY===2) return 2;
  return 0;
}

// ── превью объёма для FOK (только для FOK) ───────────────────────────────────
function previewFill(side:Side, limitLevel:number, desired:number): boolean {
  let need = desired;
  if (side===0){ // BUY против ASK
    let lvl = bestAskIdx;
    while (need>0 && lvl!==EMPTY && lvl<=limitLevel){
      let cur = levelHeadAsk[lvl];
      while (need>0 && cur!==EMPTY){
        if (orderActive[cur]) need -= Math.min(need, orderQtyLots[cur]>>>0);
        cur = orderNext[cur];
      }
      lvl = findNextNonEmptyFrom(1, lvl+1);
    }
  } else {       // SELL против BID
    let lvl = bestBidIdx;
    while (need>0 && lvl!==EMPTY && lvl>=limitLevel){
      let cur = levelHeadBid[lvl];
      while (need>0 && cur!==EMPTY){
        if (orderActive[cur]) need -= Math.min(need, orderQtyLots[cur]>>>0);
        cur = orderNext[cur];
      }
      lvl = findPrevNonEmptyFrom(0, lvl-1);
    }
  }
  return need<=0;
}

// ── ядро: new/cancel/replace ─────────────────────────────────────────────────
export function newOrder(owner:number, orderId:number, side:Side, priceTicks:number, qtyLots:number, tif:TIF=0, postOnly=false, reduceOnly=false){
  // валидации
  if (!isFiniteInt(priceTicks) || !isFiniteInt(qtyLots)){ emitREJECT(owner, orderId, 'non-integer'); return; }
  if (qtyLots<=0 || qtyLots>MAX_QTY){ emitREJECT(owner, orderId, 'qty out of range'); return; }
  const levelIdx=((priceTicks-PMIN)/TICK)|0;
  if (levelIdx<0 || levelIdx>=LEVELS){ emitREJECT(owner, orderId, 'price out of range'); return; }
  if (orderId<MAX_ORDERS && orderId2Idx[orderId]!==EMPTY && orderActive[orderId2Idx[orderId]]){ emitREJECT(owner, orderId, 'duplicate orderId'); return; }

  let remaining = qtyLots>>>0;

  // FOK превью
  if (tif===2){
    const ok = side===0
      ? previewFill(0, levelIdx, remaining)
      : previewFill(1, levelIdx, remaining);
    if (!ok){ emitREJECT(owner, orderId, 'FOK insufficient'); return; }
  }

  if (side===0){
    if (postOnly && bestAskIdx!==EMPTY && bestAskIdx<=levelIdx){ emitREJECT(owner, orderId, 'postOnly would cross'); return; }
    while (remaining>0 && bestAskIdx!==EMPTY && bestAskIdx<=levelIdx){
      remaining = fillAgainstAsk(bestAskIdx, remaining, owner, orderId);
      if (bestAskIdx!==EMPTY && levelHeadAsk[bestAskIdx]===EMPTY) bestAskIdx = findNextNonEmptyFrom(1, bestAskIdx+1);
    }
  } else {
    if (postOnly && bestBidIdx!==EMPTY && bestBidIdx>=levelIdx){ emitREJECT(owner, orderId, 'postOnly would cross'); return; }
    while (remaining>0 && bestBidIdx!==EMPTY && bestBidIdx>=levelIdx){
      remaining = fillAgainstBid(bestBidIdx, remaining, owner, orderId);
      if (bestBidIdx!==EMPTY && levelHeadBid[bestBidIdx]===EMPTY) bestBidIdx = findPrevNonEmptyFrom(0, bestBidIdx-1);
    }
  }

  if (remaining>0){
    // reduceOnly — как IOC (остаток не ставим в книгу)
    if (reduceOnly || tif===1){ if (qtyLots!==remaining) emitFILLED(); else emitREJECT(owner, orderId, reduceOnly?'reduceOnly no reduce':'IOC no fill'); return; }
    const idx=allocOrder();
    orderPriceIdx[idx]=levelIdx;
    orderQtyLots[idx]=remaining;
    orderOwner[idx]=owner;
    orderSideArr[idx]=side;
    orderActive[idx]=1;
    orderExtId[idx]=orderId;
    enqueueTail(side, levelIdx, idx);
    if (orderId<MAX_ORDERS) orderId2Idx[orderId]=idx;
    emitACK(owner, orderId);
  } else {
    emitFILLED();
  }
}

function fillAgainstBid(levelIdx:number, remaining:number, takerOwner:number, takerId:number): number {
  while (remaining>0){
    const head = levelHeadBid[levelIdx];
    if (head===EMPTY) return remaining;
    if (!orderActive[head]){ removeFromLevel(0, levelIdx, head); freeOrder(head); continue; }

    const makerOwner=orderOwner[head];
    const s = stp(makerOwner, takerOwner);
    if (s===1){ emitREJECT(takerOwner, takerId, 'STP cancel taker'); return remaining; }

    const makerQty=orderQtyLots[head]>>>0;
    const pxTicks=PMIN + levelIdx*TICK;
    const tradeQty = makerQty < remaining ? makerQty : remaining;

    if (s===2){
      const dec = Math.min(makerQty, remaining);
      orderQtyLots[head]=makerQty - dec;
      emitREDUCED(makerOwner, orderExtId[head], -dec, orderQtyLots[head]>>>0);
      if (orderQtyLots[head]===0){ removeFromLevel(0, levelIdx, head); freeOrder(head); emitFILLED(); }
      // тейкер остаётся прежним (reduce-maker)
      continue;
    } else {
      const newMakerQty = makerQty - tradeQty;
      orderQtyLots[head]=newMakerQty;
      remaining -= tradeQty;
      emitTRADE(pxTicks, tradeQty, makerOwner, takerOwner);

      if (newMakerQty===0){
        removeFromLevel(0, levelIdx, head);
        freeOrder(head);
        emitFILLED();
      } else {
        emitREDUCED(makerOwner, orderExtId[head], -tradeQty, newMakerQty>>>0);
        break;
      }
    }
  }
  return remaining;
}

function fillAgainstAsk(levelIdx:number, remaining:number, takerOwner:number, takerId:number): number {
  while (remaining>0){
    const head = levelHeadAsk[levelIdx];
    if (head===EMPTY) return remaining;
    if (!orderActive[head]){ removeFromLevel(1, levelIdx, head); freeOrder(head); continue; }

    const makerOwner=orderOwner[head];
    const s = stp(makerOwner, takerOwner);
    if (s===1){ emitREJECT(takerOwner, takerId, 'STP cancel taker'); return remaining; }

    const makerQty=orderQtyLots[head]>>>0;
    const pxTicks=PMIN + levelIdx*TICK;
    const tradeQty = makerQty < remaining ? makerQty : remaining;

    if (s===2){
      const dec = Math.min(makerQty, remaining);
      orderQtyLots[head]=makerQty - dec;
      emitREDUCED(makerOwner, orderExtId[head], -dec, orderQtyLots[head]>>>0);
      if (orderQtyLots[head]===0){ removeFromLevel(1, levelIdx, head); freeOrder(head); emitFILLED(); }
      continue;
    } else {
      const newMakerQty = makerQty - tradeQty;
      orderQtyLots[head]=newMakerQty;
      remaining -= tradeQty;
      emitTRADE(pxTicks, tradeQty, makerOwner, takerOwner);

      if (newMakerQty===0){
        removeFromLevel(1, levelIdx, head);
        freeOrder(head);
        emitFILLED();
      } else {
        emitREDUCED(makerOwner, orderExtId[head], -tradeQty, newMakerQty>>>0);
        break;
      }
    }
  }
  return remaining;
}

export function cancel(owner:number, orderId:number){
  const idx = (orderId<MAX_ORDERS)? orderId2Idx[orderId] : EMPTY;
  if (idx===EMPTY || !orderActive[idx]){ emitREJECT(owner, orderId, 'not found'); return; }
  const lvl = orderPriceIdx[idx];
  const s   = orderSideArr[idx] as Side;
  removeFromLevel(s, lvl, idx);
  const oOwner = orderOwner[idx], oExt = orderExtId[idx];
  freeOrder(idx);
  orderId2Idx[orderId]=EMPTY;
  emitCANCELED(oOwner, oExt);
}

export function replace(owner:number, orderId:number, newPriceTicks:number|null, qtyDeltaLots:number){
  const idx = (orderId<MAX_ORDERS)? orderId2Idx[orderId] : EMPTY;
  if (idx===EMPTY || !orderActive[idx]){ emitREJECT(owner, orderId, 'not found'); return; }
  if (!isFiniteInt(qtyDeltaLots)){ emitREJECT(owner, orderId, 'bad delta'); return; }

  const curQty = orderQtyLots[idx]>>>0;
  const wantQty = curQty + qtyDeltaLots;
  if (wantQty<=0){ // cancel
    const lvl=orderPriceIdx[idx];
    const s  = orderSideArr[idx] as Side;
    removeFromLevel(s, lvl, idx); const oOwner=orderOwner[idx], oExt=orderExtId[idx]; freeOrder(idx); orderId2Idx[orderId]=EMPTY; emitCANCELED(oOwner, oExt); return;
  }
  if (wantQty>MAX_QTY){ emitREJECT(owner, orderId, 'qty overflow'); return; }

  let targetLevelIdx = orderPriceIdx[idx];
  let changed=false;

  if (newPriceTicks!==null){
    if (!isFiniteInt(newPriceTicks)){ emitREJECT(owner, orderId, 'bad price'); return; }
    const li=((newPriceTicks-PMIN)/TICK|0);
    if (li<0 || li>=LEVELS){ emitREJECT(owner, orderId, 'price out of range'); return; }
    if (li!==targetLevelIdx){ targetLevelIdx=li; changed=true; }
  }
  if (qtyDeltaLots>0) changed=true;

  if (!changed){
    orderQtyLots[idx]=wantQty>>>0; emitREDUCED(orderOwner[idx], orderExtId[idx], qtyDeltaLots, wantQty>>>0); return;
  }

  const prevLevel = orderPriceIdx[idx];
  const s = orderSideArr[idx] as Side;
  removeFromLevel(s, prevLevel, idx);
  orderPriceIdx[idx]=targetLevelIdx;
  orderQtyLots[idx]=wantQty>>>0;
  enqueueTail(s, targetLevelIdx, idx);
  emitACK(orderOwner[idx], orderExtId[idx]);
  if (DEV_ASSERTS){ assertLevelPointers(s, targetLevelIdx); }
}

// ── API wrapper ──────────────────────────────────────────────────────────────
export function applyCommand(c: Cmd){
  if (c.kind===0) newOrder(c.owner, c.orderId, c.side, c.priceTicks, c.qtyLots, c.tif, c.postOnly, c.reduceOnly);
  else if (c.kind===1) cancel(c.owner, c.orderId);
  else replace(c.owner, c.orderId, c.newPriceTicks, c.qtyDeltaLots);
}

// ── снапшоты/хэш ─────────────────────────────────────────────────────────────
export function computeStateHash(): string {
  const h=createHash('sha256');
  h.update(new Uint8Array(orderActive.buffer));
  h.update(new Uint8Array(orderPriceIdx.buffer));
  h.update(new Uint8Array(orderQtyLots.buffer));
  h.update(new Uint8Array(levelHeadBid.buffer));
  h.update(new Uint8Array(levelTailBid.buffer));
  h.update(new Uint8Array(bitmapBid.buffer));
  h.update(new Uint8Array(levelHeadAsk.buffer));
  h.update(new Uint8Array(levelTailAsk.buffer));
  h.update(new Uint8Array(bitmapAsk.buffer));
  const t = Buffer.from(JSON.stringify(getCountersCompact()));
  h.update(t);
  return h.digest('hex');
}
function getCountersCompact(){
  return {
    evAck, evTrade, evFilled, evReduced, evCanceled, evReject,
    tradeQtySum: tradeQtySum.toString(),
    tradeNotionalTicksSum: tradeNotionalTicksSum.toString(),
    tradeChecksum: tradeChecksum.toString(),
    eventHash: eventHash.toString()
  };
}
export function snapshotLine(seed:number, ops:number){
  const rs = restingSummary();
  const c  = getCounters();
  return [
    `seed:${seed}`, `ops:${ops}`,
    `ack:${c.evAck}`, `trade:${c.evTrade}`, `filled:${c.evFilled}`, `reduced:${c.evReduced}`, `canceled:${c.evCanceled}`, `reject:${c.evReject}`,
    `tQty:${c.tradeQtySum.toString()}`, `tNotional:${c.tradeNotionalTicksSum.toString()}`, `tChk:${c.tradeChecksum.toString()}`, `eHash:${c.eventHash.toString()}`,
    `restCnt:${rs.restingCount}`, `restLots:${rs.restingLots}`, `bb:${rs.bestBidPx}`, `ba:${rs.bestAskPx}`
  ].join('|');
}
export function restingSummary(){
  let restingCount=0; let restingLots=0n;
  for (let lvl=0; lvl<LEVELS; lvl++){
    let curB = levelHeadBid[lvl];
    while (curB!==EMPTY){ if (orderActive[curB]){ restingCount++; restingLots+=BigInt(orderQtyLots[curB]); } curB=orderNext[curB]; }
    let curA = levelHeadAsk[lvl];
    while (curA!==EMPTY){ if (orderActive[curA]){ restingCount++; restingLots+=BigInt(orderQtyLots[curA]); } curA=orderNext[curA]; }
  }
  return { restingCount, restingLots: restingLots.toString(), bestBidPx: getBestBidPx(), bestAskPx: getBestAskPx() };
}

// ── ASCII: без агрегации, qty@owner; выравнивание до раскраски ──────────────
export function renderAscii(depth=10, perLevelOrders=10): string {
  const rows: string[] = [];
  const pad = (s:string,n:number)=> (s.length>=n? s : " ".repeat(n-s.length)+s);

  const buildSide = (side:Side, start:number, iter:(i:number)=>number, cmp:(i:number)=>boolean) => {
    const out: {px:number;orders:string[]}[] = [];
    let idx = start;
    while (idx!==EMPTY && cmp(idx) && out.length<depth){
      let cur = side===0 ? levelHeadBid[idx] : levelHeadAsk[idx];
      const parts:string[]=[];
      let count=0;
      while (cur!==EMPTY && count<perLevelOrders){
        if (orderActive[cur]){ parts.push(`${orderQtyLots[cur]}@${orderOwner[cur]}`); count++; }
        cur=orderNext[cur];
      }
      if (parts.length>0) out.push({px: PMIN+idx*TICK, orders: parts});
      idx = iter(idx);
    }
    return out;
  };

  const bids = buildSide(0, bestBidIdx, i=>findPrevNonEmptyFrom(0, i-1), _=>true);
  const asks = buildSide(1, bestAskIdx, i=>findNextNonEmptyFrom(1, i+1), _=>true);

  const BOLD = "\x1b[1m", DIM="\x1b[2m", RESET="\x1b[0m";
  const GREEN="\x1b[32m", RED="\x1b[31m";

  const widthPx=8, widthStr=56;
  rows.push(`${BOLD}       BID (qty@owner)              |            ASK (qty@owner)      ${RESET}`);
  rows.push(`${DIM}     PX         ORDERS              |        PX         ORDERS        ${RESET}`);
  for (let i=0;i<depth;i++){
    const b=bids[i]; const a=asks[i];
    const bL = b ? `${pad(String(b.px),widthPx)} ${pad(b.orders.join(","),widthStr)}` : `${" ".repeat(widthPx)} ${" ".repeat(widthStr)}`;
    const aR = a ? `${pad(String(a.px),widthPx)} ${pad(a.orders.join(","),widthStr)}` : `${" ".repeat(widthPx)} ${" ".repeat(widthStr)}`;
    rows.push(`${GREEN}${bL}${RESET} | ${RED}${aR}${RESET}`);
  }
  return rows.join("\n");
}