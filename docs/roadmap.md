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

## Post-launch engineering backlog

These items are valuable but are not allowed to obscure the active mainnet
blocker list:

- CandidateExecution/FrameDraft copy-on-write execution, Account transition
  journals, cached Entity Account-section commitments and extraction of the
  large consensus facades after byte-identical differential evidence.
- Event-driven dirty Account/book/deadline indexes, stable proposable queues,
  one-signature representation reuse and internal verified-witness reuse.
- Runtime-level CrossJCoordinator plus separate immutable CrossJTerms and
  versioned CrossJProgress reducers.
- Cross-j evidence simplification after release: one pure verified-evidence
  decoder shared by consumers without sharing their authority checks; one
  committed-route transition reducer; and a minimal canonical progress tuple
  with UI/debug projections derived from it.
- Rebuildable cross-j lookup indexes and consolidated telemetry formatting.
  Indexes remain non-authoritative, bootstrap from committed state, and are
  checked against canonical state; opening/progress/close retain distinct typed
  validators instead of a generic financial transaction.
- A centrally tested dispute-evidence budget derived from the canonical ABI and
  Account resource limits, so future limit or ABI changes cannot make honestly
  signed state exceed jurisdiction calldata bounds.
- Explicit bilateral special-confirm recovery for a finalized disputed Account,
  with a new domain-separated confirmation, immutable finalized J-nonce binding,
  and complete stale proof/draft cleanup. Until that protocol is designed,
  audited, and activated, finalized disputed Accounts remain permanently closed;
  ordinary `openAccount` never replaces them and no compatibility reopen path exists.
- Rich browser physical-storage inspector, unified QA/Health cockpit,
  shareable detached history viewer and additional failure-inbox UX.
- Complete BrowserVM-only catalog parity for the non-release `lock-ahb` and
  `dispute-transformer` runners before exposing either as a browser preset.
  Their dispute start/finalization uses the canonical scenario clock and receipt
  evidence, but later multi-entity history fanout can still reject with
  `J_PREFIX_LOCAL_PREFIX_MISMATCH`; RPC/mainnet and the shipped hub-collapse
  Scenario Player flow are independently green.
- Persist the original signed swap `maxFee` and `minNetReceive` in terminal
  swap-history projections so closed-order UI and audits retain the user's
  authorization envelope. This is audit metadata only and must not introduce
  another fee formula or change execution authority.
- A future fresh typed mutable-path schema for generic oversized Entity/Book
  records. There will be no compatibility reader before mainnet.

## Next product milestone — universal jurisdiction Stack Manager

- Add a dedicated Settings tab for deploying one canonical jurisdiction stack
  to an arbitrary EVM RPC. Show the active BrainVault signer, chain id, native
  gas balance, refresh/funding guidance, estimated deployment cost and exact
  resulting contract addresses before the jurisdiction is saved locally.
- Expose basic network/name inputs first and keep admin, token catalog, dispute
  defaults, fee/risk limits and deployment verification in collapsed Advanced.
- Build one typed `deployStack()` orchestration library used by both the UI and
  Bun CLI. Foundation deployment becomes a configuration of that same path.
  Deployment manifests carry an explicit stack version (`V1` for the current
  contracts); versions select immutable deployed bytecode, never compatibility
  behavior inside the live Runtime path.
- Persist a deployed stack only after chain-id binding, bytecode/link-reference
  verification and receipt finality. Adding it to local jurisdiction discovery
  must not mutate any Entity consensus configuration implicitly.
- Publish community stacks to Gossip under the deployer's signer authority.
  Publish an `official` jurisdiction only with Foundation Hanko; no other signer
  can announce or replace Foundation jurisdiction metadata.

## Company formation, IPO and takeover

- Create an Entity and all seed-derived signers in one action, progressing from
  founder 1-of-1 to directors 2-of-3 with restart persistence.
- Mint separate control and dividend token classes owned initially by the
  company treasury; the listing hub receives no ownership.
- List treasury collateral through a chosen hub so buyers can immediately trade
  USDT/UTC for shares; implement buybacks as ordinary treasury bids.
- Allow a collateralized holder proving more than 50% of control to schedule a
  board replacement after at least seven days without invalidating proofs early.
- Cover issuance, partial sales, multiple buyers, failed and successful
  takeovers, delayed rotation, replay and continued trading in one TradFi-style
  screenshot flow.

## Historical Reference

The older, more detailed roadmap snapshot was preserved at:

- [archive/planning/roadmap-legacy-2026-05.md](archive/planning/roadmap-legacy-2026-05.md)
