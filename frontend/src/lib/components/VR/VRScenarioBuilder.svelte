<script lang="ts">
  export let isVRActive: boolean = false;

  let selectedTool: 'hammer' | 'healer' | 'spawner' | null = null;

  interface VRTool {
    id: 'hammer' | 'healer' | 'spawner';
    name: string;
    icon: string;
    description: string;
    color: string;
  }

  const vrTools: VRTool[] = [
    {
      id: 'hammer',
      name: '⚖️ Dispute Hammer',
      icon: '🔨',
      description: 'Punch accounts to dispute and fragment network',
      color: '#ff4444'
    },
    {
      id: 'healer',
      name: '💚 Network Healer',
      icon: '🩹',
      description: 'Restore disputed accounts and heal network',
      color: '#00ff88'
    },
    {
      id: 'spawner',
      name: '✨ Entity Spawner',
      icon: '➕',
      description: 'Place new entities in 3D space',
      color: '#00ccff'
    }
  ];

  function selectTool(toolId: typeof selectedTool) {
    selectedTool = toolId;
    console.log(`🎮 VR Tool selected: ${toolId}`);
  }

  async function quickSpawnGrid() {
    // Trigger grid 2 2 2 via command
    console.log('🎲 Quick spawn: Grid 2x2x2');
    // TODO: Implement grid spawn
  }

  async function quickPaymentWave() {
    console.log('💸 Quick payment wave triggered');
  }
</script>

{#if isVRActive}
<div class="vr-scenario-builder">
  <h3>🎮 VR Scenario Builder</h3>

  <div class="tool-selection">
    <h4>Select Tool:</h4>
    {#each vrTools as tool}
      <button
        class="tool-btn"
        class:active={selectedTool === tool.id}
        on:click={() => selectTool(tool.id)}
        style="border-color: {tool.color};"
      >
        <span class="tool-icon">{tool.icon}</span>
        <span class="tool-name">{tool.name}</span>
        <div class="tool-desc">{tool.description}</div>
      </button>
    {/each}
  </div>

  <div class="quick-actions">
    <h4>Quick Actions:</h4>
    <button class="action-btn" on:click={quickSpawnGrid}>
      🎲 Spawn Grid 2x2x2
    </button>
    <button class="action-btn" on:click={quickPaymentWave}>
      💸 Payment Wave
    </button>
  </div>

  <div class="active-tool-info">
    {#if selectedTool}
      <div class="info-box" style="border-color: {vrTools.find(t => t.id === selectedTool)?.color};">
        ✓ Active: <strong>{vrTools.find(t => t.id === selectedTool)?.name}</strong>
      </div>
    {:else}
      <div class="info-box">
        Select a tool to begin
      </div>
    {/if}
  </div>
</div>
{/if}

<style>
  .vr-scenario-builder {
    background: rgba(0, 0, 0, 0.5);
    border: 2px solid rgba(0, 255, 136, 0.4);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }

  .vr-scenario-builder h3 {
    margin: 0 0 16px 0;
    color: #00ff88;
    font-size: 16px;
    font-weight: bold;
  }

  .vr-scenario-builder h4 {
    margin: 12px 0 8px 0;
    color: #cccccc;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .tool-selection {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }

  .tool-btn {
    background: rgba(0, 0, 0, 0.6);
    border: 2px solid #555;
    border-radius: 6px;
    padding: 12px;
    color: white;
    cursor: pointer;
    transition: all 0.2s ease;
    text-align: left;
  }

  .tool-btn:hover {
    background: rgba(0, 0, 0, 0.8);
    transform: translateX(4px);
  }

  .tool-btn.active {
    background: rgba(0, 255, 136, 0.2);
    border-width: 3px;
    box-shadow: 0 0 12px rgba(0, 255, 136, 0.4);
  }

  .tool-icon {
    font-size: 24px;
    margin-right: 8px;
  }

  .tool-name {
    font-weight: bold;
    font-size: 14px;
  }

  .tool-desc {
    font-size: 11px;
    color: #999;
    margin-top: 4px;
  }

  .quick-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 16px;
  }

  .action-btn {
    background: rgba(0, 122, 204, 0.2);
    border: 1px solid rgba(0, 122, 204, 0.5);
    border-radius: 4px;
    padding: 10px;
    color: #00aaff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .action-btn:hover {
    background: rgba(0, 122, 204, 0.4);
    box-shadow: 0 0 8px rgba(0, 122, 204, 0.5);
  }

  .active-tool-info {
    padding: 12px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 4px;
  }

  .info-box {
    color: #cccccc;
    font-size: 12px;
    border-left: 3px solid #555;
    padding-left: 8px;
  }

  .info-box strong {
    color: #ffffff;
  }
</style>
