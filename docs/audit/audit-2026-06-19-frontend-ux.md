# Frontend UX Audit — Simplify for ordinary users without losing informativeness

Date: 2026-06-19
Scope: `/frontend` — the user-facing wallet (user mode), onboarding, payments, assets, accounts, settings.
Method: live walkthrough of production (`xln.finance/app`, desktop 1440px + mobile 390px, 9 screenshots) + source review of `UserModePanel`, `EntityPanelTabs` (7946 lines), `OnboardingPanel`, `RuntimeCreation`, `DeltaCapacityBar`, `PaymentPanel`, i18n.

Guiding thesis: **the bones for two audiences already exist** (`appState.mode === 'user'` vs the dev `DockRoot`). The win is not "dumb it down" — it is **progressive disclosure**: consumer-grade defaults, with every protocol mechanic one tap away in an "expert" layer. Keep the density; stop making it the front door.

---

## TL;DR — top 7 findings (impact × effort)

| # | Finding | Impact | Effort | Priority |
|---|---------|--------|--------|----------|
| 1 | **"Net Worth $450" but "0 available" to pay** — funds sit in External/Reserve, channel capacity is empty. The single most confusing thing in the product. | 🔴 Critical | M | **P0** |
| 2 | **Protocol jargon is the default vocabulary** — Entity, Reserve, External EOA, Counterparty, Out/In capacity, Batch, Broadcast, Tower, Jurisdiction. | 🔴 Critical | M | **P0** |
| 3 | **Onboarding overload** — 5-minute key derivation, recovery-tower modes, soft/hard USD limits, hub-join counts shown to step-2 users. | 🔴 Critical | M | **P0** |
| 4 | **i18n exists (10 languages) but the wallet is hardcoded English** — only Landing/Topbar use `t()`; the whole wallet ignores it. | 🟠 High | M | **P1** |
| 5 | **10 sub-tabs in the account workspace** + 3 top tabs + 7 settings tabs. "Appearance"/bar-skins live next to "Pay". | 🟠 High | S | **P1** |
| 6 | **Raw 66-char entity hex shown in the header** (wraps to 2 lines on mobile); broken `/api/recovery/discover` 404 leaks "HTTP_404" into onboarding. | 🟡 Medium | S | **P1** |
| 7 | **Capacity bar is a 6-segment color code with no legend** — brilliant for experts, unreadable for normals. | 🟡 Medium | M | **P2** |

---

## What's already good (keep / build on)

- Clean, calm dark aesthetic; consistent spacing and type.
- `PaymentPanel` input model is genuinely good: one "Name, address, or invoice" field + entity picker + **Scan QR**, a max-button ("0 USDC available"), optional "+ Add note".
- Mobile collapses the 10-tab rail into "Pay + overflow menu" — the right instinct.
- Settings → Wallet has correct security copy ("Never share your recovery phrase… Reveal only when you are alone").
- Payment success uses a `PaymentSpotlight` ("Received in 42ms") — great moment of delight.
- `CommandPalette` exists for power users.
- The user/dev mode split (`UserModePanel` vs `DockRoot`) is the correct architecture for progressive disclosure.

---

## Systemic problem 1 — The spendable-vs-balance gap (P0)

**Observed:** fresh wallet shows **$450.00 Net Worth** in the hero. Open an account with hub H1, go to Pay → **"0 USDC available"**, "Pay now" disabled. The $450 is real but lives in *External* ($350 ETH + $100 USDC on-chain) and *Reserve*; **none is in channel out-capacity**, so nothing is spendable instantly.

To actually spend, a user must mentally model and execute a 3-hop pipeline:
`External (on-chain wallet) → Reserve (entity vault) → Account (channel collateral)` → only then does "out capacity" appear → only then can they Pay.

This is the #1 reason an ordinary user will bounce: *"I have $450 and the app won't let me send $5."*

**Recommendations**
- **Reframe the hero number.** Lead with **"Spendable now"** (sum of out-capacity) as the big number; show **"Total balance"** as the secondary line. Today the hero is "Net Worth" — a number you cannot spend — which is actively misleading.
- **One-tap "Top up to spend."** When spendable < total, show a single CTA that runs External→Reserve→Account collateralization automatically with a sensible default amount. Hide the three-bucket plumbing behind it (keep the manual "Move" workspace for expert mode).
- **Turn the dead end into the on-ramp.** When "Pay now" is disabled because available = 0, relabel it **"Add funds to send →"** and launch the top-up inline, instead of a disabled button + an unexplained "0 available".
- **Auto-fund a starter channel at onboarding** (see Problem 3) so a new wallet is *immediately spendable*, not just "funded."

---

## Systemic problem 2 — Jargon is the default language (P0)

The wallet speaks protocol, not money. A consumer meets all of these on the first two screens: **Entity, External EOA, Reserve, Collateral, Account (as a channel), Counterparty, Hub, Out/In capacity, Delta, Settle, Batch, Sign & Broadcast, Runtime, Tower, Jurisdiction.**

These are precise and worth keeping for experts — but they should not be the **default** vocabulary.

**Recommendation — a plain-language layer, gated by the existing user/expert mode.** Suggested mapping (defaults shown to consumers; expert mode restores the precise term):

| Protocol term (keep for expert) | Consumer default |
|---|---|
| Entity | Your wallet / Account |
| External (EOA) | On-chain wallet · "On Ethereum" |
| Reserve | Vault (on-chain balance) |
| Account (bilateral channel) | Payment line with {Hub} / Connection |
| Counterparty | Contact / Provider |
| Hub (H1/H2/H3) | Payment provider (with a name + logo, not "H1") |
| Out capacity | You can send |
| In capacity | You can receive |
| Settle / Sign & Broadcast / Batch | Confirm on-chain (1 review screen) |
| Jurisdiction | Network |
| Tower | Backup service |
| Runtime | (hide entirely from users — internal) |

Concretely: "Open Account with Counterparty" → **"Connect to a payment provider"**; "0 USDC available · Out capacity" → **"You can send: $0"**.

---

## Systemic problem 3 — Onboarding overload (P0)

**Screen 1 (`RuntimeCreation` / "Create XLN wallet"):**
- **Key derivation defaults to ~5 minutes** ("Security work factor 3 = 100 shards · 5min"). Five minutes to make a wallet is a hard bounce for normal users.
- **BrainVault vs Mnemonic** choice forced up front — a crypto-implementation decision, not a user goal.
- **Quick Login (Testnet) Alice/Bob/Carol…** is mixed into the real create form — confusing which path is "real."

**Screen 2 (`OnboardingPanel` / "Configure account"):** shows, all at once — Display name, Jurisdiction multi-select, **Soft limit (USD)**, **Hard limit (USD)**, **Max fee (USD)**, **Initial hub join (manual / 1 / 2 / 3)**, Seed-safety reveal/download, and **"Encrypted backup and last-resort dispute protection"** with modes **"Backup + disputer" / "Backup only" / "Local only" / "Last resort" / blind_backup / delayed_last_resort**. This is an expert risk-config console, not a step-2 for a new user.

**Restore flow:** clicking a quick-login lands on "Restore wallet" with "Seed resolved for 0x226a…", "Towers checked: 1", "Backups found: 0", and a raw **"Recovery check warnings: https://xln.finance:HTTP_404"** (the `/api/recovery/discover` endpoint 404s in prod).

**Recommendations**
- **Default to a fast work factor** (sub-30s) for the consumer path; show the time estimate prominently; keep 5-min "Maximum" as an opt-in. Never let the default be a 5-minute wait.
- **Collapse screen 2 to one field + Continue** (display name only). Apply smart defaults for limits/hub-join/recovery and move all of it to **Settings → Recovery / Network**, surfaced later with explanation.
- **Auto-join 1 hub and auto-collateralize a starter channel** so the wallet is spendable on first load (directly fixes Problem 1).
- **Split demo from real:** a clearly separate "Try a demo (Alice/Bob)" entry, not inline persona buttons on the real create form.
- **Fix or swallow the 404.** Never render raw `HTTP_404` / URLs to users — fix `/api/recovery/discover` or degrade silently to "No backup found."
- **Defer the BrainVault/Mnemonic choice.** Pick BrainVault by default; offer "I have a recovery phrase / advanced" as a secondary link.

---

## Systemic problem 4 — Information architecture (P1)

Counts today: **3 top tabs** (Assets / Accounts / Settings) → **10 account-workspace tabs** (Open Account, Pay, Receive, Swap, Move, Lending, History, Manage, Activity, Appearance) → **7 settings tabs** (Wallet, Recovery, Display, Network, Advanced, Log, Entity).

Problems:
- **10 peer tabs** flatten priority — "Pay" sits next to "Appearance" (bar skins/animations) and "Manage" (disputes).
- **"Appearance"** (account-bar layout, skins, bar effects) is developer/aesthetic tuning living inside the money workspace — it belongs in Settings → Display.
- **"Activity" and "History"** overlap.
- **"Open Account"** is a setup action, not a peer of "Pay"; once accounts exist it should be a "+ New connection" affordance, not a permanent tab.
- **Assets vs Accounts** force the user to hold two models at once: the 3-bucket asset ledger *and* the per-hub account list.

**Recommendations**
- Primary action bar = **Pay · Receive · Swap** (the 80%); fold Move / Lending / Manage / History / Activity into a **"More"** overflow.
- Move **Appearance** → Settings → Display. Merge **Activity** into **History**.
- Demote **Open Account** to a **"+ Connect"** button on the Accounts screen.
- Consider merging **Assets** and **Accounts** into one "Money" view: total at top, "Spendable / In vault / On-chain" as a single breakdown, payment lines listed below.

---

## Systemic problem 5 — i18n is built but unplugged (P1)

`src/lib/i18n` ships **10 locales** (en/zh/es/ru/ja/ko/pt/de/fr/tr) with browser-language autodetect. But:
- Only `Topbar`, `LanguageSwitcher`, `LandingPage`, `RuntimeCreation` import it.
- **`lib/components/Entity/**` and `lib/view/**` have zero i18n imports** — the entire wallet is hardcoded English.
- `LanguageSwitcher` is mounted **only on the landing page** — once inside the app you cannot change language, and it wouldn't matter (wallet is English regardless).
- The locale dictionaries only cover landing/vault/network/settings shells, not wallet operations (Pay, Receive, capacity, accounts).

For a Russian (or any non-English) user this means: the marketing page is localized, the actual wallet is not. High leverage because the infrastructure already exists.

**Recommendations**
- Wire `t()` through the Entity components and panels; extend dictionaries to cover wallet operations.
- Surface `LanguageSwitcher` in **Settings → Display**.
- Do this *together with* Problem 2's plain-language pass so you translate the *good* labels, not the jargon.

---

## Screen-by-screen notes

**Header (all screens).** Full 66-char entity hex (`0xfddfa75ccf…af218f`) is rendered under the name and **wraps to two monospace lines on mobile**, dominating the top of a phone for a string users never read. → Show friendly name + short id + copy icon; reveal full hex on tap.

**Assets.** Table is `Asset | External | Reserve | Accounts` — the three-bucket model exposed raw. **Faucet** (External / Reserve / Account) is a testnet concept surfaced in the main consumer view. → For consumers, collapse to "Total + Spendable" and gate faucet behind testnet/expert. Keep the full ledger in expert mode.

**Accounts (empty).** Two parallel cards: **"Network → Open Account → Counterparties (H1/H2/H3)"** and **"Direct → Open by ID"** — duplicative concepts. Hubs are named "H1/H2/H3" with no description of what they are or cost. → Unify into one "Connect" flow with named/branded providers + fees; tuck "by ID / advanced" beneath it.

**Account (open).** Per-token rows show **"Out capacity / In capacity"** with a colored bar; workspace explodes to 10 tabs. → "You can send / You can receive" + the action-bar simplification above.

**Pay.** Strong layout (covered in "what's good"). Only gap: it dead-ends at "0 available" instead of offering to fund (Problem 1). "Find routes" next to "Pay now" exposes routing — fine to keep but secondary/auto.

**Settings.** Wallet panel is clean and correct. 7 tabs is acceptable here (this is the right home for the advanced config currently dumped into onboarding).

**Desktop layout.** The wallet renders as a **narrow centered column on a 1440px screen** with large empty margins — looks unfinished. → Either make it a deliberate phone-frame (with context around it) or use the width (e.g., accounts list + detail side-by-side).

---

## The capacity bar — keep informativeness, add a plain reading (P2)

`DeltaCapacityBar` encodes **6 dimensions** in one line via color: white = peer-credit promise, green = hard collateral, red = uncollateralized debt, split out/in around a red center "delta cut," plus optional sweep/glow/ripple animations. For an expert tracking bilateral channel state this is excellent and should stay.

For an ordinary user it is an unlabeled colored bar with no legend. **Don't remove it — frame it:**
- Above/below the bar, one plain line: **"Send up to $X · Receive up to $Y."**
- A one-time legend / long-press tooltip explaining the colors.
- Default consumer view: the plain line is primary, the bar is a thin accent; expert mode promotes the full segmented bar + animations.

---

## Prioritized roadmap

**P0 — do first (consumer can't succeed without these)**
1. Reframe hero to **Spendable now** + Total; "Add funds to send" on the Pay dead-end.
2. One-tap **Top up** that auto-runs External→Reserve→Account.
3. **Auto-join 1 hub + auto-collateralize** at onboarding (spendable on first load).
4. Plain-language label pass gated by user/expert mode (Problem 2 table).
5. Collapse onboarding screen 2 to display-name-only; fast default work factor; fix/swallow the 404.

**P1 — next**
6. Wire i18n through the wallet; add `LanguageSwitcher` to Settings.
7. Action-bar IA: Pay/Receive/Swap + More; move Appearance to Settings; merge Activity/History.
8. Header identity cleanup (name + short id + copy; hide full hex).

**P2 — polish**
9. Capacity-bar plain reading + legend + consumer/expert framing.
10. Unify Assets+Accounts into one "Money" view; desktop width.
11. Brand the hubs (names/logos/fees) instead of H1/H2/H3.

---

## Quick wins (low effort, visible impact)

- Swap the hero label "Net Worth" → "Spendable" (or show both). *(S)*
- Truncate entity hex in the header; full value on tap. *(S)*
- Never render raw `HTTP_404`/URLs — friendly fallback string. *(S)*
- Move "Appearance" out of the money workspace into Settings. *(S)*
- Add "You can send $X · receive $Y" text under each capacity bar. *(S)*
- Default the work-factor selector to a fast tier with a visible time estimate. *(S)*

---

## The principle to hold throughout

You are not choosing between *simple* and *informative*. You already have the mechanism for both — the user/expert mode split. The discipline is:

> **Consumer mode = goals and money ("send", "spendable", "provider"). Expert mode = mechanics (reserve, collateral, capacity, batch, delta). Default to consumer; make expert one tap away, never the front door.**

Every dense thing the protocol exposes (the 3-bucket ledger, the 6-segment bar, batch/broadcast, recovery towers) stays — it just moves from *default* to *on-demand*.
