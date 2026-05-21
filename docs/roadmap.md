# XLN Roadmap

**[← Index](readme.md)** | **[Current Status](status.md)** | **[Mainnet Bar](mainnet.md)**

This file is the strategic roadmap.

It is intentionally different from:
- `status.md` — current blockers and active work
- `mainnet.md` — the release bar for real-user-fund launch

## Strategic Goal

XLN should become the default bounded-risk alternative to centralized exchange
and custodial settlement exposure.

The bet is simple:
- users and institutions want CEX-like speed and UX
- they do not want unbounded custodial risk
- bilateral provable-credit settlement is the right architecture for that gap

## Strategic Constraints

These should stay visible because they shape the roadmap more than preferences do.

1. **The near-term market is crypto-first, not all of global finance.**
   XLN can ship today on EVM-based J-machines. It does not need CBDCs to matter.

2. **The first wedge is bounded-risk settlement, not universal composability.**
   XLN wins where bilateral state is natural: payments, settlement, treasury, and hub-mediated flows.

3. **Adoption will be ratcheted by trust failures elsewhere.**
   CEX blowups, opaque custody, and proofless balance-sheet risk are market-making events for XLN.

## Product Path

### Phase 1 — Working crypto settlement network

Focus:
- make the bilateral runtime, payment flow, and recovery story real enough for serious testnet/prod-like use
- harden the runtime, J-layer integration, and operator surfaces

What success looks like:
- the system is usable by real technical users
- failures are observable and recoverable
- launch blockers are integration/safety issues, not missing core concepts

### Phase 2 — Limited real-money network

Focus:
- launch with explicit boundaries
- small limits, strong observability, explicit supported assets and flows
- emphasize bounded-risk settlement rather than “replace all finance” rhetoric

What success looks like:
- early adopters can move value with a materially better risk profile than leaving funds on a CEX
- the operational model survives real usage
- trust is earned through boring reliability, not novelty claims

### Phase 3 — Institutional and hub network expansion

Focus:
- more hubs
- better treasury/custody flows
- stronger entity governance and board semantics
- richer recovery and compliance-grade auditability

What success looks like:
- XLN is a credible settlement rail for exchanges, market makers, treasury operators, and other high-value actors

### Phase 4 — Broader financial integration

Focus:
- extend from crypto-native settlement into wider financial interoperability when the right J-machines exist
- keep the same bilateral model; do not regress into shared-state architecture just to chase surface area

What success looks like:
- XLN becomes the obvious bilateral settlement layer wherever programmable enforcement exists

## Market Sequence

### 1. Crypto traders and custody-sensitive users

Why first:
- the pain is already obvious
- the users already understand counterparty risk
- the alternative today is mostly “trust the venue”

Value proposition:
- same broad class of UX as a centralized venue
- better risk segmentation
- proofs and bounded exposure instead of blind omnibus trust

### 2. Stablecoin-heavy businesses and operators

Why next:
- they already move value on-chain
- they already feel settlement friction and operational cost
- they benefit from off-chain bilateral velocity with explicit on-chain enforcement

Value proposition:
- faster bilateral settlement
- less needless on-chain churn
- better auditability than informal custody/trader workflows

### 3. Inter-hub / inter-venue settlement

Why later:
- this needs credibility, uptime, and governance maturity
- the savings are large, but the trust bar is much higher

Value proposition:
- bounded bilateral exposure
- less pre-funded capital drag
- explicit proofs and dispute paths

## CBDC Optionality

CBDCs are an upside branch, not the core plan.

If programmable fiat rails appear on EVM-compatible or equivalently expressive
J-machines, XLN can extend naturally.

If they do not, XLN is still valuable as crypto-native financial infrastructure.

That means the roadmap should never depend on CBDCs for near-term relevance.

## What This Roadmap Does Not Try To Do

- it does not duplicate the active blocker list from `status.md`
- it does not restate the launch gates from `mainnet.md`
- it does not promise timelines that outrun the current engineering reality

## Historical Reference

The older, more detailed roadmap snapshot was preserved at:

- [archive/planning/roadmap-legacy-2026-05.md](archive/planning/roadmap-legacy-2026-05.md)
