# XLN Limit Order Book (LOB) — Design & Bench Overview

## 🎯 Purpose
This LOB implementation is the **matching engine core** for XLN hubs.  
It is **not an exchange UI** but a deterministic in-memory engine that:

- Accepts new limit orders, cancels, and replaces.
- Matches taker orders against resting liquidity (FIFO queues).
- Enforces **soundness guarantees**: no double-spend, strict FIFO, correct best bid/ask.
- Records **egress events** (ACK, TRADE, REDUCED, CANCELED, REJECT) into a ring buffer.
- Provides **deterministic snapshots** for regression testing.

Target: **≥50k TPS per hub** on commodity hardware (MacBook M1/M2), with clear and auditable code.

---

## ✅ Goals
1. **Clarity / Soundness**  
   Code must be *readable like a bible*, with explicit guards and comments.  
   Every branch explains its purpose. Developers must trust it.

2. **Determinism**  
   Given the same input stream, the book produces identical events and final snapshot (hash).  
   Benchmarks store and re-validate snapshots to catch regressions.

3. **Performance**  
   - O(1) enqueue, dequeue, cancel, replace.
   - Cache-friendly typed arrays (SoA layout).
   - Bitmap scanning for best bid/ask.

   We target **50k TPS stable** (actual headroom is much higher).

4. **Safety**  
   - Explicit input validation (`qty`, `price`, `id`).  
   - REJECT on invalid commands.  
   - No silent failures.  
   - `Dev asserts` can be enabled to catch invariants (e.g. bestBid mismatch).

---

## 🔑 Core Features
- **Bid/Ask separation** with typed arrays.
- **Doubly-linked lists** per price level → FIFO guarantee.
- **O(1) cancel**: direct removal via `orderId → slotIdx`.
- **Self-Trade Prevention (STP)** policies:
  - 0 = off
  - 1 = cancel taker
  - 2 = reduce maker
- **TIF (Time-in-Force)**:
  - GTC (Good Till Cancel)
  - IOC (Immediate Or Cancel)
  - FOK (Fill Or Kill, dry-run)
- **Egress Events**:
  - Recorded to a ring buffer (`EVT_RING_CAP=131k`).
  - Used by bench and ASCII visualization.
- **Deterministic Hashes**:
  - State hash (sha256 over arrays + counters).
  - Event hash (rolling checksum of event stream).

---

## 🧩 Bench Modes

### 1. Throughput
- Pre-generated synthetic workload.
- Fastest possible test (no live book awareness).
- Use to check *upper-bound performance*.

Example:
```bash
bun src/orderbook/bench.ts --mode=throughput --ops=500000 --seed=42