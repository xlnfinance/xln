<script lang="ts">
  import { onMount, afterUpdate } from 'svelte';
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import { getXLN } from '../../stores/xlnStore';
  import { Send } from 'lucide-svelte';

  export let replica: EntityReplica | null;
  export let tab: Tab;
  export let currentTimeIndex: number = -1; // Time machine index

  let chatContainer: HTMLDivElement;
  let shouldAutoScroll = true;
  let lastMessageCount = 0;
  let isAtCurrentTime = true;
  let newMessage = '';
  let sending = false;

  async function sendMessage() {
    if (!tab.entityId || !tab.signerId || !newMessage.trim() || sending) return;

    sending = true;
    try {
      const xln = getXLN();
      if (!xln) throw new Error('XLN not initialized');

      await xln.queueEntityInput(tab.entityId, tab.signerId, {
        type: 'chat',
        message: newMessage.trim()
      });
      newMessage = '';
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      sending = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

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

  // Enhanced message parsing for better display
  function parseMessage(message: string): { type: string; content: string; details?: any } {
    // Parse j-event messages for detailed display
    if (message.includes('observed j-event:')) {
      const match = message.match(/(\w+) observed j-event: (\w+) \(block (\d+), tx (0x\w+)\)/);
      if (match) {
        const [, observer, eventType, block, tx] = match;
        return {
          type: 'j-event',
          content: `${observer} observed J-event: ${eventType}`,
          details: { block, tx: tx?.slice(0, 10) + '...' || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })() }
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
            entity: entity?.slice(0, 10) + '...' || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })(),
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
      🕰️ Viewing historical state - auto-scroll disabled
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
    <div class="empty-state">No messages yet</div>
  {/if}
</div>

<!-- Send Message Input -->
<div class="chat-input">
  <input
    type="text"
    bind:value={newMessage}
    on:keydown={handleKeydown}
    placeholder="Type a message..."
    disabled={sending || !isAtCurrentTime}
  />
  <button on:click={sendMessage} disabled={sending || !newMessage.trim() || !isAtCurrentTime}>
    <Send size={16} />
  </button>
</div>

<style>
  .scrollable-component {
    height: 25vh;
    overflow-y: auto;
    padding: 8px;
  }

  .scrollable-component::-webkit-scrollbar {
    width: 6px;
  }

  .scrollable-component::-webkit-scrollbar-track {
    background: #1e1e1e;
  }

  .scrollable-component::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 3px;
  }

  .time-machine-indicator {
    background: rgba(255, 165, 0, 0.1);
    border: 1px solid rgba(255, 165, 0, 0.3);
    border-radius: 4px;
    padding: 6px 8px;
    margin-bottom: 8px;
    font-size: 0.8em;
    color: #ffa500;
    text-align: center;
  }

  .empty-state {
    text-align: center;
    color: #666;
    font-style: italic;
    padding: 20px;
    font-size: 0.9em;
  }

  .chat-message {
    background: #2d2d2d;
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 6px;
    border-left: 3px solid #007acc;
    font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  }

  .chat-message.j-event {
    border-left-color: #00ff88;
    background: rgba(0, 255, 136, 0.05);
  }

  .chat-message.reserve-update {
    border-left-color: #ffa500;
    background: rgba(255, 165, 0, 0.05);
  }

  .chat-meta {
    font-size: 0.7em;
    color: #9d9d9d;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .message-number {
    color: #666;
  }

  .signer-id {
    color: #007acc;
    font-weight: 500;
  }

  .event-type {
    background: #007acc;
    color: white;
    padding: 2px 4px;
    border-radius: 2px;
    font-weight: bold;
    font-size: 0.9em;
  }

  .j-event .event-type {
    background: #00ff88;
    color: #000;
  }

  .reserve-update .event-type {
    background: #ffa500;
    color: #000;
  }

  .chat-content {
    color: #d4d4d4;
    font-size: 0.8em;
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
    font-size: 0.9em;
    color: #aaa;
  }

  .detail-item {
    background: rgba(0, 0, 0, 0.3);
    padding: 2px 6px;
    border-radius: 3px;
    white-space: nowrap;
  }

  /* Chat Input */
  .chat-input {
    display: flex;
    gap: 8px;
    padding: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.2);
  }

  .chat-input input {
    flex: 1;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
  }

  .chat-input input:disabled {
    opacity: 0.5;
  }

  .chat-input button {
    padding: 8px 12px;
    background: rgba(255, 200, 100, 0.15);
    border: 1px solid rgba(255, 200, 100, 0.3);
    border-radius: 6px;
    color: rgba(255, 200, 100, 1);
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .chat-input button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .chat-input button:hover:not(:disabled) {
    background: rgba(255, 200, 100, 0.25);
  }
</style>
