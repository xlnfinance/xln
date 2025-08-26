<script lang="ts">
  /**
   * 🎯 TUTORIAL LAUNCHER
   * 
   * Main entry point for tutorials - shows available tutorials and launches them
   */
  
  import { tutorialService, isActiveTutorial } from './TutorialService';
  import { allTutorials } from './TutorialSteps';
  import type { Tutorial } from './TutorialSteps';
  
  export let isVisible = false;
  
  let selectedDifficulty: 'all' | 'beginner' | 'intermediate' | 'advanced' = 'all';
  
  // Filter tutorials by difficulty
  $: filteredTutorials = selectedDifficulty === 'all' 
    ? allTutorials 
    : tutorialService.getTutorialsByDifficulty(selectedDifficulty);
  
  function startTutorial(tutorial: Tutorial) {
    tutorialService.startTutorial(tutorial.id);
    isVisible = false;
  }
  
  function closeLauncher() {
    isVisible = false;
  }
  
  function getDifficultyColor(difficulty: Tutorial['difficulty']) {
    switch (difficulty) {
      case 'beginner': return '#22c55e';
      case 'intermediate': return '#f59e0b'; 
      case 'advanced': return '#ef4444';
      default: return '#6b7280';
    }
  }
  
  function getDifficultyEmoji(difficulty: Tutorial['difficulty']) {
    switch (difficulty) {
      case 'beginner': return '🟢';
      case 'intermediate': return '🟡';
      case 'advanced': return '🔴';
      default: return '⚪';
    }
  }
  
  function getTutorialProgress(tutorialId: string): number {
    return tutorialService.getTutorialProgress(tutorialId);
  }
  
  function isTutorialCompleted(tutorialId: string): boolean {
    return tutorialService.isTutorialCompleted(tutorialId);
  }
</script>

{#if isVisible}
  <div class="tutorial-launcher-overlay">
    <div class="tutorial-launcher-backdrop" on:click={closeLauncher}></div>
    
    <div class="tutorial-launcher-panel">
      <!-- Header -->
      <div class="launcher-header">
        <div class="launcher-title">
          <h2>🎯 XLN Interactive Tutorials</h2>
          <p>Learn XLN step-by-step with guided tutorials</p>
        </div>
        <button class="launcher-close-btn" on:click={closeLauncher}>×</button>
      </div>
      
      <!-- Difficulty Filter -->
      <div class="difficulty-filter">
        <label>Filter by difficulty:</label>
        <select bind:value={selectedDifficulty} class="difficulty-select">
          <option value="all">All Tutorials</option>
          <option value="beginner">🟢 Beginner</option>
          <option value="intermediate">🟡 Intermediate</option>
          <option value="advanced">🔴 Advanced</option>
        </select>
      </div>
      
      <!-- Tutorial Grid -->
      <div class="tutorials-grid">
        {#each filteredTutorials as tutorial}
          <div class="tutorial-card" class:completed={isTutorialCompleted(tutorial.id)}>
            <!-- Tutorial Header -->
            <div class="tutorial-card-header">
              <div class="tutorial-difficulty">
                <span class="difficulty-emoji">{getDifficultyEmoji(tutorial.difficulty)}</span>
                <span class="difficulty-text">{tutorial.difficulty}</span>
              </div>
              <div class="tutorial-time">⏱️ {tutorial.estimatedTime}</div>
            </div>
            
            <!-- Tutorial Content -->
            <div class="tutorial-card-content">
              <h3 class="tutorial-card-title">{tutorial.title}</h3>
              <p class="tutorial-card-description">{tutorial.description}</p>
              
              <!-- Progress Bar -->
              {#if getTutorialProgress(tutorial.id) > 0}
                <div class="progress-container">
                  <div class="progress-bar">
                    <div 
                      class="progress-fill" 
                      style="width: {(getTutorialProgress(tutorial.id) / tutorial.steps.length) * 100}%"
                    ></div>
                  </div>
                  <span class="progress-text">
                    {getTutorialProgress(tutorial.id) + 1} / {tutorial.steps.length} steps
                  </span>
                </div>
              {/if}
            </div>
            
            <!-- Tutorial Actions -->
            <div class="tutorial-card-actions">
              <button 
                class="tutorial-start-btn" 
                class:resume={getTutorialProgress(tutorial.id) > 0}
                on:click={() => startTutorial(tutorial)}
              >
                {#if isTutorialCompleted(tutorial.id)}
                  ✅ Restart Tutorial
                {:else if getTutorialProgress(tutorial.id) > 0}
                  ▶️ Resume Tutorial
                {:else}
                  🚀 Start Tutorial
                {/if}
              </button>
              
              <div class="tutorial-steps-count">
                {tutorial.steps.length} steps
              </div>
            </div>
          </div>
        {/each}
      </div>
      
      <!-- Footer -->
      <div class="launcher-footer">
        <div class="footer-note">
          💡 Tutorials are interactive and guide you through the actual XLN interface
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .tutorial-launcher-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  
  .tutorial-launcher-backdrop {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(4px);
  }
  
  .tutorial-launcher-panel {
    position: relative;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 16px;
    box-shadow: 0 25px 80px rgba(0, 0, 0, 0.4);
    width: 100%;
    max-width: 800px;
    max-height: 90vh;
    overflow: hidden;
    animation: launcherSlideIn 0.4s ease-out;
  }
  
  @keyframes launcherSlideIn {
    from {
      opacity: 0;
      transform: translateY(-30px) scale(0.9);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  
  .launcher-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 24px 28px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }
  
  .launcher-title h2 {
    margin: 0 0 4px 0;
    font-size: 24px;
    font-weight: 700;
    color: var(--text-primary);
  }
  
  .launcher-title p {
    margin: 0;
    font-size: 14px;
    color: var(--text-secondary);
  }
  
  .launcher-close-btn {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 28px;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
    transition: color 0.2s;
  }
  
  .launcher-close-btn:hover {
    color: var(--text-primary);
  }
  
  .difficulty-filter {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px 28px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }
  
  .difficulty-filter label {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }
  
  .difficulty-select {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 14px;
    color: var(--text-primary);
    cursor: pointer;
  }
  
  .tutorials-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
    gap: 20px;
    padding: 24px 28px;
    max-height: 60vh;
    overflow-y: auto;
  }
  
  .tutorial-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 20px;
    transition: all 0.3s ease;
    cursor: pointer;
  }
  
  .tutorial-card:hover {
    border-color: var(--accent-color);
    box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
    transform: translateY(-2px);
  }
  
  .tutorial-card.completed {
    border-color: #22c55e;
    background: rgba(34, 197, 94, 0.05);
  }
  
  .tutorial-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  
  .tutorial-difficulty {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  
  .difficulty-emoji {
    font-size: 14px;
  }
  
  .difficulty-text {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
  }
  
  .tutorial-time {
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-primary);
    padding: 4px 8px;
    border-radius: 4px;
  }
  
  .tutorial-card-content {
    margin-bottom: 16px;
  }
  
  .tutorial-card-title {
    margin: 0 0 8px 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.3;
  }
  
  .tutorial-card-description {
    margin: 0 0 12px 0;
    font-size: 13px;
    line-height: 1.4;
    color: var(--text-secondary);
  }
  
  .progress-container {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }
  
  .progress-bar {
    flex: 1;
    height: 4px;
    background: var(--border-color);
    border-radius: 2px;
    overflow: hidden;
  }
  
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #22c55e, #16a34a);
    transition: width 0.3s ease;
  }
  
  .progress-text {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  
  .tutorial-card-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  
  .tutorial-start-btn {
    background: linear-gradient(135deg, var(--accent-color), var(--accent-hover));
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .tutorial-start-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
  }
  
  .tutorial-start-btn.resume {
    background: linear-gradient(135deg, #f59e0b, #d97706);
  }
  
  .tutorial-steps-count {
    font-size: 12px;
    color: var(--text-muted);
  }
  
  .launcher-footer {
    padding: 16px 28px;
    border-top: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }
  
  .footer-note {
    font-size: 13px;
    color: var(--text-secondary);
    text-align: center;
  }
</style>
