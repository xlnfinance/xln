<script lang="ts">
  import type { AccountTokenDetailRow } from './account-token-details';

  export let detail: AccountTokenDetailRow;
  export let formatTokenAmount: ((tokenId: number, value: bigint) => string) | null = null;

  function stripTrailingSymbol(rawAmount: string, rawSymbol: string): string {
    const amount = String(rawAmount || '').replace(/\s+/g, ' ').trim();
    const symbol = String(rawSymbol || '').trim();
    if (!amount || !symbol) return amount;
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return amount.replace(new RegExp(`\\s+${escaped}\\s*$`, 'i'), '').trim();
  }

  function formatTokenNumberOnly(value: bigint): string {
    const raw = formatTokenAmount ? formatTokenAmount(detail.tokenId, value) : value.toString();
    return stripTrailingSymbol(raw, detail.tokenInfo.symbol);
  }
</script>

<div class="delta-details">
  <div class="detail-section">
    <h5 class="detail-section-title">Perspective</h5>
    <div class="detail-table">
      <div class="detail-grid-three detail-head">
        <span class="detail-header">Parameter</span>
        <span class="detail-header detail-header-right">Out</span>
        <span class="detail-header detail-header-right">In</span>
      </div>
      <div class="detail-grid-three">
        <span class="detail-label-cell">Capacity</span>
        <span class="detail-value-cell">{formatTokenNumberOnly(detail.derived.outCapacity)}</span>
        <span class="detail-value-cell">{formatTokenNumberOnly(detail.derived.inCapacity)}</span>
      </div>
      <div class="detail-grid-three">
        <span class="detail-label-cell">Credit limit</span>
        <span class="detail-value-cell">{formatTokenNumberOnly(detail.derived.ownCreditLimit)}</span>
        <span class="detail-value-cell">{formatTokenNumberOnly(detail.derived.peerCreditLimit)}</span>
      </div>
      <div class="detail-grid-three">
        <span class="detail-label-cell">Own credit component</span>
        <span class="detail-value-cell">{formatTokenNumberOnly(detail.derived.outOwnCredit)}</span>
        <span class="detail-value-cell">{formatTokenNumberOnly(detail.derived.inOwnCredit)}</span>
      </div>
      <div class="detail-grid-three">
        <span class="detail-label-cell">Peer credit component</span>
        <span class="detail-value-cell debt">{formatTokenNumberOnly(detail.derived.outPeerCredit)}</span>
        <span class="detail-value-cell">{formatTokenNumberOnly(detail.derived.inPeerCredit)}</span>
      </div>
      <div class="detail-grid-three">
        <span class="detail-label-cell">Collateral component</span>
        <span class="detail-value-cell coll">{formatTokenNumberOnly(detail.derived.outCollateral)}</span>
        <span class="detail-value-cell coll">{formatTokenNumberOnly(detail.derived.inCollateral)}</span>
      </div>
      <div class="detail-grid-three">
        <span class="detail-label-cell">Hold deduction</span>
        <span class="detail-value-cell debt">{formatTokenNumberOnly(detail.derived.outTotalHold ?? 0n)}</span>
        <span class="detail-value-cell debt">{formatTokenNumberOnly(detail.derived.inTotalHold ?? 0n)}</span>
      </div>
    </div>
  </div>

  <div class="detail-section canonical">
    <h5 class="detail-section-title">Canonical state</h5>
    <div class="detail-list">
      <div class="detail-line">
        <span class="detail-label">delta</span>
        <span class="detail-value">{formatTokenNumberOnly(detail.derived.delta)}</span>
      </div>
      <div class="detail-line">
        <span class="detail-label">offdelta</span>
        <span class="detail-value">{formatTokenNumberOnly(detail.delta?.offdelta ?? 0n)}</span>
      </div>
      <div class="detail-line">
        <span class="detail-label">ondelta</span>
        <span class="detail-value">{formatTokenNumberOnly(detail.delta?.ondelta ?? 0n)}</span>
      </div>
    </div>
  </div>
</div>

<style>
  .delta-details {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(240px, 1fr);
    gap: 14px;
    margin-top: 10px;
  }

  .detail-section {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 12px;
    padding: 14px;
  }

  .detail-section-title {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 700;
    color: #d6d3d1;
  }

  .detail-table,
  .detail-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .detail-grid-three {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(88px, 1fr) minmax(88px, 1fr);
    gap: 12px;
    align-items: center;
  }

  .detail-head {
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .detail-header,
  .detail-label,
  .detail-label-cell {
    color: #a8a29e;
    font-size: 12px;
  }

  .detail-header-right,
  .detail-value-cell,
  .detail-value {
    text-align: right;
  }

  .detail-value-cell,
  .detail-value {
    color: #f5f5f4;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .detail-line {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }

  .detail-line:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .debt {
    color: #fda4af;
  }

  .coll {
    color: #86efac;
  }

  @media (max-width: 900px) {
    .delta-details {
      grid-template-columns: 1fr;
    }
  }
</style>
