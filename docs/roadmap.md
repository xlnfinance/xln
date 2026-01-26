# XLN Roadmap - Crisis-Driven Infrastructure

**[← Index](readme.md)** | **[Related: Mainnet Status →](mainnet.md)**

**Vision:** Become the default bounded-risk alternative to centralized exchanges. Every CEX crisis drives irreversible adoption.

**Constraint:** XLN requires EVM J-machine (Turing-complete smart contracts for Depository.sol). Cannot work over TradFi central banks until CBDCs deployed on EVM.

**Target Market (2026-2030):** Crypto ecosystem only. Global finance requires CBDC adoption (2030+ timeline).

---

## Network Evolution

### Phase 1: Simnet (Current - Q1 2026)
**Status:** IN PROGRESS
**Goal:** Browser-only simulation. Prove bilateral consensus works.

**Tech:**
- @ethereumjs/vm (in-browser EVM)
- Depository.sol + EntityProvider.sol deployed locally
- 500 prefunded entities (USDC + ETH)
- Zero infrastructure (no servers, no RPC)

**Milestones:**
- ✅ v0.0.1 - BrowserVM working, basic panels
- [ ] v0.1.0 - Full workspace (Graph3D, Entity panel, Depository panel, time machine)
- [ ] v0.2.0 - First scenario end-to-end (ahb.ts in browser)
- [ ] v0.3.0 - VR mode (Quest browser compatible)

**Success Criteria:**
- 1,000 people try simnet
- 10 community scenarios published
- BrowserVM validates educational use case

**Timeline:** Q1 2026 (now through March)

---

### Phase 2: Testnet (Q2-Q3 2026)
**Goal:** Shared testnet. Multi-user coordination. Crisis refugees onboard here.

**Tech:**
- Base L2 Sepolia (Coinbase testnet)
- Full contract suite deployed
- Persistent state (LevelDB or server-based)
- Real RPC provider (not BrowserVM)

**Milestones:**
- [ ] v1.0.0 - Testnet launch (invite-only, 50 beta users)
- [ ] v1.1.0 - Public testnet (open registration)
- [ ] v1.2.0 - Load testing (100 entities, 1,000 tx/sec)

**Success Criteria:**
- 100+ active entities
- $1M testnet volume (play money)
- Zero bilateral consensus failures
- Mobile wallet working (iOS/Android)

**Key Event:** Wait for next CEX crisis (statistically due 2026-2027). Market when crisis hits.

**Timeline:** Q2-Q3 2026 (April - September)

---

### Phase 3: Limited Mainnet (Q4 2026)
**Goal:** Production deployment. Real money. Small amounts only.

**Tech:**
- Base L2 mainnet (production)
- Security audit (Trail of Bits or equivalent)
- Insurance: $1M bug bounty
- Envelope encryption (ECIES or HMAC)
- Watchtower protocol (offline protection)

**Launch Strategy:**
- Max $10K per user (risk containment)
- Invite-only (FTX victims, crypto OGs)
- Marketing: "Coinbase with proofs. Choose your risk."

**Success Criteria:**
- 1,000 users
- $10M TVL
- Zero exploits
- One CEX partnership (Coinbase, Kraken, or Gemini offer XLN option)

**Timeline:** Q4 2026 (October - December)

---

### Phase 4: Production Mainnet (2027-2028)
**Goal:** Scale to $100M+ TVL. Institutional-grade.

**Tech:**
- Multi-chain (Ethereum L1, Arbitrum, Optimism, Polygon)
- HSM key management
- Formal verification (TLA+ specs)
- Monitoring (Prometheus, Grafana)
- Dynamic fee market

**User caps removed.** Open to all.

**Success Criteria:**
- 10,000+ users
- $100M+ TVL
- 3+ CEXes integrated as hubs
- Institutional custody providers (Coinbase Custody, Anchorage) offer XLN

**Crisis leverage:** By 2027-2028, next major CEX failure expected. XLN positioned as escape route.

**Timeline:** 2027-2028

---

## Market Penetration (Crisis-Driven Ratchet)

### Year 0-1 (2026): Foundation - Crypto Traders

**Target:** 50M crypto traders currently using CEXes

**Pain Point:** "How do I trade on CEX without FTX risk?"

**Value Prop:**
- Same UX as Coinbase/Binance
- Set your own risk ($1K credit, $9K collateral)
- Hub bankruptcy: Lose credit limit max, not everything
- Cryptographic proof of reserves

**Adoption Mechanism:**
- Crisis refugees (next FTX victims)
- Paranoid whales (CT influencers)
- Early adopters (maxis who want proof-of-reserves)

**Market Size:** If 0.1% of crypto traders adopt = 50,000 users

**Revenue Model:** Hub fees (0.1% on volume), not user fees

**Realistic Capture:** $10M TVL by EOY 2026

---

### Year 2-3 (2027-2028): Stablecoin Transfers

**Target:** Businesses sending USDC/USDT cross-border

**Pain Point:** $100K USDC transfer = $50-200 Ethereum gas fees

**Value Prop:**
- Off-chain bilateral transfer (0.1% fee)
- Or route through XLN hub (multi-hop)
- On-chain settlement only when needed
- Provable reserves (accounting/audit compliance)

**Adoption Mechanism:**
- Crypto-native companies (already using stablecoins)
- Freelancers (paid in USDC, send to family/save)
- SMBs (cross-border commerce in crypto)

**NOT targeting:** Fiat remittances (requires banking integration)

**Market Size:** $20B/month stablecoin transfers globally

**Realistic Capture:** 1% = $200M/month volume = $200K/month revenue (0.1% fee)

---

### Year 3-4 (2028-2029): Inter-CEX Settlement

**Target:** Exchanges settling between each other

**Current System:**
- Nostro/vostro accounts (pre-funded, capital inefficient)
- On-chain transfers ($500+ gas per $100M move)
- Counterparty risk (if Binance fails, Coinbase loses nostro)

**XLN Solution:**
- Coinbase ↔ Binance bilateral account
- $10M credit, $50M collateral
- 1,000 off-chain settlements/day
- Weekly on-chain batch settlement
- Provable reserves for regulators

**Value Prop:**
- Capital efficiency (don't need $100M nostro, just $10M credit)
- Lower fees (off-chain vs on-chain)
- Bounded risk (credit limit)
- Audit trail (bilateral consensus)

**Adoption Mechanism:**
- CEX needs competitive edge (Kraken offers XLN → Coinbase must match)
- Regulatory pressure (SEC demands proof-of-reserves)
- Cost savings (millions in gas fees)

**Market Size:** $100B+ daily inter-exchange flows

**Realistic Capture:** 5% = $5B/day = $5M/day revenue at 0.01% fee

---

### Year 4-5 (2029-2030): DeFi Integration

**Target:** Aave, Compound, Curve, Uniswap

**Current System:**
- Deposit $10M to Aave = trust smart contract + oracle + governance
- Exploit/hack = lose everything
- No granular risk control

**XLN Layer:**
- Bilateral account with Aave entity
- Set credit limit (Aave can owe you during chaos)
- Collateral escrowed (Aave can't steal even if exploited)
- Withdraw instantly if Aave oracle fails

**Value Prop:**
- Bounded DeFi risk
- Institutional-grade (provable exposure)
- Same APY, less catastrophic risk

**Adoption Mechanism:**
- Aave/Compound integrate XLN deposit option
- Market to whales ($1M+ positions)
- Institutional LPs (need risk bounds for compliance)

**Market Size:** $50B DeFi TVL, $10B in large positions (>$1M)

**Realistic Capture:** 10% of whales = $1B TVL

---

### Year 5+ (2030+): Corporate Treasury

**Target:** Companies holding crypto (Tesla, MicroStrategy, Block, etc.)

**Pain Point:**
- Coinbase Custody = trust ($300B AUM, no proofs)
- Self-custody = operational nightmare
- Shareholders demand transparency

**XLN Solution:**
- Corporate Hanko entity (board → CFO → treasurer multi-sig)
- Bilateral account with custody provider
- Shareholder audit = on-chain proof
- Set credit limit per board policy

**Market Size:** $10B+ corporate crypto holdings

**Realistic Capture:** 20% = $2B TVL

---

## CBDC Timeline (Speculative - Not Guaranteed)

### IF CBDCs Deploy on EVM (2030-2035)

**Scenario:**
- Fed launches Digital Dollar on Ethereum L2
- ECB launches Digital Euro on EVM-compatible chain
- Bank of Japan, BoE, others follow

**THEN XLN Unlocks:**
- Fiat remittances (USD CBDC → PHP CBDC)
- SWIFT replacement (bank-to-bank CBDC settlement)
- Global finance TAM ($400T)

**Probability:** 30-50%

**XLN Strategy:** Build crypto infrastructure now (2026-2030), be READY if CBDCs arrive.

**If CBDCs happen:** XLN rating → 950/1000 (world-changing)

**If CBDCs don't happen:** XLN rating → 780/1000 (excellent crypto infrastructure, niche impact)

---

## Technical Evolution

### Envelope Encryption (Q2 2026)
**Priority:** BLOCKING for mainnet

Options:
- ECIES (standard, 150 LOC)
- HMAC (simpler, 80 LOC)

Without this: Cleartext routing = privacy leak

---

### Watchtower Protocol (Q3 2026)
**Priority:** HIGH for mainnet

Without this: Offline users at risk

Reference: Lightning watchtower spec

---

### HSM Integration (Q3 2026)
**Priority:** HIGH for institutional

Hardware security modules for key management.

Without this: Institutional users won't touch it.

---

### Formal Verification (2027)
**Priority:** CRITICAL for $100M+ TVL

TLA+ specs, Coq proofs for consensus-critical code.

---

### Cross-Chain (2028)
**Priority:** MEDIUM

Expand beyond Base L2:
- Ethereum L1 (expensive but legitimate)
- Arbitrum (cheaper, large DeFi ecosystem)
- Optimism (OP Stack network effects)
- Polygon (high throughput)

---

## Governance

### Foundation Launch (Q3 2026)
**Before mainnet.**

**Structure:**
- XLN Foundation (non-profit)
- 5-7 person council
- Progressive decentralization

**Responsibilities:**
- Protocol upgrades
- Security audits
- Developer grants

---

## Success Metrics (Revised - Realistic)

### 2026 (Simnet + Testnet)
- 1,000 simnet users
- 100 testnet entities
- 0 consensus failures
- 1 community developer contribution

### 2027 (Limited Mainnet)
- 1,000 mainnet users
- $10M TVL
- 1 CEX partnership (Kraken, Gemini, or smaller exchange)

### 2028 (Production Mainnet)
- 10,000 users
- $100M TVL
- 3 CEX partnerships
- 2 DeFi protocol integrations (Aave or Compound)

### 2029-2030 (Scale)
- 50,000 users
- $500M-$1B TVL
- 10+ CEX partnerships
- Major inter-exchange settlement adoption
- Institutional custody providers integrated

### 2030-2035 (IF CBDCs Deploy)
- 1M+ users
- $10B+ TVL
- CBDC settlement layer
- Remittances viable
- SWIFT replacement path visible

---

## Crisis-Driven Growth Model

**XLN is anti-fragile infrastructure.** Growth accelerates during chaos.

**Historical pattern:**
- 2014: Mt.Gox → Brief self-custody movement → Forgot
- 2022: Celsius, Voyager, BlockFi, 3AC → Brief exodus → Forgot
- 2022: FTX → Massive rage → ...Forgetting now

**XLN pattern:**
- Crisis 1 (2027): Next $5B+ CEX failure → 5,000 users flee to XLN
- Crisis 2 (2029): Another collapse → 20,000 more (network effects growing)
- Crisis 3 (2031): Major hack → 100,000+ (tipping point, XLN is default safe option)

**Ratchet effect:** Each crisis is permanent education. Users burned NEVER go back if provable alternative exists.

**Strategy:** Be ready (working, audited, simple) when crisis hits. Don't need marketing budget. Crisis IS the marketing.

---

## Regulatory Strategy (Crypto-Only Path)

### Phase 1 (2026-2027): Permissionless Launch

**Approach:** Deploy without permission, crypto-to-crypto only

**Regulatory Status:**
- Smart contracts on public blockchain (permissionless)
- No fiat integration (no MSB/MTL requirements)
- No custody (bilateral accounts, not pooled funds)
- Similar to Uniswap launch model

**Risk:** Regulatory uncertainty, but path exists (Uniswap precedent)

---

### Phase 2 (2028-2029): Institutional Legitimacy

**When TVL >$100M:**
- Engage SEC (request clarity on bilateral accounts)
- Form Foundation (non-profit governance)
- Get legal opinion (bilateral accounts ≠ custody?)

**Goal:** Regulatory clarity for institutional adoption

---

### Phase 3 (2030+): CBDC Integration IF Available

**Only if:** Fed/ECB/BoJ launch EVM-based CBDCs

**Then:** Remittances, SWIFT replacement, MSB licenses, global expansion

**Until then:** Crypto-only is the business.

---

## Revenue Model

**Hub fees:** Hubs charge users for routing (0.05-0.1%)

**Foundation revenue:** None (protocol is permissionless)

**Ecosystem value:**
- Hubs (exchanges, liquidity providers): Earn routing fees + competitive advantage (provable reserves)
- Users: Bounded risk, same convenience
- Protocols (Aave, etc.): Attract institutional capital through risk transparency

---

## Competitive Moats

### 1. Crisis-Driven Adoption (Primary Moat)

Every CEX failure is permanent marketing for XLN.

Users who lose funds NEVER go back to unprovable custody.

Competitors (rollups, L1s) don't solve "how do I not lose my money on CEX."

---

### 2. Network Effects (Secondary Moat)

More entities → more bilateral accounts → more routing options.

Unlike blockchains (more users = congestion), XLN gains capacity with growth.

Hub emerges naturally (entity with most connections).

---

### 3. Technical Correctness (Tertiary Moat)

Only protocol that:
- Keeps banking topology (hub-and-spoke)
- Adds cryptographic proofs (bilateral consensus)
- Bounds counterparty risk (credit limits + collateral)
- Solves inbound capacity (users extend credit to hubs)

No other protocol has this combination.

---

## What Could Go Wrong

### Execution Risk (70% probability)

**Scenario:** XLN code buggy, consensus fails, users lose funds, project dies

**Mitigation:**
- Formal verification (TLA+)
- External audit (Trail of Bits)
- Bug bounty ($1M+)
- Start with small caps ($10K/user max)

---

### No Crisis (20% probability)

**Scenario:** CEXes stabilize, no major failures 2026-2030, users don't care about proofs

**Mitigation:** Target paranoid whales (always want proofs regardless of crisis)

---

### CEXes Refuse Integration (40% probability)

**Scenario:** Coinbase/Binance don't offer XLN option (reduces their fraud capability)

**Mitigation:**
- Smaller exchanges adopt first (competitive pressure)
- Regulatory mandates proof-of-reserves (forces adoption)
- Decentralized hubs emerge (permissionless)

---

### Complexity Kills Adoption (50% probability)

**Scenario:** Users don't understand bilateral accounts, credit limits, collateral

**Mitigation:**
- Default settings ($1K credit, rest collateral)
- User mode (hide complexity)
- Education (essay.md, videos, tutorials)

---

### Better Alternative Emerges (10% probability)

**Scenario:** Someone builds simpler solution to CEX risk

**Analysis:** Cannot name one after reading all docs. Rollups don't solve this. Lightning failed. Self-custody too hard.

**If it exists:** We pivot or die.

---

## End State (2030)

**Best Case (30% probability):**
- CBDCs on EVM deployed
- XLN is CBDC settlement layer
- Remittances, SWIFT replacement viable
- $10B+ TVL, world-changing impact
- **Rating: 950/1000**

**Base Case (50% probability):**
- CBDCs delayed or non-EVM
- XLN is crypto infrastructure
- 50K users, $500M-$1B TVL
- Important but niche (like Uniswap)
- **Rating: 820/1000**

**Failure Case (20% probability):**
- Execution failure or no crisis or CEXes block
- <1,000 users, <$10M TVL
- Technically correct, market irrelevant
- **Rating: 680/1000** (Betamax)

---

## Strategic Priorities (2026-2030)

**#1 Priority:** Survive to next crisis (2027-2028)
- Have working product
- Have simple onboarding
- Have audited contracts
- Be READY when billions flee CEXes

**#2 Priority:** Get one CEX partnership
- Kraken (most likely - pro-crypto stance)
- Gemini (regulatory focused)
- Smaller exchanges (competitive pressure)

**#3 Priority:** Institutional legitimacy
- Security audit
- Formal verification
- Legal clarity (bilateral accounts ≠ custody)

**#4 Priority:** Developer ecosystem
- Good docs ✅ (cleaned up today)
- SDK for hub operators
- Integration guides for CEXes

**NOT Priority:** Remittances, SWIFT, fiat integration (wait for CBDCs)

---

**Last Updated:** 2026-01-24
**Next Review:** After Phase 2 testnet launch (Q3 2026)
