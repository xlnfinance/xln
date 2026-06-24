# xln — brand sketches & direction

Working brand exploration for **xln** — *the provable account network*. This folder
is a self-contained design package meant to be **reviewed by another AI or designer**.
Nothing here ships yet; it is direction, not final brand.

- `sketches/` — six renderable HTML mockups (open in any browser, no build).
- `screenshots/` — flat PNGs of each, for reviewers that cannot render HTML.
- this file — the brief, the voice, the palettes, and what to critique.

---

## how to review (brief for the reviewer)

Open `sketches/*.html` or view `screenshots/*.png`. Judge each against:

1. **Not-AI-slop test** — does it read as a crafted product, or a generated "slide"?
   Look for: real hierarchy, an 8px rhythm, tabular numerals, restraint (one accent),
   alignment. Cluttered palette+type+logo dumps fail this.
2. **Stripe / Coinbase polish** — would this sit next to stripe.com or a Coinbase app
   screen without looking amateur?
3. **Brand truth** — does it carry the idea (`provable`, `credit`, `instant`,
   `no pre-funding`) without try-hard copy?
4. **Finance correctness** — do the payment / swap / tap-to-pay flows reflect how xln
   actually works (bilateral accounts, credit↔collateral, cross-j atomic swap)?

Output: pick the single strongest direction, list concrete fixes (spacing, color,
copy, hierarchy), and flag anything that misrepresents the protocol.

---

## the idea (so the review is grounded)

xln is a **Reserve-Credit Provable Account Network**. One invariant governs every
bilateral account:

```
-L_left  ≤  Δ  ≤  C + L_right
```

- `Δ` (delta) — the net balance between two parties. The mark **△ is literally Δ.**
- `C` — collateral escrowed on-chain (channel-style safety).
- `L_left` / `L_right` — credit each side extends (bank-style, instant, provable).

What it lets a product say truthfully: **instant, provable, and you can receive
without pre-funding inbound liquidity** — the thing Lightning can't do and banks do
unprovably.

---

## voice

Four levels, each for someone who wanted to go one click deeper:

| level | line |
|---|---|
| wordmark | `xln` (always lowercase) |
| category | the provable account network |
| hero | send money like a text. settle it like cash. |
| proof | `−Lℓ ≤ Δ ≤ C + Lᵣ` |

Use `account` in product/docs (protocol-true, keeps the RCPAN acronym); `settlement`
on the public landing (clearer to outsiders).

**Banned words** (try-hard / cringe): endgame, revolutionize, unlock, seamless,
next-gen, game-changer, "the future of money."

### semantic color system (shared across every direction)

Color encodes a money **state**, never decoration:

| token | meaning |
|---|---|
| credit | within credit limit — instant, trust-based |
| collateral | escrowed on-chain — safety |
| in-flight | HTLC locked, in transit |
| settled | final, enforceable on-chain — the only "green" |
| dispute | breach / on-chain court |

---

## brand worlds (palette context)

### A · provable  — `sketches/brand-a-provable.html`
Swiss math-brutalism. Monospace, hairline grid, the invariant as hero. Most uniquely
*ownable* (nobody else can claim the invariant); risks feeling cold.
- paper `#F4F1EA` · ink `#15140F` · credit `#2F6F7A` · collateral `#E0A02E` ·
  in-flight `#C58A1B` · settled `#15140F` · dispute `#B23B2E`
- type: Space Grotesk + IBM Plex Mono · tagline: *credit you can prove, collateral you can enforce.*

### B · liquid settlement — `sketches/brand-b-liquid-settlement.html`
Premium institutional. Midnight + gold + bone, serif wordmark. "Private bank of 2050."
Risk: drifting into generic "bank."
- midnight `#0E1422` · collateral/gold `#E4C35A` · in-flight `#C9A227` ·
  credit/bone `#EDE7D8` · settled `#1FA97A` · dispute `#B23A4A`
- type: Fraunces (display) + Inter · tagline: *send money like a text. settle it like cash.*

### C · flow — `sketches/brand-c-flow.html`
Kinetic network. Deep space + flat cyan/violet/magenta, mesh routing, motion via
direction (no glow). Dev-native, energetic. Risk: neon-trio looks like every crypto app.
- space `#0A0B12` · credit/cyan `#22D3EE` · collateral/violet `#7C5CFF` ·
  in-flight/magenta `#F0398B` · settled `#2BD67B` · dispute `#FF4D6D`
- type: Space Grotesk + JetBrains Mono · tagline: *value at the speed of a message.*

---

## product screens (the part that worked)

Three takes on the **send** and **swap** screens at Stripe/Coinbase polish. Same
layout, different skin — so they can become **one UI with light/dark themes**, not three
designs.

| sketch | skin | accent | use when |
|---|---|---|---|
| `screens-stripe-light.html` | airy light, breakdown-driven | indigo `#635BFF` | B2B / devs / checkout |
| `screens-coinbase.html` | bold, rounded, account-context | blue `#0052FF` | mass-consumer / retail |
| `screens-premium-dark.html` | Linear/Phantom dark | indigo `#6E7CFF`, settled mint `#34D399` | pro / crypto-native |

**Recommendation:** `screens-premium-dark` as the hero aesthetic (most distinctive, and
mint-`settled` ties to the state system), with `screens-coinbase` as the approachable
light alternative. They share structure → ship as one themeable UI.

---

## finance flows covered

- **payment / send** — recipient, amount, fee=free, arrives instantly, credit-backed
  capacity meter, proof hash.
- **real-world tap-to-pay** (brand B) — NFC merchant charge, settled <1s,
  "credit-backed · no pre-fund", proof.
- **cross-jurisdiction swap** — you pay / you receive, fill ratio 99.4%, atomic
  (both legs or neither), hash-ladder proof.
- **bilateral account / balance** — left/right entities, delta, enforceable C + L.
- **transaction states** — credit · in-flight · settled · dispute · recovered.

---

## open questions for the reviewer

1. Light or dark as the **hero** product theme?
2. `account` vs `settlement` in the public category line?
3. Is the `△ = Δ` mark legible enough at favicon size, or does it need a wordmark lockup?
4. Motion language: how much, and where (only on state change: in-flight → settled)?

---

## files

```
design/
  readme.md
  sketches/
    screens-premium-dark.html      ← recommended hero
    screens-coinbase.html
    screens-stripe-light.html
    brand-a-provable.html
    brand-b-liquid-settlement.html
    brand-c-flow.html
  screenshots/
    *.png                          ← flat renders of each sketch
```
