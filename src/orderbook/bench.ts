// src/orderbook/bench.ts
import * as fs from "fs";
import * as path from "path";
import {
  CoreParams, Cmd, Side,
  resetBook, applyCommand, newOrder, cancel, replace,
  snapshotLine, computeStateHash, renderAscii, setEventSink, EgressEvent
} from "./lob_core";

// ——— CLI ——————————————————————————————————————————————————
const argv = process.argv.slice(2);
const num = (k:string, d:number)=>{ const a=argv.find(x=>x.startsWith(`--${k}=`)); return a? Number(a.split("=")[1]): d; };
const flag= (k:string)=> argv.some(x=>x===`--${k}`||x===`--${k}=1`||x===`--${k}=true`);

const SEED = num("seed", 0xC0FFEE);
const OPS  = Math.max(1, num("ops", 500_000));
const ADD_PCT    = num("addPct", 55)/100;
const CANCEL_PCT = num("cancelPct", 25)/100;
const REPLACE_PCT= num("replacePct", 20)/100; // больше reduce → больше ордеров на уровне
const ASCII_MODE = flag("ascii");
const ASCII_DEPTH= num("depth", 10);
const ASCII_PERLEVEL = num("perLevel", 10);
const USE_API = flag("api");           // если true — через applyCommand()
const STP = num("stp", 0) as 0|1|2;    // по умолчанию off в бенче

const params: CoreParams = {
  tick: num("tick", 1),
  pmin: num("pmin", 0),
  pmax: num("pmax", 2_000_000), // шире сетка → глубже стакан
  maxOrders: num("maxOrders", 2_000_000),
  stpPolicy: STP,
};

// ——— RNG ——————————————————————————————————————————————————
let RNG = (SEED>>>0);
const rndU32=()=>{ let x=RNG|0; x^=x<<13; x^=x>>>17; x^=x<<5; RNG=x|0; return x>>>0; };
const rnd01=()=> rndU32()/0xFFFFFFFF;

// ——— pregen (state-free) ——————————————————————————————
type K = 0|1|2; // ADD/CANCEL/REPLACE
const kinds = new Uint8Array(OPS);
const sides = new Uint8Array(OPS);
const prices= new Int32Array(OPS);
const qtys  = new Uint16Array(OPS);
const deltas= new Int32Array(OPS);
const orderIds = new Int32Array(OPS);

function pregen(){
  const {tick, pmin, pmax} = params;
  const LEVELS = (((pmax - pmin)/tick)|0)+1;
  const mid = (LEVELS>>1);
  const BAND = 2000; // ещё шире → много разноуровневых заявок

  let nextId = 1;
  for (let i=0;i<OPS;i++){
    const r = rnd01();
    if (r < ADD_PCT){
      kinds[i]=0;
      const wide = (rndU32() % 10) < 4;
      const offs = wide ? ((rndU32()% (BAND*4)) - (BAND*2)) : ((rndU32()% (BAND*2)) - BAND);
      const levelIdx = Math.max(0, Math.min(LEVELS-1, mid + (offs|0)));
      prices[i] = pmin + levelIdx*tick;
      sides[i] = (rndU32() & 1) as Side;
      qtys[i]   = ((rndU32()%3|0)+1) as number; // 1..3 — много отдельных ордеров
      orderIds[i]= nextId++;
    } else if (r < ADD_PCT + CANCEL_PCT){
      kinds[i]=1;
      orderIds[i] = Math.max(1, nextId - ((rndU32()%4096|0)+1)); // целимся в «недавние»
    } else {
      kinds[i]=2; // replace-reduce (size-down)
      orderIds[i] = Math.max(1, nextId - ((rndU32()%4096|0)+1));
      deltas[i]   = -(((rndU32()%3|0)+1)|0); // reduce 1..3
      prices[i]   = 0;
    }
  }
}

// ——— snapshot DB —————————————————————————————————————————
const SNAP_DB = path.resolve(process.cwd(), "bench_snapshots.json");
function loadSnapDb(): Record<string,string> {
  try { if (fs.existsSync(SNAP_DB)) return JSON.parse(fs.readFileSync(SNAP_DB,"utf8")); } catch {}
  return {};
}
function saveSnapDb(db: Record<string,string>){ fs.writeFileSync(SNAP_DB, JSON.stringify(db,null,2), "utf8"); }

// ——— ASCII events pretty print ——————————————————————————
const BOLD = "\x1b[1m", DIM="\x1b[2m", RESET="\x1b[0m";
const GREEN="\x1b[32m", RED="\x1b[31m", CYAN="\x1b[36m", YELLOW="\x1b[33m", MAGENTA="\x1b[35m";

function fmtEv(e:EgressEvent): string {
  switch (e.k){
    case 'ACK':      return `${DIM}[ACK]${RESET} owner=${e.owner} id=${e.id}`;
    case 'REJECT':   return `${YELLOW}[REJECT]${RESET} owner=${e.owner} id=${e.id} reason=${e.reason}`;
    case 'CANCELED': return `${MAGENTA}[CANCEL]${RESET} owner=${e.owner} id=${e.id}`;
    case 'REDUCED':  return `${CYAN}[REDUCE]${RESET} owner=${e.owner} id=${e.id} Δ=${e.delta} rem=${e.remain}`;
    case 'TRADE':    return `${BOLD}[TRADE]${RESET} px=${e.px} qty=${e.qty} maker=${e.makerOwner} taker=${e.takerOwner}`;
  }
}

// ——— ASCII mode runner ——————————————————————————————————
function runAscii(){
  const events: EgressEvent[] = [];
  setEventSink((e)=>{ events.push(e); });

  console.log(`${BOLD}ASCII playthrough${RESET} (ops=${OPS}, seed=${SEED})`);
  for (let i=0;i<OPS;i++){
    events.length = 0; // очистить буфер событий на шаг

    const k = kinds[i] as K;
    if (k===0){
      const id=orderIds[i]; const side=sides[i] as Side; const px=prices[i]; const q=qtys[i];
      console.log(`\n${BOLD}#${i+1} ADD${RESET} owner=${id} side=${side===0?GREEN+'BUY'+RESET:RED+'SELL'+RESET} px=${px} qty=${q}`);
      newOrder(id, id, side, px, q, 0, false, false);
    } else if (k===1){
      const id=orderIds[i];
      console.log(`\n${BOLD}#${i+1} CANCEL${RESET} owner=${id} id=${id}`);
      cancel(id, id);
    } else {
      const id=orderIds[i]; const d=deltas[i];
      console.log(`\n${BOLD}#${i+1} REPLACE-REDUCE${RESET} owner=${id} id=${id} delta=${d}`);
      replace(id, id, null, d);
    }

    // события шага
    if (events.length){
      for (const e of events) console.log("  " + fmtEv(e));
    } else {
      console.log(`  ${DIM}(no events)${RESET}`);
    }

    // текущий стакан
    console.log(renderAscii(ASCII_DEPTH, ASCII_PERLEVEL));
  }

  // выключаем sink
  setEventSink(null);
}

// ——— бенч ————————————————————————————————————————————————
function runBench(){
  setEventSink(null); // никакого захвата событий в бенче
  let adds=0, cancels=0, replaces=0;

  const t0 = process.hrtime.bigint();
  for (let i=0;i<OPS;i++){
    const k = kinds[i] as K;
    if (!USE_API){
      if (k===0){ newOrder(orderIds[i], orderIds[i], sides[i] as Side, prices[i], qtys[i], 0, false, false); adds++; }
      else if (k===1){ cancel(orderIds[i], orderIds[i]); cancels++; }
      else { replace(orderIds[i], orderIds[i], null, deltas[i]|0); replaces++; }
    } else {
      let cmd: Cmd;
      if (k===0) cmd = {kind:0, owner:orderIds[i], orderId:orderIds[i], side:sides[i] as Side, tif:0, postOnly:false, reduceOnly:false, priceTicks:prices[i], qtyLots:qtys[i]};
      else if (k===1) cmd = {kind:1, owner:orderIds[i], orderId:orderIds[i]};
      else cmd = {kind:2, owner:orderIds[i], orderId:orderIds[i], newPriceTicks:null, qtyDeltaLots:deltas[i]|0};
      applyCommand(cmd);
      if (k===0) adds++; else if (k===1) cancels++; else replaces++;
    }
  }
  const t1 = process.hrtime.bigint();
  const dtMs = Number(t1 - t0) / 1e6;
  const opsSec = (OPS / dtMs) * 1000;

  return { dtMs, opsSec, adds, cancels, replaces };
}

// ——— main ————————————————————————————————————————————————
function main(){
  resetBook(params);
  RNG = (SEED>>>0);
  pregen();

  if (ASCII_MODE){
    if (OPS>300) console.warn("ASCII mode: set --ops ≈100–300 для читаемости.");
    runAscii();
    const snap = snapshotLine(SEED, OPS);
    const hash = computeStateHash();
    console.log(`${snap}|hash:${hash}`);
    return;
  }

  const { dtMs, opsSec, adds, cancels, replaces } = runBench();

  const snap = snapshotLine(SEED, OPS);
  const hash = computeStateHash();
  const line = `${snap}|hash:${hash}`;

  console.log(`ops=${OPS}, time=${dtMs.toFixed(2)} ms, ~${opsSec.toFixed(0)} ops/sec`);
  console.log(`adds=${adds}, cancels=${cancels}, replaces=${replaces}`);
  console.log(line);

  const db = loadSnapDb();
  const prev = db[String(SEED)];
  if (prev){
    if (prev === line) console.log(`CHECK: OK (seed ${SEED})`);
    else { console.log(`CHECK: FAIL (seed ${SEED})`); console.log(`prev: ${prev}`); console.log(`curr: ${line}`); }
  } else {
    db[String(SEED)] = line;
    saveSnapDb(db);
    console.log(`SNAPSHOT SAVED for seed ${SEED} -> ${path.basename(SNAP_DB)}`);
  }
}

if (require.main === module) main();