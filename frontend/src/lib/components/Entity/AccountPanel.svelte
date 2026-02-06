<script lang="ts">
  import type { AccountMachine } from '$lib/types/ui';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { getXLN, xlnEnvironment, xlnFunctions, error } from '../../stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import BigIntInput from '../Common/BigIntInput.svelte';
  import AccountPreview from './AccountPreview.svelte';

  // Get environment from context (for /view route) or use global stores (for / route)
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;

  // Extract the stores from entityEnv (or use global stores as fallback)
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextEnv = entityEnv?.env;

  // Use context stores if available, otherwise fall back to global
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;

  // FINTECH-SAFE: Never return "N/A" - fail fast if data is corrupted
  // Handles BigInt by converting to Number first
  function safeFixed(value: any, decimals: number = 4): string {
    if (value == null) {
      console.error('FINTECH-SAFETY: Attempted to format null value:', value);
      throw new Error('FINTECH-SAFETY: Invalid numeric value - financial data corrupted');
    }
    // Convert BigInt to Number first, then check for NaN
    const numValue = Number(value);
    if (isNaN(numValue)) {
      console.error('FINTECH-SAFETY: Attempted to format NaN value:', value);
      throw new Error('FINTECH-SAFETY: Invalid numeric value - financial data corrupted');
    }
    return numValue.toFixed(decimals);
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

  // Form states - BigInt native!
  let selectedTokenId = 1;
  let creditAdjustment = 0;
  let paymentAmountBigInt = 0n; // BigInt for precision
  let paymentDescription = '';
  const RESEND_AFTER_MS = 10_000;
  let nowMs = Date.now();
  let nowTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    nowTimer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
  });

  onDestroy(() => {
    if (nowTimer) clearInterval(nowTimer);
  });

  // Auto-set defaults for faster testing
  $: {
    // Set default token to first available
    if (tokenDetails.length > 0 && selectedTokenId === 1 && !tokenDetails.find(td => td.tokenId === 1)) {
      selectedTokenId = tokenDetails[0]!.tokenId; // Safe: length > 0 guarantees element exists
    }

    // Set default amount to 10% of available to send - BigInt native!
    const selectedTokenDetail = tokenDetails.find(td => td.tokenId === selectedTokenId);
    if (selectedTokenDetail && paymentAmountBigInt === 0n) {
      const outCapacityBigInt = selectedTokenDetail.derived.outCapacity;
      if (outCapacityBigInt > 0n) {
        // Calculate 10% directly with BigInt (no precision loss)
        paymentAmountBigInt = (outCapacityBigInt * 10n) / 100n; // Exact 10% in wei
      }
    }
  }

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
    if (!activeXlnFunctions?.deriveDelta) {
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
        tokenInfo: { symbol: `TKN${tokenId}`, color: '#999', name: `Token ${tokenId}`, decimals: 18 },
        theirCreditLimit: 0,
        theirUsedCredit: 0,
        theirUnusedCredit: 0,
        ourCreditLimit: 0,
        ourUsedCredit: 0,
        ourUnusedCredit: 0,
        ourCollateral: 0,
        theirCollateral: 0
      };
    }

    const derived = activeXlnFunctions.deriveDelta(delta, isLeftEntity);
    const tokenInfo = activeXlnFunctions?.getTokenInfo?.(tokenId) || {
      symbol: `TKN${tokenId}`,
      color: '#999',
      name: `Token ${tokenId}`,
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
    // FINTECH-SAFETY: Convert BigInt to Number BEFORE arithmetic operations
    const theirCreditLimit = delta.rightCreditLimit;
    const theirUsedCredit = theirCreditLimit > 0n ?
      Math.max(0, Number(theirCreditLimit) - (Number(derived.inCapacity) - Number(delta.collateral))) : 0;
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

  $: pendingFrameAgeMs = account.pendingFrame?.timestamp ? (nowMs - account.pendingFrame.timestamp) : 0;
  $: canResendPendingFrame = !!account.pendingFrame && !!account.pendingAccountInput && pendingFrameAgeMs > RESEND_AFTER_MS;

  async function resendPendingFrame() {
    try {
      if (!canResendPendingFrame || !account.pendingAccountInput) return;
      const env = activeEnv;
      if (!env || !('history' in env)) throw new Error('XLN environment not ready or in historical mode');
      if (!activeXlnFunctions?.resolveEntityProposerId || !activeXlnFunctions?.sendEntityInput) {
        throw new Error('Resend helpers not available');
      }

      const accountInput = account.pendingAccountInput;
      const proposerId = activeXlnFunctions.resolveEntityProposerId(env, accountInput.toEntityId, 'resend-account-frame');
      const result = activeXlnFunctions.sendEntityInput(env, {
        entityId: accountInput.toEntityId,
        signerId: proposerId,
        entityTxs: [{ type: 'accountInput', data: accountInput }],
      });

      if (result.deferred) {
        console.warn('Resend deferred - counterparty runtimeId unknown');
      } else {
        console.log('✅ Resent pending account frame');
      }
    } catch (err: any) {
      console.error('Failed to resend pending frame:', err);
      error.set(`Resend failed: ${err?.message || 'Unknown error'}`);
    }
  }

  async function sendPayment() {
    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env || !('history' in env)) throw new Error('XLN environment not ready or in historical mode');

      // Create direct payment EntityTx
      const paymentInput = {
        entityId,
        signerId: entityId, // Simplified for now
        entityTxs: [{
          type: 'direct-payment' as const,
          data: {
            recipientEntityId: counterpartyId,
            tokenId: selectedTokenId,
            amount: paymentAmountBigInt,
            description: paymentDescription || undefined
          }
        }]
      };

      await xln.process(env, [paymentInput]);
      console.log(`✅ Payment sent: ${activeXlnFunctions?.formatTokenAmount(selectedTokenId, paymentAmountBigInt)}`);

      // Reset form
      paymentAmountBigInt = 0n;
      paymentDescription = '';

    } catch (err: any) {
      console.error('Failed to send payment:', err);
      error.set(`Payment failed: ${err?.message || 'Unknown error'}`);
    }
  }

  async function adjustCredit() {
    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env || !('history' in env)) throw new Error('XLN environment not ready or in historical mode');

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

      await xln.process(env, [adjustmentInput]);
      console.log(`✅ Credit adjusted to: ${creditAdjustment}`);

      creditAdjustment = 0;
    } catch (err: any) {
      console.error('Failed to adjust credit:', err);
      error.set(`Credit adjustment failed: ${err?.message || 'Unknown error'}`);
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
    } catch (err: any) {
      console.error('Failed to settle:', err);
      error.set(`Settlement failed: ${err?.message || 'Unknown error'}`);
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

</script>

<div class="account-panel">
  <div class="panel-header">
    <button class="back-button" on:click={handleBackToEntity}>
      ← Back to Entity
    </button>
    <div class="account-title">
      <span class="entity-pair">
        Entity {entityId} ⟷ Entity {counterpartyId}
      </span>
      <div class="consensus-status">
        <span class="frame-badge">Frame #{account.currentFrame.height}</span>
        {#if account.mempool.length > 0 || account.pendingFrame}
          <span class="status-badge pending">
            {#if account.pendingFrame}
              Awaiting Consensus
            {:else}
              {account.mempool.length} pending
            {/if}
          </span>
        {:else}
          <span class="status-badge synced">Synced</span>
        {/if}

        <!-- Quick Trust Indicator -->
        {#if account.currentFrame.stateHash}
          <span class="trust-indicator verified" title="Cryptographically verified account state">🔒 Secured</span>
        {:else}
          <span class="trust-indicator pending" title="Awaiting cryptographic verification">⏳ Unverified</span>
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
                <span class="canonical-value">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.delta.collateral)}</span>
              </div>
              <div class="canonical-item">
                <span class="canonical-key">ondelta:</span>
                <span class="canonical-value">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.delta.ondelta)}</span>
              </div>
              <div class="canonical-item">
                <span class="canonical-key">offdelta:</span>
                <span class="canonical-value">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.delta.offdelta)}</span>
              </div>
              <div class="canonical-item">
                <span class="canonical-key">leftCreditLimit:</span>
                <span class="canonical-value">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.delta.leftCreditLimit)} (Entity {isLeftEntity ? entityId : counterpartyId})</span>
              </div>
              <div class="canonical-item">
                <span class="canonical-key">rightCreditLimit:</span>
                <span class="canonical-value">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.delta.rightCreditLimit)} (Entity {isLeftEntity ? counterpartyId : entityId})</span>
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
      <h3>👤 My View (Entity {entityId} perspective)</h3>
      {#each tokenDetails as td (td.tokenId)}
        <div class="token-detail-card">
          <div class="token-header">
            <span class="token-name" style="color: {td.tokenInfo.color}">
              {td.tokenInfo.symbol} (Token #{td.tokenId})
            </span>
            <span class="net-position" class:positive={td.derived.delta > 0n} class:negative={td.derived.delta < 0n}>
              Net: {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.delta)}
            </span>
          </div>

          <!-- Reuse AccountPreview for bar visualization (DRY) -->
          <div style="margin: 12px 0;">
            <AccountPreview
              {account}
              {counterpartyId}
              {entityId}
              isSelected={false}
            />
          </div>

          <div class="capacity-summary">
            <div class="capacity-item">
              <span class="capacity-label">Available to Send:</span>
              <span class="capacity-value outbound">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outCapacity)}</span>
            </div>
            <div class="capacity-item">
              <span class="capacity-label">Available to Receive:</span>
              <span class="capacity-value inbound">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inCapacity)}</span>
            </div>
            <div class="capacity-item">
              <span class="capacity-label">Total Capacity:</span>
              <span class="capacity-value">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.totalCapacity)}</span>
            </div>
          </div>

          <div class="credit-details">
            <div class="credit-row">
              <span>Our Credit Line:</span>
              <span>{safeFixed(td.ourCreditLimit)} {td.tokenInfo.symbol}</span>
            </div>
            <div class="credit-row">
              <span>Our Credit Used:</span>
              <span>{safeFixed(td.derived.inOwnCredit)} {td.tokenInfo.symbol}</span>
            </div>
            <div class="credit-row">
              <span>Our Credit Available:</span>
              <span>{safeFixed(td.derived.outOwnCredit)} {td.tokenInfo.symbol}</span>
            </div>
            <div class="credit-row">
              <span>Their Credit Line:</span>
              <span>{safeFixed(td.theirCreditLimit)} {td.tokenInfo.symbol}</span>
            </div>
            <div class="credit-row">
              <span>Their Credit Used:</span>
              <span>{safeFixed(td.derived.outPeerCredit)} {td.tokenInfo.symbol}</span>
            </div>
            <div class="credit-row">
              <span>Their Credit Available:</span>
              <span>{safeFixed(td.derived.inPeerCredit)} {td.tokenInfo.symbol}</span>
            </div>
            <div class="credit-row">
              <span>Our Collateral:</span>
              <span>{safeFixed(td.ourCollateral)} {td.tokenInfo.symbol}</span>
            </div>
          </div>

          <!-- 🔐 Hanko Signature Proof -->
          <div class="signature-proof-section">
            <div class="signature-header">
              <span class="proof-icon">🔐</span>
              <span class="proof-title">Cryptographic Proof</span>
              <span class="frame-info">Frame #{account.currentFrame.height}</span>
            </div>

            <div class="signature-details">
              {#if account.currentFrame.stateHash}
                <div class="signature-row">
                  <span class="sig-label">State Hash:</span>
                  <code class="sig-value" title="{account.currentFrame.stateHash}">
                    {account.currentFrame.stateHash.slice(0, 16)}...
                  </code>
                  <span class="sig-status verified">✓</span>
                </div>
              {/if}

              {#if account.hankoSignature}
                <div class="signature-row">
                  <span class="sig-label">Their Hanko:</span>
                  <code class="sig-value" title="{account.hankoSignature}">
                    hanko_{account.hankoSignature.slice(0, 12)}...
                  </code>
                  <span class="sig-status verified">✓</span>
                </div>
              {:else}
                <div class="signature-row">
                  <span class="sig-label">Their Hanko:</span>
                  <span class="sig-value pending">⏳ Pending signature</span>
                </div>
              {/if}

              <div class="timestamp-row">
                <span class="timestamp-label">Last Updated:</span>
                <span class="timestamp-value">{formatTimestamp(account.currentFrame.timestamp)}</span>
              </div>
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
          <BigIntInput
            bind:value={paymentAmountBigInt}
            decimals={18}
            placeholder="Amount"
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
              {#if 'amount' in tx.data && tx.data.amount}
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
              <span class="frame-id">⏳ Pending Frame #{account.pendingFrame.height}</span>
              <span class="frame-status pending">Awaiting Consensus</span>
              <span class="frame-timestamp">
                {formatTimestamp(account.pendingFrame.timestamp)}
              </span>
              {#if canResendPendingFrame}
                <button class="resend-button" on:click|preventDefault={resendPendingFrame}>Resend Frame</button>
              {/if}
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
                    {#if tx.type === 'direct_payment'}
                      <span class="tx-amount">{activeXlnFunctions?.formatTokenAmount(tx.data.tokenId, tx.data.amount)}</span>
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
                    {#if tx.type === 'direct_payment'}
                      <span class="tx-amount">{activeXlnFunctions?.formatTokenAmount(tx.data.tokenId, tx.data.amount)}</span>
                      <span class="tx-desc">"{tx.data.description || 'no description'}"</span>
                      <span class="tx-token">Token #{tx.data.tokenId}</span>
                    {:else if tx.type === 'set_credit_limit'}
                      <span class="tx-amount">{activeXlnFunctions?.formatTokenAmount(tx.data.tokenId, tx.data.amount)}</span>
                      <span class="tx-desc">Credit extension</span>
                    {:else}
                      <span class="tx-desc">{activeXlnFunctions?.safeStringify(tx.data)}</span>
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
              <span class="frame-id">✅ Current Frame #{account.currentFrame.height || account.currentHeight}</span>
              <span class="frame-status current">Active</span>
              <span class="frame-timestamp">
                {formatTimestamp(account.currentFrame.timestamp || Date.now())}
              </span>
            </div>
            <div class="frame-details">
              <div class="frame-detail">
                <span class="detail-label">Transactions:</span>
                <span class="detail-value">{account.currentFrame?.accountTxs?.length || 0}</span>
              </div>
              <div class="frame-detail">
                <span class="detail-label">State Hash:</span>
                <span class="detail-value hash">
                  <!-- AccountSnapshot doesn't have stateHash - generate one from frame data -->
                  {#if account.currentFrame}
                    frame#{account.currentFrame.height}_{account.currentFrame.timestamp.toString().slice(-6)}
                  {:else}
                    <span style="color: #ff4444; font-weight: bold;">NO FRAME</span>
                  {/if}
                </span>
              </div>
            </div>
          </div>
        {/if}

        <!-- Historical Frames (from frameHistory array) -->
        {#if account.frameHistory && account.frameHistory.length > 0}
          <div class="historical-frames">
            <h4>📚 Historical Frames (last {Math.min(10, account.frameHistory.length)}):</h4>
            {#each account.frameHistory.slice(-10).reverse() as frame}
              <div class="frame-item historical">
                <div class="frame-header">
                  <span class="frame-id">📜 Frame #{frame.height}</span>
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
                    <span class="detail-value">{frame.byLeft === true ? 'Left' : frame.byLeft === false ? 'Right' : '—'}</span>
                  </div>
                  <div class="frame-detail">
                    <span class="detail-label">Tokens:</span>
                    <span class="detail-value">{frame.tokenIds?.join(', ') || 'None'}</span>
                  </div>
                  <div class="frame-detail">
                    <span class="detail-label">Hash:</span>
                    <span class="detail-value hash">
                      {#if frame.stateHash}
                        {frame.stateHash.slice(0,8)}...
                      {:else}
                        <span style="color: #ff4444; font-weight: bold;">MISSING HASH</span>
                      {/if}
                    </span>
                  </div>
                </div>

                <!-- Show full transaction list -->
                {#if frame.accountTxs && frame.accountTxs.length > 0}
                  <div class="frame-txs-list">
                    {#each frame.accountTxs as tx, idx}
                      <div class="frame-tx-item">
                        <span class="tx-index">{idx + 1}.</span>
                        <span class="tx-type">{tx.type}</span>
                        <span class="tx-data">{JSON.stringify(tx.data, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
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

  .trust-indicator {
    font-size: 0.75em;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 500;
  }

  .trust-indicator.verified {
    background: #1a4d1a;
    color: #00ff88;
    border: 1px solid #2d5a2d;
  }

  .trust-indicator.pending {
    background: #4d4d1a;
    color: #dcdcaa;
    border: 1px solid #5a5a2d;
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





  .bar-segment {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    min-width: 0;
  }


  /* Pink - Unused credit */

  /* Green - Collateral */
  .bar-segment.collateral {
    background: linear-gradient(135deg, #4ec9b0, #5fd4bc);
  }

  /* Orange - Used credit */

  /* Unified capacity bar styles */
  .unified-capacity-bar {
    margin-bottom: 16px;
  }

  .bar-segments {
    display: flex;
    height: 40px;
    border-radius: 6px;
    overflow: hidden;
    background: #1a1a1a;
    border: 1px solid #333;
    margin-bottom: 8px;
  }

  .bar-legend {
    display: flex;
    gap: 12px;
    font-size: 0.7em;
    color: #888;
    flex-wrap: wrap;
    justify-content: center;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .legend-color {
    width: 12px;
    height: 12px;
    border-radius: 2px;
    border: 1px solid #444;
  }

  .their-unused-bg {
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.5), rgba(198, 66, 116, 0.7));
  }

  .their-used-bg {
    background: linear-gradient(135deg, #ff6b9d, #c64274);
  }

  .collateral-bg {
    background: linear-gradient(135deg, #4facfe, #00c8ff);
  }

  .their-collateral-bg {
    background: linear-gradient(135deg, #4facfe, #00c8ff);
  }

  .bar-segment.their-collateral {
    background: linear-gradient(135deg, #4facfe, #00c8ff);
  }

  .our-used-bg {
    background: linear-gradient(135deg, #ff9a56, #cc6d2e);
  }

  .our-unused-bg {
    background: linear-gradient(135deg, rgba(255, 154, 86, 0.5), rgba(204, 109, 46, 0.7));
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

  /* Historical frame transaction list styling */
  .frame-txs-list {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #3e3e3e;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .frame-tx-item {
    display: flex;
    gap: 8px;
    padding: 6px;
    background: #1a1a1a;
    border-radius: 3px;
    font-size: 0.75em;
    align-items: flex-start;
  }

  .frame-tx-item .tx-index {
    color: #666;
    min-width: 20px;
  }

  .frame-tx-item .tx-type {
    color: #4ec9b0;
    font-family: monospace;
    font-weight: 600;
    min-width: 120px;
  }

  .frame-tx-item .tx-data {
    color: #888;
    font-family: monospace;
    font-size: 0.9em;
    word-break: break-all;
    flex: 1;
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

  .resend-button {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid #f59e0b;
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
    font-size: 0.75em;
    font-weight: 600;
    cursor: pointer;
  }

  .resend-button:hover {
    background: rgba(245, 158, 11, 0.25);
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

  /* 🔐 Hanko Signature Proof Styles */
  .signature-proof-section {
    margin-top: 16px;
    padding: 12px;
    background: #1e1e1e;
    border: 1px solid #4a4a4a;
    border-radius: 6px;
    border-left: 3px solid #007acc;
  }

  .signature-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 0.9em;
    font-weight: 600;
  }

  .proof-icon {
    font-size: 1.1em;
  }

  .proof-title {
    color: #007acc;
  }

  .frame-info {
    margin-left: auto;
    color: #888;
    font-size: 0.85em;
    font-family: monospace;
  }

  .signature-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .signature-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8em;
  }

  .sig-label {
    min-width: 80px;
    color: #ccc;
    font-size: 0.85em;
  }

  .sig-value {
    font-family: 'Courier New', monospace;
    background: #2a2a2a;
    padding: 2px 6px;
    border-radius: 3px;
    color: #dcdcaa;
    border: 1px solid #3e3e3e;
    cursor: pointer;
    transition: background 0.2s;
  }

  .sig-value:hover {
    background: #3a3a3a;
  }

  .sig-value.pending {
    background: transparent;
    border: none;
    color: #888;
    font-style: italic;
  }

  .sig-status {
    margin-left: auto;
    font-size: 0.9em;
  }

  .sig-status.verified {
    color: #00ff88;
  }

  .timestamp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.75em;
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid #3e3e3e;
  }

  .timestamp-label {
    color: #999;
  }

  .timestamp-value {
    font-family: monospace;
    color: #dcdcaa;
  }
</style>
