<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import TutorialSystem from './TutorialSystem.svelte';
  
  const dispatch = createEventDispatcher();
  
  export let isVisible = false;
  
  let showTutorial = false;
  let autoMode = true;
  let speed = 2000;
  
  function startTutorial(mode: 'auto' | 'manual' = 'auto') {
    autoMode = mode === 'auto';
    showTutorial = true;
  }
  
  function onTutorialEnd() {
    showTutorial = false;
    isVisible = false;
    dispatch('tutorialComplete');
  }
  
  function skipTutorial() {
    isVisible = false;
    dispatch('tutorialSkipped');
  }
</script>

<!-- Tutorial Launcher Modal -->
{#if isVisible && !showTutorial}
  <div class="tutorial-launcher-overlay" on:click={skipTutorial}>
    <div class="tutorial-launcher" on:click|stopPropagation>
    <div class="tutorial-intro">
      <h3>🎓 Learn XLN</h3>
      <p>Interactive tutorial showing how to create entities and proposals</p>
      
      <div class="tutorial-modes">
        <div class="mode-option">
          <h4>🤖 Auto Mode</h4>
          <p>AI guides you through each step automatically</p>
          <button 
            class="tutorial-btn tutorial-btn-primary" 
            on:click={() => startTutorial('auto')}
          >
            Start Auto Tutorial
          </button>
        </div>
        
        <div class="mode-option">
          <h4>👆 Manual Mode</h4>
          <p>You control the pace, click Next to advance</p>
          <button 
            class="tutorial-btn tutorial-btn-secondary" 
            on:click={() => startTutorial('manual')}
          >
            Start Manual Tutorial
          </button>
        </div>
      </div>
      
      <div class="tutorial-settings">
        <label>
          Auto Speed: 
          <select bind:value={speed}>
            <option value={1000}>Fast (1s)</option>
            <option value={2000}>Normal (2s)</option>
            <option value={3000}>Slow (3s)</option>
          </select>
        </label>
      </div>
      
      <!-- Skip button -->
      <div class="tutorial-skip">
        <button class="tutorial-btn tutorial-btn-skip" on:click={skipTutorial}>
          ❌ Skip Tutorial
        </button>
      </div>
    </div>
  </div>
</div>
{/if}

<!-- Tutorial System -->
{#if showTutorial}
  <TutorialSystem 
    isActive={showTutorial} 
    {autoMode} 
    {speed}
    on:tutorialEnd={onTutorialEnd}
  />
{/if}

<style>
  .tutorial-launcher-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  }

  .tutorial-launcher {
    position: relative;
    background: white;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    padding: 30px;
    z-index: 1000;
    max-width: 500px;
    width: 90%;
  }
  
  .tutorial-intro h3 {
    margin: 0 0 10px 0;
    color: #333;
    text-align: center;
  }
  
  .tutorial-intro > p {
    margin: 0 0 20px 0;
    color: #666;
    text-align: center;
  }
  
  .tutorial-modes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin-bottom: 20px;
  }
  
  .mode-option {
    border: 2px solid #e9ecef;
    border-radius: 8px;
    padding: 15px;
    text-align: center;
    transition: border-color 0.2s;
  }
  
  .mode-option:hover {
    border-color: #007bff;
  }
  
  .mode-option h4 {
    margin: 0 0 8px 0;
    color: #333;
    font-size: 16px;
  }
  
  .mode-option p {
    margin: 0 0 15px 0;
    color: #666;
    font-size: 14px;
    line-height: 1.4;
  }
  
  .tutorial-btn {
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    transition: all 0.2s;
    width: 100%;
  }
  
  .tutorial-btn-primary {
    background: #007bff;
    color: white;
  }
  
  .tutorial-btn-primary:hover {
    background: #0056b3;
  }
  
  .tutorial-btn-secondary {
    background: #6c757d;
    color: white;
  }
  
  .tutorial-btn-secondary:hover {
    background: #545b62;
  }

  .tutorial-btn-skip {
    background: #dc3545;
    color: white;
    margin-top: 15px;
    width: 100%;
  }

  .tutorial-btn-skip:hover {
    background: #c82333;
  }

  .tutorial-skip {
    text-align: center;
    margin-top: 20px;
    padding-top: 15px;
    border-top: 1px solid #e9ecef;
  }
  
  .tutorial-settings {
    text-align: center;
    padding-top: 15px;
    border-top: 1px solid #e9ecef;
  }
  
  .tutorial-settings label {
    color: #666;
    font-size: 14px;
  }
  
  .tutorial-settings select {
    margin-left: 8px;
    padding: 4px 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
  }
  
  @media (max-width: 600px) {
    .tutorial-modes {
      grid-template-columns: 1fr;
    }
  }
</style>