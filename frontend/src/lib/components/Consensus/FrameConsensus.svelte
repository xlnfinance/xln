<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  export let entityState: any = null;
  export let entityId: string;

  let currentFrame: any = null;
  let pendingFrame: any = null;
  let frameHistory: any[] = [];
  let consensusPhase: 'idle' | 'proposing' | 'signing' | 'committing' = 'idle';
  let signatures: Map<string, any> = new Map();
  let quorumThreshold: number = 2;
  let quorumMet: boolean = false;

  $: if (entityState) {
    updateConsensusView();
  }

  function updateConsensusView() {
    if (!entityState) return;

    currentFrame = entityState.currentFrame || null;
    pendingFrame = entityState.pendingFrame || null;
    frameHistory = entityState.frameHistory || [];

    // Determine consensus phase
    if (pendingFrame) {
      if (pendingFrame.signatures && pendingFrame.signatures.length >= quorumThreshold) {
        consensusPhase = 'committing';
        quorumMet = true;
      } else if (pendingFrame.signatures && pendingFrame.signatures.length > 0) {
        consensusPhase = 'signing';
      } else {
        consensusPhase = 'proposing';
      }
    } else {
      consensusPhase = 'idle';
    }

    // Update signatures map
    if (pendingFrame?.signatures) {
      signatures = new Map(pendingFrame.signatures.map((sig: any) => [sig.signer, sig]));
    }
  }

  function getPhaseIcon(phase: string): string {
    switch(phase) {
      case 'idle': return '⏸️';
      case 'proposing': return '📝';
      case 'signing': return '✍️';
      case 'committing': return '✅';
      default: return '❓';
    }
  }

  function getPhaseColor(phase: string): string {
    switch(phase) {
      case 'idle': return '#6b7280';
      case 'proposing': return '#3b82f6';
      case 'signing': return '#f59e0b';
      case 'committing': return '#10b981';
      default: return '#9d9d9d';
    }
  }

  function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }
</script>

<div class="consensus-container">
  <div class="consensus-header">
    <h3>🔄 Frame Consensus</h3>
    <div class="phase-indicator" style="color: {getPhaseColor(consensusPhase)}">
      <span class="phase-icon">{getPhaseIcon(consensusPhase)}</span>
      <span class="phase-text">{consensusPhase.toUpperCase()}</span>
    </div>
  </div>

  {#if pendingFrame}
    <div class="pending-frame">
      <div class="frame-info">
        <div class="frame-id">Frame #{pendingFrame.frameNumber || 'New'}</div>
        <div class="frame-details">
          <span>Height: {pendingFrame.height || 0}</span>
          <span>Txs: {pendingFrame.transactions?.length || 0}</span>
        </div>
      </div>

      <div class="consensus-progress">
        <div class="progress-bar">
          <div
            class="progress-fill"
            style="width: {(signatures.size / quorumThreshold) * 100}%"
            class:complete={quorumMet}
          ></div>
        </div>
        <div class="progress-text">
          {signatures.size} / {quorumThreshold} signatures
        </div>
      </div>

      <div class="signatures-list">
        <div class="signatures-header">Signatures:</div>
        {#each [...signatures.values()] as sig}
          <div class="signature-item">
            <span class="signer">{sig.signer.slice(0, 8)}...</span>
            <span class="sig-time">{formatTimestamp(sig.timestamp)}</span>
            <span class="sig-status">✓</span>
          </div>
        {/each}
      </div>

      {#if consensusPhase === 'committing'}
        <div class="commit-ready">
          🎯 Ready to commit! Frame will be finalized.
        </div>
      {/if}
    </div>
  {:else if currentFrame}
    <div class="current-frame">
      <div class="frame-info">
        <div class="frame-id">Current Frame #{currentFrame.frameNumber}</div>
        <div class="frame-hash">{currentFrame.hash?.slice(0, 16)}...</div>
      </div>
      <div class="frame-stats">
        <div class="stat">
          <span class="label">Height:</span>
          <span class="value">{currentFrame.height}</span>
        </div>
        <div class="stat">
          <span class="label">Committed:</span>
          <span class="value">{formatTimestamp(currentFrame.timestamp)}</span>
        </div>
      </div>
    </div>
  {:else}
    <div class="no-frame">
      No active frame. System is idle.
    </div>
  {/if}

  <div class="consensus-flow">
    <div class="flow-step" class:active={consensusPhase === 'proposing'}>
      <div class="step-icon">📝</div>
      <div class="step-label">PROPOSE</div>
    </div>
    <div class="flow-arrow">→</div>
    <div class="flow-step" class:active={consensusPhase === 'signing'}>
      <div class="step-icon">✍️</div>
      <div class="step-label">SIGN</div>
    </div>
    <div class="flow-arrow">→</div>
    <div class="flow-step" class:active={consensusPhase === 'committing'}>
      <div class="step-icon">✅</div>
      <div class="step-label">COMMIT</div>
    </div>
  </div>

  <div class="consensus-footer">
    <span class="entity-label">Entity: {entityId.slice(0, 8)}...</span>
    <span class="bft-indicator" title="Byzantine Fault Tolerant">
      🛡️ BFT Active
    </span>
  </div>
</div>

<style>
  .consensus-container {
    background: rgba(28, 28, 30, 0.95);
    border: 1px solid rgba(0, 122, 204, 0.3);
    border-radius: 8px;
    padding: 16px;
    margin: 16px 0;
  }

  .consensus-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .consensus-header h3 {
    margin: 0;
    color: #007acc;
    font-size: 16px;
  }

  .phase-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
  }

  .pending-frame,
  .current-frame {
    background: rgba(0, 0, 0, 0.3);
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 16px;
  }

  .frame-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .frame-id {
    font-size: 14px;
    font-weight: 600;
    color: #4ade80;
  }

  .frame-details {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: #9d9d9d;
  }

  .frame-hash {
    font-size: 11px;
    color: #6b7280;
    font-family: monospace;
  }

  .consensus-progress {
    margin: 16px 0;
  }

  .progress-bar {
    height: 8px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(to right, #3b82f6, #06b6d4);
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .progress-fill.complete {
    background: linear-gradient(to right, #10b981, #4ade80);
  }

  .progress-text {
    font-size: 12px;
    color: #9d9d9d;
    text-align: center;
  }

  .signatures-list {
    margin-top: 12px;
  }

  .signatures-header {
    font-size: 12px;
    color: #6b7280;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .signature-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 4px;
    margin-bottom: 4px;
    font-size: 12px;
  }

  .signer {
    color: #e5e7eb;
    font-family: monospace;
  }

  .sig-time {
    color: #6b7280;
    font-size: 11px;
  }

  .sig-status {
    color: #10b981;
  }

  .commit-ready {
    margin-top: 12px;
    padding: 8px;
    background: linear-gradient(to right, rgba(16, 185, 129, 0.1), rgba(74, 222, 128, 0.1));
    border: 1px solid rgba(16, 185, 129, 0.3);
    border-radius: 4px;
    text-align: center;
    color: #4ade80;
    font-size: 13px;
    font-weight: 500;
  }

  .frame-stats {
    display: flex;
    gap: 16px;
    margin-top: 8px;
  }

  .stat {
    display: flex;
    gap: 6px;
    font-size: 12px;
  }

  .stat .label {
    color: #6b7280;
  }

  .stat .value {
    color: #e5e7eb;
  }

  .no-frame {
    padding: 24px;
    text-align: center;
    color: #6b7280;
    font-size: 13px;
    font-style: italic;
  }

  .consensus-flow {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 8px;
    margin: 16px 0;
    padding: 12px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 6px;
  }

  .flow-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 12px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
    opacity: 0.5;
    transition: all 0.3s ease;
  }

  .flow-step.active {
    opacity: 1;
    background: rgba(0, 122, 204, 0.2);
    border: 1px solid rgba(0, 122, 204, 0.4);
  }

  .step-icon {
    font-size: 20px;
  }

  .step-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    color: #9d9d9d;
  }

  .flow-arrow {
    color: #4b5563;
    font-size: 18px;
  }

  .consensus-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 16px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 11px;
  }

  .entity-label {
    color: #6b7280;
  }

  .bft-indicator {
    color: #60a5fa;
    display: flex;
    align-items: center;
    gap: 4px;
  }
</style>