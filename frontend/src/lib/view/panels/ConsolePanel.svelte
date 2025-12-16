<script lang="ts">
  import { onMount } from 'svelte';
  import type { Writable } from 'svelte/store';

  // Props for isolated mode (passed from View.svelte)
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]> | undefined = undefined;
  export let isolatedTimeIndex: Writable<number> | undefined = undefined;

  interface ConsoleEntry {
    id: number;
    timestamp: string;
    level: 'debug' | 'log' | 'info' | 'warn' | 'error';
    message: string;
    stack: string | undefined;
  }

  let logs: ConsoleEntry[] = [];
  let logId = 0;
  let autoScroll = true;
  let filterLevel: 'all' | 'debug' | 'log' | 'warn' | 'error' = 'all';
  let maxLogs = 500;
  let scrollContainer: HTMLDivElement;
  let mirrorToDevTools = true; // Toggle for sending to browser console
  let searchText = '';
  let debouncedSearchText = ''; // Debounced version for filtering
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Load frame logs from history when timeIndex changes
  function loadFrameLogs() {
    if (!isolatedHistory || !isolatedTimeIndex) return;
    const history = $isolatedHistory;
    const idx = $isolatedTimeIndex;
    if (!history || history.length === 0 || idx === undefined) return;

    // Get all frame logs up to current index
    const allLogs: ConsoleEntry[] = [];
    const endIdx: number = idx >= 0 ? idx : history.length - 1;

    for (let i = 0; i <= endIdx && i < history.length; i++) {
      const frame = history[i];
      const frameLogs = frame?.logs || frame?.frameLogs || [];
      for (const flog of frameLogs) {
        allLogs.push({
          id: logId++,
          timestamp: new Date(flog.timestamp).toLocaleTimeString('en-US', {
            hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
          }),
          level: flog.level === 'debug' ? 'debug' : flog.level === 'warn' ? 'warn' : flog.level === 'error' ? 'error' : 'log',
          message: `[F${i}] ${flog.message}`,
          stack: undefined
        });
      }
    }
    logs = allLogs.slice(-maxLogs);

    if (autoScroll && scrollContainer) {
      setTimeout(() => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }, 50);
    }
  }

  // React to history changes
  $: if (isolatedHistory && isolatedTimeIndex && ($isolatedHistory || $isolatedTimeIndex !== undefined)) {
    loadFrameLogs();
  }

  // RAF-batched logging to break Svelte reactivity loops
  let pendingLogs: ConsoleEntry[] = [];
  let rafScheduled = false;

  // Command REPL
  let commandInput = '';
  let commandHistory: string[] = [];
  let historyIndex = -1;
  let commandInputEl: HTMLInputElement;
  let suggestions: string[] = [];

  // Intercept console methods
  const originalConsole = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  function formatTimestamp(): string {
    const now = new Date();
    return now.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3
    });
  }

  function flushPendingLogs() {
    if (pendingLogs.length === 0) return;
    logs = [...logs, ...pendingLogs].slice(-maxLogs);
    pendingLogs = [];
    rafScheduled = false;

    if (autoScroll && scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }

  function addLog(level: ConsoleEntry['level'], args: any[]) {
    // Format message synchronously (no Svelte reactivity)
    const message = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, (key, value) =>
            typeof value === 'bigint' ? `BigInt(${value})` : value, 2
          );
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');

    // Push to pending queue (non-reactive)
    pendingLogs.push({
      id: logId++,
      timestamp: formatTimestamp(),
      level,
      message,
      stack: args.find(arg => arg instanceof Error)?.stack
    });

    // Schedule ONE RAF update to flush all pending logs
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(flushPendingLogs);
    }
  }

  // DISABLED - Console intercept causes infinite loops with EntityPanelWrapper
  // TODO: Fix reactivity loop before re-enabling
  // onMount(() => {
  //   console.debug = (...args) => {
  //     if (mirrorToDevTools) originalConsole.debug(...args);
  //     addLog('debug', args);
  //   };
  //   // ... etc
  // });

  function clearLogs() {
    logs = [];
  }

  function copyToClipboard() {
    const text = filteredLogs.map(log =>
      `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`
    ).join('\n');
    navigator.clipboard.writeText(text);
  }

  function downloadLogs() {
    const text = filteredLogs.map(log =>
      `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`
    ).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `console-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Debounce search input (300ms delay)
  $: {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      debouncedSearchText = searchText;
    }, 300);
  }

  $: filteredLogs = logs
    .filter(log => filterLevel === 'all' || log.level === filterLevel)
    .filter(log => !debouncedSearchText || log.message.toLowerCase().includes(debouncedSearchText.toLowerCase()));

  // Command executor
  const commands = {
    help: (cmd?: string) => {
      if (cmd && commands[cmd as keyof typeof commands]) {
        return commandHelp[cmd as keyof typeof commandHelp] || 'No help available';
      }
      return `Available commands:\n${Object.keys(commands).map(c => `  ${c}`).join('\n')}\nType help(commandName) for details`;
    },
    clear: () => { clearLogs(); return 'Console cleared'; },

    // Runtime inspection
    state: () => {
      const env = $isolatedEnv;
      return {
        entities: Object.keys(env.eReplicas || {}).length,
        height: env.height,
        timestamp: env.timestamp
      };
    },

    entities: () => {
      const env = $isolatedEnv;
      return Object.keys(env.eReplicas || {});
    },

    inspect: (entityId: string) => {
      const env = $isolatedEnv;
      const replica = env.eReplicas?.[entityId];
      if (!replica) return `Entity ${entityId} not found`;
      return replica;
    },

    // Scenario control
    scenario: {
      load: (name: string) => {
        return `Loading scenario: ${name} (not yet implemented)`;
      },
      list: () => ['simnet-grid', 'diamond-dybvig', 'phantom-grid', 'corporate-treasury']
    }
  };

  const commandHelp: Record<string, string> = {
    help: 'help(command?) - Show available commands or help for specific command',
    clear: 'clear() - Clear console output',
    state: 'state() - Show current runtime state (entities count, height, timestamp)',
    entities: 'entities() - List all entity IDs',
    inspect: 'inspect(entityId) - Show detailed entity state',
    scenario: 'scenario.load(name) | scenario.list() - Load or list scenarios'
  };

  function executeCommand(cmd: string) {
    // Add to history
    commandHistory = [...commandHistory, cmd];
    historyIndex = -1;

    // Echo command
    console.log(`> ${cmd}`);

    try {
      // Simple parser - support function calls and property access
      const result = evalCommand(cmd);
      if (result !== undefined) {
        console.log(result);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
    }

    commandInput = '';
  }

  function evalCommand(cmd: string): any {
    // Whitelist-based eval - no actual eval()
    const trimmed = cmd.trim();

    // Handle help() specially
    if (trimmed.match(/^help\(\s*['"]?(\w+)?['"]?\s*\)$/)) {
      const match = trimmed.match(/^help\(\s*['"]?(\w+)?['"]?\s*\)$/);
      return commands.help(match?.[1]);
    }

    // Handle clear()
    if (trimmed === 'clear()') {
      return commands.clear();
    }

    // Handle state()
    if (trimmed === 'state()') {
      return commands.state();
    }

    // Handle entities()
    if (trimmed === 'entities()') {
      return commands.entities();
    }

    // Handle inspect(entityId)
    const inspectMatch = trimmed.match(/^inspect\(['"](.+)['"]\)$/);
    if (inspectMatch && inspectMatch[1]) {
      return commands.inspect(inspectMatch[1]);
    }

    // Handle scenario.load(name)
    const scenarioMatch = trimmed.match(/^scenario\.load\(['"](.+)['"]\)$/);
    if (scenarioMatch && scenarioMatch[1]) {
      return commands.scenario.load(scenarioMatch[1]);
    }

    // Handle scenario.list()
    if (trimmed === 'scenario.list()') {
      return commands.scenario.list();
    }

    throw new Error(`Unknown command: ${trimmed}. Type help() for available commands.`);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      if (commandInput.trim()) {
        executeCommand(commandInput);
      }
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      if (commandHistory.length > 0) {
        if (historyIndex === -1) {
          historyIndex = commandHistory.length - 1;
        } else if (historyIndex > 0) {
          historyIndex--;
        }
        const historyCmd = commandHistory[historyIndex];
        if (historyCmd !== undefined) {
          commandInput = historyCmd;
        }
      }
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (historyIndex !== -1) {
        if (historyIndex < commandHistory.length - 1) {
          historyIndex++;
          const historyCmd = commandHistory[historyIndex];
          if (historyCmd !== undefined) {
            commandInput = historyCmd;
          }
        } else {
          historyIndex = -1;
          commandInput = '';
        }
      }
      e.preventDefault();
    } else if (e.key === 'Tab') {
      // Basic autocomplete
      const partial = commandInput.trim();
      const matches = Object.keys(commands).filter(c => c.startsWith(partial));
      if (matches.length === 1) {
        commandInput = matches[0] + '(';
      } else if (matches.length > 1) {
        console.log(`Suggestions: ${matches.join(', ')}`);
      }
      e.preventDefault();
    }
  }

  function getLevelColor(level: ConsoleEntry['level']): string {
    switch (level) {
      case 'debug': return '#888';
      case 'log': return '#ccc';
      case 'info': return '#4a9eff';
      case 'warn': return '#ff9800';
      case 'error': return '#f44336';
    }
  }
</script>

<div class="console-panel">
  <div class="console-header">
    <h3> Console</h3>
    <div class="console-controls">
      <input
        type="text"
        placeholder="Search..."
        bind:value={searchText}
        class="search-input"
      />
      <select bind:value={filterLevel}>
        <option value="all">All ({logs.length})</option>
        <option value="debug">Debug</option>
        <option value="log">Log</option>
        <option value="warn">Warn ({logs.filter(l => l.level === 'warn').length})</option>
        <option value="error">Error ({logs.filter(l => l.level === 'error').length})</option>
      </select>
      <label title="Also send logs to browser DevTools (F12)">
        <input type="checkbox" bind:checked={mirrorToDevTools} />
        DevTools
      </label>
      <label>
        <input type="checkbox" bind:checked={autoScroll} />
        Auto-scroll
      </label>
      <button on:click={copyToClipboard} title="Copy filtered logs to clipboard">Copy</button>
      <button on:click={downloadLogs} title="Download filtered logs as .txt">Download</button>
      <button on:click={clearLogs}>Clear</button>
    </div>
  </div>

  <div class="console-logs" bind:this={scrollContainer}>
    {#each filteredLogs as log (log.id)}
      <div class="log-entry" style="--level-color: {getLevelColor(log.level)}">
        <span class="log-timestamp">{log.timestamp}</span>
        <span class="log-level">[{log.level.toUpperCase()}]</span>
        <span class="log-message">{log.message}</span>
        {#if log.stack}
          <details class="log-stack">
            <summary>Stack trace</summary>
            <pre>{log.stack}</pre>
          </details>
        {/if}
      </div>
    {/each}
    {#if filteredLogs.length === 0}
      <div class="empty-state">Type help() to get started</div>
    {/if}
  </div>

  <div class="command-input-container">
    <span class="prompt">></span>
    <input
      bind:this={commandInputEl}
      bind:value={commandInput}
      on:keydown={handleKeyDown}
      class="command-input"
      placeholder="Type help() for commands..."
      autocomplete="off"
      spellcheck="false"
    />
  </div>
</div>

<style>
  .console-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #1a1a1a;
    color: #e0e0e0;
    font-family: 'Courier New', monospace;
  }

  .console-header {
    padding: 12px;
    background: #252525;
    border-bottom: 1px solid #333;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }

  .console-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .console-controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .console-controls .search-input {
    padding: 4px 8px;
    background: #2a2a2a;
    border: 1px solid #444;
    color: #e0e0e0;
    border-radius: 3px;
    font-size: 12px;
    width: 150px;
  }

  .console-controls .search-input:focus {
    outline: none;
    border-color: #4a9eff;
    background: #333;
  }

  .console-controls select,
  .console-controls button {
    padding: 4px 8px;
    background: #333;
    border: 1px solid #444;
    color: #e0e0e0;
    border-radius: 3px;
    font-size: 12px;
    cursor: pointer;
  }

  .console-controls select:hover,
  .console-controls button:hover {
    background: #3a3a3a;
  }

  .console-controls label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }

  .console-logs {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    font-size: 12px;
    line-height: 1.5;
  }

  .log-entry {
    padding: 4px 8px;
    margin-bottom: 2px;
    border-left: 3px solid var(--level-color);
    background: rgba(255, 255, 255, 0.02);
    word-wrap: break-word;
  }

  .log-entry:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .log-timestamp {
    color: #666;
    margin-right: 8px;
  }

  .log-level {
    color: var(--level-color);
    font-weight: 600;
    margin-right: 8px;
  }

  .log-message {
    color: #e0e0e0;
  }

  .log-stack {
    margin-top: 4px;
    margin-left: 20px;
  }

  .log-stack summary {
    cursor: pointer;
    color: #888;
    font-size: 11px;
  }

  .log-stack pre {
    margin: 4px 0 0 0;
    padding: 8px;
    background: #0a0a0a;
    border: 1px solid #333;
    border-radius: 3px;
    font-size: 10px;
    overflow-x: auto;
  }

  .empty-state {
    text-align: center;
    padding: 40px;
    color: #666;
  }

  .command-input-container {
    display: flex;
    align-items: center;
    padding: 8px;
    background: #0a0a0a;
    border-top: 1px solid #333;
    flex-shrink: 0;
  }

  .command-input-container .prompt {
    color: #4a9eff;
    font-weight: bold;
    margin-right: 8px;
    font-size: 14px;
  }

  .command-input {
    flex: 1;
    background: transparent;
    border: none;
    color: #e0e0e0;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    outline: none;
    padding: 4px;
  }

  .command-input::placeholder {
    color: #555;
  }

  /* VR-friendly styling */
  @media (hover: none) {
    .console-panel {
      font-size: 16px;
    }
    .log-entry {
      padding: 8px 12px;
      font-size: 14px;
    }
    .command-input {
      font-size: 16px;
    }
  }
</style>
