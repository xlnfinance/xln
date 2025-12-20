# Browser EVM Execution Environment Plan

**⚠️ ARCHIVED:** This specification has been merged into **docs/xlnview.md** (Phase 1: BrowserEVM Integration)

See **docs/xlnview.md** for the complete unified specification including BrowserEVM, XLNView component architecture, and CommandCenter implementation.

---

# Original Content (Archived 2025-10-11)

## Why Embed an EVM in the Browser?
- **Local-first simulation**: Run `EntityProvider`, `Depository`, and `SubcontractProvider` directly in the client without depending on localhost :8545 or a cloud node.
- **Deterministic UX**: Every user session can boot the same initial state and replay actions instantly (great for demos, VR sandbox, or analysts).
- **Seamless fallback**: Treat the in-page VM as one transport; later swap to Arrakis/PoA or mainnet RPC by changing a single adapter.
- **Security**: Keep production keys away from a dev network; all “world editing” stays client-side until you explicitly export transactions.

## Scope
1. **Contracts supported**: `EntityProvider`, `Depository`, `SubcontractProvider`.
2. **Features**:
   - Deploy bytecode internally.
   - Execute writes/reads using a JSON-RPC–like interface.
   - Track blocks, receipts, and logs for explorer tooling.
3. **Non-goals**:
   - Gossip/consensus, network peers, or fork choice.
   - Full Ethereum RPC surface. We only implement the methods XLN UI calls.

## High-Level Architecture
```
┌───────────────────────────────────────────────┐
│  XLN Frontend (Svelte/VR)                     │
│   ├─ Command Panel                            │
│   ├─ Visualization (Graph3D / VR)             │
│   └─ EVM Adapter (in-browser)                 │
│            ▲                        │
│            │ JSON-RPC-ish calls     │
└────────────┼────────────────────────┘
             │
      ┌──────┴────────┐
      │ Web Worker     │
      │ (ethereumjs/vm│
      │  + custom state│
      │  manager)      │
      └──────┬────────┘
             │
             ▼
      Local contract world
```

## Implementation Phases

### Phase 1 – Bootstrapping (Week 1–2)
- Bundle `@ethereumjs/vm` and necessary state managers inside a Web Worker.
- Load compiled artifacts (`*.json`) from Hardhat build output.
- Write a simple loader:
  1. Create genesis accounts (pre-fund entity addresses, deployer).
  2. Deploy the three target contracts using constructor inputs from the artifacts.
  3. Expose minimal RPC-like API: `eth_call`, `eth_sendRawTransaction`, `eth_getBalance`, `eth_getCode`.

### Phase 2 – State & Block Management (Week 3)
- Implement a lightweight block builder:
  - Increment block number and timestamp on each transaction.
  - Collect receipts/logs for UI playback.
- Add persistence option (IndexedDB or localStorage) so the session can be saved/restored.
- Surface execution errors clearly to the UI.

### Phase 3 – UI Integration (Week 4–5)
- Abstract the current `ethers.js` provider usage into an adapter with two backends:
  - `BrowserVMProvider` (for the embedded VM).
  - `RpcProvider` (for Arrakis or localhost Hardhat).
- Ensure existing mutations (governance actions, reserve moves) call the adapter instead of hardcoding RPC endpoints.
- Add toggles in the command dock: **Local Simulation** vs **External Node**; display which backend is active.

### Phase 4 – Export / Import (Week 6)
- Allow exporting a transaction bundle (signed or unsigned) that can be replayed on a real network.
- Provide a simple importer to seed the browser VM from an Arrakis snapshot (genesis state + storage dump) for parity testing.

### Phase 5 – Testing & Validation (Week 7+)
- Mirror state changes by running the same scenario against Arrakis PoA network and comparing storage roots.
- Add regression tests for the adapter layer to guarantee identical behavior across backends.
- Document performance characteristics (transactions per second, VR responsiveness).

## Switching to Remote Nodes Later
- The adapter interface keeps UI logic agnostic of the backend. To flip to PoA/mainnet, change the active provider to an `ethers.JsonRpcProvider`.
- Maintain the same ABI encoding & signature flow, so exported transactions replay without modification.
- Provide environment flags (e.g., `USE_BROWSER_VM=true`) so build pipelines can choose defaults.

## Risks & Mitigations
- **Bundle size**: ethereumjs/vm is heavy. Use dynamic imports / lazy load for the worker.
- **Performance**: For large scenarios, run the VM in a Worker and throttle updates to prevent UI frame drops.
- **State divergence**: Regularly run cross-checks (Phase 5) to ensure browser VM matches production logic.

## Deliverables
- `BrowserVMProvider` adapter with tests.
- Web Worker module hosting the VM.
- Updated UI toggles and status indicators.
- Documentation (this file, plus README updates).

