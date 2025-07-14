# XLN Consensus Debugger: Migration to Svelte

## Objective
Create `svelte.html` that fully replicates all functionality from `index.html` using Svelte framework, maintaining 100% feature parity while improving maintainability and performance.

## Critical Requirements

### 1. **Time Machine Component** (High Priority - Most Complex)
- [ ] Create reactive time slider with CSS custom property progress bar integration
- [ ] Implement keyboard shortcuts: ←/→ (step), Home (start), End (live)  
- [ ] Handle edge cases: empty history, single snapshot, live vs historical states
- [ ] Sync progress bar with slider position (no lag) using CSS `--progress` variable
- [ ] Display time info: "📸 25/28" vs "⏰ LIVE" with dynamic height/snapshot counts
- [ ] Navigation logic: 0 → 1 → ... → (history.length-2) → Live(-1), skip duplicate latest snapshot
- [ ] Compact bottom-fixed positioning with backdrop blur

### 2. **Entity State Management** (Critical - Core Functionality)
- [ ] Reactive stores for: `xlnEnv`, `currentTimeIndex`, `entityFilter`
- [ ] Real-time entity state updates (messages, proposals, mempool, voting power)
- [ ] Historical state rendering from snapshots vs live state
- [ ] Entity filtering dropdown with "All Entities" + dynamic entity list
- [ ] Proposer vs Validator role indicators (👑/✅)
- [ ] Byzantine consensus state: locked frames, precommits, signatures
- [ ] Voting power visualization with progress bars and percentages

### 3. **Server I/O Visualization** (Complex State Display)
- [ ] Two-column grid layout: Server Input | Server Output
- [ ] Real-time display of: serverTxs, entityInputs, entityOutputs  
- [ ] Detailed transaction breakdown: chat/propose/vote with full data
- [ ] Precommit signatures display with truncated hashes
- [ ] Proposed frame details: height, hash, transaction count
- [ ] "No data" states with consistent messaging
- [ ] Historical vs current indicators (🕰️ vs ⚡)

### 4. **Interactive Controls** (User Actions)
- [ ] Dynamic replica selector with proposer/validator labels
- [ ] Action type switching: chat/propose/vote with conditional UI
- [ ] Input validation and error handling
- [ ] Real-time proposal dropdown population for voting
- [ ] Transaction execution with proper state updates
- [ ] Auto-refresh replica selectors after entity creation

### 5. **Entity Formation System** (Complex Form Logic)
- [ ] Dynamic validator list with add/remove functionality  
- [ ] Real-time total weight calculation and threshold validation
- [ ] Entity name validation (alphanumeric + underscore/hyphen only)
- [ ] Duplicate validator name detection
- [ ] Consensus config generation (proposer-based mode)
- [ ] Form clearing and reset functionality
- [ ] Success feedback with entity details

### 6. **Tab System & Navigation**
- [ ] Animated tab switching between Controls and Formation
- [ ] Active state management with CSS transitions
- [ ] Preserve form state when switching tabs

### 7. **Auto-reload & File Watching** (Development Feature)
- [ ] HTTP HEAD polling for dist/server.js changes
- [ ] Reload indicator with smooth show/hide animations
- [ ] 10-second interval checking with error handling

### 8. **Responsive Layout & Styling**
- [ ] Purple gradient background with glass morphism effects
- [ ] Entity cards grid with hover animations and shadows
- [ ] Monospace font for technical data, clean typography
- [ ] Mobile-responsive design with proper breakpoints
- [ ] Smooth transitions and micro-interactions
- [ ] Consistent color scheme: blues for primary, greens for success

### 9. **Advanced Features & Edge Cases**
- [ ] Entity card state indicators: proposals (pending/active), locked frames
- [ ] Message feed with collective proposal highlighting
- [ ] Voting power distribution charts and threshold visualization  
- [ ] Proposal status tracking with vote counts and voter lists
- [ ] Mempool transaction display with type-specific formatting
- [ ] Nonce tracking per user across entities
- [ ] Frame height synchronization across replicas

### 10. **State Synchronization & Performance**
- [ ] Efficient diff-based rendering for large entity lists
- [ ] Debounced updates for high-frequency state changes
- [ ] Memory management for large history arrays
- [ ] Proper cleanup of event listeners and timers

## Technical Architecture

### Svelte Store Structure
```javascript
// stores.js
export const xlnEnv = writable(null);
export const currentTimeIndex = writable(-1);
export const entityFilter = writable('all');
export const autoReloadEnabled = writable(true);
```

### Component Hierarchy
```
App.svelte
├── TimeMachine.svelte (bottom-fixed)
├── ServerIO.svelte (two-column layout)
├── EntityFilter.svelte 
├── EntitiesGrid.svelte
│   └── EntityCard.svelte (repeatable)
├── ActionableTabs.svelte
│   ├── InteractiveControls.svelte
│   └── EntityFormation.svelte
└── AutoReloadIndicator.svelte
```

## Critical Implementation Notes

### Time Machine Edge Cases
- Handle `currentTimeIndex = -1` (live) vs `>= 0` (historical)  
- Skip latest snapshot in navigation (duplicate of live state)
- Progress calculation: `sliderValue / (maxMeaningfulIndex + 1) * 100`
- Keyboard shortcuts must work globally except in inputs

### State Management Gotchas  
- Deep clone entity replicas for historical snapshots
- Map objects need proper serialization for stores
- BigInt values require special handling in reactive statements
- Entity filtering must preserve scroll position

### Byzantine Consensus Details
- Proposer creates proposals, validators sign them
- Locked frames shown with 🔒 indicator  
- Signature threshold calculation with voting power
- Gossip vs proposer-based mode handling

### Performance Considerations
- Use `{#key}` blocks for entity cards to force re-render
- Debounce rapid slider movements (100ms)
- Virtual scrolling if entity list > 50 items
- Lazy load entity details on card expansion

## Testing Checklist

### Functional Tests
- [ ] All 28 snapshots navigate correctly in time machine
- [ ] Entity creation with various validator configurations
- [ ] Proposal creation and voting across all entities
- [ ] Historical state accuracy vs live state
- [ ] Keyboard shortcuts work in all contexts
- [ ] Auto-reload triggers on file changes

### Edge Case Tests  
- [ ] Empty history state (no snapshots)
- [ ] Single entity with single validator
- [ ] Maximum threshold scenarios (all validators required)
- [ ] Rapid-fire transactions and consensus rounds
- [ ] Browser refresh preserves no state (expected)
- [ ] Mobile device compatibility and touch interactions

### UI/UX Tests
- [ ] Smooth animations without jank
- [ ] Loading states and error handling
- [ ] Form validation and user feedback  
- [ ] Responsive layout on all screen sizes
- [ ] Accessibility (keyboard navigation, screen readers)

## Deliverables
1. **svelte.html** - Single file Svelte application with CDN imports
2. **Migration verification** - Side-by-side comparison checklist
3. **Performance analysis** - Bundle size and runtime performance vs vanilla
4. **Documentation** - Component API and store usage guide

## Success Criteria
- [ ] **100% feature parity** - Every interaction from index.html works identically
- [ ] **Performance improvement** - Faster rendering and smoother animations
- [ ] **Code maintainability** - Readable component structure vs 2300-line file
- [ ] **Developer experience** - Easier to add new features and debug issues

---

**Note**: This is a complete rewrite, not an incremental migration. Test thoroughly against the existing implementation to ensure no functionality is lost. The consensus engine (`dist/server.js`) remains unchanged - only the UI layer is being modernized. 