/**
 * 🎯 SHARED TUTORIAL STEPS
 * 
 * These tutorial steps are used by both:
 * 1. Frontend TutorialOverlay.svelte for in-app guidance
 * 2. E2E tests for validation and screenshot generation
 */

export interface TutorialStep {
  id: string;
  title: string;
  description: string;
  action: 'click' | 'fill' | 'select' | 'wait' | 'navigate';
  target: string;
  value?: string;
  explanation?: string;
  screenshot?: string;
}

export interface Tutorial {
  id: string;
  title: string;
  description: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimatedTime: string;
  steps: TutorialStep[];
}

// === QUICK START TUTORIAL ===
export const quickStartTutorial: Tutorial = {
  id: 'quick-start',
  title: 'Quick Start: Create Your First Entity',
  description: 'Get started with XLN in under 60 seconds. Create Alice\'s entity and send your first transaction.',
  difficulty: 'beginner',
  estimatedTime: '1 minute',
  steps: [
    {
      id: 'navigate',
      title: 'Welcome to XLN',
      description: 'You\'re now in the XLN dashboard. Let\'s create your first entity!',
      action: 'wait',
      target: '#formationTabContent',
      explanation: 'The formation tab is where you create new entities. Think of entities as smart wallets or organizations.'
    },
    {
      id: 'select-entity-type',
      title: 'Choose Entity Type',
      description: 'Select "lazy" entity type for quick setup',
      action: 'select',
      target: '#entityTypeSelect',
      value: 'lazy',
      explanation: 'Lazy entities are perfect for testing - they work without on-chain registration.'
    },
    {
      id: 'name-entity',
      title: 'Name Your Entity',
      description: 'Give your entity a memorable name',
      action: 'fill',
      target: '#entityNameInput',
      value: 'My First Entity',
      explanation: 'Entity names help you identify them in the interface. Choose something meaningful!'
    },
    {
      id: 'select-validator',
      title: 'Choose Validator',
      description: 'Select Alice as your validator (the signer who can authorize transactions)',
      action: 'click',
      target: '[data-validator-id="0"] .validator-selector',
      explanation: 'Validators are the accounts that can sign transactions for this entity. Alice is a pre-configured test account.'
    },
    {
      id: 'pick-alice',
      title: 'Pick Alice',
      description: 'Click on alice.eth from the dropdown',
      action: 'click', 
      target: '#validatorOptions0 [data-signer="alice"]',
      explanation: 'Alice is one of the test accounts available in XLN for demonstration purposes.'
    },
    {
      id: 'set-threshold',
      title: 'Set Voting Threshold',
      description: 'Keep threshold at 1 (Alice can act alone)',
      action: 'fill',
      target: '#thresholdSlider',
      value: '1',
      explanation: 'Threshold determines how many validators must agree for transactions. 1 means Alice has full control.'
    },
    {
      id: 'create-entity',
      title: 'Create Entity',
      description: 'Click the Create Entity button to launch your entity!',
      action: 'click',
      target: 'button[type="submit"]',
      explanation: 'This creates the entity and imports it into all relevant validator accounts.'
    },
    {
      id: 'verify-creation',
      title: 'Entity Created!',
      description: 'Your entity is now live and ready for transactions',
      action: 'wait',
      target: '.entity-panel',
      explanation: '🎉 Congratulations! You\'ve created your first XLN entity. You can now send messages, create proposals, and interact with other entities.'
    }
  ]
};

// === COMPLETE WORKFLOW TUTORIAL ===
export const completeWorkflowTutorial: Tutorial = {
  id: 'complete-workflow',
  title: 'Complete Entity & Channel Workflow',
  description: 'Master the full XLN experience: create entities, demonstrate governance, and prepare for channels.',
  difficulty: 'intermediate',
  estimatedTime: '15 minutes',
  steps: [
    // Entity Creation Steps
    {
      id: 'setup',
      title: 'Navigate to XLN Dashboard',
      description: 'Load the XLN interface and ensure the environment is ready',
      action: 'navigate',
      target: '/',
      explanation: 'The XLN dashboard provides entity formation, channel management, and consensus monitoring all in one interface.'
    },
    {
      id: 'alice-entity-type',
      title: 'Create Alice\'s Simple Entity',
      description: 'Select lazy entity type and name it "Alice Personal Wallet"',
      action: 'select',
      target: '#entityTypeSelect',
      value: 'lazy',
      explanation: 'This creates a simple 1-of-1 entity where Alice has full control. Perfect for personal wallets or testing.'
    },
    {
      id: 'alice-entity-name',
      title: 'Name Alice\'s Entity',
      description: 'Enter "Alice Personal Wallet" as the entity name',
      action: 'fill',
      target: '#entityNameInput',
      value: 'Alice Personal Wallet'
    },
    {
      id: 'alice-validator',
      title: 'Set Alice as Validator',
      description: 'Select Alice as the validator for her personal entity',
      action: 'click',
      target: '[data-validator-id="0"] .validator-selector'
    },
    {
      id: 'alice-threshold',
      title: 'Set Threshold to 1',
      description: 'Set voting threshold to 1 (Alice can act alone)',
      action: 'fill',
      target: '#thresholdSlider',
      value: '1'
    },
    {
      id: 'create-alice-entity',
      title: 'Create Alice\'s Entity',
      description: 'Click Create Entity to launch Alice\'s personal wallet',
      action: 'click',
      target: 'button[type="submit"]',
      explanation: 'Entity creation involves cryptographic consensus. Alice\'s entity is now live and can receive transactions.'
    },
    
    // Multi-sig Hub Creation
    {
      id: 'add-validators',
      title: 'Create Multi-Signature Hub',
      description: 'Add more validators for the hub entity',
      action: 'click',
      target: 'button[data-action="add-validator"]',
      explanation: 'Multi-signature entities provide enhanced security. Any 2 of the 3 validators can authorize transactions.'
    },
    {
      id: 'hub-name',
      title: 'Name the Hub',
      description: 'Enter "Payment Hub ABC" as the hub name',
      action: 'fill',
      target: '#entityNameInput',
      value: 'Payment Hub ABC'
    },
    {
      id: 'hub-threshold',
      title: 'Set Hub Threshold',
      description: 'Set threshold to 2 (requires 2 out of 3 signatures)',
      action: 'fill',
      target: '#thresholdSlider',
      value: '2'
    },
    {
      id: 'create-hub',
      title: 'Create Hub Entity',
      description: 'Click Create Entity to launch the multi-sig hub',
      action: 'click',
      target: 'button[type="submit"]',
      explanation: 'The hub is now operational with 3 validator replicas. Each validator maintains their own view of the entity state.'
    },

    // Panel Configuration & Governance Demo
    {
      id: 'configure-panels',
      title: 'Configure Entity Panels',
      description: 'Set up panels to show different validator views',
      action: 'click',
      target: '.entity-panel:first-child .unified-dropdown-btn',
      explanation: 'Each panel can show a different signer\'s view of any entity they participate in.'
    },
    {
      id: 'send-chat',
      title: 'Send Chat Message',
      description: 'Demonstrate entity communication with a chat message',
      action: 'fill',
      target: '.controls-section textarea',
      value: 'Hello from Alice! Ready to create channels.',
      explanation: 'Chat messages are cryptographically signed and become part of the entity\'s permanent state.'
    },
    {
      id: 'create-proposal',
      title: 'Create Channel Opening Proposal',
      description: 'Propose to open a payment channel with the hub',
      action: 'select',
      target: '.controls-dropdown',
      value: 'proposal',
      explanation: 'Proposals enable democratic decision-making. This proposal would authorize opening a payment channel.'
    },
    {
      id: 'multi-sig-voting',
      title: 'Demonstrate Multi-Signature Voting',
      description: 'Other validators vote on the proposal',
      action: 'click',
      target: '.vote-button[data-choice="yes"]',
      explanation: 'With multiple YES votes, the proposal reaches quorum and will be executed automatically.'
    },
    {
      id: 'time-machine',
      title: 'Use Time Machine',
      description: 'Review entity history using the time machine controls',
      action: 'click',
      target: '.time-btn-compact[data-action="back"]',
      explanation: 'The time machine allows you to replay the entire entity history, perfect for audits and debugging.'
    },
    {
      id: 'completion',
      title: 'Tutorial Complete!',
      description: 'You\'ve mastered entity creation and governance. Ready for channels!',
      action: 'wait',
      target: '.entity-panels-container',
      explanation: '🎉 Tutorial complete! You\'ve created entities, demonstrated multi-signature governance, and are ready for channel operations.'
    }
  ]
};

// === MULTI-SIGNATURE GOVERNANCE TUTORIAL ===
export const multiSigGovernanceTutorial: Tutorial = {
  id: 'multi-sig-governance',
  title: 'Multi-Signature Governance',
  description: 'Learn democratic decision-making with multi-signature entities.',
  difficulty: 'intermediate',
  estimatedTime: '10 minutes',
  steps: [
    {
      id: 'create-multi-sig',
      title: 'Create Multi-Sig Entity',
      description: 'Set up a 2-of-3 entity with Alice, Bob, and Carol',
      action: 'select',
      target: '#entityTypeSelect',
      value: 'lazy',
      explanation: 'Multi-signature entities require multiple validators to agree before executing transactions.'
    },
    // More steps...
  ]
};

// Export all tutorials
export const allTutorials: Tutorial[] = [
  quickStartTutorial,
  completeWorkflowTutorial,
  multiSigGovernanceTutorial
];

// Utility functions
export function getTutorialById(id: string): Tutorial | undefined {
  return allTutorials.find(tutorial => tutorial.id === id);
}

export function getTutorialsByDifficulty(difficulty: Tutorial['difficulty']): Tutorial[] {
  return allTutorials.filter(tutorial => tutorial.difficulty === difficulty);
}
