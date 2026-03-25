<script lang="ts">
  import { onMount, afterUpdate } from 'svelte';
  import type { EntityReplica, Tab } from '$lib/types/ui';

  export let replica: EntityReplica | null;
  export let tab: Tab;
  export let currentTimeIndex: number = -1; // Time machine index

  let chatContainer: HTMLDivElement;
  let shouldAutoScroll = true;
  let lastMessageCount = 0;
  let isAtCurrentTime = true;

  // Track if we're viewing current time or historical state
  $: isAtCurrentTime = currentTimeIndex === -1;
  
  // Auto-scroll to bottom when new messages arrive (only if at current time)
  afterUpdate(() => {
    if (replica?.state?.messages && chatContainer && shouldAutoScroll && isAtCurrentTime) {
      const currentMessageCount = replica.state.messages.length;
      if (currentMessageCount > lastMessageCount) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
        lastMessageCount = currentMessageCount;
      }
    }
  });

  // Handle manual scrolling - disable auto-scroll if user scrolls up
  function handleScroll() {
    if (!chatContainer) return;
    
    const { scrollTop, scrollHeight, clientHeight } = chatContainer;
    const isAtBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 10;
    shouldAutoScroll = isAtBottom;
  }

  type ParsedMessageDetails = {
    block?: string;
    tx?: string;
    entity?: string;
    balance?: string;
  };

  type ParsedMessage = {
    type: 'message' | 'j-event' | 'reserve-update';
    content: string;
    details: ParsedMessageDetails | null;
  };

  // Enhanced message parsing for better display
  function parseMessage(message: string): ParsedMessage {
    // Parse j-event messages for detailed display
    if (message.includes('observed j-event:')) {
      const match = message.match(/(\w+) observed j-event: (\w+) \(block (\d+), tx (0x\w+)\)/);
      if (match) {
        const [, observer, eventType, block, tx] = match;
        return {
          type: 'j-event',
          content: `${observer} observed J-event: ${eventType}`,
          details: {
            block: String(block),
            tx: `${String(tx).slice(0, 10)}...`,
          }
        };
      }
    }
    
    // Parse reserve updates
    if (message.includes('Reserve updated')) {
      const match = message.match(/Reserve updated for (.+?): Token (\d+) new balance is (.+)/);
      if (match) {
        const [, entity, token, balance] = match;
        return {
          type: 'reserve-update',
          content: `Reserve Updated: Token ${token}`,
          details: { 
            entity: `${String(entity).slice(0, 10)}...`,
            balance: (Number(balance) / 1e18).toFixed(4) + ' ETH'
          }
        };
      }
    }
    
    // Default message
    return {
      type: 'message',
      content: message,
      details: null
    };
  }

  onMount(() => {
    if (replica?.state?.messages) {
      lastMessageCount = replica.state.messages.length;
    }
  });
</script>

<div class="scrollable-component chat-messages" 
     id="chat-content-{tab.id}" 
     bind:this={chatContainer}
     on:scroll={handleScroll}>
  
  {#if !isAtCurrentTime}
    <div class="time-machine-indicator">
      Viewing historical state. Auto-scroll is disabled.
    </div>
  {/if}
  
  {#if replica && replica.state?.messages?.length > 0}
    {#each replica.state.messages as message, index}
      {@const parsed = parseMessage(message)}
      <div class="chat-message" class:j-event={parsed.type === 'j-event'} class:reserve-update={parsed.type === 'reserve-update'}>
        <div class="chat-meta">
          <span class="message-number">#{index + 1}</span>
          <span class="signer-id">{replica.signerId}</span>
          {#if parsed.type === 'j-event'}
            <span class="event-type">J-EVENT</span>
          {:else if parsed.type === 'reserve-update'}
            <span class="event-type">RESERVE</span>
          {/if}
        </div>
        <div class="chat-content">
          <div class="main-content">{parsed.content}</div>
          {#if parsed.details}
            <div class="event-details">
              {#if parsed.details.block}
                <span class="detail-item">Block: {parsed.details.block}</span>
              {/if}
              {#if parsed.details.tx}
                <span class="detail-item">Tx: {parsed.details.tx}</span>
              {/if}
              {#if parsed.details.entity}
                <span class="detail-item">Entity: {parsed.details.entity}</span>
              {/if}
              {#if parsed.details.balance}
                <span class="detail-item">Balance: {parsed.details.balance}</span>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/each}
  {:else}
    <div class="empty-state">No log entries yet</div>
  {/if}
</div>

<style>
  .scrollable-component {
    min-height: 220px;
    max-height: 40vh;
    overflow-y: auto;
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 60%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 55%, transparent);
  }

  .scrollable-component::-webkit-scrollbar {
    width: 6px;
  }

  .scrollable-component::-webkit-scrollbar-track {
    background: color-mix(in srgb, var(--theme-background, #09090b) 65%, transparent);
  }

  .scrollable-component::-webkit-scrollbar-thumb {
    background: var(--theme-scrollbar, #27272a);
    border-radius: 3px;
  }

  .time-machine-indicator {
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 30%, transparent);
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 10px;
    font-size: 12px;
    color: var(--theme-accent, #fbbf24);
    text-align: center;
  }

  .empty-state {
    text-align: center;
    color: var(--theme-text-muted, #71717a);
    font-style: italic;
    padding: 20px;
    font-size: 12px;
  }

  .chat-message {
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border-radius: 10px;
    padding: 10px;
    margin-bottom: 8px;
    border-left: 3px solid var(--theme-entity, #007acc);
    font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  }

  .chat-message.j-event {
    border-left-color: var(--theme-credit, #4ade80);
    background: color-mix(in srgb, var(--theme-credit, #4ade80) 8%, var(--theme-surface, #18181b));
  }

  .chat-message.reserve-update {
    border-left-color: var(--theme-accent, #fbbf24);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 8%, var(--theme-surface, #18181b));
  }

  .chat-meta {
    font-size: 11px;
    color: var(--theme-text-secondary, #a1a1aa);
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .message-number {
    color: var(--theme-text-muted, #71717a);
  }

  .signer-id {
    color: var(--theme-entity, #007acc);
    font-weight: 500;
  }

  .event-type {
    background: color-mix(in srgb, var(--theme-entity, #007acc) 18%, transparent);
    color: var(--theme-entity, #007acc);
    padding: 2px 6px;
    border-radius: 999px;
    font-weight: bold;
    font-size: 10px;
  }

  .j-event .event-type {
    background: color-mix(in srgb, var(--theme-credit, #4ade80) 18%, transparent);
    color: var(--theme-credit, #4ade80);
  }

  .reserve-update .event-type {
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 18%, transparent);
    color: var(--theme-accent, #fbbf24);
  }

  .chat-content {
    color: var(--theme-text-primary, #e4e4e7);
    font-size: 12px;
    line-height: 1.4;
  }

  .main-content {
    margin-bottom: 4px;
    font-weight: 500;
  }

  .event-details {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 11px;
    color: var(--theme-text-secondary, #a1a1aa);
  }

  .detail-item {
    background: color-mix(in srgb, var(--theme-background, #09090b) 70%, transparent);
    padding: 3px 8px;
    border-radius: 999px;
    white-space: nowrap;
  }
</style>
