# Changelog

All notable changes to XLN will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.0.1] - 2025-10-11

### Added
- **BrowserVM Integration** - Offline blockchain with @ethereumjs/vm v10
  - Depository.sol (6.6KB, self-contained)
  - IDepository interface (future ERC standard)
  - Genesis configs in /simnet/
  - Smoke test: deploys contract + executes transactions in <3s

- **Panel System Foundation** - Bloomberg Terminal-style workspace
  - Event bus (panelBridge) for inter-panel communication
  - Layout manager (localStorage + URL sharing)
  - 4 preset layouts (default, analyst, builder, embed)
  - Dockview library integrated (2.8k stars)
  - Demo: 3 working layouts verified with Playwright

- **WebGPU/WebGL Renderer Switch** - Future-proof graphics
  - Renderer factory with auto-fallback
  - Runtime toggle between WebGL (VR-compatible) and WebGPU (performance)
  - Quest browser compatibility warnings

- **Simnet** - Browser-only simulation network
  - 500 entities prefunded (USDC + ETH)
  - No localhost:8545 dependency
  - Instant reset, deterministic genesis
  - IndexedDB persistence (optional)

### Changed
- **Repository Restructure** - Essence-driven naming
  - `/docs` → `/vibepaper` (eternal documentation)
  - `/src` → `/runtime` (consensus engine)
  - `/contracts` → `/jurisdictions` (multi-chain contracts)
  - `/scenarios` → `/worlds` (economic simulations)
  - `/e2e` → `/proofs` (validation tests)
  - `install.sh` → `bootstrap.sh`

- **Cleanup**
  - Archived: 2019_docs, 2024_src, reference, brainvault, orderbook, visualization
  - Removed: QUICKSTART.md (redundant), tests/ (merged into proofs/)
  - Updated: 400+ import paths, all build scripts

### Technical
- License: AGPL-3.0 (protect from cloud theft)
- TypeScript: Clean compilation (0 errors)
- Build: Updated for new directory structure
- Tests: All smoke tests passing

### Documentation
- readme.md - Updated with new structure + roadmap
- /vibepaper/xlnview.md - Panel architecture spec
- /simnet/readme.md - BrowserVM setup guide
- /proofs/readme.md - Test strategy
- restructure.md - Migration notes

---

## [Unreleased] - On the Road to 0.1.0

### Planned
- Wire BrowserVM into live Depository panel (real queries, not mock data)
- Extract Graph3D from NetworkTopology → view/panels/Graph3DPanel.svelte
- Implement complete 4-panel workspace in XLNView.svelte
- Add WebGPU toggle to production NetworkTopology
- Multi-network tabs (Simnet | Testnet | Mainnet switcher)

### Future (0.1.0 Target)
- Complete panel extraction from NetworkTopology
- All 4 core panels working (Graph3D, Entities, Depository, Architect)
- Layout persistence working in production
- BrowserVM fully integrated
- First public demo video

---

## Version Numbering

**0.0.x** - Foundation (BrowserVM, panel system, restructure)
**0.x.0** - Feature milestones (panel extraction, live integration)
**1.0.0** - Simnet production-ready (public launch)
**2.0.0** - Testnet (shared PoA network)
**3.0.0** - Mainnet (real value)
