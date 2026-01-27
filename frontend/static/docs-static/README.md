# xln Documentation

**Reserve-Credit Provable Account Network** — The only architecture satisfying all unavoidable constraints for internet-scale finance.

**Not "better than alternatives." The only possibility given:**
1. Unicast (broadcast cannot scale - O(n) ceiling)
2. Credit (receiving impossible without it - Lightning proved)
3. Proofs (unprovable custody dies after crises - FTX proved)
4. Programmable entities (organizations need logic - obvious)
5. EVM enforcement (FIFO debt needs Turing-completeness - UTXO cannot)

**Read [constraints.md](constraints.md) first** - understand why alternatives are impossible, not inferior.

---

## 🚀 Quick Start

**New to xln?** Start here:

1. **[constraints.md](constraints.md)** - Why XLN is inevitable (prove no alternative exists)
2. [essay.md](essay.md) - The Inevitability of Provable Credit (deep-dive)
3. [00_QA.md](core/00_QA.md) - Homakov's intro: who, why, what is xln
4. [10_UFT.md](core/10_UFT.md) - Unified Financial Theory (flagship whitepaper)
5. [roadmap.md](roadmap.md) - Simnet → Testnet → Mainnet timeline

**Developers:**
- [Payment Spec](implementation/payment-spec.md) - Direct payments, HTLCs, onion routing
- [Scenarios](implementation/scenarios.md) - Scenario DSL reference
- [RJEA Architecture](core/rjea-architecture.md) - Runtime→Entity→Account→Jurisdiction

---

## 📚 Core Protocol (5 files)

| Document | Description |
|----------|-------------|
| [00_QA.md](core/00_QA.md) | Egor Homakov intro + motivation |
| [10_UFT.md](core/10_UFT.md) | UFT: FCUAN/FRPAP/RCPAN invariants |
| [11_Jurisdiction_Machine.md](core/11_Jurisdiction_Machine.md) | J-machine (TradFi vs DeFi) |
| [12_invariant.md](core/12_invariant.md) | RCPAN: `−Lₗ ≤ Δ ≤ C + Lᵣ` |
| [rjea-architecture.md](core/rjea-architecture.md) | Full RJEA implementation (merges JEA, naming, tx-flow) |

---

## 🛠️ Implementation (3 files)

| Document | Description | Status |
|----------|-------------|--------|
| [payment-spec.md](implementation/payment-spec.md) | Direct + HTLC payments, onion routing | Production |
| [scenarios.md](implementation/scenarios.md) | Scenario DSL reference | Production |
| [TODO-bilateral-j-event-consensus.md](implementation/TODO-bilateral-j-event-consensus.md) | Active work: bilateral j-events | WIP |

---

## 🏗️ Architecture (4 files)

| Document | Description |
|----------|-------------|
| [bilaterality.md](architecture/bilaterality.md) | Why bilateral consensus is the killer feature |
| [contracts.md](architecture/contracts.md) | Smart contract architecture |
| [hanko.md](architecture/hanko.md) | Hierarchical signature system |
| [why-evm.md](architecture/why-evm.md) | EVM vs UTXO/Solana + jurisdiction requirement |

---

## 🐛 Debugging (1 file)

- [consensus-debugging-guide.md](debugging/consensus-debugging-guide.md) - How to debug consensus failures

---

## 🚢 Deployment (1 file)

- [server-setup.md](deployment/server-setup.md) - Production nginx config

---

## 🗺️ Status

| Document | Description |
|----------|-------------|
| [roadmap.md](roadmap.md) | Simnet (Q1 2026) → Testnet (Q2) → Mainnet (Q4) |
| [mainnet.md](mainnet.md) | Mainnet readiness (600/1000) |

---

## 📦 Archive

Historical documents preserved for context:

- [archive/](archive/) - Research papers, session transcripts, historical analysis

---

## 📊 Stats

- **Core docs:** 5 files (start here)
- **Implementation:** 3 files (build with xln)
- **Architecture:** 4 files (design decisions)
- **Operations:** 2 files (debugging + deployment)
- **Total critical:** 16 files
- **Reduction:** 95 → 16 files (83% deleted)
- **Bloat removed:** 1,303 lines cut from remaining docs

---

## 🌐 Web Navigation

This documentation is available at:
- **GitHub:** https://github.com/xlnfinance/xln/tree/main/docs
- **Web:** https://xln.finance/docs (with index.html)

**Structure:**
```
/docs/
├── readme.md          - this file
├── roadmap.md         - timeline
├── mainnet.md         - readiness
├── index.html         - web interface
│
├── core/              - 5 files: protocol fundamentals
├── implementation/    - 4 files: how to build
├── architecture/      - 4 files: design decisions
├── debugging/         - 1 file: troubleshooting
├── deployment/        - 1 file: production setup
│
└── archive/           - historical docs
```

---

## 🎯 Navigation by Audience

**Newcomers:** index.html → 00_QA.md → 10_UFT.md
**Developers:** payment-spec.md, rjea-architecture.md
**Investors:** roadmap.md, mainnet.md
**Architects:** architecture/

---

**Last updated:** 2026-01-24
**Maintainer:** xln core team
**License:** See LICENSE in repo root
