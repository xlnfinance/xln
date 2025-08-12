<script lang="ts">
  import type { EntityReplica, Tab } from '../../types';
  
  export let replica: EntityReplica | null;
  export let tab: Tab;

  let selectedAction = 'chat';
  let message = '';
</script>

<div class="controls-section">
  <select class="controls-dropdown" bind:value={selectedAction}>
    <option value="chat" selected>💬 Create chat message</option>
    <option value="proposal">📋 Add proposal</option>
    <option value="vote">🗳️ Vote on proposal</option>
    <option value="entity">🏛️ Form new entity</option>
    <option value="jtx">💸 Send J-tx</option>
    <option value="settings">⚙️ Update settings</option>
  </select>
  
  <div class="controls-form">
    {#if selectedAction === 'chat'}
      <div class="form-group">
        <label class="form-label">Message:</label>
        <textarea class="form-textarea" bind:value={message} placeholder="Enter your message..."></textarea>
      </div>
      <button class="form-button">Send Message</button>
    {:else}
      <div class="form-group">
        <label class="form-label">Action:</label>
        <div class="form-input" style="padding: 12px; background: #1e1e1e; border-radius: 4px; color: #666;">
          {selectedAction} controls will be implemented here
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .controls-section {
    padding: 12px;
  }

  .controls-dropdown {
    width: 100%;
    padding: 8px;
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 4px;
    color: #d4d4d4;
    margin-bottom: 12px;
  }

  .controls-form {
    transition: all 0.3s ease;
  }

  .form-group {
    margin-bottom: 12px;
  }

  .form-label {
    display: block;
    color: #9d9d9d;
    font-size: 0.85em;
    margin-bottom: 4px;
  }

  .form-input,
  .form-textarea {
    width: 100%;
    padding: 6px 8px;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 0.85em;
    resize: vertical;
  }

  .form-textarea {
    min-height: 60px;
  }

  .form-button {
    background: #007acc;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
    transition: background-color 0.2s ease;
  }

  .form-button:hover {
    background: #0086e6;
  }
</style>
