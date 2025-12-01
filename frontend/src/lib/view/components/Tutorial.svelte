<script lang="ts">
  /**
   * Interactive Tutorial Overlay
   * Guides users through first-time experience
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount, onDestroy } from 'svelte';
  import { panelBridge } from '../utils/panelBridge';

  let currentStep = 0;
  let showTutorial = false;

  const TUTORIAL_STEPS = [
    {
      target: '.architect-panel',
      title: '🎬 Welcome to XLN!',
      message: 'Click "Create Jurisdiction" to start your economy',
      position: 'center'
    },
    {
      target: '.topology-grid',
      title: '🌐 Choose Topology',
      message: 'Select STAR (USA model) for a simple Fed + 2 Banks demo',
      position: 'right'
    },
    {
      target: '.create-economy-btn',
      title: '🚀 Create Economy',
      message: 'Click to generate entities with realistic bank names',
      position: 'bottom'
    },
    {
      target: '.fps-overlay',
      title: '📊 Watch Performance',
      message: 'FPS overlay shows real-time rendering speed (target: 60+)',
      position: 'left'
    },
    {
      target: '.settings-tab',
      title: '⚙️ Customize Everything',
      message: 'Camera presets, auto-rotate, WebGPU toggle - all configurable',
      position: 'left'
    }
  ];

  // Listen for tutorial start events from Architect panel
  const unsubTutorial = panelBridge.on('tutorial:action', ({ action }) => {
    if (action === 'start') {
      showTutorial = true;
      currentStep = 0;
    }
  });

  onMount(() => {
    // Tutorial is now hidden by default
    // Users can trigger it manually via "Start Tutorial" button in Architect panel
    showTutorial = false;
  });

  onDestroy(() => {
    unsubTutorial();
  });

  function nextStep() {
    if (currentStep < TUTORIAL_STEPS.length - 1) {
      currentStep++;
    } else {
      completeTutorial();
    }
  }

  function prevStep() {
    if (currentStep > 0) {
      currentStep--;
    }
  }

  function skipTutorial() {
    showTutorial = false;
    localStorage.setItem('xln-tutorial-seen', 'true');
  }

  function completeTutorial() {
    showTutorial = false;
    localStorage.setItem('xln-tutorial-seen', 'true');
  }

  $: step = TUTORIAL_STEPS[currentStep] ?? TUTORIAL_STEPS[0];
</script>

{#if showTutorial && step}
  <div class="tutorial-overlay">
    <div class="tutorial-backdrop" on:click={skipTutorial}></div>

    <div class="tutorial-card" class:center={step.position === 'center'}>
      <div class="tutorial-header">
        <h3>{step.title}</h3>
        <button class="skip-btn" on:click={skipTutorial}>×</button>
      </div>

      <p class="tutorial-message">{step.message}</p>

      <div class="tutorial-footer">
        <span class="step-indicator">{currentStep + 1} / {TUTORIAL_STEPS.length}</span>
        <div class="tutorial-buttons">
          {#if currentStep > 0}
            <button class="nav-btn" on:click={prevStep}>← Back</button>
          {/if}
          <button class="nav-btn primary" on:click={nextStep}>
            {currentStep < TUTORIAL_STEPS.length - 1 ? 'Next →' : 'Got it!'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .tutorial-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 10000;
    pointer-events: all;
  }

  .tutorial-backdrop {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(4px);
  }

  .tutorial-card {
    position: absolute;
    background: linear-gradient(135deg, #1e1e1e, #2d2d30);
    border: 2px solid #00ff41;
    border-radius: 12px;
    padding: 24px;
    max-width: 400px;
    box-shadow:
      0 20px 60px rgba(0,0,0,0.5),
      0 0 40px rgba(0,255,65,0.2);
    animation: slideIn 0.3s ease-out;
  }

  .tutorial-card.center {
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translate(-50%, -60%);
    }
    to {
      opacity: 1;
      transform: translate(-50%, -50%);
    }
  }

  .tutorial-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .tutorial-header h3 {
    margin: 0;
    font-size: 18px;
    color: #00ff41;
    font-weight: 700;
  }

  .skip-btn {
    background: none;
    border: none;
    color: #666;
    font-size: 28px;
    cursor: pointer;
    padding: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .skip-btn:hover {
    color: #ff4646;
  }

  .tutorial-message {
    color: #ccc;
    font-size: 14px;
    line-height: 1.6;
    margin: 0 0 20px 0;
  }

  .tutorial-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .step-indicator {
    font-size: 12px;
    color: #666;
    font-weight: 600;
  }

  .tutorial-buttons {
    display: flex;
    gap: 8px;
  }

  .nav-btn {
    padding: 8px 16px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 6px;
    color: #ccc;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .nav-btn:hover {
    background: rgba(255,255,255,0.1);
    border-color: #00ff41;
  }

  .nav-btn.primary {
    background: #00ff41;
    border-color: #00ff41;
    color: #000;
  }

  .nav-btn.primary:hover {
    background: #00dd38;
    box-shadow: 0 0 20px rgba(0,255,65,0.3);
  }
</style>
