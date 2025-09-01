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

// === PROPOSAL WORKFLOW TUTORIAL ===
export const proposalWorkflowTutorial: Tutorial = {
  id: 'proposal-workflow',
  title: '🗳️ Proposal & Voting Workflow',
  description: 'Learn how to create proposals, vote, and execute collective decisions in XLN entities.',
  difficulty: 'intermediate',
  estimatedTime: '8 minutes',
  steps: [
    {
      id: 'introduction',
      title: 'Proposal System Overview',
      description: 'Learn how XLN enables collective decision-making through proposals and voting.',
      action: 'wait',
      target: '.app-container',
      explanation: 'XLN proposals allow entity members to propose actions and vote democratically. Proposals execute automatically when thresholds are met.',
      screenshot: 'proposal-01-introduction'
    },
    {
      id: 'navigate-formation',
      title: 'Open Entity Formation',
      description: 'Click the Formation tab to create a new entity for our proposal demonstration',
      action: 'click',
      target: 'button:has-text("Formation")',
      explanation: 'First, we need an entity with multiple validators to demonstrate the proposal workflow.',
      screenshot: 'proposal-02-formation-tab'
    },
    {
      id: 'set-entity-name',
      title: 'Name Your Entity',
      description: 'Enter "Governance DAO" as the entity name',
      action: 'fill',
      target: '#entityNameInput',
      value: 'Governance DAO',
      explanation: 'Give your entity a meaningful name that reflects its purpose.',
      screenshot: 'proposal-03-entity-name'
    },
    {
      id: 'add-validator',
      title: 'Add Second Validator',
      description: 'Click "Add Validator" to create a multi-signature entity',
      action: 'click',
      target: 'button:has-text("➕ Add Validator")',
      explanation: 'Multi-validator entities enable democratic governance through voting.',
      screenshot: 'proposal-04-add-validator'
    },
    {
      id: 'select-alice',
      title: 'Choose Alice as First Validator',
      description: 'Select alice from the dropdown for the first validator',
      action: 'select',
      target: '.validator-row:first-child .validator-name',
      value: 'alice',
      explanation: 'Alice will be our first validator with voting rights.',
      screenshot: 'proposal-05-select-alice'
    },
    {
      id: 'select-bob',
      title: 'Choose Bob as Second Validator',
      description: 'Select bob from the dropdown for the second validator',
      action: 'select',
      target: '.validator-row:last-child .validator-name',
      value: 'bob',
      explanation: 'Bob will be our second validator. With 2 validators, we can demonstrate voting.',
      screenshot: 'proposal-06-select-bob'
    },
    {
      id: 'set-threshold',
      title: 'Set Voting Threshold',
      description: 'Set threshold to 1 so either validator can approve proposals',
      action: 'fill',
      target: '#thresholdSlider',
      value: '1',
      explanation: 'Threshold determines how many validators must approve a proposal for it to execute.',
      screenshot: 'proposal-07-threshold'
    },
    {
      id: 'create-entity',
      title: 'Create the Entity',
      description: 'Click "Create Entity" to establish your governance entity',
      action: 'click',
      target: 'button:has-text("Create Entity")',
      explanation: 'This creates the entity with the configured validators and voting rules.',
      screenshot: 'proposal-08-create-entity'
    },
    {
      id: 'wait-creation',
      title: 'Entity Created Successfully',
      description: 'Your governance entity is now ready for proposals and voting',
      action: 'wait',
      target: '.entity-panel',
      explanation: 'The entity is now active and ready for governance operations.',
      screenshot: 'proposal-09-entity-ready'
    },
    {
      id: 'select-entity-dropdown',
      title: 'Select Your Entity',
      description: 'Click the entity dropdown to select your newly created entity',
      action: 'click',
      target: '.unified-dropdown:first-child',
      explanation: 'Select the entity to interact with it.',
      screenshot: 'proposal-10-entity-dropdown'
    },
    {
      id: 'pick-entity',
      title: 'Choose Your Entity',
      description: 'Select the "Governance DAO" entity from the dropdown',
      action: 'click',
      target: '#dropdownResults .dropdown-item:first-child',
      explanation: 'This selects the entity for governance operations.',
      screenshot: 'proposal-11-pick-entity'
    },
    {
      id: 'select-signer-dropdown',
      title: 'Select Signer',
      description: 'Click the signer dropdown to choose who will create the proposal',
      action: 'click',
      target: '.unified-dropdown:nth-child(2)',
      explanation: 'The signer determines who is creating and initially voting on the proposal.',
      screenshot: 'proposal-12-signer-dropdown'
    },
    {
      id: 'pick-alice-signer',
      title: 'Choose Alice as Signer',
      description: 'Select Alice to act as the proposal creator',
      action: 'click',
      target: '#dropdownResults .dropdown-item:first-child',
      explanation: 'Alice will create the proposal and automatically vote as the proposer.',
      screenshot: 'proposal-13-pick-alice'
    },
    {
      id: 'expand-controls',
      title: 'Expand Controls Section',
      description: 'Click "Controls" to open the proposal creation interface',
      action: 'click',
      target: '.entity-panel button:has-text("Controls")',
      explanation: 'The controls section contains proposal creation and voting tools.',
      screenshot: 'proposal-14-expand-controls'
    },
    {
      id: 'fill-proposal-title',
      title: 'Enter Proposal Title',
      description: 'Type "Marketing Budget Approval" as the proposal title',
      action: 'fill',
      target: 'input[placeholder="Enter proposal title..."]',
      value: 'Marketing Budget Approval',
      explanation: 'Clear, descriptive titles help validators understand what they\'re voting on.',
      screenshot: 'proposal-15-title-filled'
    },
    {
      id: 'fill-proposal-description',
      title: 'Enter Proposal Description',
      description: 'Add a detailed description of the proposal',
      action: 'fill',
      target: 'textarea[placeholder="Enter proposal description..."]',
      value: 'Approve $75,000 budget for Q4 marketing campaigns including social media, content creation, and partnership outreach.',
      explanation: 'Detailed descriptions help validators make informed decisions.',
      screenshot: 'proposal-16-description-filled'
    },
    {
      id: 'submit-proposal',
      title: 'Create the Proposal',
      description: 'Click "Create Proposal" to submit it to the entity for voting',
      action: 'click',
      target: 'button:has-text("Create Proposal")',
      explanation: 'This creates the proposal and automatically adds Alice\'s YES vote as the proposer.',
      screenshot: 'proposal-17-proposal-created'
    },
    {
      id: 'view-proposal',
      title: 'Proposal Created!',
      description: 'Your proposal is now visible in the proposals list with Alice\'s automatic vote',
      action: 'wait',
      target: '.proposal-item',
      explanation: 'Proposals show voting status, threshold progress, and execution state.',
      screenshot: 'proposal-18-proposal-visible'
    },
    {
      id: 'switch-to-bob',
      title: 'Switch to Bob for Voting',
      description: 'Now let\'s switch to Bob to demonstrate the voting process',
      action: 'click',
      target: '.unified-dropdown:nth-child(2)',
      explanation: 'Different signers can vote on proposals to reach consensus.',
      screenshot: 'proposal-19-switch-bob'
    },
    {
      id: 'select-bob-signer',
      title: 'Select Bob as Signer',
      description: 'Choose Bob from the signer dropdown',
      action: 'click',
      target: '#dropdownResults .dropdown-item:nth-child(2)',
      explanation: 'Bob will now vote on Alice\'s proposal.',
      screenshot: 'proposal-20-bob-selected'
    },
    {
      id: 'expand-bob-controls',
      title: 'Open Bob\'s Controls',
      description: 'Click "Controls" to access Bob\'s voting interface',
      action: 'click',
      target: '.entity-panel button:has-text("Controls")',
      explanation: 'Each signer has access to the same governance tools.',
      screenshot: 'proposal-21-bob-controls'
    },
    {
      id: 'select-proposal-vote',
      title: 'Select Proposal to Vote On',
      description: 'Choose the "Marketing Budget Approval" proposal from the voting dropdown',
      action: 'select',
      target: 'select option:has-text("Marketing Budget")',
      value: 'Marketing Budget Approval',
      explanation: 'Select which proposal to vote on from the list of pending proposals.',
      screenshot: 'proposal-22-select-proposal'
    },
    {
      id: 'vote-yes',
      title: 'Vote YES on the Proposal',
      description: 'Select "Yes" to approve the marketing budget proposal',
      action: 'click',
      target: 'input[type="radio"][value="yes"]',
      explanation: 'Bob votes YES to approve the marketing budget.',
      screenshot: 'proposal-23-vote-yes'
    },
    {
      id: 'add-vote-comment',
      title: 'Add Vote Comment',
      description: 'Add a comment explaining your vote',
      action: 'fill',
      target: 'textarea[placeholder*="vote comment"]',
      value: 'Excellent proposal. The marketing budget is well-justified and will drive growth.',
      explanation: 'Comments provide context for voting decisions and improve governance transparency.',
      screenshot: 'proposal-24-vote-comment'
    },
    {
      id: 'submit-vote',
      title: 'Submit Your Vote',
      description: 'Click "Submit Vote" to record Bob\'s YES vote',
      action: 'click',
      target: 'button:has-text("Submit Vote")',
      explanation: 'This records Bob\'s vote and may trigger proposal execution if threshold is met.',
      screenshot: 'proposal-25-vote-submitted'
    },
    {
      id: 'proposal-executed',
      title: 'Proposal Approved & Executed!',
      description: 'The proposal reached consensus and executed automatically',
      action: 'wait',
      target: '.proposal-item:has-text("APPROVED")',
      explanation: 'When voting threshold is met, proposals execute automatically. Check the chat for execution confirmation.',
      screenshot: 'proposal-26-executed'
    },
    {
      id: 'view-collective-message',
      title: 'Collective Action Recorded',
      description: 'Notice the collective message in chat confirming proposal execution',
      action: 'wait',
      target: '.chat-messages .message-item:has-text("[COLLECTIVE]")',
      explanation: 'Executed proposals generate collective messages visible to all entity members.',
      screenshot: 'proposal-27-collective-message'
    },
    {
      id: 'completion',
      title: 'Proposal Workflow Complete!',
      description: 'You\'ve mastered XLN\'s governance system: creating proposals, voting, and automatic execution',
      action: 'wait',
      target: '.entity-panel',
      explanation: '🎉 You now understand XLN\'s democratic governance: proposals → voting → automatic execution. This enables trustless collective decision-making.',
      screenshot: 'proposal-28-completion'
    }
  ]
};

// Export all tutorials
export const allTutorials: Tutorial[] = [
  quickStartTutorial,
  completeWorkflowTutorial,
  multiSigGovernanceTutorial,
  proposalWorkflowTutorial
];

// Utility functions
export function getTutorialById(id: string): Tutorial | undefined {
  return allTutorials.find(tutorial => tutorial.id === id);
}

export function getTutorialsByDifficulty(difficulty: Tutorial['difficulty']): Tutorial[] {
  return allTutorials.filter(tutorial => tutorial.difficulty === difficulty);
}
