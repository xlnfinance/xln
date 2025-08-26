<script lang="ts">
  /**
   * 🎯 INTERACTIVE TUTORIAL OVERLAY
   * 
   * Provides in-app guidance that matches E2E test scenarios.
   * Users can follow along step-by-step or run automated demos.
   */
  
  import { onMount, createEventDispatcher } from 'svelte';
  
  export let isVisible = false;
  export let currentStep = 0;
  export let totalSteps = 0;
  export let tutorialData: TutorialStep[] = [];
  
  interface TutorialStep {
    title: string;
    description: string;
    explanation?: string;
    targetSelector?: string;
    action?: 'click' | 'fill' | 'select' | 'wait';
    actionData?: any;
    highlightElement?: boolean;
  }
  
  const dispatch = createEventDispatcher();
  
  let overlayElement: HTMLElement;
  let currentHighlight: HTMLElement | null = null;
  
  // Reactive current step data
  $: currentStepData = tutorialData[currentStep] || null;
  $: progress = totalSteps > 0 ? ((currentStep + 1) / totalSteps) * 100 : 0;
  
  onMount(() => {
    // Initialize tutorial system
    console.log('🎯 Tutorial overlay mounted');
  });
  
  function nextStep() {
    if (currentStep < totalSteps - 1) {
      currentStep++;
      updateHighlight();
      dispatch('stepChanged', { step: currentStep, stepData: currentStepData });
    }
  }
  
  function prevStep() {
    if (currentStep > 0) {
      currentStep--;
      updateHighlight();
      dispatch('stepChanged', { step: currentStep, stepData: currentStepData });
    }
  }
  
  function closeTutorial() {
    isVisible = false;
    clearHighlight();
    dispatch('close');
  }
  
  function executeStepAction() {
    if (!currentStepData?.targetSelector || !currentStepData?.action) return;
    
    const targetElement = document.querySelector(currentStepData.targetSelector);
    if (!targetElement) {
      console.warn(`🎯 Tutorial target not found: ${currentStepData.targetSelector}`);
      return;
    }
    
    switch (currentStepData.action) {
      case 'click':
        (targetElement as HTMLElement).click();
        break;
      case 'fill':
        if (targetElement instanceof HTMLInputElement || targetElement instanceof HTMLTextAreaElement) {
          targetElement.value = currentStepData.actionData || '';
          targetElement.dispatchEvent(new Event('input', { bubbles: true }));
        }
        break;
      case 'select':
        if (targetElement instanceof HTMLSelectElement) {
          targetElement.value = currentStepData.actionData || '';
          targetElement.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;
    }
    
    // Auto-advance after action
    setTimeout(nextStep, 1000);
  }
  
  function updateHighlight() {
    clearHighlight();
    
    if (!currentStepData?.targetSelector || !currentStepData?.highlightElement) return;
    
    const targetElement = document.querySelector(currentStepData.targetSelector) as HTMLElement;
    if (!targetElement) return;
    
    // Add highlight class
    targetElement.classList.add('tutorial-highlight');
    currentHighlight = targetElement;
    
    // Scroll into view
    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  
  function clearHighlight() {
    if (currentHighlight) {
      currentHighlight.classList.remove('tutorial-highlight');
      currentHighlight = null;
    }
  }
  
  // Watch for step changes
  $: if (isVisible && currentStepData) {
    updateHighlight();
  }
  
  // Cleanup on destroy
  function cleanup() {
    clearHighlight();
  }
</script>

<!-- Tutorial Overlay -->
{#if isVisible && currentStepData}
  <div class="tutorial-overlay" bind:this={overlayElement}>
    <!-- Backdrop -->
    <div class="tutorial-backdrop" on:click={closeTutorial}></div>
    
    <!-- Tutorial Panel -->
    <div class="tutorial-panel">
      <!-- Header -->
      <div class="tutorial-header">
        <div class="tutorial-progress-container">
          <div class="tutorial-progress-bar">
            <div class="tutorial-progress-fill" style="width: {progress}%"></div>
          </div>
          <span class="tutorial-step-counter">
            Step {currentStep + 1} of {totalSteps}
          </span>
        </div>
        <button class="tutorial-close-btn" on:click={closeTutorial}>×</button>
      </div>
      
      <!-- Content -->
      <div class="tutorial-content">
        <h3 class="tutorial-title">{currentStepData.title}</h3>
        <p class="tutorial-description">{currentStepData.description}</p>
        
        {#if currentStepData.explanation}
          <div class="tutorial-explanation">
            <span class="tutorial-explanation-icon">💡</span>
            <span>{currentStepData.explanation}</span>
          </div>
        {/if}
        
        {#if currentStepData.action && currentStepData.targetSelector}
          <div class="tutorial-action-hint">
            <button class="tutorial-action-btn" on:click={executeStepAction}>
              {#if currentStepData.action === 'click'}
                🖱️ Click for me
              {:else if currentStepData.action === 'fill'}
                ✏️ Fill for me
              {:else if currentStepData.action === 'select'}
                📋 Select for me
              {:else}
                ▶️ Do action
              {/if}
            </button>
          </div>
        {/if}
      </div>
      
      <!-- Navigation -->
      <div class="tutorial-navigation">
        <button 
          class="tutorial-nav-btn tutorial-prev-btn" 
          on:click={prevStep}
          disabled={currentStep === 0}
        >
          ← Previous
        </button>
        
        <button class="tutorial-skip-btn" on:click={closeTutorial}>
          Skip Tutorial
        </button>
        
        <button 
          class="tutorial-nav-btn tutorial-next-btn" 
          on:click={nextStep}
          disabled={currentStep >= totalSteps - 1}
        >
          {currentStep >= totalSteps - 1 ? 'Finish' : 'Next →'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .tutorial-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  
  .tutorial-backdrop {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(4px);
  }
  
  .tutorial-panel {
    position: relative;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    width: 100%;
    max-width: 500px;
    max-height: 80vh;
    overflow: hidden;
    animation: tutorialSlideIn 0.3s ease-out;
  }
  
  @keyframes tutorialSlideIn {
    from {
      opacity: 0;
      transform: translateY(-20px) scale(0.95);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  
  .tutorial-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }
  
  .tutorial-progress-container {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  
  .tutorial-progress-bar {
    flex: 1;
    height: 4px;
    background: var(--border-color);
    border-radius: 2px;
    overflow: hidden;
  }
  
  .tutorial-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #4ade80, #22c55e);
    transition: width 0.3s ease;
  }
  
  .tutorial-step-counter {
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: 500;
    white-space: nowrap;
  }
  
  .tutorial-close-btn {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 24px;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
    transition: color 0.2s;
  }
  
  .tutorial-close-btn:hover {
    color: var(--text-primary);
  }
  
  .tutorial-content {
    padding: 24px 20px;
  }
  
  .tutorial-title {
    margin: 0 0 12px 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
  }
  
  .tutorial-description {
    margin: 0 0 16px 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-secondary);
  }
  
  .tutorial-explanation {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 16px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--text-primary);
  }
  
  .tutorial-explanation-icon {
    flex-shrink: 0;
    font-size: 14px;
  }
  
  .tutorial-action-hint {
    margin-top: 16px;
  }
  
  .tutorial-action-btn {
    background: linear-gradient(135deg, #3b82f6, #1d4ed8);
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .tutorial-action-btn:hover {
    background: linear-gradient(135deg, #2563eb, #1e40af);
    transform: translateY(-1px);
  }
  
  .tutorial-navigation {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-top: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }
  
  .tutorial-nav-btn {
    background: var(--accent-color);
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .tutorial-nav-btn:hover:not(:disabled) {
    background: var(--accent-hover);
    transform: translateY(-1px);
  }
  
  .tutorial-nav-btn:disabled {
    background: var(--border-color);
    color: var(--text-muted);
    cursor: not-allowed;
    transform: none;
  }
  
  .tutorial-skip-btn {
    background: none;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .tutorial-skip-btn:hover {
    border-color: var(--text-secondary);
    color: var(--text-primary);
  }
  
  /* Global highlight style for tutorial targets */
  :global(.tutorial-highlight) {
    position: relative;
    animation: tutorialPulse 2s infinite;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.5) !important;
    border-radius: 4px !important;
    z-index: 9998 !important;
  }
  
  :global(.tutorial-highlight::before) {
    content: '';
    position: absolute;
    top: -3px;
    left: -3px;
    right: -3px;
    bottom: -3px;
    border: 2px solid #3b82f6;
    border-radius: 6px;
    animation: tutorialGlow 2s infinite;
    pointer-events: none;
  }
  
  @keyframes tutorialPulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.02); }
  }
  
  @keyframes tutorialGlow {
    0%, 100% { 
      opacity: 0.3;
      box-shadow: 0 0 20px rgba(59, 130, 246, 0.3);
    }
    50% { 
      opacity: 0.8;
      box-shadow: 0 0 30px rgba(59, 130, 246, 0.6);
    }
  }
</style>
