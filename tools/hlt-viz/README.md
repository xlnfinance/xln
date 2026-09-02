# hlt-viz: Hub-Ledger Topology Visualizer

2D slow-motion visualization of a recorded hub WAL. Shows every payment that really happened,
in real order and real timing, replayed at a chosen speed.

## Usage

### 1. Extract

```bash
bun tools/hlt-viz/extract.ts --recording <hub-recording.json> --out <viz-data.json>
```

Example:
```bash
bun tools/hlt-viz/extract.ts \
  --recording .logs/qa/hlt/hlt-hub-recording.rec3.json \
  --out .logs/qa/hlt/viz-rec3.json
```

Output: compact JSON with indexed users, per-frame events as `[kind, from, to, amount, lockId]` arrays.
`from` / `to` are user indices, or `-1` for the hub.

### 2. View

Serve the repo root over HTTP and open the page with `?data=`:

```bash
python3 -m http.server 8123
# http://localhost:8123/tools/hlt-viz/index.html?data=/.logs/qa/hlt/viz-rec3.json
```

Or drop the extracted JSON onto the page / use the file picker.

### Controls

| Control | Description |
|---|---|
| Play/Pause (button or space) | Start or pause the replay |
| Speed slider | 0.001× – 10× real time (log scale, default 0.01×) |
| 0.01× / 0.1× / 1× | Jump to a named speed |
| Timeline | Drag to seek; resets in-flight pulses |

Default 0.01× is slow motion: a pulse takes ~1 s of wall time to travel. 1× is a quick flash.

### HUD

Users, frame height, recording time / total, speed, payments (locks with `from >= 0`,
i.e. user→hub legs), resolves, swaps, TPS over the last recording second and the last wall second.

The "this second" list shows the last 8 events in the current recording second.

### Visual Legend

| Event kind | Colour | Description |
|---|---|---|
| lock | Green | HTLC lock (payment) |
| resolve | Blue | HTLC resolve |
| direct | Yellow | Direct payment |
| swap_offer/resolve/cancel | Orange | Swap lifecycle |
| settle | Red | Settlement transition |
| other | Grey | Add delta, set credit limit, etc. |

Hub is the centre; users sit on a ring that fills the viewport. Each pulse travels
payer → payee (usually via the hub). Payer and payee dots flash on depart/arrive.
