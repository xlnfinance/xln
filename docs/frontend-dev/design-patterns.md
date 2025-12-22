# XLN Visual Debugger Design Patterns

## Overview
This document captures UI/UX patterns and design decisions discovered during development of the XLN visual debugging interface.

## Design Philosophy

### Hackery Aesthetic
- **Monospace typography**: Monaco, Menlo, Consolas for authentic developer feel
- **Dark theme**: Black background with white text
- **Minimal gradients**: Avoid corporate-style fancy effects
- **Lowercase branding**: `xln core` not `XLN CORE`
- **Terminal-inspired**: Clean, functional, no-nonsense interface

## Layout Architecture

### Tab-Based Entity Management
```html
<!-- Each entity gets its own tab -->
<div class="tab" data-tab-id="tab-1">
  <span class="tab-title">Entity 1</span>
  <span class="tab-signer">alice</span>
  <button class="tab-close">×</button>
</div>
```

**Benefits**:
- Parallel entity interaction
- Clear context switching
- Persistent state per entity
- Easy comparison between entities

### Compact Entity Cards
```css
.entity-card {
  padding: 12px;
  margin: 8px 0;
  background: #f8f9fa;
  border-radius: 6px;
  font-size: 13px;
}

.entity-identicon {
  width: 24px;
  height: 24px;
  display: inline-block;
}

.validator-list {
  font-size: 11px;
  color: #666;
  margin-top: 4px;
}
```

**Design Goals**:
- Maximum information density
- Minimal visual clutter
- Quick scanning capability
- Clear hierarchy

## Interactive Components

### Time Machine Navigation
```javascript
// Synchronized controls
function syncTimeControls(frameIndex) {
  document.getElementById('time-slider').value = frameIndex;
  updateAllTabContent(); // Refresh all visible data
}
```

**Features**:
- Slider for quick navigation
- Step buttons for precise control
- Real-time state synchronization
- History frame indicators

### Proposal Interface
```html
<div class="proposal-card">
  <div class="proposal-header">
    <span class="proposal-id">123</span>
    <span class="proposal-description">Update threshold to 2</span>
    <span class="proposal-status executed">EXECUTED</span>
  </div>
  <div class="proposal-votes">
    <div class="vote-item">alice - ✅ yes: "Looks good"</div>
    <div class="vote-item">bob - ❌ no: "Too restrictive"</div>
  </div>
  <div class="proposal-progress">
    <div class="progress-bar" style="width: 66%"></div>
    <span class="progress-text">2/3 voting power</span>
  </div>
</div>
```

**Key Elements**:
- Clear proposal identification
- Visual voting status
- Progress bar based on voting power
- Individual vote comments
- Execution status badges

### Action Selection System
```javascript
// Default to most common action
const actionSelector = document.getElementById('action-selector');
actionSelector.value = 'chat'; // Default to chat

// Context-aware options
function updateActionOptions(proposals) {
  const voteOptions = proposals.map(p => 
    `<option value="vote:${p.id}">Vote on: ${p.description}</option>`
  ).join('');
  
  actionSelector.innerHTML = baseOptions + voteOptions;
}
```

**UX Patterns**:
- Smart defaults (chat as primary action)
- Context-sensitive options
- Pre-filled forms for quick actions
- Clear action categorization

## Data Visualization

### Transaction History Display
```javascript
function renderTransactionHistory(transactions) {
  return transactions.map(tx => {
    const direction = getTransactionDirection(tx);
    const icon = getTransactionIcon(tx.type);
    
    return `
      <div class="transaction-item">
        <span class="tx-icon">${icon}</span>
        <span class="tx-type">${tx.type}</span>
        <span class="tx-direction">${direction}</span>
        <span class="tx-content">${formatTxContent(tx)}</span>
      </div>
    `;
  }).join('');
}
```

**Visualization Principles**:
- Clear directional indicators (→ THIS REPLICA, FROM THIS REPLICA →)
- Type-specific icons (💬 chat, 📋 propose, 🗳️ vote)
- Consistent formatting
- No artificial limits (show all transactions)

### State Visualization
```javascript
// Visual indicators for replica state
function getReplicaStatusIcon(replica) {
  if (replica.isProposer) return '👑';
  if (replica.mempool.length > 0) return '📤';
  return '✅';
}

// Progress visualization
function renderVotingProgress(proposal, validators) {
  const totalPower = Array.from(validators.values()).reduce((a, b) => a + b, 0n);
  const yesPower = calculateYesVotingPower(proposal, validators);
  const percentage = Number((yesPower * 100n) / totalPower);
  
  return `<div class="progress-bar" style="width: ${percentage}%"></div>`;
}
```

## Form Design Patterns

### Entity Creation Form
```html
<div class="entity-form">
  <div class="form-section">
    <label>Entity Type</label>
    <select id="entity-type">
      <option value="lazy">Lazy (No specific number)</option>
      <option value="numbered">Numbered (Sequential ID)</option>
      <option value="named">Named (Custom identifier)</option>
    </select>
  </div>
  
  <div class="form-section">
    <label>Validators</label>
    <div class="validator-list">
      <div class="validator-item">
        <input type="checkbox" id="val-alice" value="alice" checked>
        <label for="val-alice">alice</label>
        <input type="number" value="1" min="1" class="validator-weight">
      </div>
    </div>
  </div>
  
  <div class="form-section">
    <label>Threshold: <span id="threshold-display">2</span></label>
    <input type="range" id="threshold-slider" min="1" max="10" value="2">
  </div>
</div>
```

**Form UX Principles**:
- Progressive disclosure
- Real-time validation feedback
- Smart defaults
- Clear field relationships
- Visual weight indicators

### Vote Submission Form
```javascript
// Pre-fill form when clicking proposal
function prefillVoteForm(proposalId, tabId) {
  document.getElementById('vote-proposal-select').value = proposalId;
  document.getElementById('vote-choice').value = ''; // Force user choice
  document.getElementById('vote-comment').value = '';
  document.getElementById('vote-comment').focus();
}
```

**Interaction Patterns**:
- Click-to-prefill from proposals
- Mandatory choice selection
- Optional but encouraged comments
- Immediate feedback on submission

## Settings and Configuration

### Modal-Based Settings
```css
.settings-modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.8);
  display: none;
  z-index: 1000;
}

.settings-content {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: #1a1a1a;
  padding: 30px;
  border-radius: 8px;
  color: white;
}
```

**Modal Design**:
- Dark overlay for focus
- Centered positioning
- Consistent dark theme
- Escape key handling
- Click-outside to close

### Toggle Controls
```html
<div class="setting-item">
  <label for="mode-toggle">Processing Mode</label>
  <div class="toggle-container">
    <span class="toggle-label">Gossip</span>
    <label class="toggle-switch">
      <input type="checkbox" id="mode-toggle">
      <span class="toggle-slider"></span>
    </label>
    <span class="toggle-label">Proposer</span>
  </div>
</div>
```

**Control Patterns**:
- Binary state toggles
- Clear state labeling
- Visual feedback
- Immediate application

## Error Handling UI

### User-Friendly Error Messages
```javascript
function showError(message, context = '') {
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-message';
  errorDiv.innerHTML = `
    <span class="error-icon">⚠️</span>
    <span class="error-text">${message}</span>
    ${context ? `<span class="error-context">${context}</span>` : ''}
  `;
  
  document.body.appendChild(errorDiv);
  setTimeout(() => errorDiv.remove(), 5000);
}
```

### Validation Feedback
```javascript
// Real-time form validation
function validateEntityForm() {
  const selectedValidators = getSelectedValidators();
  const threshold = getThreshold();
  
  if (threshold > selectedValidators.length) {
    showFieldError('threshold', 'Threshold cannot exceed validator count');
    return false;
  }
  
  return true;
}
```

## Performance Considerations

### Efficient Rendering
```javascript
// Avoid unnecessary re-renders
let lastRenderState = {};
function shouldRerender(newState) {
  const stateKey = JSON.stringify({
    height: newState.height,
    proposalCount: newState.proposals.size,
    messageCount: newState.messages.length
  });
  
  if (stateKey === lastRenderState) return false;
  lastRenderState = stateKey;
  return true;
}
```

### Memory Management
```javascript
// Limit UI history
const MAX_DISPLAYED_TRANSACTIONS = 100;
function limitDisplayedTransactions(transactions) {
  return transactions.slice(-MAX_DISPLAYED_TRANSACTIONS);
}
```

## Accessibility Considerations

### Keyboard Navigation
```javascript
// ESC to close modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAllModals();
  }
});

// Tab navigation support
function makeFocusable(element) {
  element.setAttribute('tabindex', '0');
  element.addEventListener('keydown', handleKeyNavigation);
}
```

### Screen Reader Support
```html
<!-- Semantic markup -->
<main role="main">
  <section aria-label="Entity Tabs">
    <div role="tablist">
      <button role="tab" aria-selected="true">Entity 1</button>
    </div>
  </section>
</main>

<!-- ARIA labels -->
<button aria-label="Close tab for Entity 1">×</button>
<input aria-describedby="threshold-help" id="threshold">
<div id="threshold-help">Minimum votes required for proposal approval</div>
```

## Future Enhancements

### Framework Migration Considerations
- **React**: Better state management, component reusability
- **Vue**: Simpler migration path, good reactivity
- **Svelte**: Minimal bundle size, good performance

### Advanced Visualizations
- **Network diagrams**: Show entity relationships
- **Timeline views**: Visualize consensus progression
- **Performance metrics**: Display timing and throughput data
- **State diffs**: Highlight changes between frames

### Enhanced Interactions
- **Drag & drop**: Reorganize entity tabs
- **Right-click menus**: Context-sensitive actions
- **Keyboard shortcuts**: Power-user features
- **Split views**: Compare multiple entities side-by-side
