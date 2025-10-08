<script lang="ts">
  import { onMount } from 'svelte';
  import { xlnEnvironment } from '../../stores/xlnStore';

  let commandHistory: string[] = [];
  let historyIndex: number = -1;
  let currentCommand: string = '';
  let outputLines: Array<{
    timestamp: number;
    text: string;
    type: 'command' | 'output' | 'error' | 'success' | 'info' | 'step';
  }> = [];
  let outputContainer: HTMLDivElement;

  const WELCOME_BANNER = `
╔══════════════════════════════════════════════════════════════╗
║                    XLN Terminal v1.0                          ║
║          Cross-Local Network Command Interface                ║
╠══════════════════════════════════════════════════════════════╣
║  Type 'help' for available commands                          ║
║  Type 'scenario list' to see scenarios                       ║
║  Press ↑/↓ for command history                               ║
╚══════════════════════════════════════════════════════════════╝
`;

  const HELP_TEXT = `
Available Commands:

SCENARIOS:
  scenario list                  List available scenarios
  scenario load <name>           Load scenario from file
  scenario exec                  Execute loaded scenario
  scenario step                  Execute next step only

PAYMENTS:
  pay <from> <to> <amount>       Send payment
  flow <from> <to> [--tps=N]     Start payment flow

NETWORK:
  network stats                  Show network statistics
  network graph                  ASCII network visualization
  entities                       List all entities
  entity <id>                    Inspect entity details

SYSTEM:
  clear                          Clear terminal
  help                           Show this help
`;

  onMount(() => {
    addOutput(WELCOME_BANNER, 'info');
    addOutput('> Ready for commands...', 'success');
    addOutput('', 'info');

    // Auto-execute network graph on load
    setTimeout(() => {
      executeCommand('network graph');
    }, 500);
  });

  function addOutput(text: string, type: 'command' | 'output' | 'error' | 'success' | 'info' | 'step' = 'output') {
    outputLines = [...outputLines, { timestamp: Date.now(), text, type }];
    setTimeout(() => {
      if (outputContainer) {
        outputContainer.scrollTop = outputContainer.scrollHeight;
      }
    }, 50);
  }

  async function executeCommand(cmd: string) {
    if (!cmd.trim()) return;

    // Add to history
    commandHistory = [...commandHistory, cmd];
    historyIndex = commandHistory.length;

    // Show command in output
    addOutput(`$ ${cmd}`, 'command');

    const parts = cmd.trim().toLowerCase().split(/\s+/);
    const command = parts[0];
    const subcommand = parts[1];
    const args = parts.slice(2);

    try {
      if (command === 'help') {
        addOutput(HELP_TEXT, 'info');
      } else if (command === 'clear') {
        outputLines = [];
        addOutput(WELCOME_BANNER, 'info');
      } else if (command === 'scenario') {
        await handleScenarioCommand(subcommand || '', args);
      } else if (command === 'network') {
        await handleNetworkCommand(subcommand || '', args);
      } else if (command === 'entities' || command === 'entity') {
        await handleEntityCommand(subcommand || '', args);
      } else if (command === 'pay' || command === 'flow') {
        addOutput('⚠️  Payment commands coming soon...', 'info');
      } else {
        addOutput(`❌ Unknown command: ${command}`, 'error');
        addOutput(`   Type 'help' for available commands`, 'info');
      }
    } catch (error) {
      addOutput(`❌ Error: ${(error as Error).message}`, 'error');
    }

    addOutput('', 'info');
  }

  async function handleScenarioCommand(subcommand: string, _args: string[]) {
    if (subcommand === 'list') {
      addOutput('Available Scenarios:', 'info');
      addOutput('  • h-network          - H-shaped topology (2 hubs, 4 users)', 'info');
      addOutput('  • diamond-dybvig     - Bank run scenario', 'info');
      addOutput('', 'info');
    } else {
      addOutput(`⚠️  Scenario command '${subcommand}' not implemented yet`, 'info');
    }
  }

  async function handleNetworkCommand(subcommand: string, _args: string[]) {
    const env = $xlnEnvironment;
    if (!env) {
      addOutput('❌ Environment not initialized', 'error');
      return;
    }

    if (subcommand === 'stats') {
      const replicaKeys = Array.from(env.replicas.keys()) as string[];
      const entityCount = new Set(replicaKeys.map(k => k.split(':')[0])).size;
      const totalAccounts = Array.from(env.replicas.values()).reduce((sum, r: any) => sum + (r.state?.accounts?.size || 0), 0);

      addOutput('╔═══════════════════════════════════════╗', 'info');
      addOutput('║    XLN Network Statistics             ║', 'info');
      addOutput('╠═══════════════════════════════════════╣', 'success');
      addOutput(`║ Entities:       ${String(entityCount).padStart(5)}                 ║`, 'info');
      addOutput(`║ Accounts:       ${String(totalAccounts).padStart(5)}                 ║`, 'info');
      addOutput(`║ S-Block:        ${String(env.height).padStart(5)}                 ║`, 'info');
      addOutput('╚═══════════════════════════════════════╝', 'info');
    } else if (subcommand === 'graph') {
      await renderASCIIGraph();
    } else {
      addOutput(`❌ Unknown network command: ${subcommand}`, 'error');
    }
  }

  async function renderASCIIGraph() {
    const env = $xlnEnvironment;
    if (!env) {
      addOutput('❌ Environment not initialized', 'error');
      return;
    }

    // Extract entities and accounts
    const replicaKeys = Array.from(env.replicas.keys()) as string[];
    const entityIds = new Set(replicaKeys.map(k => k.split(':')[0]).filter((id): id is string => !!id));

    if (entityIds.size === 0) {
      addOutput('⚠️  No entities in network', 'info');
      return;
    }

    addOutput('', 'info');
    addOutput('╔═══════════════════════════════════════════════════════════╗', 'info');
    addOutput('║                  XLN NETWORK STATE                        ║', 'info');
    addOutput('╚═══════════════════════════════════════════════════════════╝', 'info');
    addOutput('', 'info');

    // Render each entity and its accounts using invariant ASCII style
    for (const entityId of Array.from(entityIds)) {
      const replicaEntry = Array.from(env.replicas.entries() as [string, any][]).find(([k]) => k.startsWith(entityId + ':'));
      const replica = replicaEntry?.[1];
      if (!replica) continue;

      const shortId = entityId.slice(0, 10);
      addOutput(`Entity: ${shortId}...`, 'success');

      const accounts = replica.state?.accounts;
      if (!accounts || accounts.size === 0) {
        addOutput('  └─ No accounts', 'info');
        addOutput('', 'info');
        continue;
      }

      // Render each account
      for (const [counterpartyId, accountData] of accounts.entries()) {
        const counterShort = (counterpartyId as string).slice(0, 10);
        addOutput(`  ├─ Account with ${counterShort}...`, 'info');

        // Get deltas for visualization
        const deltas = accountData.deltas;
        if (deltas && deltas.size > 0) {
          for (const [tokenId, delta] of deltas.entries()) {
            const tokenIdNum = Number(tokenId);
            const tokenSymbol = tokenIdNum === 1 ? 'ETH' : tokenIdNum === 2 ? 'USDC' : `TKN${tokenIdNum}`;

            // Derive perspective-correct values
            const leftCredit = Number(delta.leftCreditLimit) / 1e18;
            const rightCredit = Number(delta.rightCreditLimit) / 1e18;
            const collateral = Number(delta.collateral) / 1e18;
            const offdelta = Number(delta.offdelta) / 1e18;

            // Render invariant visualization
            addOutput(`  │  ${tokenSymbol}:`, 'info');

            // Calculate position on the invariant line
            const totalRange = leftCredit + collateral + rightCredit;
            const lineWidth = 40;

            let visualization = '';
            if (totalRange > 0) {
              const leftPart = Math.round((leftCredit / totalRange) * lineWidth);
              const collateralPart = Math.round((collateral / totalRange) * lineWidth);

              // Position delta
              const deltaPos = offdelta + leftCredit;
              const deltaIndex = Math.round((deltaPos / totalRange) * lineWidth);

              // Build the line
              for (let i = 0; i < lineWidth; i++) {
                if (i < leftPart) {
                  visualization += i === deltaIndex ? 'Δ' : '-';
                } else if (i < leftPart + collateralPart) {
                  visualization += i === deltaIndex ? 'Δ' : '=';
                } else {
                  visualization += i === deltaIndex ? 'Δ' : '-';
                }
              }
              visualization = `[${visualization}]`;
            } else {
              visualization = '[.Δ]';
            }

            addOutput(`  │  ${visualization}`, 'info');
            addOutput(`  │  L-Credit: ${leftCredit.toFixed(2)}  Collateral: ${collateral.toFixed(2)}  R-Credit: ${rightCredit.toFixed(2)}`, 'info');
            addOutput(`  │  Delta: ${offdelta >= 0 ? '+' : ''}${offdelta.toFixed(2)}`, offdelta > 0 ? 'success' : offdelta < 0 ? 'error' : 'info');
          }
        }
        addOutput('  │', 'info');
      }

      addOutput('', 'info');
    }
  }

  async function handleEntityCommand(subcommand: string, _args: string[]) {
    const env = $xlnEnvironment;
    if (!env) {
      addOutput('❌ Environment not initialized', 'error');
      return;
    }

    const replicaKeys = Array.from(env.replicas.keys()) as string[];
    const entityIds = new Set(replicaKeys.map(k => k.split(':')[0]).filter((id): id is string => !!id));

    if (!subcommand || subcommand === 'list') {
      addOutput(`Entities (${entityIds.size}):`, 'info');
      entityIds.forEach(id => {
        addOutput(`  🟢 ${id.slice(0, 10)}...`, 'success');
      });
    } else {
      addOutput('⚠️  Entity inspection coming soon...', 'info');
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      executeCommand(currentCommand);
      currentCommand = '';
      historyIndex = commandHistory.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (historyIndex > 0) {
        historyIndex--;
        currentCommand = commandHistory[historyIndex] || '';
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (historyIndex < commandHistory.length - 1) {
        historyIndex++;
        currentCommand = commandHistory[historyIndex] || '';
      } else {
        historyIndex = commandHistory.length;
        currentCommand = '';
      }
    }
  }
</script>

<div class="terminal-container">
  <div class="terminal-output" bind:this={outputContainer}>
    {#each outputLines as line}
      <div class="terminal-line {line.type}">
        {line.text}
      </div>
    {/each}
  </div>

  <div class="terminal-input-row">
    <span class="terminal-prompt">xln$</span>
    <input
      type="text"
      class="terminal-input"
      bind:value={currentCommand}
      on:keydown={handleKeydown}
      placeholder="enter command..."
    />
  </div>
</div>

<style>
  .terminal-container {
    width: 100%;
    height: calc(100vh - 60px);
    display: flex;
    flex-direction: column;
    background: #000000;
    font-family: 'Courier New', 'Consolas', 'Monaco', monospace;
    padding: 20px;
  }

  .terminal-output {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    background: rgba(0, 20, 0, 0.3);
    border: 1px solid rgba(0, 255, 136, 0.2);
    border-radius: 4px;
    margin-bottom: 16px;
  }

  .terminal-line {
    margin: 0;
    padding: 2px 0;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 13px;
  }

  .terminal-line.command {
    color: #00d9ff;
    font-weight: 600;
  }

  .terminal-line.output {
    color: rgba(255, 255, 255, 0.8);
  }

  .terminal-line.error {
    color: #ff4444;
    font-weight: 600;
  }

  .terminal-line.success {
    color: #00ff88;
    font-weight: 600;
  }

  .terminal-line.info {
    color: rgba(255, 255, 255, 0.5);
  }

  .terminal-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: rgba(0, 20, 0, 0.5);
    border: 2px solid rgba(0, 255, 136, 0.3);
    border-radius: 4px;
  }

  .terminal-prompt {
    color: #00ff88;
    font-weight: 600;
    font-size: 14px;
    user-select: none;
  }

  .terminal-input {
    flex: 1;
    background: transparent;
    border: none;
    color: #00d9ff;
    font-family: inherit;
    font-size: 14px;
    outline: none;
  }

  .terminal-input::placeholder {
    color: rgba(255, 255, 255, 0.2);
  }

  .terminal-output::-webkit-scrollbar {
    width: 8px;
  }

  .terminal-output::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.3);
  }

  .terminal-output::-webkit-scrollbar-thumb {
    background: rgba(0, 255, 136, 0.3);
    border-radius: 4px;
  }

  .terminal-output::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 255, 136, 0.5);
  }
</style>
