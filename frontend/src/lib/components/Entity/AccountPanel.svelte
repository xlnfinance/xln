<script lang="ts">
  import type { AccountMachine } from '../../types';
  import { createEventDispatcher } from 'svelte';
  import { xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';

  // All utility functions now come from server.js via xlnFunctions

  // Helper to safely format numbers that might be undefined/null
  function safeFixed(value: any, decimals: number = 4): string {
    if (value == null || isNaN(value)) return 'N/A';
    return Number(value).toFixed(decimals);
  }

  // Simple timestamp formatting
  function formatTimestamp(ms: number): string {
    return new Date(ms).toLocaleTimeString();
  }


  export let account: AccountMachine;
  export let counterpartyId: string;
  export let entityId: string;

  const dispatch = createEventDispatcher();

  // Handle back to entity navigation
  function handleBackToEntity() {
    dispatch('back');
  }

  // Form states
  let selectedTokenId = 1;
  let creditAdjustment = 0;
  let collateralAdjustment = 0;
  let paymentAmount = 0;
  let paymentDescription = '';

  // Determine if we are the "left" entity in the canonical bilateral ordering
  // Use lexicographic comparison for deterministic left/right assignment
  $: isLeftEntity = entityId < counterpartyId;

  // Debug perspective calculation
  $: {
    console.log(`🔍 PERSPECTIVE DEBUG:`, {
      entityId: entityId.slice(-4),
      counterpartyId: counterpartyId.slice(-4),
      isLeftEntity,
      entityIdFull: entityId,
      counterpartyIdFull: counterpartyId
    });
  }

  // XLN functions accessed through $xlnEnvironment.xln (attached in xlnStore)

  $: tokenDetails = Array.from(account.deltas?.entries() || []).map(([tokenId, delta]) => {
    if (!$xlnFunctions?.deriveDelta) {
      return {
        tokenId,
        delta,
        derived: {
          delta: 0n,
          totalCapacity: 0n,
          inCapacity: 0n,
          outCapacity: 0n,
          ascii: '[loading...]'
        },
        tokenInfo: { symbol: `TKN${tokenId}`, color: '#999', name: `Token ${tokenId}`, decimals: 18 }
      };
    }

    const derived = $xlnFunctions.deriveDelta(delta, isLeftEntity);
    const tokenInfo = {
      symbol: tokenId === 1 ? 'ETH' : tokenId === 2 ? 'USDT' : tokenId === 3 ? 'USDC' : `TKN${tokenId}`,
      color: tokenId === 1 ? '#627eea' : tokenId === 2 ? '#26a17b' : tokenId === 3 ? '#2775ca' : '#999',
      name: tokenId === 1 ? 'Ethereum' : tokenId === 2 ? 'Tether USD' : tokenId === 3 ? 'USD Coin' : `Token ${tokenId}`,
      decimals: 18
    };

    // Debug derived values including ASCII
    console.log(`🔍 DERIVED DEBUG (Entity ${entityId.slice(-4)}, isLeft=${isLeftEntity}):`, {
      tokenId,
      rawDelta: {
        collateral: delta.collateral.toString(),
        ondelta: delta.ondelta.toString(),
        offdelta: delta.offdelta.toString(),
        leftCredit: delta.leftCreditLimit.toString(),
        rightCredit: delta.rightCreditLimit.toString()
      },
      derived: {
        delta: derived.delta.toString(),
        totalCapacity: derived.totalCapacity.toString(),
        ownCreditLimit: derived.ownCreditLimit.toString(),
        peerCreditLimit: derived.peerCreditLimit.toString(),
        inCapacity: derived.inCapacity.toString(),
        outCapacity: derived.outCapacity.toString(),
        hasAscii: 'ascii' in derived,
        ascii: derived.ascii || 'MISSING'
      }
    });

    // Calculate detailed segments
    const theirCreditLimit = delta.rightCreditLimit;
    const theirUsedCredit = theirCreditLimit > 0n ?
      Math.max(0, Number(theirCreditLimit) - Number(derived.inCapacity - delta.collateral)) : 0;
    const theirUnusedCredit = Number(theirCreditLimit) - theirUsedCredit;

    const ourCreditLimit = delta.leftCreditLimit;
    const ourUsedCredit = ourCreditLimit > 0n ?
      Math.max(0, Number(ourCreditLimit) - Number(derived.outCapacity)) : 0;
    const ourUnusedCredit = Number(ourCreditLimit) - ourUsedCredit;

    // Calculate credit limits with proper BigInt handling

    const result = {
      tokenId,
      tokenInfo,
      delta,
      derived,
      theirCreditLimit: Number(theirCreditLimit) / 1e18,
      theirUsedCredit: theirUsedCredit / 1e18,
      theirUnusedCredit: theirUnusedCredit / 1e18,
      ourCreditLimit: Number(ourCreditLimit) / 1e18,
      ourUsedCredit: ourUsedCredit / 1e18,
      ourUnusedCredit: ourUnusedCredit / 1e18,
      ourCollateral: Number(delta.collateral) / 1e18,
      theirCollateral: 0, // Would come from their side's delta
    };

    // Result calculated successfully

    return result;
  });

  async function sendPayment() {
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // Create direct payment EntityTx
      const paymentInput = {
        entityId,
        signerId: entityId, // Simplified for now
        entityTxs: [{
          type: 'direct-payment' as const,
          data: {
            recipientEntityId: counterpartyId,
            tokenId: selectedTokenId,
            amount: BigInt(Math.floor(paymentAmount * 1e18)),
            description: paymentDescription || undefined
          }
        }]
      };

      await xln.processUntilEmpty(env, [paymentInput]);
      console.log(`✅ Payment sent: ${paymentAmount} ${getTokenInfo(selectedTokenId).symbol}`);

      // Reset form
      paymentAmount = 0;
      paymentDescription = '';

    } catch (err) {
      console.error('Failed to send payment:', err);
      error.set({
        message: `Payment failed: ${err.message}`,
        source: 'AccountPanel.sendPayment',
        details: $xlnFunctions?.safeStringify(err)
      });
    }
  }

  async function adjustCredit() {
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // Create credit adjustment EntityTx
      const adjustmentInput = {
        entityId,
        signerId: entityId,
        entityTxs: [{
          type: 'adjust-credit' as const,
          data: {
            counterpartyEntityId: counterpartyId,
            tokenId: selectedTokenId,
            newCreditLimit: BigInt(Math.floor(creditAdjustment * 1e18))
          }
        }]
      };

      await xln.processUntilEmpty(env, [adjustmentInput]);
      console.log(`✅ Credit adjusted to: ${creditAdjustment}`);

      creditAdjustment = 0;
    } catch (err) {
      console.error('Failed to adjust credit:', err);
      error.set({
        message: `Credit adjustment failed: ${err.message}`,
        source: 'AccountPanel.adjustCredit',
        details: $xlnFunctions?.safeStringify(err)
      });
    }
  }

  async function settleAccount() {
    if (!confirm('Are you sure you want to settle this account on-chain?')) return;

    try {
      const xln = await getXLN();
      const ethJurisdiction = await xln.getJurisdictionByAddress('ethereum');
      if (!ethJurisdiction) throw new Error('Ethereum jurisdiction not found');

      // Submit settle for all tokens
      for (const td of tokenDetails) {
        if (td.delta.ondelta !== 0n || td.delta.offdelta !== 0n) {
          await xln.submitSettle(
            ethJurisdiction,
            entityId < counterpartyId ? entityId : counterpartyId,
            entityId < counterpartyId ? counterpartyId : entityId,
            [{
              tokenId: td.tokenId,
              leftDiff: 0n, // TODO: Calculate proper settlement
              rightDiff: 0n,
              collateralDiff: 0n
            }]
          );
        }
      }

      console.log('✅ Settlement submitted');
    } catch (err) {
      console.error('Failed to settle:', err);
      error.set({
        message: `Settlement failed: ${err.message}`,
        source: 'AccountPanel.settleAccount',
        details: $xlnFunctions?.safeStringify(err)
      });
    }
  }

  async function initiateDispute() {
    if (!confirm('Are you sure you want to initiate a dispute? This will freeze the account.')) return;

    // TODO: Implement dispute initiation
    console.log('🚨 Dispute initiated');
    alert('Dispute functionality coming soon');
  }

  async function closeAccount() {
    if (!confirm('Are you sure you want to close this account? All balances must be settled first.')) return;

    // TODO: Implement cooperative close
    console.log('❌ Closing account');
    alert('Account closure functionality coming soon');
  }

  function handleBack() {
    dispatch('back');
  }
</script>

<div class="account-panel">
  <div class="panel-header">
    <button class="back-button" on:click={handleBackToEntity}>
      ← Back to Entity
    </button>
    <div class="account-title">
      <span class="entity-pair">
        Entity #{$xlnFunctions?.getEntityNumber(entityId)} ⟷ Entity #{$xlnFunctions?.getEntityNumber(counterpartyId)}
      </span>
      <div class="consensus-status">
        <span class="frame-badge">Frame #{account.currentFrame.frameId}</span>
        {#if account.mempool.length > 0}
          <span class="status-badge pending">{account.mempool.length} pending</span>
        {:else}
          <span class="status-badge synced">Synced</span>
        {/if}
      </div>
    </div>
  </div>

  <div class="panel-content">
    <!-- Canonical State (Raw Data) -->
    <div class="section">
      <h3>📊 Canonical State</h3>
      <div class="canonical-data">
        <div class="canonical-note">Raw bilateral state (identical on both sides):</div>
        {#each tokenDetails as td (td.tokenId)}
          <div class="canonical-token">
            <div class="token-id-label">{td.tokenInfo.symbol} (Token #{td.tokenId}):</div>
            <div class="canonical-values">
              <div class="canonical-item">
                <span class="canonical-key">collateral:</span>
                <span class="canonical-value">{$xlnFunctions?.formatTokenAmount(td.tokenId, td.delta.collateral)}</span>
              </div>
              <div class="canonical-item">
                <span class="canonical-key">ondelta:</span>
                <span class="canonical-value">{$xlnFunctions?.formatTokenAmount(td.tokenId, td.delta.ondelta)}</span>
              </div>
              <div class="canonical-item">
                <span class="canonical-key">offdelta:</span>
                <span class="canonical-value">{$xlnFunctions?.formatTokenAmount(td.tokenId, td.delta.offdelta)}</span>
              </div>
              <div class="canonical-item">
                <span class="canonical-key">leftCreditLimit:</span>
                <span class="canonical-value">{$xlnFunctions?.formatTokenAmount(td.tokenId, td.delta.leftCreditLimit)} (Entity #{$xlnFunctions?.getEntityNumber(isLeftEntity ? entityId : counterpartyId)})</span>
              </div>
              <div class="canonical-item">
                <span class="canonical-key">rightCreditLimit:</span>
                <span class="canonical-value">{$xlnFunctions?.formatTokenAmount(td.tokenId, td.delta.rightCreditLimit)} (Entity #{$xlnFunctions?.getEntityNumber(isLeftEntity ? counterpartyId : entityId)})</span>
              </div>
            </div>
            <!-- ASCII Visualization -->
            <div class="ascii-visualization">
              <div class="ascii-label">Position:</div>
              <div class="ascii-bar">{td.derived.ascii || '[not available]'}</div>
              <div class="ascii-legend">
                <span>[-] Credit</span>
                <span>[=] Collateral</span>
                <span>[|] Balance Position</span>
              </div>
            </div>
          </div>
        {/each}
      </div>
    </div>

    <!-- Personal View (Perspective-based) -->
    <div class="section">
      <h3>👤 My View (Entity #{$xlnFunctions?.getEntityNumber(entityId)} perspective)</h3>
      {#each tokenDetails as td (td.tokenId)}
        <div class="token-detail-card">
          <div class="token-header">
            <span class="token-name" style="color: {td.tokenInfo.color}">
              {td.tokenInfo.symbol} (Token #{td.tokenId})
            </span>
            <span class="net-position" class:positive={td.derived.delta > 0n} class:negative={td.derived.delta < 0n}>
              Net: {$xlnFunctions?.formatTokenAmount(td.tokenId, td.derived.delta)}
            </span>
          </div>

          <div class="balance-visualization">
            <div class="balance-row">
              <span class="row-label">Our Side</span>
              <div class="detailed-bar">
                {#if td.ourUnusedCredit > 0}
                  <div
                    class="bar-segment unused-credit"
                    style="flex: {td.ourUnusedCredit}"
                    title="Unused credit we gave: {safeFixed(td.ourUnusedCredit, 4)}"
                  >
                    <span class="segment-label">{safeFixed(td.ourUnusedCredit, 2)}</span>
                  </div>
                {/if}
                {#if td.ourCollateral > 0}
                  <div
                    class="bar-segment collateral"
                    style="flex: {td.ourCollateral}"
                    title="Our collateral: {safeFixed(td.ourCollateral, 4)}"
                  >
                    <span class="segment-label">{safeFixed(td.ourCollateral, 2)}</span>
                  </div>
                {/if}
                {#if td.ourUsedCredit > 0}
                  <div
                    class="bar-segment used-credit"
                    style="flex: {td.ourUsedCredit}"
                    title="Used credit we gave: {safeFixed(td.ourUsedCredit, 4)}"
                  >
                    <span class="segment-label">{safeFixed(td.ourUsedCredit, 2)}</span>
                  </div>
                {/if}
              </div>
            </div>

            <div class="balance-row">
              <span class="row-label">Their Side</span>
              <div class="detailed-bar">
                {#if td.theirUnusedCredit > 0}
                  <div
                    class="bar-segment unused-credit"
                    style="flex: {td.theirUnusedCredit}"
                    title="Unused credit they gave: {safeFixed(td.theirUnusedCredit, 4)}"
                  >
                    <span class="segment-label">{safeFixed(td.theirUnusedCredit, 2)}</span>
                  </div>
                {/if}
                {#if td.theirUsedCredit > 0}
                  <div
                    class="bar-segment used-credit"
                    style="flex: {td.theirUsedCredit}"
                    title="Used credit they gave: {safeFixed(td.theirUsedCredit, 4)}"
                  >
                    <span class="segment-label">{safeFixed(td.theirUsedCredit, 2)}</span>
                  </div>
                {/if}
              </div>
            </div>
          </div>

          <div class="capacity-summary">
            <div class="capacity-item">
              <span class="capacity-label">Can Send:</span>
              <span class="capacity-value outbound">{$xlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outCapacity)}</span>
            </div>
            <div class="capacity-item">
              <span class="capacity-label">Can Receive:</span>
              <span class="capacity-value inbound">{$xlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inCapacity)}</span>
            </div>
            <div class="capacity-item">
              <span class="capacity-label">Total Capacity:</span>
              <span class="capacity-value">{$xlnFunctions?.formatTokenAmount(td.tokenId, td.derived.totalCapacity)}</span>
            </div>
          </div>

          <div class="credit-details">
            <div class="credit-row">
              <span>Our Credit Limit:</span>
              <span>{safeFixed(td.ourCreditLimit)} {td.tokenInfo.symbol}</span>
            </div>
            <div class="credit-row">
              <span>Their Credit Limit:</span>
              <span>{safeFixed(td.theirCreditLimit)} {td.tokenInfo.symbol}</span>
            </div>
            <div class="credit-row">
              <span>Our Collateral:</span>
              <span>{safeFixed(td.ourCollateral)} {td.tokenInfo.symbol}</span>
            </div>
          </div>
        </div>
      {/each}
    </div>

    <!-- Actions Section -->
    <div class="section">
      <h3>Quick Actions</h3>

      <!-- Send Payment -->
      <div class="action-card">
        <h4>Send Payment</h4>
        <div class="action-form">
          <select bind:value={selectedTokenId} class="form-select">
            {#each tokenDetails as td}
              <option value={td.tokenId}>{td.tokenInfo.symbol}</option>
            {/each}
          </select>
          <input
            type="number"
            step="0.01"
            placeholder="Amount"
            bind:value={paymentAmount}
            class="form-input"
          />
          <input
            type="text"
            placeholder="Description (optional)"
            bind:value={paymentDescription}
            class="form-input"
          />
          <button class="action-button primary" on:click={sendPayment}>
            Send Payment
          </button>
        </div>
      </div>

      <!-- Adjust Credit -->
      <div class="action-card">
        <h4>Adjust Credit Limit</h4>
        <div class="action-form">
          <select bind:value={selectedTokenId} class="form-select">
            {#each tokenDetails as td}
              <option value={td.tokenId}>{td.tokenInfo.symbol}</option>
            {/each}
          </select>
          <input
            type="number"
            step="0.1"
            placeholder="New credit limit"
            bind:value={creditAdjustment}
            class="form-input"
          />
          <button class="action-button secondary" on:click={adjustCredit}>
            Update Credit
          </button>
        </div>
      </div>

      <!-- Management Actions -->
      <div class="action-card">
        <h4>Account Management</h4>
        <div class="management-buttons">
          <button class="action-button settle" on:click={settleAccount}>
            Settle On-Chain
          </button>
          <button class="action-button dispute" on:click={initiateDispute}>
            Initiate Dispute
          </button>
          <button class="action-button close" on:click={closeAccount}>
            Close Account
          </button>
        </div>
      </div>
    </div>

    <!-- Mempool Preview -->
    {#if account.mempool.length > 0}
      <div class="section">
        <h3>Pending Transactions</h3>
        <div class="mempool-list">
          {#each account.mempool as tx, i}
            <div class="mempool-item">
              <span class="tx-index">#{i + 1}</span>
              <span class="tx-type">{tx.type}</span>
              {#if tx.data.amount}
                <span class="tx-amount">{safeFixed((Number(tx.data.amount) / 1e18), 4)}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Account Frame History Section -->
    <div class="section">
      <h3>💾 Account Frame History ({account.frameHistory?.length || 0} confirmed frames)</h3>
      <div class="frame-history">

        <!-- Pending Frame (TOP PRIORITY) -->
        {#if account.pendingFrame}
          <div class="frame-item pending">
            <div class="frame-header">
              <span class="frame-id">⏳ Pending Frame #{account.pendingFrame.frameId}</span>
              <span class="frame-status pending">Awaiting Consensus</span>
              <span class="frame-timestamp">
                {formatTimestamp(account.pendingFrame.timestamp)}
              </span>
            </div>
            <div class="frame-details">
              <div class="frame-detail">
                <span class="detail-label">Transactions:</span>
                <span class="detail-value">{account.pendingFrame.accountTxs.length}</span>
              </div>
              <div class="frame-detail">
                <span class="detail-label">Signatures:</span>
                <span class="detail-value">{account.pendingSignatures?.length || 0}/2</span>
              </div>
              <div class="pending-transactions">
                {#each account.pendingFrame.accountTxs as tx, i}
                  <div class="pending-tx">
                    <span class="tx-index">{i+1}.</span>
                    <span class="tx-type">{tx.type}</span>
                    {#if tx.type === 'direct-payment'}
                      <span class="tx-amount">{$xlnFunctions?.formatTokenAmount(tx.data.tokenId, tx.data.amount)}</span>
                      <span class="tx-desc">{tx.data.description || ''}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {/if}

        <!-- Mempool Queue (Enhanced) -->
        {#if account.mempool.length > 0}
          <div class="frame-item mempool">
            <div class="frame-header">
              <span class="frame-id">📝 Mempool Queue</span>
              <span class="frame-status mempool">{account.mempool.length} Queued</span>
            </div>
            <div class="frame-details">
              <div class="mempool-transactions">
                {#each account.mempool as tx, i}
                  <div class="mempool-tx">
                    <span class="tx-index">{i+1}.</span>
                    <span class="tx-type">{tx.type}</span>
                    {#if tx.type === 'direct-payment'}
                      <span class="tx-amount">{$xlnFunctions?.formatTokenAmount(tx.data.tokenId, tx.data.amount)}</span>
                      <span class="tx-desc">"{tx.data.description || 'no description'}"</span>
                      <span class="tx-token">Token #{tx.data.tokenId}</span>
                    {:else if tx.type === 'set-credit-limit'}
                      <span class="tx-amount">{$xlnFunctions?.formatTokenAmount(tx.data.tokenId, tx.data.amount)}</span>
                      <span class="tx-desc">{tx.data.isForSelf ? 'Self limit' : 'Peer limit'}</span>
                    {:else}
                      <span class="tx-desc">{$xlnFunctions?.safeStringify(tx.data)}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {/if}

        <!-- Current Active Frame -->
        {#if account.currentFrame}
          <div class="frame-item current">
            <div class="frame-header">
              <span class="frame-id">✅ Current Frame #{account.currentFrame.frameId || account.currentFrameId}</span>
              <span class="frame-status current">Active</span>
              <span class="frame-timestamp">
                {formatTimestamp(account.currentFrame.timestamp || Date.now())}
              </span>
            </div>
            <div class="frame-details">
              <div class="frame-detail">
                <span class="detail-label">Transactions:</span>
                <span class="detail-value">{account.currentFrame.accountTxs?.length || 0}</span>
              </div>
              <div class="frame-detail">
                <span class="detail-label">State Hash:</span>
                <span class="detail-value hash">{account.currentFrame.stateHash?.slice(0,12) || 'N/A'}...</span>
              </div>
            </div>
          </div>
        {/if}

        <!-- Historical Frames (from frameHistory array) -->
        {#if account.frameHistory && account.frameHistory.length > 0}
          <div class="historical-frames">
            <h4>📚 Historical Frames (last {Math.min(10, account.frameHistory.length)}):</h4>
            {#each account.frameHistory.slice(-10).reverse() as frame, i}
              <div class="frame-item historical">
                <div class="frame-header">
                  <span class="frame-id">📜 Frame #{frame.frameId}</span>
                  <span class="frame-status historical">Confirmed</span>
                  <span class="frame-timestamp">
                    {formatTimestamp(frame.timestamp)}
                  </span>
                </div>
                <div class="frame-details">
                  <div class="frame-detail">
                    <span class="detail-label">Transactions:</span>
                    <span class="detail-value">{frame.accountTxs.length}</span>
                  </div>
                  <div class="frame-detail">
                    <span class="detail-label">Proposer:</span>
                    <span class="detail-value">{frame.isProposer ? 'Us' : 'Them'}</span>
                  </div>
                  <div class="frame-detail">
                    <span class="detail-label">Tokens:</span>
                    <span class="detail-value">{frame.tokenIds?.join(', ') || 'None'}</span>
                  </div>
                  <div class="frame-detail">
                    <span class="detail-label">Hash:</span>
                    <span class="detail-value hash">{frame.stateHash?.slice(0,8) || 'N/A'}...</span>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if !account.currentFrame && !account.pendingFrame && account.mempool.length === 0 && (!account.frameHistory || account.frameHistory.length === 0)}
          <div class="no-frames">
            No account activity yet. Send a payment to start bilateral consensus.
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .account-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
  }

  .panel-header {
    padding: 16px;
    border-bottom: 1px solid #3e3e3e;
    background: #252526;
  }

  .back-button {
    padding: 6px 12px;
    background: transparent;
    border: 1px solid #007acc;
    color: #007acc;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
    margin-bottom: 12px;
    transition: all 0.2s ease;
  }

  .back-button:hover {
    background: #007acc;
    color: white;
  }

  .account-title {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .entity-pair {
    font-size: 1.2em;
    font-weight: 600;
    color: #d4d4d4;
  }

  .consensus-status {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .frame-badge {
    padding: 4px 8px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    font-size: 0.85em;
    color: #9cdcfe;
  }

  .status-badge {
    font-size: 0.85em;
  }

  .status-badge.synced {
    color: #4ec9b0;
  }

  .status-badge.pending {
    color: #dcdcaa;
  }

  .panel-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .section {
    margin-bottom: 24px;
  }

  .section h3 {
    margin: 0 0 16px 0;
    color: #007acc;
    font-size: 1.1em;
  }

  .token-detail-card {
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }

  .token-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .token-name {
    font-weight: 600;
    font-size: 1.1em;
  }

  .net-position {
    font-family: monospace;
    font-size: 0.95em;
    padding: 4px 8px;
    border-radius: 4px;
    background: #1a1a1a;
  }

  .net-position.positive {
    color: #4ec9b0;
  }

  .net-position.negative {
    color: #f48771;
  }

  .balance-visualization {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 16px;
  }

  .balance-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .row-label {
    min-width: 80px;
    font-size: 0.85em;
    color: #888;
  }

  .detailed-bar {
    flex: 1;
    height: 32px;
    background: #1a1a1a;
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    border: 1px solid #333;
  }

  .bar-segment {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    min-width: 0;
  }

  .segment-label {
    font-size: 0.7em;
    color: white;
    font-weight: 600;
    text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
  }

  /* Pink - Unused credit */
  .bar-segment.unused-credit {
    background: linear-gradient(135deg, #ff69b4, #ff86c8);
  }

  /* Green - Collateral */
  .bar-segment.collateral {
    background: linear-gradient(135deg, #4ec9b0, #5fd4bc);
  }

  /* Orange - Used credit */
  .bar-segment.used-credit {
    background: linear-gradient(135deg, #ff8c00, #ffa500);
  }

  .capacity-summary {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    padding: 12px;
    background: #1a1a1a;
    border-radius: 4px;
    margin-bottom: 12px;
  }

  .capacity-item {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .capacity-label {
    font-size: 0.75em;
    color: #888;
    margin-bottom: 4px;
  }

  .capacity-value {
    font-family: monospace;
    font-weight: 600;
  }

  .capacity-value.outbound {
    color: #ce9178;
  }

  .capacity-value.inbound {
    color: #4ec9b0;
  }

  .credit-details {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.85em;
  }

  .credit-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 8px;
    background: #1a1a1a;
    border-radius: 3px;
  }

  .credit-row span:first-child {
    color: #888;
  }

  .credit-row span:last-child {
    font-family: monospace;
    color: #d4d4d4;
  }

  .action-card {
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }

  .action-card h4 {
    margin: 0 0 12px 0;
    color: #d4d4d4;
    font-size: 0.95em;
  }

  .action-form {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .form-select,
  .form-input {
    padding: 8px;
    background: #1a1a1a;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 0.9em;
  }

  .form-select {
    min-width: 100px;
  }

  .form-input {
    flex: 1;
  }

  .form-input:focus,
  .form-select:focus {
    border-color: #007acc;
    outline: none;
  }

  .action-button {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .action-button.primary {
    background: #007acc;
    color: white;
  }

  .action-button.primary:hover {
    background: #0086e6;
  }

  .action-button.secondary {
    background: #0e639c;
    color: white;
  }

  .action-button.secondary:hover {
    background: #1177bb;
  }

  .management-buttons {
    display: flex;
    gap: 8px;
  }

  .action-button.settle {
    background: #0d7377;
    color: white;
  }

  .action-button.settle:hover {
    background: #0a5d61;
  }

  .action-button.dispute {
    background: #d73a49;
    color: white;
  }

  .action-button.dispute:hover {
    background: #cb2431;
  }

  .action-button.close {
    background: #6c757d;
    color: white;
  }

  .action-button.close:hover {
    background: #5a6268;
  }

  .mempool-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .mempool-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    font-size: 0.85em;
  }

  .tx-index {
    color: #888;
    font-weight: 600;
  }

  .tx-type {
    color: #9cdcfe;
    font-family: monospace;
  }

  .tx-amount {
    margin-left: auto;
    color: #ce9178;
    font-family: monospace;
  }

  /* Account Frame History Styles */
  .frame-history {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .frame-item {
    background: #2d2d2d;
    border-radius: 6px;
    border: 1px solid #3e3e3e;
    overflow: hidden;
  }

  .frame-item.current {
    border-color: #10b981;
  }

  .frame-item.pending {
    border-color: #f59e0b;
  }

  .frame-item.mempool {
    border-color: #6366f1;
  }

  .frame-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: #252526;
    border-bottom: 1px solid #3e3e3e;
  }

  .frame-id {
    font-weight: 600;
    color: #d4d4d4;
    font-family: monospace;
  }

  .frame-status {
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.75em;
    font-weight: 600;
  }

  .frame-status.current {
    background: rgba(16, 185, 129, 0.2);
    color: #10b981;
  }

  .frame-status.pending {
    background: rgba(245, 158, 11, 0.2);
    color: #f59e0b;
  }

  .frame-status.mempool {
    background: rgba(99, 102, 241, 0.2);
    color: #6366f1;
  }

  .frame-status.historical {
    background: rgba(156, 163, 175, 0.2);
    color: #9ca3af;
  }

  .frame-timestamp {
    font-size: 0.8em;
    color: #9d9d9d;
    font-family: monospace;
  }

  .frame-details {
    padding: 8px 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .frame-detail {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .detail-label {
    color: #9d9d9d;
    font-size: 0.8em;
  }

  .detail-value {
    color: #d4d4d4;
    font-family: monospace;
    font-size: 0.8em;
  }

  .detail-value.hash {
    color: #9cdcfe;
  }

  .mempool-transactions {
    width: 100%;
    margin-top: 8px;
    padding: 8px;
    background: #1e1e1e;
    border-radius: 4px;
  }

  .mempool-tx, .pending-tx {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 0.8em;
    color: #d4d4d4;
    font-family: monospace;
    margin-bottom: 4px;
    padding: 4px;
    background: #1a1a1a;
    border-radius: 2px;
  }

  .pending-transactions {
    width: 100%;
    margin-top: 8px;
    padding: 8px;
    background: #1e1e1e;
    border-radius: 4px;
  }

  .tx-desc {
    color: #9d9d9d;
    font-style: italic;
  }

  .tx-token {
    color: #6366f1;
    font-size: 0.75em;
  }

  .no-frames {
    text-align: center;
    color: #6c757d;
    font-style: italic;
    font-size: 0.9em;
    padding: 20px;
  }

  /* Canonical State Styles */
  .canonical-data {
    background: #1e1e1e;
    border: 1px solid #007acc;
    border-radius: 6px;
    padding: 12px;
  }

  .canonical-note {
    font-size: 0.85em;
    color: #9d9d9d;
    margin-bottom: 12px;
    font-style: italic;
  }

  .canonical-token {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid #3e3e3e;
  }

  .canonical-token:last-child {
    border-bottom: none;
    margin-bottom: 0;
  }

  .token-id-label {
    font-weight: bold;
    color: #d4d4d4;
    margin-bottom: 8px;
  }

  .canonical-values {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 8px;
    margin-bottom: 12px;
  }

  .canonical-item {
    display: flex;
    justify-content: space-between;
    font-size: 0.85em;
    font-family: monospace;
  }

  .canonical-key {
    color: #9cdcfe;
    font-weight: 500;
  }

  .canonical-value {
    color: #ce9178;
    font-weight: 600;
  }

  /* ASCII Visualization Styles */
  .ascii-visualization {
    margin-top: 8px;
    padding: 8px;
    background: #252526;
    border-radius: 4px;
    border: 1px solid #3e3e3e;
  }

  .ascii-label {
    font-size: 0.8em;
    color: #9d9d9d;
    margin-bottom: 4px;
  }

  .ascii-bar {
    font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
    font-size: 0.9em;
    color: #00ff88;
    background: #1a1a1a;
    padding: 6px 8px;
    border-radius: 2px;
    letter-spacing: 0.5px;
    word-break: break-all;
  }

  .ascii-legend {
    display: flex;
    gap: 12px;
    margin-top: 4px;
    font-size: 0.75em;
    color: #888;
  }
</style>