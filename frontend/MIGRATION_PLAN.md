# XLN Visual Debugger: Svelte+Vite Migration Plan

## Overview
This document outlines the migration strategy from the monolithic `index.html` file to a modern Svelte+Vite application structure, with components limited to 1000 lines of code each.

## Current State Analysis

### Monolithic Structure Issues
- **Single 2,800+ line HTML file** with embedded CSS and JavaScript
- **Mixed concerns**: UI, state management, business logic all in one file
- **No component reusability** or proper separation of concerns
- **Difficult testing** and maintenance
- **No build optimization** or modern tooling

### Key Features to Preserve
- **Tab-based entity panels** with dynamic content
- **Time machine controls** for historical state navigation
- **Real-time consensus visualization**
- **Entity formation workflows**
- **Jurisdiction management**
- **Transaction history and I/O tracking**

## Migration Strategy

### Phase 1: Project Setup & Core Infrastructure
1. **Initialize Svelte+Vite project**
2. **Set up TypeScript configuration**
3. **Configure build tools and development environment**
4. **Create base application structure**

### Phase 2: Component Architecture Design
1. **Break down monolithic structure into logical components**
2. **Design component hierarchy and data flow**
3. **Implement shared state management**
4. **Create reusable UI components**

### Phase 3: Component Implementation
1. **Implement core layout components**
2. **Create entity management components**
3. **Build consensus visualization components**
4. **Implement time machine functionality**

### Phase 4: Integration & Testing
1. **Integrate with existing server.ts backend**
2. **Implement comprehensive testing**
3. **Performance optimization**
4. **Documentation and deployment**

## Component Architecture

### Component Hierarchy
```
App.svelte (Root)
├── Layout/
│   ├── TopBar.svelte (~200 LOC)
│   ├── MainContent.svelte (~150 LOC)
│   └── TimeMachine.svelte (~300 LOC)
├── Entity/
│   ├── EntityPanelsContainer.svelte (~400 LOC)
│   ├── EntityPanel.svelte (~600 LOC)
│   ├── EntityProfile.svelte (~300 LOC)
│   ├── ConsensusState.svelte (~250 LOC)
│   ├── ChatMessages.svelte (~200 LOC)
│   ├── ProposalsList.svelte (~400 LOC)
│   ├── TransactionHistory.svelte (~350 LOC)
│   └── EntityControls.svelte (~500 LOC)
├── Formation/
│   ├── EntityFormation.svelte (~600 LOC)
│   ├── ValidatorSelector.svelte (~400 LOC)
│   ├── JurisdictionSelector.svelte (~300 LOC)
│   └── ThresholdControls.svelte (~200 LOC)
├── Jurisdiction/
│   ├── JurisdictionsPanel.svelte (~500 LOC)
│   └── JurisdictionCard.svelte (~300 LOC)
├── Common/
│   ├── Dropdown.svelte (~300 LOC)
│   ├── Modal.svelte (~200 LOC)
│   ├── Button.svelte (~100 LOC)
│   ├── Input.svelte (~150 LOC)
│   └── Avatar.svelte (~100 LOC)
└── Stores/
    ├── xlnStore.ts (~400 LOC)
    ├── tabStore.ts (~200 LOC)
    ├── settingsStore.ts (~150 LOC)
    └── timeStore.ts (~200 LOC)
```

### Component Specifications

#### 1. App.svelte (~200 LOC)
**Purpose**: Root application component
**Responsibilities**:
- Initialize XLN environment
- Set up global error handling
- Manage application-wide state
- Coordinate between major sections

#### 2. Layout Components

##### TopBar.svelte (~200 LOC)
**Purpose**: Application header with navigation and controls
**Features**:
- XLN logo and branding
- Global action buttons (Run Demo, Clear DB, Create Entity)
- Settings and theme toggle
- Status indicators

##### MainContent.svelte (~150 LOC)
**Purpose**: Main content area layout manager
**Responsibilities**:
- Route between different views (Entity Panels, Formation, Jurisdictions)
- Handle responsive layout
- Manage content transitions

##### TimeMachine.svelte (~300 LOC)
**Purpose**: Time navigation and history controls
**Features**:
- Time slider with progress indication
- Navigation buttons (step forward/backward, go to start/end)
- Current time/frame display
- Keyboard shortcuts handling

#### 3. Entity Management Components

##### EntityPanelsContainer.svelte (~400 LOC)
**Purpose**: Container for multiple entity panels
**Features**:
- Dynamic panel creation and removal
- Panel layout management (responsive grid)
- Tab system coordination
- Panel state persistence

##### EntityPanel.svelte (~600 LOC)
**Purpose**: Individual entity panel with all components
**Features**:
- Entity dropdown selector
- Profile display
- Collapsible component sections
- Component state management
- Real-time data updates

##### EntityProfile.svelte (~300 LOC)
**Purpose**: Entity profile information display
**Features**:
- Entity avatar and basic info
- Board member visualization
- Role indicators (proposer/validator)
- Jurisdiction information

##### ConsensusState.svelte (~250 LOC)
**Purpose**: Consensus status and metrics
**Features**:
- Lock/unlock status
- Frame height tracking
- Role display
- Proposal and message counts

##### ChatMessages.svelte (~200 LOC)
**Purpose**: Chat message display and input
**Features**:
- Message list with scrolling
- Message composition
- Real-time updates
- Message formatting

##### ProposalsList.svelte (~400 LOC)
**Purpose**: Proposal management and voting
**Features**:
- Proposal list with status
- Voting interface
- Progress tracking
- Vote details and comments

##### TransactionHistory.svelte (~350 LOC)
**Purpose**: Transaction history visualization
**Features**:
- Banking-style transaction list
- Frame-based history
- Activity indicators
- Filtering and search

##### EntityControls.svelte (~500 LOC)
**Purpose**: Entity action controls
**Features**:
- Action type selector
- Dynamic form generation
- Transaction submission
- Validation and error handling

#### 4. Formation Components

##### EntityFormation.svelte (~600 LOC)
**Purpose**: Entity creation workflow
**Features**:
- Entity type selection (lazy/numbered/named)
- Name input and validation
- Validator configuration
- Threshold settings
- Preview and creation

##### ValidatorSelector.svelte (~400 LOC)
**Purpose**: Validator selection and management
**Features**:
- Validator dropdown with search
- Weight assignment
- Add/remove validators
- Validation and constraints

##### JurisdictionSelector.svelte (~300 LOC)
**Purpose**: Jurisdiction selection and info
**Features**:
- Jurisdiction dropdown
- Network information display
- Contract status
- Connection validation

##### ThresholdControls.svelte (~200 LOC)
**Purpose**: Threshold configuration
**Features**:
- Threshold slider
- Weight calculation
- Visual feedback
- Validation

#### 5. Jurisdiction Components

##### JurisdictionsPanel.svelte (~500 LOC)
**Purpose**: Jurisdiction management interface
**Features**:
- Jurisdiction grid layout
- Status monitoring
- Refresh controls
- Contract deployment

##### JurisdictionCard.svelte (~300 LOC)
**Purpose**: Individual jurisdiction display
**Features**:
- Connection status
- Network details
- Entity listings
- Action buttons

#### 6. Common/Reusable Components

##### Dropdown.svelte (~300 LOC)
**Purpose**: Reusable dropdown component
**Features**:
- Search functionality
- Hierarchical options
- Avatar support
- Keyboard navigation

##### Modal.svelte (~200 LOC)
**Purpose**: Modal dialog component
**Features**:
- Overlay management
- Focus trapping
- Escape key handling
- Customizable content

##### Button.svelte (~100 LOC)
**Purpose**: Standardized button component
**Features**:
- Multiple variants
- Loading states
- Icon support
- Accessibility

##### Input.svelte (~150 LOC)
**Purpose**: Form input component
**Features**:
- Multiple input types
- Validation states
- Label and help text
- Error display

##### Avatar.svelte (~100 LOC)
**Purpose**: Avatar display component
**Features**:
- SVG avatar generation
- Fallback handling
- Size variants
- Caching

### State Management

#### Store Architecture
```typescript
// xlnStore.ts - Main XLN environment state
interface XLNState {
  environment: XLNEnvironment | null;
  replicas: Map<string, EntityReplica>;
  history: Snapshot[];
  loading: boolean;
  error: string | null;
}

// tabStore.ts - Tab system state
interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  nextTabId: number;
}

// settingsStore.ts - Application settings
interface SettingsState {
  theme: 'dark' | 'light';
  dropdownMode: 'signer-first' | 'entity-first';
  serverDelay: number;
  componentStates: Record<string, boolean>;
}

// timeStore.ts - Time machine state
interface TimeState {
  currentTimeIndex: number;
  maxTimeIndex: number;
  isLive: boolean;
}
```

## Implementation Plan

### Phase 1: Project Setup (Week 1)

#### Day 1-2: Initialize Project
```bash
# Create Svelte+Vite project in frontend folder
cd frontend
npm create svelte@latest . -- --template skeleton --types typescript
npm install

# Add additional dependencies
npm install -D @types/node vite-plugin-static-copy
npm install lucide-svelte @floating-ui/dom
```

#### Day 3-4: Configure Build System
- Set up Vite configuration
- Configure TypeScript
- Set up development scripts
- Configure static asset handling

#### Day 5-7: Create Base Structure
- Set up folder structure
- Create base components
- Set up routing (if needed)
- Configure stores

### Phase 2: Core Components (Week 2-3)

#### Week 2: Layout and Infrastructure
- Implement App.svelte
- Create TopBar.svelte
- Build MainContent.svelte
- Implement TimeMachine.svelte
- Set up store architecture

#### Week 3: Common Components
- Build reusable components (Button, Input, Modal, etc.)
- Implement Dropdown.svelte with search
- Create Avatar.svelte with SVG generation
- Set up component library structure

### Phase 3: Entity Management (Week 4-5)

#### Week 4: Entity Display Components
- Implement EntityPanelsContainer.svelte
- Create EntityPanel.svelte
- Build EntityProfile.svelte
- Implement ConsensusState.svelte

#### Week 5: Entity Interaction Components
- Create ChatMessages.svelte
- Implement ProposalsList.svelte
- Build TransactionHistory.svelte
- Create EntityControls.svelte

### Phase 4: Formation and Jurisdiction (Week 6)

#### Week 6: Formation Components
- Implement EntityFormation.svelte
- Create ValidatorSelector.svelte
- Build JurisdictionSelector.svelte
- Implement ThresholdControls.svelte
- Create JurisdictionsPanel.svelte and JurisdictionCard.svelte

### Phase 5: Integration and Testing (Week 7-8)

#### Week 7: Integration
- Integrate with existing server.ts
- Implement data flow
- Handle real-time updates
- Performance optimization

#### Week 8: Testing and Polish
- Unit testing for components
- Integration testing
- Performance testing
- Bug fixes and polish

## Migration Benefits

### Technical Benefits
- **Modular Architecture**: Easy to maintain and extend
- **Type Safety**: Full TypeScript support
- **Performance**: Optimized builds and lazy loading
- **Testing**: Component-level testing capabilities
- **Developer Experience**: Hot reload, better debugging

### Maintainability Benefits
- **Separation of Concerns**: Clear component boundaries
- **Reusability**: Shared components across the application
- **Scalability**: Easy to add new features
- **Documentation**: Self-documenting component structure

### User Experience Benefits
- **Faster Loading**: Optimized bundle sizes
- **Better Performance**: Reactive updates only where needed
- **Responsive Design**: Mobile-friendly components
- **Accessibility**: Built-in accessibility features

## Risk Mitigation

### Technical Risks
- **State Management Complexity**: Use proven patterns (stores)
- **Performance Issues**: Implement virtual scrolling for large lists
- **Integration Challenges**: Maintain backward compatibility

### Migration Risks
- **Feature Parity**: Comprehensive testing against current functionality
- **Data Loss**: Careful handling of localStorage and state
- **User Disruption**: Gradual rollout with fallback options

## Success Metrics

### Code Quality
- All components under 1000 LOC
- 90%+ TypeScript coverage
- 80%+ test coverage
- Zero ESLint errors

### Performance
- <2s initial load time
- <100ms component render time
- <50MB memory usage
- 90+ Lighthouse score

### Functionality
- 100% feature parity with current system
- All existing workflows preserved
- Improved user experience metrics
- Zero critical bugs

## Conclusion

This migration plan provides a structured approach to modernizing the XLN Visual Debugger while maintaining all existing functionality. The component-based architecture will improve maintainability, performance, and developer experience while setting the foundation for future enhancements.

The phased approach allows for incremental development and testing, reducing risk and ensuring a smooth transition from the current monolithic structure to a modern, scalable application.
