# Claude Code Session Documentation

## Current System State & Recent Achievements

### XLN Architecture Overview
XLN (Cross-Local Network) is a cross-jurisdictional off-chain settlement network with a three-layer architecture:

- **J-Machine**: Smart contracts (Depository.sol, EntityProvider.sol) on blockchain
- **E-Machine**: Entity consensus layer with BFT state machines
- **A-Machine**: Account settlement between entities

### Major Recent Implementations

#### 1. Unified State Management (`src/state-helpers.ts`)
- **Consolidated all cloning**: Replaced scattered `entity-state-clone.ts` and duplicate functions
- **Entry points**: `cloneEntityState()`, `cloneEntityReplica()`, `cloneMap()`, `captureSnapshot()`
- **jBlock integrity**: Critical financial state preservation with validation and logging
- **Architecture**: `cloneEntityReplica` now delegates to `cloneEntityState` for consistency

#### 2. Entity-First Account Opening Flow
- **Problem**: Account operations were direct inter-entity messages
- **Solution**: Account requests now originate from EntityTx decisions
- **Flow**:
  ```
  EntityTx('account_request') → Local account creation → Bubble AccountInput → Route to target
  ```
- **Benefits**: Entity-first architecture, consensus integration, distributed-ready

#### 3. Reserve Structure Migration
- **Changed**: `Map<string, AssetBalance>` → `Map<string, bigint>`
- **Simplified**: Direct `tokenId => amount` mapping, metadata from TOKEN_REGISTRY
- **Fixed**: Frontend BigInt handling, type safety, display formatting

#### 4. Always-Visible UI Components
- **Reserves**: Moved from foldable to always-visible top section with portfolio values
- **Accounts**: Always-visible below reserves with entity selection buttons
- **Global Scale**: Portfolio bars now use global scale ($1000-$10000) for cross-entity comparison

#### 5. J-Watcher Timing & Deduplication
- **Fixed**: J-watcher now starts AFTER snapshots are fully loaded
- **Prevents**: Duplicate j-event processing on page reload
- **Guard**: `jWatcherStarted` flag prevents multiple instances
- **Reduced logs**: Minimal output for cleaner debugging

### Current System Capabilities

#### Frontend (SvelteKit + Vite)
- **Entity Panels**: Dynamic multi-panel layout with 50/50 dropdowns
- **Real-time Updates**: WebSocket connection to server with auto-reactivity
- **Time Machine**: Navigate through consensus history snapshots
- **Global Portfolio Scale**: Visual wealth comparison across entities
- **Account Management**: One-click account opening between entities

#### Backend (Bun + Level DB)
- **Consensus Engine**: BFT consensus with proposer/validator roles
- **State Persistence**: Snapshot system with IndexedDB/filesystem storage
- **J-Event Watching**: Blockchain monitoring with proper jBlock tracking
- **Account System**: Entity-to-entity settlement channels
- **Output Routing**: EntityTx can generate outputs for inter-entity communication

#### Smart Contracts (Solidity + Hardhat)
- **Depository.sol**: Reserve management with `reserveToReserve()` function
- **EntityProvider.sol**: Entity registration and control shares
- **Deployment**: Ignition-based with verification scripts

### Development Commands

```bash
# Backend
bun run src/server.ts          # Start server with demo
NO_DEMO=1 bun run src/server.ts # Start server without demo

# Frontend
cd frontend && bun run dev     # Start SvelteKit dev server

# Contracts
bunx hardhat run scripts/verify-contract-functions.cjs --network ethereum
```

### Current Goals & Next Steps

#### Immediate Priorities
1. **Test Entity-First Account Flow**: Verify account_request creates local + bubbles correctly
2. **Monitor I/O Panel**: Confirm outgoing AccountInputs appear in server outputs
3. **R2R Functionality**: Ensure Reserve-to-Reserve transfers work with new structure
4. **Global Scale Testing**: Verify portfolio bars scale correctly across entities

#### Architectural Improvements
1. **Full Entity Output Bubbling**: Complete the EntityTx → EntityInput routing system
2. **Account Symmetry**: Ensure both entities get proper account machines
3. **Settlement Integration**: Connect A-machine with E-machine consensus
4. **Real Signatures**: Replace mock signatures with actual cryptographic ones

#### UI/UX Enhancements
1. **Visual Consistency**: Ensure all progress bars use global scale
2. **Error Handling**: Better UI feedback for failed operations
3. **Performance**: Optimize for larger entity counts
4. **Mobile Responsiveness**: Adapt layout for different screen sizes

### Key Technical Insights

#### Entity vs Input Distinction (Critical Understanding)
- **EntityTx**: What an entity decides to do (internal consensus decision)
- **EntityInput**: What happens TO an entity (external input from other entities/server)
- **Example**: Entity A decides to open account (EntityTx) → Creates message for Entity B (EntityInput)

#### Financial State Integrity
- **jBlock tracking**: Essential for preventing duplicate j-event processing
- **BigInt handling**: All amounts must be BigInt for precision
- **Validation**: Multiple layers ensure state corruption doesn't occur

#### Snapshot & Time Travel
- **Browser**: Uses IndexedDB for persistence
- **Server**: Uses Level DB filesystem storage
- **History**: Every server tick creates snapshot for time machine
- **Reactivity**: UI automatically updates when navigating history

### Known Issues & Workarounds

#### Fixed Issues
- ✅ BigInt serialization errors → Proper toString() conversion
- ✅ Duplicate j-events on reload → Proper snapshot loading timing
- ✅ Reserve display corruption → Fixed structure mapping
- ✅ Multiple j-watcher instances → Added startup guard
- ✅ Jurisdiction resets → Hardcoded to Ethereum

#### Current Limitations
- **Demo Mode**: Still uses mock signatures and prefunded accounts
- **Single Jurisdiction**: Only Ethereum (8545) supported currently
- **Local Simulation**: Real distributed deployment not yet implemented
- **Account Asymmetry**: Target entity might not auto-create reciprocal account

### File Structure & Key Locations

#### Core Backend Files
- `src/server.ts`: Main server with environment management
- `src/entity-consensus.ts`: BFT consensus implementation
- `src/entity-tx/apply.ts`: EntityTx processing with output support
- `src/j-event-watcher.ts`: Blockchain event monitoring
- `src/state-helpers.ts`: Unified cloning and snapshot utilities
- `src/types.ts`: All interfaces and type definitions

#### Core Frontend Files
- `frontend/src/routes/+page.svelte`: Main layout with dynamic panel sizing
- `frontend/src/lib/components/Entity/EntityPanel.svelte`: Main entity view
- `frontend/src/lib/components/Entity/AccountChannels.svelte`: Account management
- `frontend/src/lib/stores/`: State management (XLN, tabs, settings, time)

#### Configuration
- `jurisdictions.json`: Contract addresses and network config
- `claude.md`: Development guidelines and overrides
- `contracts/`: Solidity contracts with Hardhat deployment

### Development Philosophy

#### Code Style
- **Functional/Declarative**: Pure functions, immutable state
- **Entity-First**: All operations originate from entity decisions
- **Deterministic**: Consensus requires repeatable, sorted operations
- **Type Safety**: Comprehensive TypeScript interfaces
- **Minimal Code**: "Best code is no code" principle

#### Architecture Principles
- **Layer Separation**: Clear boundaries between J/E/A machines
- **Consensus-Driven**: All state changes go through entity consensus
- **Snapshot-Based**: Time travel through deterministic history
- **Output-Oriented**: Entities generate outputs that server routes
- **First-Principles**: Simple, understandable implementations

This documentation should help future Claude Code sessions understand the current state and continue development effectively.