<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { EnvSnapshot, RuntimeReplica } from '@xln/core/api/public/runtime-module';
  import {
    CONSOLE_MAX_LOGS,
    consoleCommandCompletions,
    consoleLevelColor,
    createConsoleCommands,
    evalConsoleCommand,
    filterConsoleLogs,
    formatConsoleLogText,
    projectConsoleFrameLogs,
    type ConsoleEntry,
    type ConsoleFilterLevel,
  } from '../../../../packages/runtime-client/src/console-panel-view';

  // Props for isolated mode (passed from View.svelte)
  export let runtimeFrameEnv: Writable<RuntimeReplica | null>;
  export let runtimeFrameHistory: Writable<EnvSnapshot[]> | undefined = undefined;
  export let runtimeFrameTimeIndex: Writable<number> | undefined = undefined;

  let logs: ConsoleEntry[] = [];
  let autoScroll = true;
  let filterLevel: ConsoleFilterLevel = 'all';
  let maxLogs = CONSOLE_MAX_LOGS;
  let scrollContainer: HTMLDivElement;
  let searchText = '';
  let debouncedSearchText = ''; // Debounced version for filtering
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Load frame logs from history when timeIndex changes
  function loadFrameLogs() {
    if (!runtimeFrameHistory || !runtimeFrameTimeIndex) return;
    const history = $runtimeFrameHistory;
    const timeIndex = $runtimeFrameTimeIndex;
    if (!history || timeIndex === undefined) return;
    logs = projectConsoleFrameLogs(history, timeIndex, { maxLogs });
    if (autoScroll && scrollContainer) {
      setTimeout(() => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }, 50);
    }
  }

  // React to history changes
  $: if (runtimeFrameHistory && runtimeFrameTimeIndex && ($runtimeFrameHistory || $runtimeFrameTimeIndex !== undefined)) {
    loadFrameLogs();
  }

  // Command REPL
  let commandInput = '';
  let commandHistory: string[] = [];
  let historyIndex = -1;

  function clearLogs() {
    logs = [];
  }

  function copyToClipboard() {
    navigator.clipboard.writeText(formatConsoleLogText(filteredLogs));
  }

  function downloadLogs() {
    const blob = new Blob([formatConsoleLogText(filteredLogs)], { type: 'text/plain' });
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

  $: filteredLogs = filterConsoleLogs(logs, filterLevel, debouncedSearchText);

  // Command executor over the shared whitelist REPL
  const commands = createConsoleCommands({
    readEnv: () => $runtimeFrameEnv,
    clear: () => clearLogs(),
  });

  function executeCommand(cmd: string) {
    // Add to history
    commandHistory = [...commandHistory, cmd];
    historyIndex = -1;

    // Echo command
    console.log(`> ${cmd}`);

    try {
      const result = evalConsoleCommand(commands, cmd);
      if (result !== undefined) {
        console.log(result);
      }
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }

    commandInput = '';
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
      const matches = consoleCommandCompletions(commandInput);
      if (matches.length === 1) {
        commandInput = matches[0] + '(';
      } else if (matches.length > 1) {
        console.log(`Suggestions: ${matches.join(', ')}`);
      }
      e.preventDefault();
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
      <div class="log-entry" style="--level-color: {consoleLevelColor(log.level)}">
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
