# XLN Roadmap - Path to Global Settlement

**Vision:** Replace SWIFT. 51% of world's settlement volume. Multi-jurisdictional consensus.

---

## Network Evolution

### Phase 1: Simnet (Oct 2025 - Q1 2026)
**Browser-only simulation. Prove the primitive.**

**Tech:**
- @ethereumjs/vm (in-browser blockchain)
- Depository.sol (6.6KB, implements IDepository)
- 500 prefunded entities (USDC + ETH)
- Zero infrastructure (no servers, no RPC)

**Milestones:**
- ✅ v0.0.1 - BrowserVM working, panel foundation
- [ ] v0.1.0 - Full 4-panel workspace (Graph3D, Entities, Depository, Architect)
- [ ] v0.2.0 - First scenario running end-to-end in simnet
- [ ] v0.3.0 - VR mode working in Quest browser

**Success Criteria:**
- 1000 people try simnet
- 10 scenarios published by community
- BrowserVM proves viable for education/demos

---

### Phase 2: Testnet (Q1 2026 - Q3 2026)
**Shared PoA network. Multi-user coordination.**

**Tech:**
- Arrakis (custom PoA chain, 5 validators)
- Full contract suite (EntityProvider, Depository, SubcontractProvider)
- Persistent state (multi-session)

**Milestones:**
- [ ] v1.0.0 - Testnet launch (invite-only, 50 beta entities)
- [ ] v1.1.0 - Public testnet (open registration)
- [ ] v1.2.0 - Load testing (1000 entities, 10k tx/sec)

**Success Criteria:**
- 100+ entities actively settling
- $10M/month test volume
- Zero consensus failures under load

---

### Phase 3: Mainnet (Q4 2026 - 2027)
**Production deployment. Real value.**

**Tech:**
- Multi-chain (Ethereum L1, Polygon, Arbitrum, Optimism)
- Professional audits (Trail of Bits, OpenZeppelin)
- Governance (multi-sig + timelock)

**Milestones:**
- [ ] v2.0.0 - Ethereum mainnet launch
- [ ] v2.1.0 - L2 expansion (Polygon, Arbitrum)
- [ ] v2.2.0 - Cross-chain routing

**Success Criteria:**
- 1000+ entities on mainnet
- $100M/month real settlement volume
- Regulatory clarity in 3 jurisdictions (US, EU, Singapore)

---

## Market Expansion

### Year 1-2 (2026-2027): Capture Niche
**Target:** Cross-border remittances (Philippines ↔ US)

**Why:**
- $700B/year market
- 5-10% current fees (Western Union, Wise)
- XLN: 0.1% (50x cheaper)

**Actions:**
- Partner with Filipino banks (BDO, BPI)
- License as MSB in US + Philippines
- Market to OFWs (Overseas Filipino Workers)

**Revenue Target:** $7M/year (1% market share)

---

### Year 3-5 (2028-2030): Global Remittances
**Expand to 50+ corridors**

**Wedge markets:**
- Nigeria ↔ UK (diaspora)
- Mexico ↔ US (largest corridor)
- India ↔ UAE (labor migration)
- Argentina ↔ Anywhere (inflation escape)

**Revenue Target:** $70M/year (10% of global remittances)

---

### Year 6-10 (2031-2035): Interbank Settlement
**Replace SWIFT for bank-to-bank transfers**

**Why banks switch:**
- 100x faster (instant vs T+2)
- 50x cheaper (0.01% vs 0.5%)
- Better audit trail (on-chain, immutable)

**Requirements:**
- IMF/World Bank endorsement
- "Open settlement standard" regulation
- Central bank partnerships

**Revenue Target:** $20B/year (5% of interbank settlement)

---

## Technical Evolution

### IDepository → ERC Standard
**Timeline:** Q2-Q3 2026

**Goal:** Submit IDepository interface as Ethereum ERC

**Why:**
- Standardize bilateral reserve management
- Enable interoperability (other protocols can integrate)
- Establish XLN as infrastructure primitive

**Path:**
1. Draft EIP (Ethereum Improvement Proposal)
2. Community review (Ethereum Magicians forum)
3. Reference implementation (Depository)
4. Audit + formalize
5. ERC number assigned

---

### WebGPU Adoption
**Timeline:** Late 2026 (when Meta ships WebXR+WebGPU)

**Current:**
- WebGL (VR-compatible, stable)
- WebGPU toggle ready (auto-fallback)

**Future:**
- Quest browser WebXR+WebGPU support
- Switch default to WebGPU
- 2x rendering performance in VR

---

### AI Integration
**Timeline:** 2027+

**Ideas:**
- Natural language commands in Architect panel
- AI-assisted scenario generation
- Anomaly detection (unusual settlement patterns)
- Governance proposals auto-drafted

---

## User Experience

### Simnet → Mainnet Graduation
**User journey:**

1. **Try in browser** (simnet) - Zero commitment
2. **Test with play money** (testnet) - Learn the system
3. **Deploy entity** (mainnet) - Real value
4. **Expand network** - Invite partners

**Key:** Same UI, same code, different data source.

---

## Governance

### Foundation Structure
**Timeline:** Before mainnet (Q3 2026)

**Entity:**
- XLN Foundation (non-profit)
- Multi-sig council (5-7 members)
- Progressive decentralization

**Responsibilities:**
- Protocol upgrades
- Treasury management
- Grant distribution
- Regulatory liaison

---

## Regulatory Strategy

### Jurisdictional Approach

**Phase 1:** Crypto-friendly countries
- Singapore, UAE, Estonia, El Salvador
- Lower barrier, faster approval

**Phase 2:** Major markets
- EU (MiCA compliance)
- UK (FCA authorization)
- US (FinCEN + state licenses)

**Phase 3:** Global expansion
- 50+ countries
- Local partnerships
- Compliance automation

---

## Success Metrics

### Simnet (2026)
- 1,000 users trying simnet
- 100 scenarios created
- 10 community contributions

### Testnet (2026-2027)
- 100 active entities
- $10M/month volume
- Zero consensus failures

### Mainnet (2027+)
- 1,000 entities
- $100M/month volume
- 3 jurisdictions licensed

### Global (2030+)
- 100,000 entities
- $100B/year volume
- 50 countries operational

---

**End State:** XLN is default settlement layer for cross-border value transfer. SWIFT is legacy. Banks integrate XLN or lose business.
