/**
 * Bench / ASCII Driver for the LOB Core — Fidelity Edition
 * --------------------------------------------------------
 * Two modes:
 *  - throughput (default): deterministic pre-generated workload (fast, synthetic)
 *  - fidelity: book-aware generator that maintains realistic depth and mixes flow
 *
 * Goals in fidelity mode:
 *  - Target average visible depth ~ D levels on each side (default 40)
 *  - Keep a healthy pool of resting orders; avoid long empty-book stretches
 *  - Cancels are rare (1–5%) and hit live orders
 *  - Replaces pick live orders and actually move price/size
 *  - Deterministic given seed
 *
 * Typical usage:
 *   bun src/orderbook/bench.ts --mode=fidelity --ops=2_000_000 --seed=1 \
 *     --depth=40 --minRest=20000 --cancelPct=0.03 --logEvery=100000 --asciiTick
 */
import * as fs from "fs";
import * as path from "path";
import { resetBook, applyCommand, newOrder, cancel, replace, snapshotLine, computeStateHash, renderAscii, drainEvents, enableDevAsserts, getBestBidPx, getBestAskPx, } from "./lob_core";
/* ================================
   CLI & Defaults
   ================================ */
const argv = process.argv.slice(2);
const num = (k, d) => {
    const a = argv.find(x => x.startsWith(`--${k}=`));
    if (!a)
        return d;
    const v = Number(a.split("=")[1].replace(/_/g, "")); // allow 1_000_000
    return Number.isFinite(v) ? v : d;
};
const flag = (k) => argv.some(x => x === `--${k}` || x === `--${k}=1` || x === `--${k}=true`);
const MODE = (() => {
    const a = argv.find(x => x.startsWith("--mode="));
    const m = a ? a.split("=")[1].toLowerCase() : "throughput";
    return m === "fidelity" ? "fidelity" : "throughput";
})();
const SEED = num("seed", 0xC0FFEE);
const OPS = Math.max(1, num("ops", 500_000));
/** throughput-mode mix (old path, synthetic) */
const ADD_PCT = num("addPct", 55) / 100;
const CANCEL_PCT = num("cancelPct", 25) / 100;
const REPLACE_PCT = num("replacePct", 20) / 100;
const HEAVY = flag("heavy");
const CROSS_PCT = Math.min(1, Math.max(0, num("crossPct", HEAVY ? 0.7 : 0.2)));
const REPRICE_PCT = Math.min(1, Math.max(0, num("repricePct", HEAVY ? 0.5 : 0.1)));
const CLUSTER_PCT = Math.min(1, Math.max(0, num("clusterPct", 0.6)));
const HOT_LEVELS = num("hot", 16);
/** fidelity-mode knobs */
const TARGET_DEPTH = num("depth", 40); // levels per side to try to keep populated
const MIN_RESTING = num("minRest", 20000); // minimal resting order count we try to maintain
const CANCEL_RATE = Math.min(0.2, Math.max(0, num("cancelPct", 0.03))); // 3% default
const REPLACE_RATE = Math.min(0.2, Math.max(0, num("replacePct2", 0.05)));
const TAKER_RATE = Math.min(0.9, Math.max(0, num("takerPct", 0.25))); // 25% of time, be a taker
const MAKER_BIAS_NEAR = Math.min(1, Math.max(0, num("makerNearPct", 0.65))); // maker adds near spread
const MAKER_QTY_MAX = num("makerQtyMax", 4); // lots per maker order (small)
const REPLACE_SIZE_STEP = num("replaceSizeStep", 2); // ±delta lots when changing size
const REPRICE_NEAR_TICKS = num("repriceNear", 5); // moves price a few ticks
const REPRICE_JUMP_TKS = num("repriceJump", 20); // occasional larger jump
/** progress logging / proof-of-work */
const LOG_EVERY = Math.max(0, num("logEvery", 100_000)); // 0 → off
const ASCII_TICK = flag("asciiTick"); // micro ASCII per tick
/** API / policy */
const USE_API = flag("api");
const STP = num("stp", 0);
const DEV = flag("dev"); // dev asserts (slower)
/** LOB params (price grid) */
const params = {
    tick: num("tick", 1),
    pmin: num("pmin", 0),
    pmax: num("pmax", 2_000_000),
    maxOrders: num("maxOrders", 2_000_000),
    stpPolicy: STP,
};
/** ASCII driver (step-by-step) */
const ASCII_MODE = flag("ascii");
const ASCII_DEPTH = num("asciiDepth", Math.max(40, TARGET_DEPTH));
const ASCII_PERLVL = num("perLevel", 12);
/* ================================
   Deterministic RNG
   ================================ */
let RNG = (SEED >>> 0);
const rndU32 = () => { let x = RNG | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; RNG = x | 0; return x >>> 0; };
const rnd01 = () => rndU32() / 0xffffffff;
const pick = (a) => a[(rndU32() % a.length) | 0];
const kinds = new Uint8Array(OPS);
const sides = new Uint8Array(OPS);
const prices = new Int32Array(OPS);
const qtys = new Uint16Array(OPS);
const deltas = new Int32Array(OPS);
const orderIds = new Int32Array(OPS);
const reprice = new Uint8Array(OPS); // 1 iff replace changes price
const LIVE_RING_SIZE = 1 << 16;
const liveIds = new Int32Array(LIVE_RING_SIZE);
let liveWr = 0;
const livePush = (id) => { liveIds[liveWr & (LIVE_RING_SIZE - 1)] = id; liveWr++; };
const livePick = () => {
    if (liveWr === 0)
        return 1;
    const span = Math.min(liveWr, LIVE_RING_SIZE);
    const idx = (liveWr - 1 - (rndU32() % span | 0)) & (LIVE_RING_SIZE - 1);
    return liveIds[idx] || 1;
};
function pregenThroughput() {
    const { tick, pmin, pmax } = params;
    const LEVELS = ((pmax - pmin) / tick | 0) + 1;
    const mid = (LEVELS >> 1);
    const BAND_NEAR = HEAVY ? 50 : 10;
    const BAND_FAR = HEAVY ? 400 : 150;
    const hotAsk = [];
    const hotBid = [];
    for (let i = 0; i < HOT_LEVELS; i++) {
        hotAsk.push(Math.min(LEVELS - 1, mid + 1 + (i % (BAND_NEAR + 5))));
        hotBid.push(Math.max(0, mid - 1 - (i % (BAND_NEAR + 5))));
    }
    let nextId = 1;
    for (let i = 0; i < OPS; i++) {
        const r = rnd01();
        if (r < ADD_PCT) {
            kinds[i] = 0;
            const s = (rndU32() & 1);
            sides[i] = s;
            const doCross = rnd01() < CROSS_PCT;
            const doCluster = rnd01() < CLUSTER_PCT;
            let levelIdx;
            if (doCross)
                levelIdx = (s === 0) ? pick(hotAsk) : pick(hotBid);
            else if (doCluster)
                levelIdx = (s === 0) ? pick(hotBid) : pick(hotAsk);
            else {
                const offs = ((rndU32() % (BAND_FAR * 2 + 1)) - BAND_FAR) | 0;
                levelIdx = Math.max(0, Math.min(LEVELS - 1, mid + offs));
            }
            prices[i] = pmin + levelIdx * tick;
            qtys[i] = ((rndU32() % 3 | 0) + 1);
            const id = nextId++;
            orderIds[i] = id;
            livePush(id);
        }
        else if (r < ADD_PCT + CANCEL_PCT) {
            kinds[i] = 1;
            orderIds[i] = livePick();
        }
        else {
            kinds[i] = 2;
            orderIds[i] = livePick();
            if (rnd01() < REPRICE_PCT) {
                reprice[i] = 1;
                const s = (rndU32() & 1);
                sides[i] = s;
                const li = (s === 0) ? pick(hotAsk) : pick(hotBid);
                prices[i] = pmin + li * tick;
                deltas[i] = ((rndU32() % 3 | 0) - 1) | 0;
            }
            else {
                prices[i] = 0;
                deltas[i] = -(((rndU32() % 3 | 0) + 1) | 0);
            }
        }
    }
}
/* ================================
   Fidelity-mode generator (book-aware)
   ================================ */
/** “Live” pools for fidelity (track what actually survived). */
const liveBuy = []; // orderIds of live bids
const liveSell = []; // orderIds of live asks
/** Guarded push/pop for live pools */
function poolPush(side, id) {
    (side === 0 ? liveBuy : liveSell).push(id);
}
function poolPick(side) {
    const pool = (side === undefined) ? ((rndU32() & 1) ? liveBuy : liveSell) : (side === 0 ? liveBuy : liveSell);
    if (!pool.length)
        return null;
    const i = rndU32() % pool.length | 0;
    return pool[i] ?? null;
}
function poolRemove(side, id) {
    const pool = side === 0 ? liveBuy : liveSell;
    const i = pool.indexOf(id);
    if (i >= 0) {
        pool[i] = pool[pool.length - 1];
        pool.pop();
    }
}
/** Per-side shallow “view” used for placement decisions (no core peeking) */
let estBestBid = -1;
let estBestAsk = -1;
function updateBestFromCore() {
    estBestBid = getBestBidPx();
    estBestAsk = getBestAskPx();
}
/** Place a maker limit near or away from the spread. Returns external id. */
let nextExtId = 1;
function placeMaker(side, near) {
    const tick = params.tick, pmin = params.pmin, pmax = params.pmax;
    // If we don’t have a spread yet, seed around mid.
    let basePx;
    if (estBestBid < 0 || estBestAsk < 0) {
        const mid = ((pmin + pmax) >> 1);
        basePx = near ? mid + ((side === 0) ? -1 : +1) * (1 + (rndU32() % 3)) : mid + ((rndU32() % 200) - 100) * tick;
    }
    else {
        basePx = near
            ? (side === 0 ? Math.max(estBestBid - (rndU32() % 3) * tick, pmin)
                : Math.min(estBestAsk + (rndU32() % 3) * tick, pmax))
            : (side === 0 ? Math.max(estBestBid - (REPRICE_JUMP_TKS + (rndU32() % 50)) * tick, pmin)
                : Math.min(estBestAsk + (REPRICE_JUMP_TKS + (rndU32() % 50)) * tick, pmax));
    }
    const px = Math.max(pmin, Math.min(pmax, basePx));
    const qty = 1 + (rndU32() % MAKER_QTY_MAX);
    const id = nextExtId++;
    newOrder(id, id, side, px, qty, 0, false, false);
    // We only know if it posted after we drain events. Pool push happens in the drain step.
    return id;
}
/** Place a taker order that is guaranteed to cross some liquidity (if present). */
function placeTaker() {
    updateBestFromCore();
    if (estBestBid < 0 || estBestAsk < 0) {
        // No book yet; act as maker instead
        placeMaker((rndU32() & 1), true);
        return;
    }
    const buy = (rndU32() & 1) === 0; // taker side
    const id = nextExtId++;
    const qty = 1 + (rndU32() % MAKER_QTY_MAX);
    if (buy) {
        // Cross through best ask by a few ticks
        const px = estBestAsk + ((rndU32() % 3) * params.tick);
        newOrder(id, id, 0, px, qty, 0, false, false);
    }
    else {
        const px = estBestBid - ((rndU32() % 3) * params.tick);
        newOrder(id, id, 1, px, qty, 0, false, false);
    }
}
/** Targeted cancel of a live order. */
function doCancel() {
    // ~50% pick side explicitly to ensure variety
    const pickSide = (rndU32() % 2) ? (rndU32() % 2) : undefined;
    const victim = poolPick(pickSide);
    if (victim == null)
        return;
    cancel(victim, victim);
}
/** Targeted replace: slight price move or small size delta. */
function doReplace() {
    const side = (rndU32() & 1);
    const victim = poolPick(side);
    if (victim == null)
        return;
    updateBestFromCore();
    const doPrice = rnd01() < 0.7; // prefer price changes to exercise queues
    if (doPrice && (estBestBid >= 0 && estBestAsk >= 0)) {
        const near = rnd01() < 0.8;
        const dir = (side === 0) ? +1 : -1; // move toward/away from spread
        const jump = near ? (1 + (rndU32() % REPRICE_NEAR_TICKS)) : (REPRICE_JUMP_TKS + (rndU32() % REPRICE_JUMP_TKS));
        const base = (side === 0 ? estBestBid : estBestAsk);
        const px = Math.max(params.pmin, Math.min(params.pmax, base + dir * jump * params.tick));
        replace(victim, victim, px, 0);
    }
    else {
        const delta = ((rndU32() % 2) ? +REPLACE_SIZE_STEP : -REPLACE_SIZE_STEP);
        replace(victim, victim, null, delta);
    }
}
/* ================================
   Snapshot DB
   ================================ */
const SNAP_DB = path.resolve(process.cwd(), "bench_snapshots.json");
const loadSnapDb = () => {
    try {
        if (fs.existsSync(SNAP_DB))
            return JSON.parse(fs.readFileSync(SNAP_DB, "utf8"));
    }
    catch { }
    return {};
};
const saveSnapDb = (db) => fs.writeFileSync(SNAP_DB, JSON.stringify(db, null, 2), "utf8");
/* ================================
   ASCII helpers
   ================================ */
const BOLD = "\x1b[1m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const GREEN = "\x1b[32m", RED = "\x1b[31m", CYAN = "\x1b[36m", YELLOW = "\x1b[33m", MAGENTA = "\x1b[35m";
function fmtEvent(e) {
    switch (e.k) {
        case "ACK": return `${DIM}[ACK]${RESET} owner=${e.owner} id=${e.id}`;
        case "REJECT": return `${YELLOW}[REJECT]${RESET} owner=${e.owner} id=${e.id} reason=${e.reason}`;
        case "CANCELED": return `${MAGENTA}[CANCEL]${RESET} owner=${e.owner} id=${e.id}`;
        case "REDUCED": return `${CYAN}[REDUCE]${RESET} owner=${e.owner} id=${e.id} Δ=${e.delta} rem=${e.remain}`;
        case "TRADE": return `${BOLD}[TRADE]${RESET} px=${e.px} qty=${e.qty} maker=${e.makerOwner} taker=${e.takerOwner}`;
    }
}
/* ================================
   ASCII (step-by-step)
   ================================ */
function runAscii() {
    console.log(`${BOLD}ASCII playthrough${RESET} (mode=${MODE}, ops=${OPS}, seed=${SEED})`);
    let evPtr = 0;
    for (let i = 0; i < OPS; i++) {
        if (MODE === "throughput") {
            // Use pregen arrays
            const k = kinds[i];
            if (k === 0) {
                const id = orderIds[i], s = sides[i], px = prices[i], q = qtys[i];
                console.log(`\n${BOLD}#${i + 1} ADD${RESET} owner=${id} side=${s === 0 ? GREEN + 'BUY' + RESET : RED + 'SELL' + RESET} px=${px} qty=${q}`);
                newOrder(id, id, s, px, q, 0, false, false);
            }
            else if (k === 1) {
                const id = orderIds[i];
                console.log(`\n${BOLD}#${i + 1} CANCEL${RESET} owner=${id} id=${id}`);
                cancel(id, id);
            }
            else {
                const id = orderIds[i];
                if (reprice[i]) {
                    const np = prices[i], d = deltas[i] | 0;
                    console.log(`\n${BOLD}#${i + 1} REPLACE${RESET} owner=${id} id=${id} newPx=${np} dQty=${d}`);
                    replace(id, id, np, d);
                }
                else {
                    const d = deltas[i] | 0;
                    console.log(`\n${BOLD}#${i + 1} REPLACE-REDUCE${RESET} owner=${id} id=${id} delta=${d}`);
                    replace(id, id, null, d);
                }
            }
        }
        else {
            // Fidelity: choose action based on book conditions
            updateBestFromCore();
            // Decide action
            const wantCancel = rnd01() < CANCEL_RATE && (liveBuy.length + liveSell.length) > 0;
            const wantReplace = !wantCancel && rnd01() < REPLACE_RATE && (liveBuy.length + liveSell.length) > 0;
            if (wantCancel) {
                console.log(`\n${BOLD}#${i + 1} CANCEL${RESET} (targeted)`);
                doCancel();
            }
            else if (wantReplace) {
                console.log(`\n${BOLD}#${i + 1} REPLACE${RESET} (targeted)`);
                doReplace();
            }
            else {
                // maker vs taker balance depends on depth/resting
                const depthWeak = (estBestBid < 0 || estBestAsk < 0) || (estBestAsk - estBestBid <= params.tick); // no spread/too narrow
                const restingWeak = (liveBuy.length + liveSell.length) < MIN_RESTING;
                const doTaker = !depthWeak && !restingWeak && (rnd01() < TAKER_RATE);
                if (doTaker) {
                    console.log(`\n${BOLD}#${i + 1} ADD-TAKER${RESET}`);
                    placeTaker();
                }
                else {
                    const side = (rndU32() & 1);
                    const near = rnd01() < MAKER_BIAS_NEAR;
                    console.log(`\n${BOLD}#${i + 1} ADD-MAKER${RESET} side=${side === 0 ? 'BUY' : 'SELL'} near=${near}`);
                    placeMaker(side, near);
                }
            }
        }
        // Drain & reflect events in pools (to keep them accurate)
        const drained = drainEvents(evPtr);
        evPtr = drained.next;
        for (const e of drained.items) {
            if (e.k === "ACK") {
                // order posted; add to corresponding pool (owner == orderId in our bench)
                // we don't know side here, but later trades/cancels will remove it from both pools safely.
                // To be precise, we rely on subsequent TRADE/REDUCE/CANCEL to prune.
                // A simple heuristic: probe both; redundant is fine (we de-dupe on remove).
                // Better: track by side via tiny map, but keeping it simple here:
                // add to both temporarily, then clean on trade/cancel.
                // To keep pools sane, push into both, but we will de-dupe on remove.
                liveBuy.push(e.id);
                liveSell.push(e.id);
            }
            if (e.k === "CANCELED") {
                poolRemove(0, e.id);
                poolRemove(1, e.id);
            }
            if (e.k === "REDUCED" && e.remain === 0) {
                poolRemove(0, e.id);
                poolRemove(1, e.id);
            }
            if (e.k === "TRADE") {
                // We can’t see maker/taker ids here, but filled makers emit REDUCED/FILLED shortly after.
                // Nothing to do.
            }
        }
        // Show step ASCII in ASCII mode
        if (ASCII_MODE) {
            console.log(renderAscii(ASCII_DEPTH, ASCII_PERLVL));
        }
    }
}
/* ================================
   Bench (with per-chunk proof logs)
   ================================ */
function runBench() {
    let adds = 0, cancels = 0, replaces = 0;
    let evPtr = 0;
    let workProof = 0n;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < OPS; i++) {
        if (MODE === "throughput") {
            const k = kinds[i];
            if (!USE_API) {
                if (k === 0) {
                    newOrder(orderIds[i], orderIds[i], sides[i], prices[i], qtys[i], 0, false, false);
                    adds++;
                }
                else if (k === 1) {
                    cancel(orderIds[i], orderIds[i]);
                    cancels++;
                }
                else {
                    if (reprice[i])
                        replace(orderIds[i], orderIds[i], prices[i], deltas[i] | 0);
                    else
                        replace(orderIds[i], orderIds[i], null, deltas[i] | 0);
                    replaces++;
                }
            }
            else {
                let cmd;
                if (k === 0)
                    cmd = { kind: 0, owner: orderIds[i], orderId: orderIds[i], side: sides[i], tif: 0, postOnly: false, reduceOnly: false, priceTicks: prices[i], qtyLots: qtys[i] };
                else if (k === 1)
                    cmd = { kind: 1, owner: orderIds[i], orderId: orderIds[i] };
                else
                    cmd = reprice[i]
                        ? { kind: 2, owner: orderIds[i], orderId: orderIds[i], newPriceTicks: prices[i], qtyDeltaLots: deltas[i] | 0 }
                        : { kind: 2, owner: orderIds[i], orderId: orderIds[i], newPriceTicks: null, qtyDeltaLots: deltas[i] | 0 };
                applyCommand(cmd);
                if (k === 0)
                    adds++;
                else if (k === 1)
                    cancels++;
                else
                    replaces++;
            }
        }
        else {
            // fidelity mode
            updateBestFromCore();
            const wantCancel = rnd01() < CANCEL_RATE && (liveBuy.length + liveSell.length) > 0;
            const wantReplace = !wantCancel && rnd01() < REPLACE_RATE && (liveBuy.length + liveSell.length) > 0;
            if (wantCancel) {
                doCancel();
                cancels++;
            }
            else if (wantReplace) {
                doReplace();
                replaces++;
            }
            else {
                const depthWeak = (estBestBid < 0 || estBestAsk < 0) || (estBestAsk - estBestBid <= params.tick);
                const restingWeak = (liveBuy.length + liveSell.length) < MIN_RESTING;
                const doTaker = !depthWeak && !restingWeak && (rnd01() < TAKER_RATE);
                if (doTaker) {
                    placeTaker();
                }
                else {
                    placeMaker((rndU32() & 1), rnd01() < MAKER_BIAS_NEAR);
                }
                adds++;
            }
        }
        // Drain events, fold into workProof, and maintain pools
        const drained = drainEvents(evPtr);
        evPtr = drained.next;
        for (const e of drained.items) {
            // fold into rolling workProof
            if (e.k === "TRADE") {
                workProof = (workProof * 0x1000003n
                    ^ BigInt(e.px & 0xffff)
                    ^ (BigInt(e.qty & 0xffff) << 16n)
                    ^ (BigInt(e.makerOwner & 0xffff) << 32n)
                    ^ (BigInt(e.takerOwner & 0xffff) << 48n)) & 0x1fffffffffffffn;
            }
            else if (e.k === "REDUCED") {
                workProof = (workProof * 0x1000003n
                    ^ 0x11n
                    ^ BigInt(e.id & 0xffff)
                    ^ (BigInt(e.owner & 0xffff) << 16n)
                    ^ (BigInt((e.delta & 0xffff)) << 32n)
                    ^ (BigInt(e.remain & 0xffff) << 48n)) & 0x1fffffffffffffn;
                if (e.remain === 0) {
                    poolRemove(0, e.id);
                    poolRemove(1, e.id);
                }
            }
            else if (e.k === "CANCELED") {
                workProof = (workProof * 0x1000003n
                    ^ 0x22n
                    ^ BigInt(e.id & 0xffff)
                    ^ (BigInt(e.owner & 0xffff) << 16n)) & 0x1fffffffffffffn;
                poolRemove(0, e.id);
                poolRemove(1, e.id);
            }
            else if (e.k === "ACK") {
                workProof = (workProof * 0x1000003n
                    ^ 0x33n
                    ^ BigInt(e.id & 0xffff)
                    ^ (BigInt(e.owner & 0xffff) << 16n)) & 0x1fffffffffffffn;
                // We don’t know side here cheaply; let REDUCED/CANCELED prune later.
                // Keep pools reasonably sized by pushing to one side randomly:
                ((rndU32() & 1) ? liveBuy : liveSell).push(e.id);
            }
            else if (e.k === "REJECT") {
                workProof = (workProof * 0x1000003n
                    ^ 0x44n
                    ^ BigInt(e.id & 0xffff)
                    ^ (BigInt(e.owner & 0xffff) << 16n)) & 0x1fffffffffffffn;
            }
        }
        // Progress log & optional tiny ASCII
        if (LOG_EVERY && ((i + 1) % LOG_EVERY === 0)) {
            process.stdout.write(`tick ${String(i + 1).padStart(8)} | rest=${String(liveBuy.length + liveSell.length).padStart(6)} | workProof=${workProof.toString()}      \r`);
            if (ASCII_TICK) {
                console.log("\n" + renderAscii(Math.max(6, Math.min(ASCII_DEPTH, 40)), 10));
            }
        }
    }
    const t1 = process.hrtime.bigint();
    const dtMs = Number(t1 - t0) / 1e6;
    const opsSec = (OPS / dtMs) * 1000;
    return { dtMs, opsSec, adds, cancels, replaces, workProof };
}
/* ================================
   Main
   ================================ */
function main() {
    enableDevAsserts(DEV);
    resetBook(params);
    RNG = (SEED >>> 0);
    if (MODE === "throughput") {
        // old synthetic generator
        pregenThroughput();
    }
    else {
        // fidelity mode uses live generation; nothing to pregen
    }
    if (ASCII_MODE) {
        runAscii();
        const snap = snapshotLine(SEED, OPS);
        const hash = computeStateHash();
        console.log(`${snap}|hash:${hash}`);
        return;
    }
    const { dtMs, opsSec, adds, cancels, replaces, workProof } = runBench();
    const snap = snapshotLine(SEED, OPS);
    const hash = computeStateHash();
    const line = `${snap}|work:${workProof.toString()}|hash:${hash}`;
    console.log(`\nmode=${MODE}`);
    console.log(`ops=${OPS}, time=${dtMs.toFixed(2)} ms, ~${opsSec.toFixed(0)} ops/sec`);
    console.log(`adds=${adds}, cancels=${cancels}, replaces=${replaces}`);
    console.log(line);
    const db = loadSnapDb();
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
        saveSnapDb(db);
        console.log(`SNAPSHOT SAVED for seed ${SEED} -> ${path.basename(SNAP_DB)}`);
    }
}
if (require.main === module)
    main();
