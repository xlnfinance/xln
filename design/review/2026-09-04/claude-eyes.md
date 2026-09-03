# Own-eyes review — 2026-09-04, after design pass 2

Same rubric as the models (0–1000 per parameter, strict). Scored from
`design/screenshots/ui/` after the second pass (auto scale, two-column
Receive/Settings/Account, toast lifecycle, folded activity).

| screen (desktop-dark) | hier | prem | typo | color | data | layout | visceral | responsive | consist | trust | total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 01 Home | 860 | 800 | 820 | 840 | 800 | 780 | 820 | 760 | 840 | 800 | **812** |
| 02 Pay | 860 | 780 | 800 | 820 | 820 | 820 | 760 | 820 | 820 | 880 | **818** |
| 03 Receipt | 880 | 840 | 840 | 840 | 840 | 800 | 600 | 700 | 800 | 900 | **804** |
| 04 Receive | 800 | 780 | 800 | 780 | 780 | 800 | 640 | 800 | 800 | 760 | **774** |
| 05 Swap | 720 | 740 | 780 | 780 | 660 | 700 | 700 | 700 | 780 | 620 | **718** |
| 06 Account | 820 | 800 | 800 | 800 | 840 | 800 | 860 | 800 | 820 | 840 | **818** |
| 07 Activity | 820 | 820 | 800 | 840 | 800 | 780 | 600 | 720 | 840 | 800 | **782** |
| 08 Activity detail | 840 | 820 | 820 | 840 | 820 | 820 | 600 | 780 | 800 | 860 | **800** |
| 09 Settings | 800 | 820 | 820 | 820 | 820 | 800 | 900 | 820 | 820 | 820 | **824** |

Light theme: −20 to −40 on `premium` and `color` across the board (cards on
off-white read flatter; the indigo Pay button is the only strong element).
Mobile: Home, Pay and Account hold; Activity detail as a sheet is good; the
Pay page below the fold is now short since the desktop aside is gone.

**Overall (own eyes): 794 / 1000.** Ship-able for a beta; not yet the 950 the
brief asks for.

## What still costs points, in order

1. **Swap has no price.** The limit-order form shows "You receive 0.00" until the user types both sides. Needs the hub's last price / book mid as a suggested rate, a rate line ("1 WETH = … USDC") and a slippage-free explanation. (data, trust)
2. **Receipt and Activity have no bar.** Money moved, but the visceral principle stops at Home/Pay/Account. A one-line at-scale bar under the receipt amount and inside activity rows (amount vs. balance) would carry the thesis through. (visceral)
3. **Light theme depth.** Cards need a hairline plus a 1–2 % tint, and the token/avatar circles need a shade darker so they do not float. (premium, color)
4. **Home hero legend** duplicates the bar; the numbers are already the sub-rows when a token is expanded. Try: legend only on hover/tap of the bar, or fold into the "Instant" line. (premium)
5. **Two identical "Credit limit updated" rows.** Core does not say whose limit changed; until it does, fold both into one row "Credit lines set · 50,000 each way". (data)
6. **Receive QR** is the biggest white object in the app. Keep it white (scanners), but shrink to 200 px on desktop and give the amount field the visual weight. (hierarchy)
7. **Empty space on desktop Swap/Receive.** The right column exists now but is short; the Swap aside should carry the account before/after like Pay does. (layout)
8. **Frame vocabulary leaks**: "Frames signed 7", "5 committed entries", "Ledger detail". Users read "frames" as video. Consider "signed updates". (trust for non-crypto users; keep for crypto-native)

## Fixed in this pass (from r1/r2 findings)

- Auto scale: one 1-2-5 step that fits the largest balance into the hero track; pinned scale still available; segments never thinner than 2 px.
- Toasts die on navigation and when the committed receipt appears; no "submitted" banner over later screens.
- One route diagram per viewport (chips on mobile, timeline on desktop); hop fee shows its share of the total.
- Receipt shows the clock time next to the duration; activity row uses the finalizing frame so both say the same frame.
- Receive, Settings and Account use the desktop width (two columns); Settings previews the scale live.
- Empty token lanes collapse; legend once; zero collateral not painted green; entity ids shortened.
- Activity/Home: account settings out of the money column; orphan "just now" removed; mobile Activity rows no longer collapse to zero width; desktop-only asides no longer leak onto phones.
