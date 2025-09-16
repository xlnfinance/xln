<script lang="ts">
  import type { EntityReplica } from '../../types';

  export let replica: EntityReplica | null;

  // Get channels from entity state
  $: channels = replica?.state?.channels
    ? Array.from(replica.state.channels.entries()).map(([counterpartyId, channel]) => ({
        counterpartyId,
        ...channel,
      }))
    : [];
</script>

<div class="account-channels" data-testid="account-channels">
  <div class="channels-header">
    <h4>🔗 Account Channels</h4>
    <span class="channels-count">({channels.length})</span>
  </div>

  {#if channels.length === 0}
    <div class="no-channels">
      <div class="empty-icon">📭</div>
      <p>No account channels established</p>
      <small>Use the Network Directory to join hubs and create channels</small>
    </div>
  {:else}
    <div class="scrollable-component channels-list">
      {#each channels as channel (channel.counterpartyId)}
        <div class="channel-item" class:inactive={!channel.isActive}>
          <div class="channel-header">
            <div class="counterparty">
              <strong>🏢 {channel.counterpartyId}</strong>
              <span class="channel-status" class:active={channel.isActive}>
                {channel.isActive ? '✅ Active' : '❌ Inactive'}
              </span>
            </div>
            <div class="channel-nonce">
              <small>Nonce: {channel.nonce}</small>
            </div>
          </div>

          <div class="channel-balances">
            <div class="balance-row">
              <span class="balance-label">My Balance:</span>
              <span class="balance-value my-balance">
                {channel.myBalance.toString()} wei
              </span>
            </div>
            <div class="balance-row">
              <span class="balance-label">Their Balance:</span>
              <span class="balance-value their-balance">
                {channel.theirBalance.toString()} wei
              </span>
            </div>
          </div>

          {#if channel.collateral && channel.collateral.length > 0}
            <div class="channel-collateral">
              <div class="collateral-header">🔒 Collateral</div>
              <div class="collateral-list">
                {#each channel.collateral as asset}
                  <div class="collateral-item">
                    {asset.symbol}: {asset.amount.toString()}
                    <small>(decimals: {asset.decimals})</small>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <div class="channel-meta">
            <small class="last-update">
              Last updated: {new Date(channel.lastUpdate).toLocaleString()}
            </small>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .scrollable-component {
    height: 25vh;
    overflow-y: auto;
    padding: 8px;
  }
  .account-channels {
    margin-top: 16px;
  }

  .channels-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding: 0px 16px 8px 16px;
    border-bottom: 1px solid #3e3e3e;
  }

  .channels-header h4 {
    margin: 0;
    font-size: 1em;
    color: #007acc;
  }

  .channels-count {
    color: #9d9d9d;
    font-size: 0.9em;
  }

  .no-channels {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 30px 20px;
    text-align: center;
    background: rgba(108, 117, 125, 0.1);
    border: 1px solid rgba(108, 117, 125, 0.3);
    border-radius: 6px;
  }

  .empty-icon {
    font-size: 36px;
    margin-bottom: 12px;
  }

  .no-channels p {
    margin: 0 0 8px 0;
    color: #d4d4d4;
  }

  .no-channels small {
    color: #9d9d9d;
  }

  .channels-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .channel-item {
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    padding: 12px;
    transition: all 0.2s ease;
  }

  .channel-item:hover {
    border-color: #007acc;
  }

  .channel-item.inactive {
    opacity: 0.7;
    border-color: #dc3545;
  }

  .channel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }

  .counterparty {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .counterparty strong {
    color: #007acc;
  }

  .channel-status {
    font-size: 0.8em;
    padding: 2px 6px;
    border-radius: 3px;
    background: #dc3545;
    color: white;
  }

  .channel-status.active {
    background: #28a745;
  }

  .channel-nonce {
    color: #9d9d9d;
    font-size: 0.8em;
  }

  .channel-balances {
    margin-bottom: 10px;
  }

  .balance-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  .balance-label {
    color: #9d9d9d;
    font-size: 0.9em;
  }

  .balance-value {
    font-family: monospace;
    font-size: 0.9em;
  }

  .my-balance {
    color: #28a745;
  }

  .their-balance {
    color: #ffc107;
  }

  .channel-collateral {
    margin-bottom: 10px;
    padding: 8px;
    background: rgba(108, 117, 125, 0.1);
    border-radius: 4px;
  }

  .collateral-header {
    font-size: 0.8em;
    color: #9d9d9d;
    margin-bottom: 6px;
  }

  .collateral-item {
    font-size: 0.8em;
    font-family: monospace;
    color: #d4d4d4;
    margin-bottom: 2px;
  }

  .channel-meta {
    padding-top: 8px;
    border-top: 1px solid #3e3e3e;
  }

  .last-update {
    color: #9d9d9d;
    font-size: 0.75em;
  }
</style>
