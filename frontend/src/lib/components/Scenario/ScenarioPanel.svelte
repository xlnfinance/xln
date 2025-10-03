<script lang="ts">

  // Available scenarios
  const availableScenarios = [
    {
      id: 'h-network',
      name: 'H-Network (Default)',
      description: 'H-shaped network topology with 2 hubs and 4 users',
      file: 'h-network.scenario.txt'
    },
    {
      id: 'diamond-dybvig',
      name: 'Diamond-Dybvig Bank Run',
      description: 'Classic fractional reserve bank run scenario',
      file: 'diamond-dybvig.scenario.txt'
    },
  ];

  let selectedScenarioId: string = '';
  let scenarioText: string = '';
  let isLoading: boolean = false;
  let commandInput: string = '';
  let parseErrors: string[] = [];

  // Load scenario text from file
  async function loadScenario(scenarioId: string) {
    if (!scenarioId) return;

    isLoading = true;
    parseErrors = [];

    try {
      const scenario = availableScenarios.find(s => s.id === scenarioId);
      if (!scenario) {
        throw new Error(`Scenario ${scenarioId} not found`);
      }

      // Fetch the scenario file
      const response = await fetch(`/scenarios/${scenario.file}`);
      if (!response.ok) {
        throw new Error(`Failed to load scenario: ${response.statusText}`);
      }

      scenarioText = await response.text();
      console.log('📜 Loaded scenario:', scenario.name);
    } catch (error) {
      console.error('❌ Failed to load scenario:', error);
      parseErrors = [(error as Error).message];
    } finally {
      isLoading = false;
    }
  }

  // Execute scenario
  async function executeScenario() {
    if (!scenarioText.trim()) {
      parseErrors = ['No scenario loaded'];
      return;
    }

    parseErrors = [];

    try {
      // Import XLN server module (contains scenario functions)
      const serverUrl = new URL('/server.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ serverUrl);

      // Get current environment from store
      const { getEnv } = await import('$lib/stores/xlnStore');
      const env = getEnv();

      if (!env) {
        throw new Error('Environment not initialized');
      }

      // Parse scenario using XLN module
      const parsed = XLN.parseScenario(scenarioText);

      if (parsed.errors.length > 0) {
        parseErrors = parsed.errors.map((e: any) =>
          `Line ${e.lineNumber}: ${e.message}${e.context ? ` (${e.context})` : ''}`
        );
        return;
      }

      // Execute scenario
      console.log('🎬 Executing scenario...');
      const result = await XLN.executeScenario(env, parsed.scenario);

      if (result.success) {
        console.log(`✅ Scenario executed successfully! Generated ${result.framesGenerated} frames`);
      } else {
        parseErrors = result.errors.map((e: any) =>
          `t=${e.timestamp}s: ${e.error}`
        );
      }
    } catch (error) {
      console.error('❌ Scenario execution failed:', error);
      parseErrors = [(error as Error).message];
    }
  }

  // Add command to scenario
  function addCommand() {
    if (!commandInput.trim()) return;

    // Append command to scenario text
    scenarioText = scenarioText.trim() + '\n' + commandInput.trim() + '\n';
    commandInput = '';
  }

  // Handle Enter key in command input
  function handleCommandKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      addCommand();
    }
  }

  // Reactive: Load scenario when selection changes
  $: if (selectedScenarioId) {
    loadScenario(selectedScenarioId);
  }
</script>

<div class="scenario-panel">
  <!-- Header -->
  <div class="panel-header">
    <h3>🎬 Scenarios</h3>
  </div>

  <!-- Scenario Selector -->
  <div class="scenario-selector">
    <select bind:value={selectedScenarioId} class="scenario-dropdown">
      <option value="">Select scenario...</option>
      {#each availableScenarios as scenario}
        <option value={scenario.id}>{scenario.name}</option>
      {/each}
    </select>
  </div>

  <!-- Scenario Text Editor -->
  {#if scenarioText}
    <div class="scenario-editor">
      <div class="editor-header">
        <span class="editor-title">Scenario Script</span>
        <button on:click={executeScenario} class="execute-btn" disabled={isLoading}>
          {isLoading ? '⏳ Loading...' : '▶️ Execute'}
        </button>
      </div>

      <textarea
        bind:value={scenarioText}
        class="scenario-textarea"
        placeholder="Scenario script..."
        spellcheck="false"
      />

      <!-- Command Input -->
      <div class="command-input-section">
        <input
          type="text"
          bind:value={commandInput}
          on:keydown={handleCommandKeydown}
          class="command-input"
          placeholder="Type command and press Enter..."
        />
        <button on:click={addCommand} class="add-command-btn">+ Add</button>
      </div>

      <!-- Parse Errors -->
      {#if parseErrors.length > 0}
        <div class="parse-errors">
          <div class="error-header">⚠️ Errors:</div>
          {#each parseErrors as error}
            <div class="error-item">{error}</div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .scenario-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: rgba(30, 30, 30, 0.95);
    backdrop-filter: blur(10px);
    border-radius: 8px;
    overflow: hidden;
  }

  .panel-header {
    padding: 12px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(40, 40, 40, 0.8);
  }

  .panel-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #ffffff;
  }

  .scenario-selector {
    padding: 12px 16px;
  }

  .scenario-dropdown {
    width: 100%;
    padding: 8px 12px;
    background: rgba(50, 50, 50, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #ffffff;
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .scenario-dropdown:hover {
    background: rgba(60, 60, 60, 0.8);
    border-color: rgba(0, 122, 204, 0.5);
  }

  .scenario-dropdown:focus {
    outline: none;
    border-color: #007acc;
    box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
  }

  .scenario-editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
  }

  .editor-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 16px;
    background: rgba(40, 40, 40, 0.6);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .editor-title {
    font-size: 12px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.7);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .execute-btn {
    padding: 6px 12px;
    background: linear-gradient(135deg, #007acc 0%, #005a9e 100%);
    border: none;
    border-radius: 4px;
    color: #ffffff;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .execute-btn:hover:not(:disabled) {
    background: linear-gradient(135deg, #0086e6 0%, #006bb3 100%);
    box-shadow: 0 2px 8px rgba(0, 122, 204, 0.3);
  }

  .execute-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .scenario-textarea {
    flex: 1;
    padding: 12px;
    background: rgba(20, 20, 20, 0.8);
    border: none;
    color: #d4d4d4;
    font-family: 'Courier New', 'Consolas', monospace;
    font-size: 13px;
    line-height: 1.6;
    resize: none;
    overflow-y: auto;
  }

  .scenario-textarea:focus {
    outline: none;
  }

  .command-input-section {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    background: rgba(30, 30, 30, 0.9);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .command-input {
    flex: 1;
    padding: 8px 12px;
    background: rgba(50, 50, 50, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #ffffff;
    font-family: 'Courier New', 'Consolas', monospace;
    font-size: 13px;
    transition: all 0.2s ease;
  }

  .command-input:focus {
    outline: none;
    border-color: #007acc;
    box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
  }

  .add-command-btn {
    padding: 8px 16px;
    background: rgba(60, 60, 60, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #ffffff;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
  }

  .add-command-btn:hover {
    background: rgba(70, 70, 70, 0.8);
    border-color: rgba(0, 122, 204, 0.5);
  }

  .parse-errors {
    padding: 12px 16px;
    background: rgba(139, 0, 0, 0.1);
    border-top: 1px solid rgba(255, 0, 0, 0.3);
    max-height: 150px;
    overflow-y: auto;
  }

  .error-header {
    font-size: 12px;
    font-weight: 600;
    color: #ff6b6b;
    margin-bottom: 8px;
  }

  .error-item {
    font-size: 12px;
    color: #ffcccc;
    font-family: 'Courier New', 'Consolas', monospace;
    padding: 4px 0;
    border-left: 2px solid #ff6b6b;
    padding-left: 8px;
    margin-bottom: 4px;
  }

  /* Scrollbar styling */
  .scenario-textarea::-webkit-scrollbar,
  .parse-errors::-webkit-scrollbar {
    width: 8px;
  }

  .scenario-textarea::-webkit-scrollbar-track,
  .parse-errors::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
  }

  .scenario-textarea::-webkit-scrollbar-thumb,
  .parse-errors::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 4px;
  }

  .scenario-textarea::-webkit-scrollbar-thumb:hover,
  .parse-errors::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.3);
  }
</style>
