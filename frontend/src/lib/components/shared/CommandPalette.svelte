<!--
  CommandPalette.svelte — ⌘K / Ctrl+K quick command interface

  Supports:
  - pay 100 usdc to @name     → instant payment
  - swap 0.5 weth for usdc    → navigate to swap with prefill
  - open H2                   → open account with hub
  - send 50 usdc to 0x...     → direct payment by address
  - balance / bal              → show balances
  - settings                   → open settings tab

  Case insensitive. Fuzzy entity name matching.
-->
<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import { fly, fade } from 'svelte/transition';

  export let isOpen = false;

  const dispatch = createEventDispatcher<{
    close: void;
    command: { type: string; args: Record<string, unknown> };
  }>();

  let inputValue = '';
  let inputEl: HTMLInputElement;
  let selectedIndex = 0;

  type Suggestion = {
    id: string;
    icon: string;
    label: string;
    sublabel: string;
    action: () => void;
  };

  $: suggestions = buildSuggestions(inputValue, $xlnEnvironment, $xlnFunctions);

  function buildSuggestions(query: string, env: any, fns: any): Suggestion[] {
    if (!query.trim()) return defaultSuggestions(env, fns);
    const q = query.trim().toLowerCase();
    const results: Suggestion[] = [];

    // pay <amount> <token> to <name>
    const payMatch = q.match(/^pay\s+(\d+(?:\.\d+)?)\s*(\w+)?\s*(?:to\s+)?@?(.+)?$/i);
    if (payMatch) {
      const amount = payMatch[1] || '';
      const token = (payMatch[2] || 'usdc').toUpperCase();
      const recipient = payMatch[3]?.trim() || '';
      if (recipient) {
        const matches = findEntities(recipient, env);
        for (const m of matches.slice(0, 3)) {
          results.push({
            id: `pay-${m.id}`,
            icon: '↗',
            label: `Pay ${amount} ${token} to ${m.name}`,
            sublabel: `Send via bilateral channel`,
            action: () => dispatch('command', { type: 'pay', args: { amount, token, recipientId: m.id, recipientName: m.name } }),
          });
        }
      }
      if (results.length === 0) {
        results.push({
          id: 'pay-hint',
          icon: '↗',
          label: `Pay ${amount} ${token}${recipient ? ` to ${recipient}` : ''}`,
          sublabel: recipient ? 'No matching entity found' : 'Add recipient: pay 100 usdc to @name',
          action: () => {},
        });
      }
    }

    // swap <amount> <token> for <token>
    const swapMatch = q.match(/^swap\s+(\d+(?:\.\d+)?)\s*(\w+)?\s*(?:for|to|->|→)\s*(\w+)?/i);
    if (swapMatch) {
      const amount = swapMatch[1] || '';
      const fromToken = (swapMatch[2] || 'usdc').toUpperCase();
      const toToken = (swapMatch[3] || 'weth').toUpperCase();
      results.push({
        id: 'swap',
        icon: '⇄',
        label: `Swap ${amount} ${fromToken} → ${toToken}`,
        sublabel: 'Open swap panel with prefilled amounts',
        action: () => dispatch('command', { type: 'swap', args: { amount, fromToken, toToken } }),
      });
    }

    // open <hub>
    const openMatch = q.match(/^open\s+(.+)/i);
    if (openMatch) {
      const hubQuery = openMatch[1].trim();
      const matches = findEntities(hubQuery, env);
      for (const m of matches.slice(0, 3)) {
        results.push({
          id: `open-${m.id}`,
          icon: '+',
          label: `Open account with ${m.name}`,
          sublabel: m.id.slice(0, 10) + '...',
          action: () => dispatch('command', { type: 'open', args: { entityId: m.id, name: m.name } }),
        });
      }
    }

    // balance / bal
    if (/^bal(ance)?$/i.test(q)) {
      results.push({
        id: 'balance',
        icon: '$',
        label: 'Show balances',
        sublabel: 'Switch to Assets tab',
        action: () => dispatch('command', { type: 'navigate', args: { tab: 'assets' } }),
      });
    }

    // settings
    if (/^set(tings)?$/i.test(q)) {
      results.push({
        id: 'settings',
        icon: '⚙',
        label: 'Open Settings',
        sublabel: 'Wallet, appearance, J-machines',
        action: () => dispatch('command', { type: 'navigate', args: { tab: 'settings' } }),
      });
    }

    // Fallback: search entities by name
    if (results.length === 0 && q.length >= 2) {
      const matches = findEntities(q, env);
      for (const m of matches.slice(0, 5)) {
        results.push({
          id: `entity-${m.id}`,
          icon: '◉',
          label: m.name,
          sublabel: `${m.id.slice(0, 10)}... · ${m.isHub ? 'Hub' : 'Entity'}`,
          action: () => dispatch('command', { type: 'explore', args: { entityId: m.id } }),
        });
      }
    }

    return results;
  }

  function defaultSuggestions(env: any, fns: any): Suggestion[] {
    return [
      { id: 'pay', icon: '↗', label: 'Pay', sublabel: 'pay 100 usdc to @name', action: () => { inputValue = 'pay '; } },
      { id: 'swap', icon: '⇄', label: 'Swap', sublabel: 'swap 0.5 weth for usdc', action: () => { inputValue = 'swap '; } },
      { id: 'balance', icon: '$', label: 'Balances', sublabel: 'View your assets', action: () => dispatch('command', { type: 'navigate', args: { tab: 'assets' } }) },
      { id: 'settings', icon: '⚙', label: 'Settings', sublabel: 'Wallet & appearance', action: () => dispatch('command', { type: 'navigate', args: { tab: 'settings' } }) },
    ];
  }

  function findEntities(query: string, env: any): Array<{ id: string; name: string; isHub: boolean }> {
    const results: Array<{ id: string; name: string; isHub: boolean }> = [];
    if (!env) return results;
    const q = query.toLowerCase();
    const seen = new Set<string>();

    // Search gossip profiles (validated entries in gossip layer)
    const gossipLayer = env.gossip;
    const profiles = gossipLayer?.validatedProfiles ?? gossipLayer?.profiles;
    if (profiles instanceof Map) {
      for (const [, profile] of profiles) {
        const name = String(profile?.name || profile?.metadata?.name || '').trim();
        const entityId = String(profile?.entityId || '').trim().toLowerCase();
        if (!name || !entityId || seen.has(entityId)) continue;
        if (name.toLowerCase().includes(q) || entityId.includes(q)) {
          seen.add(entityId);
          results.push({ id: entityId, name, isHub: profile?.metadata?.isHub === true });
        }
      }
    } else if (Array.isArray(profiles)) {
      for (const profile of profiles) {
        const name = String(profile?.name || profile?.metadata?.name || '').trim();
        const entityId = String(profile?.entityId || '').trim().toLowerCase();
        if (!name || !entityId || seen.has(entityId)) continue;
        if (name.toLowerCase().includes(q) || entityId.includes(q)) {
          seen.add(entityId);
          results.push({ id: entityId, name, isHub: profile?.metadata?.isHub === true });
        }
      }
    }

    // Search local replicas (always available)
    if (env.eReplicas instanceof Map) {
      for (const [key, replica] of env.eReplicas) {
        const entityId = String(key).split(':')[0]?.trim().toLowerCase() || '';
        if (!entityId || seen.has(entityId)) continue;
        const state = (replica as any)?.state;
        const profile = state?.profile;
        const name = String(profile?.name || profile?.metadata?.name || state?.entityId?.slice(0, 8) || entityId.slice(0, 8));
        if (name.toLowerCase().includes(q) || entityId.includes(q)) {
          seen.add(entityId);
          results.push({ id: entityId, name, isHub: false });
        }
      }
    }

    // Sort: exact prefix match first, then includes
    results.sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      return a.name.localeCompare(b.name);
    });

    return results;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = suggestions[selectedIndex];
      if (selected) {
        selected.action();
        if (selected.id !== 'pay' && selected.id !== 'swap') close();
      }
      return;
    }
  }

  function close() {
    isOpen = false;
    inputValue = '';
    selectedIndex = 0;
    dispatch('close');
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
      // Don't intercept when user is typing in an input/textarea/contenteditable
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase() || '';
      if (!isOpen && (tagName === 'input' || tagName === 'textarea' || target?.isContentEditable)) {
        return; // Let native Cmd+K work in text fields
      }
      event.preventDefault();
      if (isOpen) {
        close();
      } else {
        isOpen = true;
        requestAnimationFrame(() => inputEl?.focus());
      }
    }
  }

  $: if (inputValue !== undefined) selectedIndex = 0;

  onMount(() => {
    window.addEventListener('keydown', handleGlobalKeydown);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleGlobalKeydown);
  });

  $: if (isOpen) {
    requestAnimationFrame(() => inputEl?.focus());
  }
</script>

{#if isOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="palette-backdrop" transition:fade={{ duration: 150 }} on:click={close} role="presentation">
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="palette" transition:fly={{ y: -20, duration: 200 }} on:click|stopPropagation role="dialog" aria-label="Command palette">
      <div class="palette-input-wrap">
        <span class="palette-icon">⌘</span>
        <input
          bind:this={inputEl}
          bind:value={inputValue}
          class="palette-input"
          type="text"
          placeholder="Type a command... pay, swap, open, balance"
          spellcheck="false"
          autocomplete="off"
          on:keydown={handleKeydown}
          data-testid="command-palette-input"
        />
        <kbd class="palette-kbd">ESC</kbd>
      </div>
      {#if suggestions.length > 0}
        <ul class="palette-results">
          {#each suggestions as suggestion, i (suggestion.id)}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <li
              class="palette-result"
              class:selected={i === selectedIndex}
              on:click={() => { suggestion.action(); if (suggestion.id !== 'pay' && suggestion.id !== 'swap') close(); }}
              on:mouseenter={() => selectedIndex = i}
              role="option"
              aria-selected={i === selectedIndex}
            >
              <span class="result-icon">{suggestion.icon}</span>
              <div class="result-text">
                <span class="result-label">{suggestion.label}</span>
                <span class="result-sublabel">{suggestion.sublabel}</span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    z-index: 9999;
    display: flex;
    justify-content: center;
    padding-top: min(20vh, 120px);
  }

  .palette {
    width: min(560px, 90vw);
    max-height: min(420px, 60vh);
    background: #1a1a1e;
    border: 1px solid #2f2f35;
    border-radius: 14px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .palette-input-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid #27272a;
  }

  .palette-icon {
    color: #52525b;
    font-size: 16px;
    flex-shrink: 0;
  }

  .palette-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: #f3f4f6;
    font-size: 15px;
    font-family: inherit;
    caret-color: #fbbf24;
  }

  .palette-input::placeholder {
    color: #52525b;
  }

  .palette-kbd {
    font-size: 10px;
    color: #52525b;
    background: #27272a;
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid #3f3f46;
    font-family: 'JetBrains Mono', monospace;
    flex-shrink: 0;
  }

  .palette-results {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
  }

  .palette-result {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.1s ease;
  }

  .palette-result.selected {
    background: rgba(251, 191, 36, 0.08);
  }

  .palette-result:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .result-icon {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 7px;
    background: #27272a;
    color: #a1a1aa;
    font-size: 14px;
    flex-shrink: 0;
  }

  .palette-result.selected .result-icon {
    background: rgba(251, 191, 36, 0.15);
    color: #fbbf24;
  }

  .result-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .result-label {
    color: #e5e7eb;
    font-size: 13px;
    font-weight: 500;
  }

  .result-sublabel {
    color: #52525b;
    font-size: 11px;
    margin-top: 1px;
  }
</style>
