<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import { writable } from 'svelte/store';
  
  const dispatch = createEventDispatcher();
  
  export let isActive = false;
  export let autoMode = false;
  export let speed = 2000; // ms between auto steps
  
  interface TutorialStep {
    id: string;
    title: string;
    description: string;
    selector: string;
    action: 'click' | 'fill' | 'select' | 'wait' | 'highlight';
    value?: string;
    position?: 'top' | 'bottom' | 'left' | 'right';
    validation?: () => boolean;
  }
  
  const proposalTutorialSteps: TutorialStep[] = [
    {
      id: 'start',
      title: 'Welcome to XLN Tutorial',
      description: 'Learn how to create entities and proposals in XLN. You can switch between auto and manual mode anytime.',
      selector: '.app-container',
      action: 'highlight',
      position: 'bottom'
    },
    {
      id: 'formation-tab',
      title: 'Open Entity Formation',
      description: 'Click on the Formation tab to start creating a new entity',
      selector: 'text=Formation',
      action: 'click',
      position: 'bottom'
    },
    {
      id: 'entity-name',
      title: 'Enter Entity Name',
      description: 'Give your entity a meaningful name',
      selector: '#entityNameInput',
      action: 'fill',
      value: 'Tutorial Entity',
      position: 'right'
    },
    {
      id: 'add-validator',
      title: 'Add Second Validator',
      description: 'Entities need multiple validators for consensus',
      selector: 'button:has-text("➕ Add Validator")',
      action: 'click',
      position: 'left'
    },
    {
      id: 'select-alice',
      title: 'Select Alice as First Validator',
      description: 'Choose alice as the first validator',
      selector: '.validator-row:first-child .validator-name',
      action: 'select',
      value: 'alice',
      position: 'right'
    },
    {
      id: 'select-bob',
      title: 'Select Bob as Second Validator',
      description: 'Choose bob as the second validator',
      selector: '.validator-row:last-child .validator-name',
      action: 'select',
      value: 'bob',
      position: 'right'
    },
    {
      id: 'set-threshold',
      title: 'Set Consensus Threshold',
      description: 'Set how many validators must agree for decisions',
      selector: '#thresholdSlider',
      action: 'fill',
      value: '1',
      position: 'top'
    },
    {
      id: 'create-entity',
      title: 'Create the Entity',
      description: 'Click to create your entity with the configured validators',
      selector: 'button:has-text("Create Entity")',
      action: 'click',
      position: 'top',
      validation: () => {
        const env = (window as any).xlnEnv;
        return env?.replicas?.size > 0;
      }
    },
    {
      id: 'wait-creation',
      title: 'Wait for Entity Creation',
      description: 'The system is processing your entity...',
      selector: '.entity-panel',
      action: 'wait',
      position: 'top'
    },
    {
      id: 'select-entity',
      title: 'Select Your Entity',
      description: 'Click the entity dropdown to select your newly created entity',
      selector: '.unified-dropdown:first-child',
      action: 'click',
      position: 'bottom'
    },
    {
      id: 'pick-entity',
      title: 'Choose Entity from List',
      description: 'Select the entity you just created',
      selector: '#dropdownResults .dropdown-item:first-child',
      action: 'click',
      position: 'right'
    },
    {
      id: 'select-signer',
      title: 'Select Signer',
      description: 'Choose who will sign transactions for this entity',
      selector: '.unified-dropdown:nth-child(2)',
      action: 'click',
      position: 'bottom'
    },
    {
      id: 'pick-alice',
      title: 'Choose Alice as Signer',
      description: 'Select alice to sign transactions',
      selector: '#dropdownResults .dropdown-item:first-child',
      action: 'click',
      position: 'right'
    },
    {
      id: 'expand-controls',
      title: 'Expand Controls Section',
      description: 'Click to expand the controls where you can create proposals',
      selector: '.entity-panel .controls-header',
      action: 'click',
      position: 'left'
    },
    {
      id: 'proposal-title',
      title: 'Enter Proposal Title',
      description: 'Give your proposal a clear, descriptive title',
      selector: 'input[placeholder="Enter proposal title..."]',
      action: 'fill',
      value: 'Approve Marketing Budget',
      position: 'top'
    },
    {
      id: 'proposal-description',
      title: 'Enter Proposal Description',
      description: 'Provide details about what this proposal is for',
      selector: 'textarea[placeholder="Enter proposal description..."]',
      action: 'fill',
      value: 'Approve $50,000 budget for Q4 marketing campaigns',
      position: 'top'
    },
    {
      id: 'create-proposal',
      title: 'Create Proposal',
      description: 'Submit your proposal to the entity for voting',
      selector: 'button:has-text("Create Proposal")',
      action: 'click',
      position: 'bottom'
    },
    {
      id: 'proposal-created',
      title: 'Proposal Created!',
      description: 'Your proposal has been created and is now visible in the proposals list',
      selector: '.proposal-item',
      action: 'highlight',
      position: 'right'
    },
    {
      id: 'complete',
      title: 'Tutorial Complete!',
      description: 'You have successfully created an entity and proposal. Explore the voting features next!',
      selector: '.app-container',
      action: 'highlight',
      position: 'top'
    }
  ];
  
  let currentStepIndex = 0;
  let isPaused = false;
  let highlightElement: HTMLElement | null = null;
  let overlay: HTMLElement | null = null;
  let tooltip: HTMLElement | null = null;
  
  $: currentStep = proposalTutorialSteps[currentStepIndex] || null;
  $: isLastStep = currentStepIndex >= proposalTutorialSteps.length - 1;
  
  onMount(() => {
    if (isActive) {
      startTutorial();
    }
  });
  
  function startTutorial() {
    currentStepIndex = 0;
    isPaused = false;
    executeStep();
  }
  
  function stopTutorial() {
    isActive = false;
    clearHighlight();
    dispatch('tutorialEnd');
  }
  
  function pauseTutorial() {
    isPaused = true;
  }
  
  function resumeTutorial() {
    isPaused = false;
    if (autoMode) {
      setTimeout(() => nextStep(), speed);
    }
  }
  
  function nextStep() {
    if (currentStepIndex < proposalTutorialSteps.length - 1) {
      currentStepIndex++;
      executeStep();
    } else {
      stopTutorial();
    }
  }
  
  function previousStep() {
    if (currentStepIndex > 0) {
      currentStepIndex--;
      executeStep();
    }
  }
  
  async function executeStep() {
    if (!currentStep) return;
    
    clearHighlight();
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const element = document.querySelector(currentStep.selector) as HTMLElement;
    if (!element) {
      console.warn(`Tutorial: Element not found for selector: ${currentStep.selector}`);
      if (autoMode && !isPaused) {
        setTimeout(() => nextStep(), 1000);
      }
      return;
    }
    
    highlightElement = element;
    showTooltip(element, currentStep);
    
    // Add ripple effect
    addRippleEffect(element);
    
    // Execute action
    if (autoMode && !isPaused) {
      setTimeout(async () => {
        await performAction(element, currentStep);
        
        // Validate if specified
        if (currentStep.validation) {
          let attempts = 0;
          const maxAttempts = 10;
          
          const checkValidation = () => {
            if (currentStep.validation!() || attempts >= maxAttempts) {
              setTimeout(() => nextStep(), 500);
            } else {
              attempts++;
              setTimeout(checkValidation, 500);
            }
          };
          
          checkValidation();
        } else {
          setTimeout(() => nextStep(), speed);
        }
      }, 1000);
    }
  }
  
  async function performAction(element: HTMLElement, step: TutorialStep) {
    try {
      switch (step.action) {
        case 'click':
          element.click();
          break;
        case 'fill':
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            element.focus();
            element.value = step.value || '';
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
          break;
        case 'select':
          if (element instanceof HTMLSelectElement) {
            element.value = step.value || '';
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
          break;
        case 'wait':
          // Just highlight, no action needed
          break;
        case 'highlight':
          // Just highlight, no action needed
          break;
      }
    } catch (error) {
      console.warn('Tutorial action failed:', error);
    }
  }
  
  function addRippleEffect(element: HTMLElement) {
    const ripple = document.createElement('div');
    ripple.className = 'tutorial-ripple';
    
    const rect = element.getBoundingClientRect();
    ripple.style.left = `${rect.left + rect.width / 2}px`;
    ripple.style.top = `${rect.top + rect.height / 2}px`;
    
    document.body.appendChild(ripple);
    
    setTimeout(() => {
      ripple.remove();
    }, 2000);
  }
  
  function showTooltip(element: HTMLElement, step: TutorialStep) {
    // Create overlay
    overlay = document.createElement('div');
    overlay.className = 'tutorial-overlay';
    document.body.appendChild(overlay);
    
    // Create tooltip
    tooltip = document.createElement('div');
    tooltip.className = 'tutorial-tooltip';
    tooltip.innerHTML = `
      <div class="tutorial-tooltip-content">
        <h3>${step.title}</h3>
        <p>${step.description}</p>
        <div class="tutorial-controls">
          <button class="tutorial-btn tutorial-btn-secondary" data-action="previous" ${currentStepIndex === 0 ? 'disabled' : ''}>Previous</button>
          <button class="tutorial-btn tutorial-btn-primary" data-action="next">${isLastStep ? 'Finish' : 'Next'}</button>
          <button class="tutorial-btn tutorial-btn-toggle" data-action="toggle-mode">${autoMode ? 'Manual' : 'Auto'}</button>
          ${autoMode && !isPaused ? '<button class="tutorial-btn tutorial-btn-warning" data-action="pause">Pause</button>' : ''}
          ${autoMode && isPaused ? '<button class="tutorial-btn tutorial-btn-success" data-action="resume">Resume</button>' : ''}
          <button class="tutorial-btn tutorial-btn-danger" data-action="stop">Exit</button>
        </div>
        <div class="tutorial-progress">
          <div class="tutorial-progress-bar" style="width: ${((currentStepIndex + 1) / proposalTutorialSteps.length) * 100}%"></div>
        </div>
        <div class="tutorial-step-info">${currentStepIndex + 1} of ${proposalTutorialSteps.length}</div>
      </div>
    `;
    
    // Position tooltip
    const rect = element.getBoundingClientRect();
    const position = step.position || 'bottom';
    
    document.body.appendChild(tooltip);
    
    const tooltipRect = tooltip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
    let top = rect.bottom + 10;
    
    switch (position) {
      case 'top':
        top = rect.top - tooltipRect.height - 10;
        break;
      case 'left':
        left = rect.left - tooltipRect.width - 10;
        top = rect.top + rect.height / 2 - tooltipRect.height / 2;
        break;
      case 'right':
        left = rect.right + 10;
        top = rect.top + rect.height / 2 - tooltipRect.height / 2;
        break;
    }
    
    // Keep tooltip in viewport
    left = Math.max(10, Math.min(left, window.innerWidth - tooltipRect.width - 10));
    top = Math.max(10, Math.min(top, window.innerHeight - tooltipRect.height - 10));
    
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    
    // Add event listeners
    tooltip.addEventListener('click', handleTooltipClick);
    
    // Highlight target element
    element.classList.add('tutorial-highlight');
    element.style.position = 'relative';
    element.style.zIndex = '10001';
  }
  
  function handleTooltipClick(event: Event) {
    const target = event.target as HTMLElement;
    const action = target.getAttribute('data-action');
    
    switch (action) {
      case 'next':
        nextStep();
        break;
      case 'previous':
        previousStep();
        break;
      case 'toggle-mode':
        autoMode = !autoMode;
        executeStep(); // Refresh tooltip
        break;
      case 'pause':
        pauseTutorial();
        executeStep(); // Refresh tooltip
        break;
      case 'resume':
        resumeTutorial();
        break;
      case 'stop':
        stopTutorial();
        break;
    }
  }
  
  function clearHighlight() {
    if (highlightElement) {
      highlightElement.classList.remove('tutorial-highlight');
      highlightElement.style.position = '';
      highlightElement.style.zIndex = '';
    }
    
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    
    if (tooltip) {
      tooltip.removeEventListener('click', handleTooltipClick);
      tooltip.remove();
      tooltip = null;
    }
  }
</script>

{#if isActive}
  <!-- Tutorial is managed through DOM manipulation for better control -->
{/if}

<style>
  :global(.tutorial-overlay) {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    z-index: 10000;
    pointer-events: none;
  }
  
  :global(.tutorial-tooltip) {
    position: fixed;
    background: white;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    padding: 20px;
    z-index: 10002;
    max-width: 350px;
    min-width: 300px;
    pointer-events: all;
    border: 2px solid #007bff;
  }
  
  :global(.tutorial-tooltip-content h3) {
    margin: 0 0 10px 0;
    color: #333;
    font-size: 18px;
  }
  
  :global(.tutorial-tooltip-content p) {
    margin: 0 0 15px 0;
    color: #666;
    line-height: 1.4;
  }
  
  :global(.tutorial-controls) {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 15px;
  }
  
  :global(.tutorial-btn) {
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
  }
  
  :global(.tutorial-btn:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  :global(.tutorial-btn-primary) {
    background: #007bff;
    color: white;
  }
  
  :global(.tutorial-btn-secondary) {
    background: #6c757d;
    color: white;
  }
  
  :global(.tutorial-btn-success) {
    background: #28a745;
    color: white;
  }
  
  :global(.tutorial-btn-warning) {
    background: #ffc107;
    color: #333;
  }
  
  :global(.tutorial-btn-danger) {
    background: #dc3545;
    color: white;
  }
  
  :global(.tutorial-btn-toggle) {
    background: #17a2b8;
    color: white;
  }
  
  :global(.tutorial-progress) {
    width: 100%;
    height: 6px;
    background: #e9ecef;
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  
  :global(.tutorial-progress-bar) {
    height: 100%;
    background: linear-gradient(90deg, #007bff, #28a745);
    transition: width 0.3s ease;
  }
  
  :global(.tutorial-step-info) {
    text-align: center;
    font-size: 12px;
    color: #666;
  }
  
  :global(.tutorial-highlight) {
    animation: tutorial-pulse 2s infinite;
    border: 3px solid #007bff !important;
    border-radius: 4px !important;
    box-shadow: 0 0 0 4px rgba(0, 123, 255, 0.3) !important;
  }
  
  :global(.tutorial-ripple) {
    position: fixed;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: rgba(0, 123, 255, 0.6);
    pointer-events: none;
    z-index: 10003;
    animation: tutorial-ripple-effect 2s ease-out;
    transform: translate(-50%, -50%);
  }
  
  @keyframes :global(tutorial-pulse) {
    0% { box-shadow: 0 0 0 4px rgba(0, 123, 255, 0.3); }
    50% { box-shadow: 0 0 0 8px rgba(0, 123, 255, 0.1); }
    100% { box-shadow: 0 0 0 4px rgba(0, 123, 255, 0.3); }
  }
  
  @keyframes :global(tutorial-ripple-effect) {
    0% {
      width: 20px;
      height: 20px;
      opacity: 1;
    }
    100% {
      width: 200px;
      height: 200px;
      opacity: 0;
    }
  }
</style>
