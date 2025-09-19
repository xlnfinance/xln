<script lang="ts">
  import type { EntityReplica } from '../../types';
  import { deriveDelta, getTokenInfo, formatTokenAmount, calculatePercentage } from '../../utils/account-utils';
  import { getXLN, replicas, xlnEnvironment } from '../../stores/xlnStore';

  export let replica: EntityReplica | null;

  // Settle form variables
  let settleLeftDiff = 0;
  let settleRightDiff = 0;
  let settleCollateralDiff = 0;
  let settleOnDeltaDiff = 0;

  // Get accounts from entity state
  $: accounts = replica?.state?.accounts
    ? Array.from(replica.state.accounts.entries()).map(([counterpartyId, account]) => ({
        counterpartyId,
        ...account,
      }))
    : [];

  // Get available entities for account opening
  $: availableEntities = replica ? getAvailableEntities() : [];

  function getAvailableEntities() {
    if (!replica || !$replicas) return [];

    const currentEntityId = replica.entityId;
    const existingAccountIds = new Set(replica.state?.accounts ? Array.from(replica.state.accounts.keys()) : []);

    // Get unique entities from replicas, excluding current entity and existing accounts
    const entitySet = new Set<string>();
    for (const [replicaKey] of $replicas.entries()) {
      const [entityId] = replicaKey.split(':');
      if (entityId !== currentEntityId && !existingAccountIds.has(entityId)) {
        entitySet.add(entityId);
      }
    }

    return Array.from(entitySet).map(entityId => {
      // Try to get a human-readable name for the entity
      const entityNumber = getEntityNumber(entityId);
      return {
        entityId,
        displayName: `Entity #${entityNumber}`,
        shortId: entityId.slice(-4)
      };
    });
  }

  function getEntityNumber(entityId: string): number {
    // Convert bytes32 entityId back to entity number
    return parseInt(entityId, 16);
  }

  async function openAccountWith(targetEntityId: string) {
    if (!replica) return;

    try {
      console.log(`💳 NEW-FLOW: Opening account with Entity ${targetEntityId.slice(-4)} via entity transaction`);

      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // NEW FLOW: Send account_request as EntityTx to local e-machine
      const accountRequestInput = {
        entityId: replica.entityId,
        signerId: replica.signerId,
        entityTxs: [{
          type: 'openAccount' as const,
          data: {
            targetEntityId
          }
        }]
      };

      await xln.processUntilEmpty(env, [accountRequestInput]);
      console.log(`✅ Account request sent to local e-machine for Entity ${targetEntityId.slice(-4)}`);
    } catch (error) {
      console.error('Failed to send account request:', error);
      alert(`Failed to send account request: ${error.message}`);
    }
  }

  async function prefundAccount(counterpartyEntityId: string) {
    if (!replica) return;

    // Simple prefunding with default values for testing
    const tokenId = 1; // ETH
    const amount = 0.1; // 0.1 ETH

    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // Get jurisdiction info
      const ethJurisdiction = await xln.getJurisdictionByAddress('ethereum');
      if (!ethJurisdiction) {
        throw new Error('Ethereum jurisdiction not found');
      }

      // Call submitPrefundAccount function
      const result = await xln.submitPrefundAccount(
        ethJurisdiction,
        replica.entityId,
        counterpartyEntityId,
        tokenId,
        (BigInt(Math.floor(amount * 1e18))).toString() // Convert to wei
      );

      console.log(`✅ Account prefunded with Entity ${counterpartyEntityId.slice(-4)}: ${amount} ETH`);
      console.log('Transaction:', result.hash);

    } catch (error) {
      console.error('Failed to prefund account:', error);
      alert(`Failed to prefund account: ${error.message}`);
    }
  }

  // For each account, derive the token balances (assuming we are always "left" for simplicity)
  function getAccountTokens(account: any) {
    if (!account.deltas || !account.deltas.size) return [];

    return Array.from(account.deltas.entries()).map(([tokenId, delta]) => {
      const derived = deriveDelta(delta, true); // Assume we are left party
      const tokenInfo = getTokenInfo(tokenId);

      return {
        tokenId,
        tokenInfo,
        delta,
        derived,
      };
    });
  }

  async function submitSettle(tokenId: number, counterpartyEntityId: string) {
    if (!replica) return;

    try {
      console.log('⚖️ Submitting settle transaction:', {
        tokenId,
        leftEntity: replica.entityId,
        rightEntity: counterpartyEntityId,
        leftDiff: settleLeftDiff,
        rightDiff: settleRightDiff,
        collateralDiff: settleCollateralDiff,
        onDeltaDiff: settleOnDeltaDiff
      });

      // Validate the invariant: leftDiff + rightDiff + collateralDiff = 0
      const total = settleLeftDiff + settleRightDiff + settleCollateralDiff;
      if (Math.abs(total) > 0.0001) {
        alert(`Settlement invariant violation: leftDiff + rightDiff + collateralDiff must = 0. Current total: ${total}`);
        return;
      }

      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // Get jurisdiction info
      const ethJurisdiction = await xln.getJurisdictionByAddress('ethereum');
      if (!ethJurisdiction) {
        throw new Error('Ethereum jurisdiction not found');
      }

      // Convert to wei amounts
      const leftDiffWei = BigInt(Math.floor(settleLeftDiff * 1e18));
      const rightDiffWei = BigInt(Math.floor(settleRightDiff * 1e18));
      const collateralDiffWei = BigInt(Math.floor(settleCollateralDiff * 1e18));

      // Call settle function directly
      await xln.submitSettle(
        ethJurisdiction,
        replica.entityId < counterpartyEntityId ? replica.entityId : counterpartyEntityId,
        replica.entityId < counterpartyEntityId ? counterpartyEntityId : replica.entityId,
        [{
          tokenId,
          leftDiff: leftDiffWei,
          rightDiff: rightDiffWei,
          collateralDiff: collateralDiffWei
        }]
      );

      console.log('✅ Settlement submitted successfully');

      // Reset form
      settleLeftDiff = 0;
      settleRightDiff = 0;
      settleCollateralDiff = 0;
      settleOnDeltaDiff = 0;

    } catch (error) {
      console.error('Failed to submit settle:', error);
      alert(`Failed to submit settle: ${error.message}`);
    }
  }
</script>

<div class="account-channels" data-testid="account-channels">
  <div class="accounts-header">
    <h4>💳 Accounts</h4>
    <span class="accounts-count">({accounts.length})</span>
  </div>

  <!-- One-Click Account Opening Section -->
  {#if availableEntities.length > 0}
    <div class="account-opening-section">
      <h5>🚀 Quick Account Opening</h5>
      <div class="entity-buttons">
        {#each availableEntities as entity (entity.entityId)}
          <div class="entity-card">
            <div class="entity-info">
              <span class="entity-icon">🏢</span>
              <span class="entity-name">{entity.displayName}</span>
              <span class="entity-id">...{entity.shortId}</span>
            </div>
            <div class="entity-actions">
              <button
                class="action-button open-button"
                on:click={() => openAccountWith(entity.entityId)}
                title="Open account with {entity.displayName}"
              >
                📝 Open
              </button>
              <button
                class="action-button prefund-button"
                on:click={() => prefundAccount(entity.entityId)}
                title="Prefund account with {entity.displayName} (0.1 ETH)"
              >
                💰 Prefund
              </button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if accounts.length === 0}
    <div class="no-accounts">
      <div class="empty-icon">📭</div>
      <p>No accounts established</p>
      <small>Use the Network Directory to join hubs and create accounts</small>
    </div>
  {:else}
    <div class="scrollable-component accounts-list">
      {#each accounts as account (account.counterpartyId)}
        <div class="account-item" data-account-id="{account.counterpartyEntityId}">
          <div class="account-header">
            <div class="counterparty">
              <strong>🏢 Entity {account.counterpartyEntityId.slice(-4)}</strong>
              <span class="account-status">
                {account.mempool.length > 0 ? '🟡 Pending' : '✅ Synced'}
              </span>
            </div>
            <div class="account-transitions">
              <small>Transitions: {account.sentTransitions}</small>
            </div>
          </div>

          <!-- Per-token balances -->
          {#each getAccountTokens(account) as tokenData (tokenData.tokenId)}
            <div class="token-balance">
              <div class="token-header">
                <div class="token-info">
                  <span class="token-symbol" style="color: {tokenData.tokenInfo.color}">
                    {tokenData.tokenInfo.symbol}
                  </span>
                  <span class="token-delta">
                    Delta: {formatTokenAmount(tokenData.tokenId, tokenData.derived.delta)}
                  </span>
                </div>
              </div>

              <div class="balance-bars">
                <div class="balance-side">
                  <div class="side-label">Our Side</div>
                  <div class="capacity-bar">
                    <div class="bar-segment credit"
                         style="width: {calculatePercentage(tokenData.derived.inOwnCredit, tokenData.derived.totalCapacity)}%">
                    </div>
                    <div class="bar-segment collateral"
                         style="width: {calculatePercentage(tokenData.derived.inCollateral, tokenData.derived.totalCapacity)}%">
                    </div>
                  </div>
                  <div class="capacity-values">
                    <span>Credit: {formatTokenAmount(tokenData.tokenId, tokenData.derived.inOwnCredit)}</span>
                    <span>Collateral: {formatTokenAmount(tokenData.tokenId, tokenData.derived.inCollateral)}</span>
                  </div>
                </div>

                <div class="balance-side">
                  <div class="side-label">Their Side</div>
                  <div class="capacity-bar">
                    <div class="bar-segment credit"
                         style="width: {calculatePercentage(tokenData.derived.outPeerCredit, tokenData.derived.totalCapacity)}%">
                    </div>
                    <div class="bar-segment collateral"
                         style="width: {calculatePercentage(tokenData.derived.outCollateral, tokenData.derived.totalCapacity)}%">
                    </div>
                  </div>
                  <div class="capacity-values">
                    <span>Credit: {formatTokenAmount(tokenData.tokenId, tokenData.derived.outPeerCredit)}</span>
                    <span>Collateral: {formatTokenAmount(tokenData.tokenId, tokenData.derived.outCollateral)}</span>
                  </div>
                </div>
              </div>

              <!-- Settle Interface -->
              <div class="settle-interface">
                <div class="settle-header">
                  <span class="settle-icon">⚖️</span>
                  <span class="settle-title">Settle Deltas</span>
                </div>
                <div class="settle-form">
                  <div class="diff-inputs">
                    <input type="number" step="0.01" placeholder="Left Diff" bind:value={settleLeftDiff} class="diff-input" />
                    <input type="number" step="0.01" placeholder="Right Diff" bind:value={settleRightDiff} class="diff-input" />
                    <input type="number" step="0.01" placeholder="Collateral Diff" bind:value={settleCollateralDiff} class="diff-input" />
                    <input type="number" step="0.01" placeholder="OnDelta Diff" bind:value={settleOnDeltaDiff} class="diff-input" />
                  </div>
                  <button class="settle-btn" on:click={() => submitSettle(tokenData.tokenId, account.counterpartyId)}>
                    📤 Broadcast Settle
                  </button>
                </div>
              </div>
            </div>
          {/each}

          <div class="account-meta">
            <small class="frame-timestamp">
              Frame #{account.currentFrame.frameId} • Updated: {new Date(account.currentFrame.timestamp).toLocaleString()}
            </small>
            <small class="account-status">
              Mempool: {account.mempool?.length || 0} pending •
              Sent: {account.sentTransitions || 0} •
              Credit: ${((account.globalCreditLimits?.ownLimit || 0n) / 100n).toString()}
            </small>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .scrollable-component {
    height: 100vh;
    overflow-y: auto;
    padding: 8px;
  }
  .account-channels {
    margin-top: 16px;
  }

  .accounts-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding: 0px 16px 8px 16px;
    border-bottom: 1px solid #3e3e3e;
  }

  .accounts-header h4 {
    margin: 0;
    font-size: 1em;
    color: #007acc;
  }

  .accounts-count {
    color: #9d9d9d;
    font-size: 0.9em;
  }

  .no-accounts {
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

  .no-accounts p {
    margin: 0 0 8px 0;
    color: #d4d4d4;
  }

  .no-accounts small {
    color: #9d9d9d;
  }

  .accounts-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .account-item {
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    padding: 24px;
    transition: all 0.2s ease;
  }

  .account-item:hover {
    border-color: #007acc;
  }

  .account-item.highlight {
    border-color: #ffc107;
    box-shadow: 0 0 20px rgba(255, 193, 7, 0.3);
    animation: highlightPulse 2s ease-in-out;
  }

  @keyframes highlightPulse {
    0% { box-shadow: 0 0 20px rgba(255, 193, 7, 0.6); }
    50% { box-shadow: 0 0 30px rgba(255, 193, 7, 0.8); }
    100% { box-shadow: 0 0 20px rgba(255, 193, 7, 0.3); }
  }

  .account-header {
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

  .account-status {
    font-size: 0.8em;
    padding: 2px 6px;
    border-radius: 3px;
    background: #28a745;
    color: white;
  }

  .account-transitions {
    color: #9d9d9d;
    font-size: 0.8em;
  }


  .account-meta {
    padding-top: 8px;
    border-top: 1px solid #3e3e3e;
  }

  .frame-timestamp {
    color: #9d9d9d;
    font-size: 0.75em;
  }

  /* Token balance styles */
  .token-balance {
    margin: 12px 0;
    padding: 10px;
    background: #222;
    border-radius: 4px;
    border-left: 3px solid #007acc;
  }

  .token-header {
    margin-bottom: 8px;
  }

  .token-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .token-symbol {
    font-weight: bold;
    font-size: 0.9em;
  }

  .token-delta {
    font-family: monospace;
    font-size: 0.8em;
    color: #d4d4d4;
  }

  .balance-bars {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 8px;
  }

  .balance-side {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .side-label {
    font-size: 0.8em;
    color: #9d9d9d;
    font-weight: bold;
  }

  .capacity-bar {
    height: 20px;
    background: #1a1a1a;
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    border: 1px solid #3e3e3e;
  }

  .bar-segment {
    height: 100%;
    transition: width 0.3s ease;
  }

  .bar-segment.credit {
    background: linear-gradient(90deg, #ff6b6b, #ff8e8e);
  }

  .bar-segment.collateral {
    background: linear-gradient(90deg, #4ecdc4, #45b7aa);
  }

  .capacity-values {
    display: flex;
    justify-content: space-between;
    font-size: 0.75em;
    color: #999;
    margin-top: 2px;
  }

  .capacity-values span {
    font-family: monospace;
  }

  /* Account Opening Section Styles */
  .account-opening-section {
    margin: 12px 0;
    padding: 12px;
    background: #1e1e1e;
    border-radius: 6px;
    border: 1px solid #007acc;
  }

  .account-opening-section h5 {
    margin: 0 0 12px 0;
    color: #007acc;
    font-size: 0.9em;
    font-weight: bold;
  }

  .entity-buttons {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .entity-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px;
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 6px;
    transition: all 0.2s ease;
  }

  .entity-card:hover {
    border-color: #007acc;
    background: #333;
  }

  .entity-info {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
  }

  .entity-actions {
    display: flex;
    gap: 6px;
  }

  .action-button {
    padding: 4px 8px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #1e1e1e;
    color: #d4d4d4;
    cursor: pointer;
    font-size: 0.75em;
    transition: all 0.2s ease;
  }

  .open-button:hover {
    background: #007acc;
    border-color: #0086e6;
    color: white;
  }

  .prefund-button:hover {
    background: #28a745;
    border-color: #1e7e34;
    color: white;
  }

  .action-button:active {
    transform: translateY(1px);
  }

  .entity-icon {
    font-size: 1em;
  }

  .entity-name {
    font-weight: bold;
  }

  .entity-id {
    font-family: monospace;
    font-size: 0.9em;
    color: #999;
    opacity: 0.8;
  }

  .settle-interface {
    margin-top: 16px;
    padding: 12px;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
  }

  .settle-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  .settle-icon {
    font-size: 16px;
  }

  .settle-title {
    font-weight: 600;
    color: #d4d4d4;
  }

  .diff-inputs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 12px;
  }

  .diff-input {
    padding: 6px 8px;
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 14px;
  }

  .diff-input:focus {
    border-color: #007acc;
    outline: none;
  }

  .settle-btn {
    width: 100%;
    padding: 8px 16px;
    background: #0d7377;
    border: none;
    border-radius: 4px;
    color: white;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s ease;
  }

  .settle-btn:hover {
    background: #0a5d61;
  }
</style>
