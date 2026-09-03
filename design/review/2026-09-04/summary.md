# Design review summary

Reviewers: zai-coding-cn/glm-4.6v, openrouter/google/gemini-flash-latest, openrouter/x-ai/grok-latest

| screen | hierarchy | premium | typography | color | data_legibility | layout | visceral_value | mobile | consistency | trust | total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| desktop-dark/01-home.png | 840 | 747 | 783 | 800 | 753 | 770 | 573 | 400 | 800 | 787 | **725** |
| desktop-dark/02-pay.png | 840 | 747 | 760 | 810 | 773 | 803 | 663 | 403 | 797 | 857 | **745** |
| desktop-dark/03-receipt.png | 813 | 710 | 780 | 813 | 790 | 753 | 500 | 440 | 697 | 783 | **708** |
| desktop-dark/04-receive.png | 760 | 653 | 730 | 740 | 703 | 620 | 453 | 473 | 683 | 663 | **648** |
| desktop-dark/05-swap.png | 733 | 657 | 727 | 767 | 620 | 667 | 560 | 430 | 707 | 593 | **646** |
| desktop-dark/06-account.png | 757 | 680 | 750 | 680 | 727 | 633 | 647 | 467 | 727 | 767 | **684** |
| desktop-dark/07-activity.png | 780 | 787 | 777 | 830 | 730 | 750 | 467 | 423 | 813 | 767 | **712** |
| desktop-dark/08-activity-detail.png | 837 | 807 | 773 | 840 | 760 | 820 | 490 | 410 | 703 | 830 | **727** |
| desktop-dark/09-settings.png | 780 | 770 | 790 | 820 | 797 | 687 | 740 | 453 | 767 | 843 | **745** |
| desktop-light/01-home.png | 820 | 693 | 773 | 747 | 753 | 767 | 577 | 420 | 773 | 780 | **710** |
| desktop-light/02-pay.png | 817 | 703 | 763 | 773 | 740 | 777 | 650 | 420 | 770 | 757 | **717** |
| desktop-light/03-receipt.png | 847 | 733 | 810 | 797 | 803 | 770 | 543 | 473 | 747 | 817 | **734** |
| desktop-light/04-receive.png | 717 | 637 | 733 | 730 | 690 | 573 | 507 | 463 | 657 | 657 | **636** |
| desktop-light/05-swap.png | 740 | 677 | 753 | 743 | 660 | 673 | 570 | 437 | 720 | 617 | **659** |
| desktop-light/06-account.png | 733 | 580 | 750 | 710 | 710 | 590 | 700 | 447 | 717 | 743 | **668** |
| desktop-light/07-activity.png | 740 | 677 | 757 | 743 | 723 | 657 | 410 | 447 | 730 | 737 | **662** |
| desktop-light/08-activity-detail.png | 833 | 757 | 810 | 803 | 780 | 817 | 447 | 420 | 763 | 823 | **725** |
| desktop-light/09-settings.png | 793 | 730 | 797 | 787 | 783 | 677 | 723 | 480 | 783 | 783 | **734** |

**Overall: 699 / 1000** (mean of screen totals across reviewers)

## Priority fixes by reviewer

### zai-coding-cn/glm-4.6v · desktop-dark · 873

The desktop-dark variant demonstrates strong fintech product design with excellent hierarchy, premium aesthetics, and clear data visualization. The visceral value bars effectively communicate financial positions, and trust elements are well-implemented. Minor improvements could enhance readability and interactivity.

- Remove redundant tier legend from home screen
- Improve QR code contrast in receive screen
- Enhance modal focus in receipt screen
- Add better interactivity feedback to activity list
- Refine layout balance in activity detail view

### zai-coding-cn/glm-4.6v · desktop-light · 810

The desktop light theme shows strong foundational design with excellent data visualization and trust indicators, but suffers from inconsistent emphasis on critical information and some elements being too subtle for a premium fintech product. The visceral value principle is present but not consistently emphasized across all screens.

- Increase size/contrast of all amount displays and status indicators
- Make provability cues (proof hashes, verification status) more prominent across all screens
- Standardize and increase prominence of visceral value bars and limits
- Improve consistency in button styling and interactive elements
- Enhance trust indicators with clearer, more prominent verification status

### openrouter/google/gemini-flash-latest · desktop-dark · 765

The desktop dark interface establishes an exceptionally calm, high-trust fintech foundation with clear cryptographic state cues and disciplined typography. However, it currently suffers from single-column layout underutilization on desktop, persistent UI glitches like lingering toasts and stale zero-quotes, and inconsistent execution of the visceral value bar principle across views.

- Fix viewport layout utilization: convert single-column layouts on Receive, Swap, Account, and Settings into responsive two-column desktop structures, eliminating expansive dead black gutters.
- Resolve state and notification bugs: eliminate the lingering stale payment toast across screens, remove the orphaned 'just now' text in Activity, and default-select the latest transaction in Activity on desktop.
- Enforce consistent visceral value bars: remove artificial gradient fade-outs on Home/USDC bars, add minimum readable indicators for small payments (<$100), and add magnitude bars to Activity rows.
- Complete the Swap engine UI: wire live quote fetching to display exchange rates, slippage, and estimated output for token pairs, and show both token capacity bars in the right rail.
- Refine dark-mode contrast and clutter: replace the glaring pure-white QR code on Receive with a padded dark card, hoist repetitive account legends into a single header, and format raw 66-character hex strings with standard truncation and copy affordances.

### openrouter/google/gemini-flash-latest · desktop-light · 779

The light desktop experience establishes a clean, high-trust fintech aesthetic with strong typography and deterministic verification cues, but it suffers from severe desktop layout abandonment where mobile single-column layouts are centered in vast empty space. In addition, the core visceral-value scale principle is under-applied across history and receive screens, and persistent toast banners leak across routes to obscure content.

- Enforce full desktop two-column layouts across Receive, Account, and Settings to eliminate single-column mobile containers stranded in 60%+ empty canvas.
- Fix the sticky toast notification lifecycle so submission banners auto-dismiss immediately on route change or upon opening settlement receipt modals.
- Extend the 1 px = $N visceral-value absolute bar principle into Activity rows, Receive headroom, and Receipt cards where proportional magnitude is currently absent.
- Remove lingering unstyled artifacts, specifically the duplicate 'Credit limit updated' entries on Home and the orphan 'just now' text on Activity Detail.
- Replace unbounded gradient fade-outs on balance tier bars with framed track outlines and explicit capacity notches to preserve readability.

### openrouter/x-ai/grok-latest · desktop-light · 580

Light is calmer than typical crypto chrome, but the product thesis — one absolute money scale — is not drawn: bars fill, fade, and cannot be compared, while $25 is invisible on $60k tracks. Trust then slips on a sticky “submitted” toast, two fees, and two frame ids for one payment.

- Paint every bar at Settings’ 1 px = $N with hard stops (no fade): Home total, token row, and account send/receive become comparable; mark the $25 on Pay Before/After.
- Settled payments: no “Payment submitted” toast; dismiss on navigation so Receive/Swap/Account never show it.
- Pay: one fee (table 0.000050 vs route 0.000025) and one route diagram.
- Account: hide 0.00 WETH/USDT cards; legend only colors actually in the bar; hatch in-flight.
- Receipt ↔ Activity detail: one frame id, clock = “2023 ms”, never 00:15:23; add at-scale bars to the activity amounts.

### openrouter/x-ai/grok-latest · desktop-dark · 555

The dark desktop has the right rail, indigo, notch bars, and frame/proof vocabulary, but it still behaves like a mobile wallet parked in a 1440px canvas. Visceral value is not shipping: bars follow card width, Settings’ 1px=$10 is ignored, and a leftover ‘Payment submitted’ toast plus frame #42 vs #43 make settlement feel guessed rather than proven.

- Absolute-scale bars at Settings’ 1px=$N on Home, Pay, Receive, Account: never stretch to card width; clip+fade; $11,500 must read ~1/9 of a $100k capacity bar; hatch holds.
- One committed receipt: delete ‘Payment submitted’ toasts; unify Receipt modal and Activity-detail (same frame, proof, time); never say submitted after settle.
- Bilateral encoding: notch at 0, left=send stack (indigo credit, purple collateral, amber owed, hatched in-flight), right=receive; legend colors must match pixels — drop amber-left/blue-right.
- Use Pay/Activity two-column on Receive, Swap, Account, Settings (QR|invoice, form|quote+before/after, tokens|state, controls|live scale preview).
- Mint only for settled/positive; one money string ($11,500.00 / 25.00 USDC); label the two 50k credit events Yours vs Theirs; drop the Home total legend; disable Swap on a 100→0.00 quote.

## Issues per screen

### desktop-dark/01-home.png

- (glm-4.6v) Home desktop: The tier legend under the total repeats the three numbers already shown in the bar tooltip; drop it or make it the bar's caption
  - fix: Home desktop: Remove redundant tier legend under total balance and integrate into bar tooltip
  - fix: Home desktop: Increase contrast on 'Instant: send up to $60,000.00' text for better readability
- (gemini-flash-latest) Home desktop: the horizontal breakdown bar under Total balance and the USDC balance row uses a right-edge gradient fade to black, making the Accounts segment look clipped or unrendered rather than showing a deterministic absolute scale length.
- (gemini-flash-latest) Home desktop: the Recent activity list displays two consecutive identical 'Credit limit updated / with Hub One / 50,000.00 USDC' entries with no timestamp, frame number, or deduplication, creating visual confusion.
- (gemini-flash-latest) Home desktop: bilateral account capacity labels under the Hub One bar ('send up to 60,000.00', 'receive up to 40,000.00') use low-contrast dark gray text on a dark card background, making critical limits hard to read.
- (gemini-flash-latest) Home desktop: left column leaves excessive empty vertical space below the single USDC row while the right column stacks densely, creating an unbalanced layout on wide desktop viewports.
  - fix: Home desktop: replace the right gradient fade mask on total and token balance bars with a crisp end-cap notch and an explicit scale indicator directly aligned to the bar.
  - fix: Home desktop: deduplicate or add distinct relative timestamps (e.g. '12m ago', '1h ago') and frame badges to identical ledger events in the Recent card.
  - fix: Home desktop: increase text color of bilateral capacity labels under the Hub One bar from muted gray to high-legibility secondary text (#A1A1AA).
  - fix: Home desktop: expand the Balances card into a full table layout with columns for On-chain, Reserve, and Bilateral accounts to balance the left column height against the right column.
- (grok-latest) Home + Pay + Account desktop: the $11,500 composition bar is stretched to the left column while Hub One’s send/receive bar is stretched to the card; 11.5k and ~100k read as the same width, so 1px=$N is fake.
- (grok-latest) Home desktop: the On-chain $0.00 / Reserve $1,500.00 / Accounts $10,000.00 legend under the total repeats the bar; Instant already says the only extra fact.
- (grok-latest) Home + Activity + Activity-detail: two identical ‘Credit limit updated · 50,000.00 USDC’ rows with no yours/theirs label, so a 50k credit event looks like a 50k payment.
- (grok-latest) Home desktop: hero is ‘$11,500.00’ but the USDC row is ‘11,500.00’ and Hub One uses ‘60,000.00’ with no $; mint is used for sync, reserve, and settled.
  - fix: Draw every bar at Settings scale (1px=$10): length=amount/scale, never width:100%; clip overflow with a right fade and a numeric remainder. $11,500 = 1150px at $10/px; 60k send must be ~5.2× that.
  - fix: Delete the three-dot legend under Total balance; keep one caption: ‘Instant · send $60,000 · receive $40,000’.
  - fix: Rename the two activity rows ‘Their credit line · 50,000.00 USDC’ and ‘Your credit line · 50,000.00 USDC’ (same labels as the Account card).
  - fix: One money string on Home: $11,500.00 / $10,000.00 / $60,000.00. Mint (#34D399) only on settled/positive; sync is a 6px dim dot, reserve is not mint.

### desktop-dark/02-pay.png

  - fix: Pay screen: Consider adding a subtle border or background to the route visualization for better separation from payment form
- (gemini-flash-latest) Pay desktop: the recipient field displays an unformatted 66-character hex address wrapped across two lines ('0x499d0dc46b549fcf353811291de337ef5aa6fa651b77ccd36dc0efbd64fef2bd'), creating visual clutter compared to the clean truncated address in the Route card.
- (gemini-flash-latest) Pay desktop: the payment route is redundantly displayed in two places—as an interactive pill row in the main form and as a full vertical stepper in the right rail Route card.
- (gemini-flash-latest) Pay desktop: 'This payment: 25.00' renders as an imperceptible 2.5px dot on the 1px=$10 scale while Before/After bars show no visible difference due to the $60k capacity, failing to give meaningful visceral feedback for small transactions.
- (gemini-flash-latest) Pay desktop: the Delivery field places the action link immediately after the status without spacing or separator ('Instant Change'), appearing as a single garbled label.
  - fix: Pay desktop: truncate recipient address in the input header to '0x499d...ef2bd' with an inline copy icon, revealing full hex only on click or hover.
  - fix: Pay desktop: remove the redundant inline Route pill row from the main form card, letting the right-rail Route stepper own the multi-hop visualization.
  - fix: Pay desktop: add a minimum visible width (8px) with a localized delta zoom callout on the payment bar so small transactions remain readable.
  - fix: Pay desktop: separate the delivery status and change button with flex-between spacing or a clear button outline for 'Change'.
- (grok-latest) Pay desktop: route is drawn three times (You→Hub One→Meridian Desk chips, ROUTE tree, and the Arrives/Delivery table) plus a full 42-char To hex — the form is a map, not a payment.
- (grok-latest) Pay desktop: Fee is 0.000050 USDC in the table and 0.000025 in the ROUTE tree; two fees on one payment kills trust.
- (grok-latest) Pay desktop: amount hero is ‘25’ while CTA is ‘Pay 25.00 USDC’ and ‘This payment’ is 25.00; the 25-wide tick in the amount card does not share scale with the full-width 60k Hub One bar under it.
- (grok-latest) Pay desktop: Delivery ‘Instant Change’ looks like a broken control; the expand icon top-right has no label.
  - fix: Keep one route: the You → Hub One → Meridian Desk chips. Drop the ROUTE tree card or reduce it to a single fee line. Truncate To to 0x499d…ef2bd with copy-on-click; do not wrap the full hex.
  - fix: One fee, one place: 0.000050 USDC (or 0.000025) next to Arrives. Delete the other.
  - fix: Hero amount ‘25.00’; CTA ‘Pay $25.00 USDC’. Overlay the $25 payment as a 2.5px hatch on the Hub One bar at 1px=$10; do not give ‘This payment’ its own track.
  - fix: Replace ‘Instant Change’ with a quiet ‘Arrives instantly’ and put any slow path under a ‘More’ disclosure. Remove the unlabeled expand button.

### desktop-dark/03-receipt.png

- (glm-4.6v) Receipt modal: Background dimming could be stronger to focus attention on the modal content
  - fix: Receipt modal: Increase background dim opacity to 80% for better modal focus
  - fix: Receipt modal: Add a subtle shadow to the modal for depth
- (gemini-flash-latest) Receipt desktop & Pay desktop: when the modal opens, a floating toast notification ('Payment submitted: 25.00 USDC to Meridian Desk') simultaneously appears at the bottom of the viewport, creating competing visual confirmations.
- (gemini-flash-latest) Receipt desktop: the Settled row reads 'Instantly · 2049 ms', which is contradictory and confusing because ~2 seconds is not instantaneous.
- (gemini-flash-latest) Receipt desktop: the primary 'Done' action is rendered as a dark ghost button (#1E2028 on #12141A) with low contrast, making dismiss intent weak for a success dialog.
  - fix: Receipt desktop: suppress toast notifications when a modal receipt is triggered so the modal remains the single confirmation surface.
  - fix: Receipt desktop: replace 'Instantly · 2049 ms' with 'Committed in 2.05s' or show exact block/frame commitment time without the conflicting 'Instantly' label.
  - fix: Receipt desktop: change the 'Done' button background from dark slate to primary accent (#6E7CFF) or high-contrast white/mint to clearly anchor completion.
- (grok-latest) Receipt + Receive + Swap desktop: toast ‘Payment submitted: 25.00 USDC to Meridian Desk’ sits under a modal that already says PAID / Settled — optimistic language on a committed frame, and the toast then leaks onto Receive and Swap.
- (grok-latest) Receipt vs Activity-detail: same payment is Frame #42 and proof …0b0f here, Frame #43 and proof …320b0f in the pane; time is ‘2049 ms’ vs ‘00:15:11’.
- (grok-latest) Receipt desktop: ‘Instantly · 2049 ms’ is a bench number, not a bank receipt; Done and the X duplicate; no bar for $25 vs remaining capacity.
  - fix: Delete the submitted toast everywhere. After commit, one receipt surface only (prefer the Activity master-detail pane on desktop; modal is a fallback).
  - fix: Pin one evidence triple for this payment: frame height, proof hash, clock time. Reuse it on modal and Activity-detail. Drop milliseconds; ‘Instant’ or ‘2s’ max.
  - fix: Receipt body: amount, counterparty, frame, proof (copy), ‘Verified by your runtime’. One close control. Optional: 25px hatch on a scaled Hub One bar, not a second CTA.

### desktop-dark/04-receive.png

- (glm-4.6v) Receive screen: QR code background is too bright, creates harsh contrast with dark theme
  - fix: Receive screen: Reduce QR code background brightness or add subtle border
  - fix: Receive screen: Increase contrast on 'receive up to 40,025.00 instantly' text
- (gemini-flash-latest) Receive desktop: the QR code container is an unpadded, pure white (#FFFFFF) block that glares harshly against the pitch-dark background and lacks dark-mode calming.
- (gemini-flash-latest) Receive desktop: an arbitrary blue gradient underline is rendered under the 0.00 amount input with no scale label or notch, violating the visceral value rule.
- (gemini-flash-latest) Receive desktop: the screen offers three competing copy actions ('Copy invoice', 'Copy link', 'Copy xln:// app link') without explaining how they differ in protocol behavior or payload.
- (gemini-flash-latest) Receive desktop & Swap desktop: a stale toast from the previous payment ('Payment submitted: 25.00 USDC to Meridian Desk') persists at the bottom of the viewport.
  - fix: Receive desktop: soften the QR container to a dark card with 16px padding and off-white QR modules (#E4E4E7) to eliminate dark-mode glare.
  - fix: Receive desktop: remove the blue gradient underline under the amount input and replace it with standard input focus borders.
  - fix: Receive desktop: consolidate actions into a primary 'Copy Link' button and a secondary dropdown menu for raw invoice and deep link protocols.
  - fix: Receive desktop: ensure toast dismissal unmounts globally on navigation to prevent lingering stale messages.
- (grok-latest) Receive desktop: amount is 0.00 but a full-width indigo bar fills the field — at 1px=$N a zero invoice is an empty track; this bar lies.
- (grok-latest) Receive desktop: three copy verbs (Copy invoice, Copy link, Copy xln:// app link) with no difference stated; YOUR ENTITY ID is a low-contrast 40-char smear with no copy on the row.
- (grok-latest) Receive desktop: the whole stack is a ~420px mobile column in a 1440px frame (QR, field, field, hex, two buttons). Pay already showed the correct two-column pattern.
  - fix: If amount is 0.00, draw no fill (0px). If the bar is ‘receive up to 40,025’, label it that and draw 4002.5px at $10/px, clipped — never a decorative underline.
  - fix: One primary: ‘Copy link’. Invoice and xln:// go under a single ‘More copy options’ menu. Entity ID: 0xf581…b476 with a copy glyph, 14px tabular, contrast ≥4.5:1.
  - fix: Desktop: QR + amount on the left (~480px), note + id + copy on the right. Do not center a phone layout in the canvas.

### desktop-dark/05-swap.png

  - fix: Swap screen: Consider adding a subtle divider between 'You pay' and 'You receive' sections for clearer separation
- (gemini-flash-latest) Swap desktop: entering '100 USDC' in 'You pay' leaves 'You receive' at '0.00 WETH' with no quote, exchange rate, fee breakdown, or price impact shown, making the swap opaque.
- (gemini-flash-latest) Swap desktop: the primary 'Swap' button is disabled without an explanatory tooltip or state label explaining why.
- (gemini-flash-latest) Swap desktop: the right rail only displays the USDC account bar for Hub One, ignoring the counterpart token (WETH) capacity needed to complete the swap.
- (gemini-flash-latest) Swap desktop: layout uses a narrow two-column container centered on the desktop viewport, leaving vast unused space on both sides.
  - fix: Swap desktop: render a live exchange rate quote (e.g. '1 WETH = 3,250.00 USDC') and auto-populate the estimated receive amount before allowing swap submission.
  - fix: Swap desktop: show button state text explaining disablement (e.g. 'Enter valid pair' or 'No quote available') instead of an unexplained muted button.
  - fix: Swap desktop: display both the source token (USDC) and target token (WETH) bilateral capacity bars in the right rail card.
  - fix: Swap desktop: expand the swap card max-width or add orderbook depth/pool stats to utilize the desktop layout.
- (grok-latest) Swap desktop: You pay 100 USDC against You receive 0.00 WETH with a still-visible Swap CTA and no rate, min-received, or empty-book state — it looks possible to spend 100 for nothing.
- (grok-latest) Swap desktop: right card repeats the Hub One capacity bar with no 100 USDC hold hatch (spec: holds are hatched) and no before/after, unlike Pay.
- (grok-latest) Swap desktop: ‘Same network / Across networks’ is a protocol toggle in the title row; body copy uses ‘move Δ’. Toast leftover from Pay still at the bottom.
  - fix: When the book cannot quote: receive stays 0.00, Swap is disabled at 30% opacity, and a 12px caption reads ‘No WETH book on Hub One’. Never a live CTA on a 100→0 quote.
  - fix: Show rate (USDC per WETH), then hatch a 10px hold on the Hub One send side for $100 at 1px=$10. Reuse Pay’s Before/After pair.
  - fix: Move network scope under the receive token (‘Hub One · same network’). Write ‘Filled size moves the account delta; nothing settles on-chain.’ Kill the toast.

### desktop-dark/06-account.png

  - fix: Account screen: Consider adding hover states to token rows for better interactivity feedback
- (gemini-flash-latest) Account desktop: the 4-part bar legend ('collateral', 'credit line', 'owed', 'in flight') is duplicated in full inside every single token card (USDC, WETH, USDT), creating unnecessary repetitive clutter.
- (gemini-flash-latest) Account desktop: empty token accounts (WETH and USDT at 0.00) occupy the same large card height as the active USDC account, pushing relevant data down.
- (gemini-flash-latest) Account desktop: the entity address in the header is a raw 66-character hex string spanning across the top without a truncation rule or copy button.
- (gemini-flash-latest) Account desktop: all content is trapped in a single centered 600px column on wide desktop, leaving empty black gutters on either side.
  - fix: Account desktop: hoist the bilateral bar legend to a single header-level guide or tooltip, removing the repeated legend rows from individual token cards.
  - fix: Account desktop: collapse zero-balance token accounts into compact one-line rows with an expandable chevron.
  - fix: Account desktop: format the header entity ID as '0x5725...8d47' with an inline copy icon and external explorer/runtime link.
  - fix: Account desktop: switch to a two-column desktop layout with token accounts on the left and hub metadata/credit configuration on the right.
- (grok-latest) Account desktop: legend is collateral=green, credit line=blue, owed=amber, in flight=purple, but the USDC bar is amber|blue halves — right ‘receive’ is painted as ‘credit line’, so the legend is a lie.
- (grok-latest) Account desktop: +9,975 owed on a ‘send up to 59,975’ track is drawn as nearly-full left amber; at one scale owed is ~17% of send, not 90%. Collateral 0.00 is mint, which is for positive/settled.
- (grok-latest) Account desktop: WETH and USDT empty cards each repeat the 4-color legend, three zero rows, and ‘Canonical state >’; Hub One’s 40-char hex sits above the money. Narrow centered column wastes the rail layout.
  - fix: Paint the bar from the legend: left of notch = stack(own credit indigo, collateral purple, owed amber), right = receive credit; in-flight hatched. If a component is 0, omit it.
  - fix: At 1px=$10, left fill for $9,975 owed = 998px of a 5,998px send track (clip). Collateral 0.00 uses the same dim number color as 0.00 WETH, not mint.
  - fix: One legend on the USDC card only. Collapse even tokens to a single row ‘WETH 0.00 · even’. Rename ‘Canonical state’ to ‘Signed state’. Desktop: token list left, selected token+bar right. Copy icon on a truncated hub id.

### desktop-dark/07-activity.png

- (glm-4.6v) Activity screen: 'Select a movement to see its receipt' placeholder text is too prominent
  - fix: Activity screen: Reduce opacity of placeholder text to 50% when no item selected
  - fix: Activity screen: Add subtle hover effect to activity items for better interactivity
- (gemini-flash-latest) Activity desktop: the right-side detail pane renders a blank bordered box with placeholder text ('Select a movement to see its receipt.'), wasting half the desktop screen when navigating to Activity.
- (gemini-flash-latest) Activity desktop: transaction rows show no individual timestamps (e.g. '14:20' or '2h ago'), relying solely on the coarse section header 'TODAY'.
- (gemini-flash-latest) Activity desktop: consecutive 'Credit limit updated' rows are visually indistinguishable, showing identical amounts and labels without frame numbers or sequence indicators.
- (gemini-flash-latest) Activity desktop: transaction rows lack visceral value bars, abandoning the core 1px=$N principle across the ledger view.
  - fix: Activity desktop: default-select the most recent transaction on desktop load so the receipt details immediately populate the right rail.
  - fix: Activity desktop: add tabular monospace timestamps (e.g. '14:32:05') to the right of each transaction row.
  - fix: Activity desktop: show frame numbers or sequence badges (e.g. 'Frame #41' vs 'Frame #42') to differentiate repeated protocol events.
  - fix: Activity desktop: render a subtle horizontal magnitude bar under transaction amounts calibrated to the active global scale.
- (grok-latest) Activity desktop: +10,000.00 and −25.00 are the same row height with no bar, so a 400× size difference exists only as digits — visceral value is off.
- (grok-latest) Activity desktop: right pane is a short empty card ‘Select a movement to see its receipt’ instead of a full-height detail; ‘5 movements’ is protocol-speak.
- (grok-latest) Activity desktop: no time on rows (only TODAY); unsigned 50,000.00 on credit-limit rows can be read as incoming money (same issue as Home).
  - fix: Add a 1px=$10 bar under each payment amount (10,000 = 1000px clipped; 25 = 2.5px). Non-payments get no bar.
  - fix: Make the right pane a full-height empty state: 13px ‘Select a movement’. Header counter: ‘5’ not ‘5 movements’.
  - fix: Row meta: ‘Today · 00:15’ (or relative). Credit rows use the yours/theirs labels from the Account card, not a bare 50,000.00.

### desktop-dark/08-activity-detail.png

- (glm-4.6v) Activity detail: Right panel could use more breathing room from the edge of screen
  - fix: Activity detail: Add 16px left margin to right panel for better desktop layout balance
  - fix: Activity detail: Increase font size of frame number for better prominence
- (gemini-flash-latest) Activity Detail desktop: a stray 'just now' text string floats detached at the bottom left under 'Account opened' with no associated row or icon, indicating a layout rendering bug.
- (gemini-flash-latest) Activity Detail desktop: the active selected row in the left list has an extremely subtle background difference (#181A20 vs #0D0E12), making it difficult to spot which transaction is being inspected.
- (gemini-flash-latest) Activity Detail desktop: cryptographic proof hash ('0xf1431594...320b0f') and counterparty address lack click-to-copy affordances or verified explorer tooltips.
  - fix: Activity Detail desktop: fix the left list layout bug by anchoring the 'just now' timestamp inside the item flex container or removing orphaned text nodes.
  - fix: Activity Detail desktop: enhance the selected row state with an accent left border (#6E7CFF, 3px) and a slightly brighter container background (#1F222E).
  - fix: Activity Detail desktop: add an inline copy button and tooltip next to Proof hash and To address in the receipt card.
- (grok-latest) Activity-detail vs Receipt: Frame #43 vs #42, proof suffix …320b0f vs …0b0f, ‘00:15:11’ vs ‘2049 ms’, ‘PAYMENT · SETTLED’ vs ‘PAID’ — one payment, two evidence sets.
- (grok-latest) Activity-detail desktop: ‘Frame #43’ and ‘Frames · 5 committed entries’ collide; ‘00:15:11’ is unlabeled (clock vs duration); ‘just now’ floats under the list off-grid.
- (grok-latest) Activity-detail desktop: To is ‘Meridian Desk0x499d0d…f2bd’ with a missing space; still no scaled bar next to −25.00.
  - fix: This pane is the canonical receipt. Modal must clone its fields. One frame height, one proof, one ISO time.
  - fix: Rows: To, Via, Frame #43, Time 00:15:11 UTC, Proof (copy). Drop ‘Frames · 5 committed entries’ or rename ‘History · 5 committed frames’ as a link. Put ‘just now’ on the selected row, not in the left margin.
  - fix: To: ‘Meridian Desk · 0x499d…f2bd’. Optional 2.5px hatch under −25.00 at 1px=$10.

### desktop-dark/09-settings.png

- (glm-4.6v) Settings screen: 'Dollars per pixel' slider could use more visual feedback
  - fix: Settings screen: Add hover state to slider thumb for better interactivity
  - fix: Settings screen: Consider adding a subtle animation to theme toggle buttons
- (gemini-flash-latest) Settings desktop: the entire settings interface is confined to a single narrow column (~640px) centered in the viewport, leaving over 60% of the desktop display as unused dark space.
- (gemini-flash-latest) Settings desktop: the Home visibility toggles ('On-chain wallet', 'Reserve', 'Accounts') lack the semantic color swatches (green for Reserve, indigo for Accounts) used throughout the home bars.
- (gemini-flash-latest) Settings desktop: the Runtime id field presents an unformatted 42-character hex address without a copy icon or link to node logs.
  - fix: Settings desktop: adopt a two-column desktop grid with section navigation or descriptions on the left and interactive controls on the right.
  - fix: Settings desktop: add semantic color indicators (mint dot for Reserve, indigo dot for Accounts) next to each toggle title to visually reinforce tier identity.
  - fix: Settings desktop: format the Runtime id with monospace styling, a copy-to-clipboard button, and an active node status ping badge.
- (grok-latest) Settings desktop: ‘1 px = $10’ is in the SCALE header, beside the slider, and on the $10 chip — three captions for one value, and there is no live bar preview so the control does not prove itself.
- (grok-latest) Settings desktop: VAULT row is ‘Sandbox / sandbox’; RUNTIME ‘Mode embedded’ is internal. Reveal recovery phrase is a peer of Lock with no re-auth step shown.
- (grok-latest) Settings desktop: another centered ~560px mobile stack; this is the one screen that should preview visceral scale in the spare column.
  - fix: Keep the $10 chip + one live caption ‘1px = $10’. Right column: a 1150px-clipped bar labeled ‘$11,500 at this scale’ and a 2.5px tick labeled ‘$25’.
  - fix: Rename VAULT → Network, value ‘Sandbox’. Hide ‘Mode embedded’ or move under a Debug disclosure. Runtime id truncated with copy. Reveal recovery: require Lock/re-auth, danger styling, not a sibling of Lock.
  - fix: Desktop two-column: controls left, scale preview right.

### desktop-light/01-home.png

- (glm-4.6v) Home desktop: The tier legend under the total repeats the three numbers already shown in the bar tooltip; drop it or make it the bar's caption
- (glm-4.6v) Home desktop: The 'Instant' send/receive limits text is too small and low emphasis, making the visceral value principle unclear
- (glm-4.6v) Home desktop: The 'Open account' button in the Accounts panel has inconsistent styling with primary actions
  - fix: Home desktop: Remove redundant tier legend or integrate it as bar caption
  - fix: Home desktop: Increase size/contrast of instant limits text to make visceral value principle obvious
  - fix: Home desktop: Apply primary button styling to 'Open account' button
- (gemini-flash-latest) Home desktop: the grand balance tier bar under $11,500.00 terminates in an ungrounded linear gradient fade on the right, obscuring whether the bar represents total capacity or open headroom.
- (gemini-flash-latest) Home desktop: the tier legend under Total Balance ('On-chain $0.00', 'Reserve $1,500.00', 'Accounts $10,000.00') repeats numbers already shown in the account breakdown below.
- (gemini-flash-latest) Home desktop: while the 60/40 two-column split organizes data cleanly (a strong desktop trade-off), the 'RECENT' card repeats identical 'Credit limit updated' entries consecutively with no deduplication or grouped timestamps.
  - fix: Home desktop: replace the right-side gradient mask on `.total-tier-bar` with a solid track outline and explicit max capacity tick mark.
  - fix: Home desktop: remove `.tier-legend` row below total balance and embed the three amounts into a segmented tooltip or bar caption.
  - fix: Home desktop: add deduplication or a grouped counter badge ('2x') to consecutive identical state transitions in the Recent activity list.
- (grok-latest) Home desktop-light: the Total balance bar is a width-filling green+blue stack with a fade tail, not 1 px = $N; it cannot be compared to the Hub One send/receive bar on the same screen.
- (grok-latest) Home desktop-light: On-chain $0.00 / Reserve $1,500.00 / Accounts $10,000.00 under the total restates the bar, then Instant restates Hub One’s $60,000 / $40,000 — three captions for one number.
- (grok-latest) Home desktop-light + Account desktop-light: bilateral bars fade to transparent, so send $60,000 vs receive $40,000 is not readable as 3:2 (the blue tail looks longer than the amber).
- (grok-latest) Home desktop-light: “1 token · 2 empty hidden”, sandbox, and hub chips are chrome; Recent lists two identical Credit limit updated 50,000.00 rows.
  - fix: Home total + USDC row: paint each tier at Settings scale with a hard stop (no fade); leave unused track empty so $11,500 is visibly shorter than the Hub One $100,000 capacity bar.
  - fix: Delete the On-chain/Reserve/Accounts legend and the Instant duplicate; if a caption is needed, one line under the bar: “Reserve $1,500 · Accounts $10,000”.
  - fix: Bilateral bars (Home Accounts, Pay, Account): hard-edged left/right from the notch; length(send)=$60,000 and length(receive)=$40,000 at the same px/$ as Home.
  - fix: Drop sandbox/hub chips and “N empty hidden”; collapse duplicate Credit limit updated rows into one.

### desktop-light/02-pay.png

- (glm-4.6v) Pay screen: The route visualization could be more prominent to reinforce visceral value
- (glm-4.6v) Pay screen: The 'Instant' label on arrival time is too subtle for critical trust information
  - fix: Pay screen: Make route visualization larger and more central
  - fix: Pay screen: Increase contrast/size of 'Instantly' label to emphasize provable speed
- (gemini-flash-latest) Pay desktop: 'This payment' preview displays a tiny 25.00 single pixel/dot without a surrounding background track, making visual comparison hard without reading text.
- (gemini-flash-latest) Pay desktop: while the right-column Before/After bilateral account comparison is exceptionally clear for transaction impact (trade-off: adds height), the 'Add a note >' trigger is pushed below the fold on compact viewports.
  - fix: Pay desktop: add a subtle background track with tick marks to the 'This payment' micro-bar matching the 1px=$10 scale.
  - fix: Pay desktop: move 'Add a note' into the primary amount card directly under the currency selector to prevent CTA displacement.
- (grok-latest) Pay desktop-light: Fee is 0.000050 USDC in the form table and 0.000025 in the ROUTE panel — two fees for one payment.
- (grok-latest) Pay desktop-light: route is drawn three times (You → Hub One → Meridian Desk chips, right ROUTE list, Arrives/Delivery).
- (grok-latest) Pay desktop-light: $25 is not marked on the 60k/40k bar; Before 10,000.00 and After 9,975.00 bars are visually identical.
- (grok-latest) Pay desktop-light: To dumps the full 0x499d… hex; a stray bullet sits under This payment; Delivery “Instant Change” reads as a contradiction.
  - fix: Single fee source: show 0.000025 USDC (or the real figure) once, next to the route, never again.
  - fix: Delete the Route chip row; keep the right ROUTE list as the only path diagram.
  - fix: On both Before/After bars, hatch or overlay a $25 hard segment at scale; do not redraw the full 60k/40k bar inside the Amount card.
  - fix: To: name + 0x499d…f2bd on one line; remove the bullet; Delivery = “Instant” only, move Change into a quiet text button.

### desktop-light/03-receipt.png

- (glm-4.6v) Receipt modal: The proof hash is truncated and hard to read
- (glm-4.6v) Receipt modal: 'Verified by your runtime' text is too small for critical trust indicator
  - fix: Receipt modal: Show full proof hash or make it copyable
  - fix: Receipt modal: Increase size/contrast of verification text
- (gemini-flash-latest) Receipt desktop: modal dialog is rendered simultaneously with the bottom toast banner ('Payment submitted: 25.00 USDC to Meridian Desk'), creating dual competing completion indicators.
- (gemini-flash-latest) Receipt desktop: the receipt modal lacks any visceral value bar graphic, communicating committed settlement exclusively through text and metadata.
  - fix: Receipt desktop: suppress or dismiss the bottom submission toast immediately when the deterministic receipt modal mounts.
  - fix: Receipt desktop: render a mini bilateral account bar inside the receipt modal showing the new 9,975.00 balance state and the 25.00 deduction.
- (grok-latest) Receipt desktop-light + Receive/Swap/Account: toast “Payment submitted: 25.00 USDC…” while the modal says PAID / Settled instantly — submitted vs settled, and the toast then sticks on unrelated screens.
- (grok-latest) Receipt desktop-light vs Activity detail: Frame #42 vs #43; “2023 ms” vs “00:15:23”.
- (grok-latest) Receipt desktop-light: no bar; $25 vs $11,475 is numerals only.
- (grok-latest) Receipt desktop-light: X and Done both dismiss; Done is a large gray brick under a generic mint check.
  - fix: If the frame is committed, no toast, or toast = “Settled · frame 42”; never “submitted” after PAID; auto-dismiss so it cannot appear on Receive/Swap/Account.
  - fix: One frame id and one clock: Frame #42 (or #43, not both) and “2023 ms”; reuse that pair on Activity detail.
  - fix: Under 25.00, a 25 px-at-scale hard bar beside a ghost track of the $11,475 total.
  - fix: Remove X; Done as a text button. Keep the mint check at 40 px, not a hero orb.

### desktop-light/04-receive.png

- (glm-4.6v) Receive screen: The receive limit text is too small and positioned awkwardly
- (glm-4.6v) Receive screen: No clear indication of provable receipt mechanism
  - fix: Receive screen: Increase size/position receive limit text more prominently
  - fix: Receive screen: Add provability indicator near QR code
- (gemini-flash-latest) Receive desktop and Settings desktop: both screens lock layout to a narrow ~440px mobile column centered in the 1440px viewport, leaving ~65% of the desktop canvas completely vacant.
- (gemini-flash-latest) Receive desktop: the amount input features an unstyled solid blue bottom border line that disrupts the card container aesthetic used elsewhere.
- (gemini-flash-latest) Receive desktop: shows zero visceral value representation of the 'receive up to 40,025.00 instantly' capacity limit.
  - fix: Receive desktop: adopt a two-column desktop layout placing the QR code and invoice link on the left, and inbound capacity bars with pending incoming invoices on the right.
  - fix: Receive desktop: remove the bottom border on the amount input in `.receive-amount` and use the uniform `.card` inset styling from Pay.
  - fix: Receive desktop: add an inbound bilateral headroom bar under 'receive up to 40,025.00 instantly' at the global 1px=$10 scale.
- (grok-latest) Receive desktop-light: stale “Payment submitted…” toast on an invoice screen.
- (grok-latest) Receive desktop-light: indigo fade under Amount 0.00 reads as a filled value, not a $0 request (caption says receive up to 40,025.00).
- (grok-latest) Receive desktop-light: single centered column (QR + form) while Pay uses two columns — desktop width unused.
- (grok-latest) Receive desktop-light: Copy invoice, Copy link, and Copy xln:// app link are three copy actions; YOUR ENTITY ID is a raw hex dump.
  - fix: Kill the toast on route change (see Receipt).
  - fix: Amount 0.00: no bar. If a request is entered, draw only that amount at scale; put “receive up to 40,025” as caption, not a full-width indigo strip.
  - fix: Desktop: QR + entity id in the right column; amount/note/copy in the left, same 2-col shell as Pay.
  - fix: One primary: Copy link. Invoice and xln:// as overflow. Entity id: truncated with a copy glyph, not 64 hex chars.

### desktop-light/05-swap.png

- (glm-4.6v) Swap screen: The account limits bar is too small and hard to interpret
- (glm-4.6v) Swap screen: No clear indication that swaps are instant and provable
  - fix: Swap screen: Increase size of account limits bar
  - fix: Swap screen: Add provability indicator near swap button
- (gemini-flash-latest) Swap desktop: the right column renders only one small 'YOUR ACCOUNT WITH HUB ONE' card, leaving a massive empty void below it on desktop.
- (gemini-flash-latest) Swap desktop: the primary 'Swap' button in its disabled/pending quote state uses `--accent-dim` with low-contrast white text, failing legibility standards.
- (gemini-flash-latest) Swap desktop: displays no price quotation, exchange rate (USDC/WETH), or price impact summary before execution.
  - fix: Swap desktop: fill the right column with a swap routing breakdown card showing the pool/hub quote, fee rate, and before/after token balance bars.
  - fix: Swap desktop: adjust disabled button styling in `.swap-submit` to use `--surface-3` background with `--ink-3` text for clear inactive status.
  - fix: Swap desktop: display an exchange rate badge (e.g. '1 WETH = 3,450.00 USDC') between the pay and receive input cards.
- (grok-latest) Swap desktop-light: You pay 100 USDC / You receive 0.00 WETH with a disabled Swap and no rate, impact, or reason — looks broken, not empty.
- (grok-latest) Swap desktop-light: no After-state (Pay has Before/After); the Hub One bar does not mark the $100.
- (grok-latest) Swap desktop-light: stale payment toast; sandbox chip on USDC.
- (grok-latest) Swap desktop-light: Same network / Across networks floats top-right; right column is one short card over a blank canvas.
  - fix: If unquoted: receive = “—” not 0.00; one line under the CTA: “No WETH on this account” (or the real reason); do not imply 100→0.
  - fix: When quoted: show rate + min receive, and Before/After bars with the $100 hard segment at scale (same widget as Pay).
  - fix: Remove toast and sandbox chip.
  - fix: Pin Same network into the left card header; fill the right column with the after-bar, not a lecture paragraph.

### desktop-light/06-account.png

- (glm-4.6v) Account screen: The credit line breakdown bars are too small
- (glm-4.6v) Account screen: 'Canonical state' link is too subtle for important state information
  - fix: Account screen: Increase size of credit line bars
  - fix: Account screen: Make 'Canonical state' link more prominent
- (gemini-flash-latest) Account desktop: single centered narrow column wastes desktop width and causes the persistent bottom toast to directly overlap and obscure the USDT card.
- (gemini-flash-latest) Account desktop: the bilateral bar implementation with debt, notch, and credit line is the most informative in the app (trade-off), but legend indicators ('— collateral', '— credit line') use tiny 11px font with low-contrast colored dashes.
  - fix: Account desktop: convert the token list on desktop into a 2-column or 3-column responsive card grid, and clear sticky toasts on route change.
  - fix: Account desktop: replace dash legend markers in `.bar-legend` with distinct 8x8px square swatches and increase label font size to 12px with `--ink-2`.
- (grok-latest) Account desktop-light: WETH and USDT render full cards (legend, Canonical state, zero rows) for 0.00; Home already hides empty tokens.
- (grok-latest) Account desktop-light: each card legends collateral / credit line / owed / in flight (green, blue, amber, purple) but the bar is only amber|blue — the legend is false.
- (grok-latest) Account desktop-light: toast covers the USDT card; header is Hub One + hub chip + full hex.
- (grok-latest) Account desktop-light: single-column stack; Pay/Extend credit/Swap repeats Home’s 3-up chrome. Holds are not hatched.
  - fix: Hide tokens at 0.00 (same rule as Home “empty hidden”); show a quiet “WETH, USDT — even” text if needed.
  - fix: Legend only for colors actually in the bar; in-flight hatched; collateral 0.00 not mint.
  - fix: Truncate header id to 0x5725…8d47; drop hub chip; toast must not overlay cards.
  - fix: Desktop two-column: token stack left, movements right; hatch holds; keep Pay as the only filled action, Extend credit as text.

### desktop-light/07-activity.png

- (glm-4.6v) Activity screen: Transaction amounts are not visually distinct enough
- (glm-4.6v) Activity screen: No clear way to access receipts from list
- (glm-4.6v) Activity screen: Status indicators are too small
  - fix: Activity screen: Increase size/contrast of transaction amounts
  - fix: Activity screen: Add clear receipt access button per transaction
  - fix: Activity screen: Increase size of status indicators
- (gemini-flash-latest) Activity desktop: the right column is occupied solely by a single empty card ('Select a movement to see its receipt.'), wasting half of the desktop viewport.
- (gemini-flash-latest) Activity desktop: transaction amounts (+10,000.00 USDC, -25.00 USDC) completely lack visceral value bars, abandoning the wallet's core absolute-scale premise in the primary history view.
  - fix: Activity desktop: default-select the latest transaction on desktop load to populate the receipt pane immediately instead of rendering an empty placeholder card.
  - fix: Activity desktop: embed a horizontal proportional magnitude bar under each transaction row amount drawn at the user scale.
- (grok-latest) Activity desktop-light: Sent sits on the page gray while the four rows below read as a grouped list — first-row alignment bug.
- (grok-latest) Activity desktop-light: Credit limit updated 50,000.00 USDC is typeset like a transfer (same weight/position as +10,000.00 / −25.00); two identical rows.
- (grok-latest) Activity desktop-light: five filter chips for five rows; right pane is an empty “Select a movement…” card wasting the master-detail.
- (grok-latest) Activity desktop-light + detail: no bars, so −25 vs +10,000 vs 50,000 limits are distinguished only by digit count.
  - fix: One list surface: every row on the same bg; selected = fill, not a different parent.
  - fix: Limits: “Credit line → 50,000 USDC” in secondary type, one row, no +/−; payments keep signed tabular amounts.
  - fix: Filters: All + a More overflow until a type has counts; empty detail = no card, just the sentence.
  - fix: Right of each amount, a hard bar at the global scale (10,000 px-at-scale vs 25).

### desktop-light/08-activity-detail.png

- (glm-4.6v) Activity detail: The proof hash is truncated
- (glm-4.6v) Activity detail: 'From your runtime's committed frames' text is too small for trust indicator
  - fix: Activity detail: Show full proof hash
  - fix: Activity detail: Increase size/contrast of frame verification text
- (gemini-flash-latest) Activity-detail desktop: while the master-detail receipt pane provides high-trust frame verification (trade-off: desktop only), a stray unstyled 'just now' text string floats disconnected below the transaction list in the bottom-left margin.
- (gemini-flash-latest) Activity-detail desktop: receipt panel lacks visual bar representation for the -25.00 USDC movement.
  - fix: Activity-detail desktop: remove or correctly position the orphan `.timestamp` element currently overflowing below the list.
  - fix: Activity-detail desktop: include a delta visualization bar in the receipt header card showing -25.00 USDC against the Hub One account balance.
- (grok-latest) Activity detail desktop-light: Time 00:15:23 is not a wall-clock, a duration, or the receipt’s 2023 ms — unreadable as proof.
- (grok-latest) Activity detail desktop-light: Frame #43 vs receipt #42; “Frame” and “Frames · 5 committed entries” collide.
- (grok-latest) Activity detail desktop-light: subtitle “Sent to Meridian Desk via Hub One” repeats To and Via rows; “just now” hangs under the list with no row.
- (grok-latest) Activity detail desktop-light: master-detail is desktop-only; no sheet pattern is shown for the shared mobile codebase.
  - fix: Time = “2023 ms · frame 42” (same as receipt); drop 00:15:23.
  - fix: One Frame row; rename the other “Batch · 5 entries” or delete it.
  - fix: Delete the subtitle or the To/Via rows; bind “just now” to the Sent row, not the canvas.
  - fix: On < desktop, this panel is a sheet from the row; do not leave a dead right column on mobile.

### desktop-light/09-settings.png

- (glm-4.6v) Settings screen: The dollars per pixel scale slider could be more prominent
- (glm-4.6v) Settings screen: Security options at bottom are too subtle
  - fix: Settings screen: Increase prominence of scale slider
  - fix: Settings screen: Make security options more prominent
- (gemini-flash-latest) Settings desktop: uses a phone-width single column centered in a vast desktop void, requiring vertical scrolling despite abundant screen real estate.
- (gemini-flash-latest) Settings desktop: the 'Dollars per pixel' slider and preset chips are functional, but lack a live sample bar beneath them to preview the visual effect of changing scale.
  - fix: Settings desktop: reorganize settings into a two-column desktop layout (Left: Scale & Display preview; Right: Runtime, Vault & Accounts).
  - fix: Settings desktop: add a live interactive preview bar showing a $1,000 amount rendered at the selected scale directly beneath the preset chips.
- (grok-latest) Settings desktop-light: “1 px = $10” appears three times (section meta, slider value, $10 chip) with no live preview bar — the scale is explained, not shown.
- (grok-latest) Settings desktop-light: SCALE chips $1…$1000 plus a slider are two controls for one integer.
- (grok-latest) Settings desktop-light: VAULT reads “Sandbox / sandbox”; Runtime id is a raw hex row among non-editable status (Mode, Frame).
- (grok-latest) Settings desktop-light: Home toggles can keep On-chain $0.00 on Home (and they do), which is the legend noise on 01-home.
  - fix: One value: chips only (or slider only). Beside it, a 200 px track with a $2,000 hard bar labeled “this is $2,000 at 1 px = $10”.
  - fix: Hide On-chain when $0 even if the toggle is on, or default the On-chain toggle off.
  - fix: Vault: “Network · sandbox” once. Runtime id truncated + copy. Frame stays as status, not a faux setting.
  - fix: Reveal recovery phrase stays secondary; Lock as the only filled button in VAULT.
